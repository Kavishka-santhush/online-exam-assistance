/**
 * Cleanup job.
 *
 * Nightly housekeeping for state that accumulates without anyone asking:
 *
 *   1. certificates — `certificate.service.checkCertificateExpiries()` flips
 *      ISSUED rows past their valid-through date to EXPIRED;
 *   2. invites      — PENDING `OrganizationInvite`s past `expiresAt` become EXPIRED;
 *   3. live quizzes — sessions still WAITING/RUNNING from a crashed host are
 *      force-ENDED so their codes free up and leaderboards settle;
 *   4. uploads      — transient IMPORT_FILE / EXPORT_FILE blobs older than the
 *      retention window are deleted from local disk *and* their rows removed
 *      (user-owned media — avatars, recordings, generated PDFs — is never touched);
 *   5. notifications— already-read rows older than the retention window are pruned.
 *
 * File deletion is confined to `env.uploadRoot` via a resolve-and-contain check
 * so a tampered storagePath can never make the job unlink outside the uploads
 * tree. Runs on CLEANUP_SWEEP_CRON (default 03:00 daily).
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const cron = require('node-cron');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const prisma = require('../config/prisma');
const certificate = require('../services/certificate.service');

const TRANSIENT_KINDS = ['IMPORT_FILE', 'EXPORT_FILE'];
const UPLOAD_RETENTION_DAYS = 1;
const NOTIFICATION_RETENTION_DAYS = 90;
const LIVE_QUIZ_STALE_HOURS = 24;

let task = null;
let running = false;

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);

/** Delete a blob only if it resolves inside the uploads root. */
async function safeUnlink(storagePath) {
  if (!storagePath) return false;
  const resolved = path.resolve(storagePath);
  const root = path.resolve(env.uploadRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    logger.warn('cleanup refused to unlink outside uploads root', { storagePath });
    return false;
  }
  try {
    await fs.unlink(resolved);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.debug('cleanup unlink failed', { storagePath, error: error.message });
    return false;
  }
}

async function expireInvites() {
  const result = await prisma.organizationInvite.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}

async function endStaleLiveQuizzes() {
  const cutoff = hoursAgo(LIVE_QUIZ_STALE_HOURS);
  const stale = await prisma.liveQuizSession.findMany({
    where: { status: { in: ['WAITING', 'RUNNING', 'PAUSED'] }, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  if (!stale.length) return 0;
  await prisma.liveQuizSession.updateMany({
    where: { id: { in: stale.map((row) => row.id) } },
    data: { status: 'ENDED' },
  });
  return stale.length;
}

async function purgeTransientUploads() {
  const cutoff = daysAgo(UPLOAD_RETENTION_DAYS);
  const rows = await prisma.uploadedFile.findMany({
    where: { kind: { in: TRANSIENT_KINDS }, createdAt: { lt: cutoff } },
    select: { id: true, storagePath: true },
    take: 500,
  });
  let removedFiles = 0;
  for (const row of rows) {
    if (await safeUnlink(row.storagePath)) removedFiles += 1;
  }
  if (rows.length) await prisma.uploadedFile.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return { scanned: rows.length, filesRemoved: removedFiles };
}

async function pruneNotifications() {
  const cutoff = daysAgo(NOTIFICATION_RETENTION_DAYS);
  const result = await prisma.notification.deleteMany({
    where: { readAt: { not: null }, createdAt: { lt: cutoff } },
  });
  return result.count;
}

async function tick() {
  if (running) return { skipped: true };
  running = true;
  const summary = {};
  try {
    await certificate.checkCertificateExpiries().catch((error) => logger.error('certificate expiry sweep failed', { error: error.message }));
    summary.invitesExpired = await expireInvites();
    summary.liveQuizzesEnded = await endStaleLiveQuizzes();
    summary.uploads = await purgeTransientUploads();
    summary.notificationsPruned = await pruneNotifications();
    logger.info('cleanup sweep complete', summary);
    return summary;
  } catch (error) {
    logger.error('cleanup tick failed', { error: error.message });
    return { ...summary, error: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (task) return task;
  if (!cron.validate(env.CLEANUP_SWEEP_CRON)) {
    logger.error('invalid CLEANUP_SWEEP_CRON expression', { expression: env.CLEANUP_SWEEP_CRON });
    return null;
  }
  task = cron.schedule(env.CLEANUP_SWEEP_CRON, () => {
    tick().catch((error) => logger.error('cleanup job uncaught', { error: error.message }));
  });
  logger.info('cleanup job started', { cron: env.CLEANUP_SWEEP_CRON });
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('cleanup job stopped');
  }
}

module.exports = { start, stop, tick, name: 'cleanup' };
