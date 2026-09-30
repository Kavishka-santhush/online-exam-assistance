/**
 * Server entrypoint.
 *
 * Boots the Express app behind a single Node HTTP server that also hosts the
 * Socket.io gateway (so the API and realtime layer share one port), starts the
 * cron jobs (exam scheduling, reminders, auto-submit, cleanup), and wires
 * graceful shutdown so in-flight requests, sockets, timers, and the Prisma
 * connection are drained before the process exits.
 *
 * This file is intentionally the only place that calls `.listen()`; `app.js`
 * stays importable by tests and tooling without opening a port.
 */

require('./src/config/env'); // fail fast on a bad environment before anything else

const http = require('node:http');
const env = require('./src/config/env');
const logger = require('./src/utils/logger.util');
const prisma = require('./src/config/prisma');
const app = require('./src/app');
const { initSocket, closeSocket } = require('./src/socket/index.socket');

// Scheduled jobs. Each module exports `{ start(), stop() }`.
const examScheduler = require('./src/jobs/examScheduler.job');
const reminderJob = require('./src/jobs/reminder.job');
const autoSubmitJob = require('./src/jobs/autoSubmit.job');
const cleanupJob = require('./src/jobs/cleanup.job');

const JOBS = [examScheduler, reminderJob, autoSubmitJob, cleanupJob];

function startJobs() {
  for (const job of JOBS) {
    try {
      job.start();
    } catch (error) {
      logger.error('failed to start a scheduled job', { error: error.message });
    }
  }
}

function stopJobs() {
  for (const job of JOBS) {
    try {
      job.stop?.();
    } catch (error) {
      logger.warn('error stopping a scheduled job', { error: error.message });
    }
  }
}

const server = http.createServer(app);

// Socket.io shares the HTTP server so the client can connect to the same origin.
initSocket(server);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down gracefully`);

  // Stop accepting scheduled work first so nothing new fires mid-drain.
  stopJobs();

  // Close the Socket.io gateway, then the HTTP server.
  await Promise.resolve(closeSocket()).catch((error) => logger.warn('socket close error', { error: error.message }));

  server.close(async (err) => {
    if (err) logger.error('error while closing HTTP server', { error: err.message });
    await prisma
      .$disconnect()
      .catch((error) => logger.warn('prisma disconnect error', { error: error.message }));
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });

  // Hard deadline so a stuck connection cannot block shutdown forever.
  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception — exiting', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

server.listen(env.PORT, () => {
  logger.info(`exam platform API listening`, {
    port: env.PORT,
    env: env.NODE_ENV,
    api: env.API_BASE_URL,
    uploads: env.uploadRoot,
  });
  startJobs();
});

module.exports = server;
