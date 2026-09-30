/**
 * Exam scheduler job.
 *
 * Drives the time-based parts of the exam lifecycle that cannot rely on a user
 * hitting an endpoint:
 *
 *   1. open  — a SCHEDULED exam whose `startsAt` has arrived becomes PUBLISHED
 *              (and stamping `publishedAt`) so candidates can begin immediately
 *              at the scheduled moment;
 *   2. close — a PUBLISHED / ACTIVE exam whose `endsAt` has passed becomes CLOSED
 *              so no new attempt can start after the window;
 *   3. release — `grading.service.processScheduledReleases()` publishes results
 *              whose `resultsVisibleAt` has come due.
 *
 * Runs on EXAM_SCHEDULER_CRON (default every minute). A re-entrancy guard keeps
 * overlapping ticks from double-transitioning the same row.
 */

const cron = require('node-cron');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const prisma = require('../config/prisma');
const grading = require('../services/grading.service');

let task = null;
let running = false;

async function openScheduledExams(now) {
  // SCHEDULED exams with a start time that has passed (or no explicit start).
  const due = await prisma.exam.findMany({
    where: {
      status: 'SCHEDULED',
      startsAt: { not: null, lte: now },
    },
    select: { id: true, title: true },
    take: 200,
  });
  if (!due.length) return 0;

  await prisma.exam.updateMany({
    where: { id: { in: due.map((exam) => exam.id) } },
    data: { status: 'PUBLISHED', publishedAt: now },
  });
  logger.info('scheduler opened scheduled exams', { count: due.length, ids: due.map((e) => e.id) });
  return due.length;
}

async function closeEndedExams(now) {
  const due = await prisma.exam.findMany({
    where: {
      status: { in: ['PUBLISHED', 'ACTIVE'] },
      endsAt: { not: null, lte: now },
    },
    select: { id: true },
    take: 200,
  });
  if (!due.length) return 0;

  await prisma.exam.updateMany({
    where: { id: { in: due.map((exam) => exam.id) } },
    data: { status: 'CLOSED', closedAt: now },
  });
  logger.info('scheduler closed ended exams', { count: due.length, ids: due.map((e) => e.id) });
  return due.length;
}

async function releaseDueResults() {
  try {
    const result = await grading.processScheduledReleases();
    if (result && typeof result === 'object' && 'released' in result) {
      logger.info('scheduler released results', { released: result.released });
    }
    return result;
  } catch (error) {
    logger.error('scheduled result release failed', { error: error.message });
    return null;
  }
}

async function tick() {
  if (running) return { skipped: true };
  running = true;
  const now = new Date();
  try {
    const opened = await openScheduledExams(now);
    const closed = await closeEndedExams(now);
    const releases = await releaseDueResults();
    return { opened, closed, releases };
  } catch (error) {
    logger.error('exam scheduler tick failed', { error: error.message });
    return { error: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (task) return task;
  if (!cron.validate(env.EXAM_SCHEDULER_CRON)) {
    logger.error('invalid EXAM_SCHEDULER_CRON expression', { expression: env.EXAM_SCHEDULER_CRON });
    return null;
  }
  task = cron.schedule(env.EXAM_SCHEDULER_CRON, () => {
    tick().catch((error) => logger.error('exam scheduler uncaught', { error: error.message }));
  });
  logger.info('exam scheduler job started', { cron: env.EXAM_SCHEDULER_CRON });
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('exam scheduler job stopped');
  }
}

module.exports = { start, stop, tick, name: 'examScheduler' };
