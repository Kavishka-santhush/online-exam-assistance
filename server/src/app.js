/**
 * Express application assembly.
 *
 * Order matters:
 *   1. security + transport middleware (helmet, cors, compression, morgan)
 *   2. Clerk's JWT verification, globally, so every `authenticate` can read it
 *   3. body parsing — deliberately skipped for `/webhook` paths so the Clerk and
 *      Stripe routers can attach their own `express.raw` parser and see the
 *      untouched bytes required for signature verification
 *   4. static uploads (local Multer storage — no cloud)
 *   5. the resource routers under `/api/*`
 *   6. 404 + the central error handler last
 *
 * `index.js` boots this app behind an HTTP server and attaches Socket.io.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const { clerkMiddleware } = require('@clerk/express');

const env = require('./config/env');
const logger = require('./utils/logger.util');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');

// ---- routers ---------------------------------------------------------------
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const examRoutes = require('./routes/exam.routes');
const questionRoutes = require('./routes/question.routes');
const questionBankRoutes = require('./routes/questionBank.routes');
const attemptRoutes = require('./routes/attempt.routes');
const proctoringRoutes = require('./routes/proctoring.routes');
const gradingRoutes = require('./routes/grading.routes');
const certificateRoutes = require('./routes/certificate.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const notificationRoutes = require('./routes/notification.routes');
const paymentRoutes = require('./routes/payment.routes');
const aiRoutes = require('./routes/ai.routes');
const reportRoutes = require('./routes/report.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

// Respect the reverse-proxy IP so rate limiting and audit logs record the real
// client address rather than the load balancer.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- security + transport --------------------------------------------------
app.use(
  helmet({
    // PDFs / CSVs are served from /uploads with inline disposition; a strict CSP
    // on the API host would not help, and cross-origin isolation can break the
    // WebRTC proctoring handshake.
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / curl (no Origin header) and any configured origin.
      if (!origin || env.corsOrigins.includes(origin) || env.corsOrigins.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-Requested-With', 'stripe-signature'],
    exposedHeaders: ['X-User-Id'],
  }),
);

app.use(compression());

if (!env.isTest) {
  app.use(
    morgan(env.isProduction ? 'combined' : 'dev', {
      stream: logger.stream,
      skip: (req) => req.path === '/health',
    }),
  );
}

// ---- Clerk authentication (verifies the JWT into req.auth) -----------------
app.use(clerkMiddleware());

// ---- body parsing (raw-passthrough for webhooks) ---------------------------
const jsonParser = express.json({ limit: '5mb' });
const urlencodedParser = express.urlencoded({ extended: true, limit: '5mb' });

function parseBody(req, res, next) {
  // Stripe / Clerk webhooks need the exact request body to verify signatures;
  // those routers install their own express.raw parser.
  if (req.originalUrl.includes('/webhook')) return next();
  return jsonParser(req, res, (jsonError) => {
    if (jsonError) return next(jsonError);
    return urlencodedParser(req, res, next);
  });
}

app.use(parseBody);

// ---- static uploads --------------------------------------------------------
app.use(
  '/uploads',
  express.static(env.uploadRoot, {
    index: false,
    maxAge: env.isProduction ? '1h' : 0,
    setHeaders(res) {
      // Uploaded content is untrusted: never let the browser sniff it into HTML.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; object-src 'none'");
    },
  }),
);

// ---- health ----------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok', service: 'exam-platform-api', time: new Date().toISOString() } });
});

app.get('/api', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      name: 'Online Exam & Assessment Platform API',
      version: '1.0.0',
      docs: '/api/health',
      resources: [
        'auth', 'organizations', 'exams', 'questions', 'question-banks', 'attempts',
        'proctoring', 'grading', 'certificates', 'analytics', 'notifications',
        'payments', 'ai', 'reports', 'admin',
      ],
    },
  });
});

// ---- resource routers ------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/question-banks', questionBankRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/proctoring', proctoringRoutes);
app.use('/api/grading', gradingRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);

// ---- fallbacks -------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
