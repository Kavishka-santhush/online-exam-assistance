/**
 * Rate limiting.
 *
 * Separate buckets so one abusive endpoint cannot starve the rest of the API:
 *   apiLimiter      - everything under /api (generous)
 *   authLimiter     - Clerk webhook + provisioning probes (tight)
 *   aiLimiter       - OpenRouter proxies (expensive, per user)
 *   submitLimiter   - exam submit / autosave bursts (per attempt, not per IP)
 *   uploadLimiter   - Multer endpoints
 *   proctorLimiter  - violation reporting (candidates fire these in bursts)
 *
 * In production these should be backed by Redis (`PROCTORING_REDIS_URL`); the
 * in-memory store is fine for a single node and is the default so the API
 * boots with no extra infrastructure.
 */

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const logger = require('../utils/logger.util');

const keyByUserOrIp = (req) => (req.userId ? `u:${req.userId}` : `ip:${req.ip}`);
const keyByAttempt = (req) => `a:${req.params.attemptId ?? req.body?.attemptId ?? req.userId ?? req.ip}`;

function buildLimiter({ windowMs, max, keyGenerator = keyByUserOrIp, message, skip = null, name }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skip: skip ?? ((req) => env.isTest && req.method === 'GET'),
    handler: (req, res) => {
      logger.warn('rate limit exceeded', { limiter: name, key: keyGenerator(req), path: req.originalUrl });
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: message ?? 'Too many requests - please slow down',
          details: { limiter: name, windowMs, max },
        },
      });
    },
  });
}

const apiLimiter = buildLimiter({
  name: 'api',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  message: 'API limit reached - try again shortly',
});

const authLimiter = buildLimiter({
  name: 'auth',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => `ip:${req.ip}`,
  message: 'Too many authentication attempts',
});

const aiLimiter = buildLimiter({
  name: 'ai',
  windowMs: 60 * 60 * 1000,
  max: env.AI_RATE_LIMIT_MAX,
  message: 'AI request limit reached for this hour',
});

/** Candidates autosave every 30s and submit once; both share this bucket. */
const submitLimiter = buildLimiter({
  name: 'exam-submit',
  windowMs: 60 * 1000,
  max: env.EXAM_SUBMIT_RATE_LIMIT_MAX,
  keyGenerator: keyByAttempt,
  message: 'Too many exam actions in the last minute',
});

const autosaveLimiter = buildLimiter({
  name: 'autosave',
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: keyByAttempt,
  message: 'Autosave requests are arriving faster than expected',
});

const uploadLimiter = buildLimiter({
  name: 'upload',
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Upload limit reached - try again later',
});

const proctorLimiter = buildLimiter({
  name: 'proctor-events',
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: keyByAttempt,
  message: 'Too many monitoring events',
});

const webhookLimiter = buildLimiter({
  name: 'webhook',
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => `ip:${req.ip}`,
  message: 'Webhook flood detected',
});

module.exports = {
  aiLimiter,
  apiLimiter,
  authLimiter,
  autosaveLimiter,
  buildLimiter,
  proctorLimiter,
  submitLimiter,
  uploadLimiter,
  webhookLimiter,
};
