/**
 * Reminder job.
 *
 * Sends time-sensitive "heads up" notifications that no user request triggers:
 *
 *   1. exam-starting — registered candidates are reminded shortly before a
 *      scheduled exam opens. We stamp `settings.startingReminderAt` on the exam
 *      so the sweep is idempotent even though it runs every few minutes;
 *   2. certificate-expiry — `certificate.service.notifyExpiringCertificates()`
 *      emails holders whose certificates are about to lapse.
 *
 * Runs on REMINDER_SWEEP_CRON (default every five minutes).
 */

const cron = require('node-cron');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const prisma = require('../config/prisma');
const notification = require('../services/notification.service');
const certificate = require('../services/certificate.service');

// Remind this many minutes ahead of a scheduled start.
const LEAD_MINUTES = 20;
// Only look at exams starting within [now, now + this window]; bounds the scan.
const SCAN_WINDOW_MINUTES = 6 * 60;

let task = null;
let running = false;

async function remindStartingExams(now) {
  const leadUntil = new Date(now.getTime() + LEAD_MINUTES * 60_000);
  const scanUntil = new Date(now.getTime() + SCAN_WINDOW_MINUTES * 60_000);

  const candidates = await prisma.exam.findMany({
    where: {
      status: { in: ['SCHEDULED', 'PUBLISHED', 'ACTIVE'] },
      startsAt: { not: null, gte: now, lte: scanUntil },
    },
    select: { id: true, title: true, slug: true, startsAt: true, settings: true },
    take: 200,
  });

  let sent = 0;
  for (const exam of candidates) {
    const settings = exam.settings && typeof exam.settings === 'object' ? exam.settings : {};
    if (settings.startingReminderAt) continue; // already reminded for this exam
    // Only fire once we are inside the lead window.
    if (new Date(exam.startsAt) > leadUntil) continue;

    await notification
      .notifyExamCandidates(exam.id, {
        type: 'EXAM_STARTING',
        title: `"${exam.title}" is about to start`,
        body: `Your exam begins at ${new Date(exam.startsAt).toLocaleString()}. Make sure your setup is ready.`,
        actionUrl: `/exams/${exam.slug}`,
        emailProps: { examTitle: exam.title, startsAt: exam.startsAt, slug: exam.slug },
      })
      .catch((error) => logger.error('exam-starting reminder failed', { examId: exam.id, error: error.message }));

    await prisma.exam
      .update({ where: { id: exam.id }, data: { settings: { ...settings, startingReminderAt: now.toISOString() } } })
      .catch(() => null);
    sent += 1;
  }
  return sent;
}

async function remindExpiringCertificates(now) {
  try {
    const result = await certificate.notifyExpiringCertificates(30);
    if (result && typeof result === 'object' && 'notified' in result && result.notified) {
      logger.info('certificate expiry reminders sent', { ...result, at: now.toISOString() });
    }
    return result;
  } catch (error) {
    logger.error('certificate expiry reminder failed', { error: error.message });
    return null;
  }
}

async function tick() {
  if (running) return { skipped: true };
  running = true;
  const now = new Date();
  try {
    const starting = await remindStartingExams(now);
    await remindExpiringCertificates(now);
    return { starting };
  } catch (error) {
    logger.error('reminder tick failed', { error: error.message });
    return { error: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (task) return task;
  if (!cron.validate(env.REMINDER_SWEEP_CRON)) {
    logger.error('invalid REMINDER_SWEEP_CRON expression', { expression: env.REMINDER_SWEEP_CRON });
    return null;
  }
  task = cron.schedule(env.REMINDER_SWEEP_CRON, () => {
    tick().catch((error) => logger.error('reminder job uncaught', { error: error.message }));
  });
  logger.info('reminder job started', { cron: env.REMINDER_SWEEP_CRON });
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('reminder job stopped');
  }
}

module.exports = { start, stop, tick, name: 'reminder' };
