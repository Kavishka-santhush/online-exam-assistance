/**
 * Auto-submit job.
 *
 * The authoritative timer enforcer. A candidate's browser may be closed, their
 * connection dropped, or their local clock tampered with, so the server cannot
 * trust the client to submit when time runs out. This sweep asks `timer.service`
 * (via `attempt.service.autoSubmitExpired`) for every IN_PROGRESS / PAUSED
 * attempt whose deadline has passed and finalises each one exactly the way a
 * manual submit would — grading, notifications and the proctor room all fire
 * through the same `finaliseAttempt` path.
 *
 * Runs on AUTO_SUBMIT_SWEEP_CRON (default every minute). The grace window lets a
 * just-expired attempt finish an in-flight autosave before it is locked.
 */

const cron = require('node-cron');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const attempt = require('../services/attempt.service');

// Give expiring attempts a few seconds of slack so a concurrent autosave that
// is milliseconds from landing is not cut off mid-write.
const GRACE_SEC = 5;
const BATCH_LIMIT = 100;

let task = null;
let running = false;

async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = await attempt.autoSubmitExpired({ limit: BATCH_LIMIT, graceSec: GRACE_SEC });
    if (result.scanned) {
      logger.info('auto-submit sweep', { scanned: result.scanned, submitted: result.submitted, failed: result.failed?.length ?? 0 });
    }
    return result;
  } catch (error) {
    logger.error('auto-submit sweep failed', { error: error.message });
    return { error: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (task) return task;
  if (!cron.validate(env.AUTO_SUBMIT_SWEEP_CRON)) {
    logger.error('invalid AUTO_SUBMIT_SWEEP_CRON expression', { expression: env.AUTO_SUBMIT_SWEEP_CRON });
    return null;
  }
  task = cron.schedule(env.AUTO_SUBMIT_SWEEP_CRON, () => {
    tick().catch((error) => logger.error('auto-submit job uncaught', { error: error.message }));
  });
  logger.info('auto-submit job started', { cron: env.AUTO_SUBMIT_SWEEP_CRON });
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('auto-submit job stopped');
  }
}

module.exports = { start, stop, tick, name: 'autoSubmit' };
