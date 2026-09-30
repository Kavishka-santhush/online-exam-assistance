/**
 * Shared PrismaClient singleton.
 *
 * One connection pool is reused by every request, socket handler and cron
 * job. Slow-query logging is emitted through the logger outside production.
 * `env.js` loads `.env` before this module runs, so Prisma picks up
 * DATABASE_URL from process.env.
 */

const { PrismaClient } = require('@prisma/client');
const env = require('./env');
const logger = require('../utils/logger.util');

const prisma = new PrismaClient({
  log: env.isProduction ? ['warn', 'error'] : ['query', 'warn', 'error'],
});

if (!env.isProduction && typeof prisma.$on === 'function') {
  prisma.$on('query', (event) => {
    if (event.duration > 250) {
      logger.warn(`slow query ${event.duration}ms`, { query: event.query, params: event.params });
    }
  });
}

module.exports = prisma;
