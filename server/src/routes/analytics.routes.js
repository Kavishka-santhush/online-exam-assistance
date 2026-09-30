/**
 * Analytics routes — mounted at `/api/analytics`.
 *
 * Instructor analytics are staff-only (the service re-checks exam access for
 * the resolved organization). AI-driven analytics hit OpenRouter and are rate
 * limited. Candidates can read only their own history without any role gate.
 */

const express = require('express');
const controller = require('../controllers/analytics.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireStaff } = require('../middleware/role.middleware');
const { aiLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const staff = [authenticate, resolveOrganization, requireStaff()];

// ---- candidate self-service ----
router.get('/me/history', authenticate, controller.myHistory);

// ---- organization roll-up ----
router.get('/organization', ...staff, controller.organizationAnalytics);
router.get('/candidates/:userId/history', ...staff, controller.candidateHistory);

// ---- exam-scoped analytics ----
router.get('/exams/:examId/overview', ...staff, controller.overview);
router.get('/exams/:examId/score-distribution', ...staff, controller.scoreDistribution);
router.get('/exams/:examId/time', ...staff, controller.timeAnalysis);
router.get('/exams/:examId/questions', ...staff, controller.questionAnalytics);
router.get('/exams/:examId/topics', ...staff, controller.topicPerformance);
router.get('/exams/:examId/candidates', ...staff, controller.candidateComparison);
router.get('/exams/:examId/violations', ...staff, controller.violationAnalytics);
router.get('/exams/:examId/trend', ...staff, controller.attemptTrend);
router.get('/exams/:examId/survey', ...staff, controller.surveyResults);
router.get('/exams/:examId/export/analytics', ...staff, controller.exportAnalytics);
router.get('/exams/:examId/export/results', ...staff, controller.exportResults);

// ---- AI analytics ----
router.post('/exams/:examId/ai/quality', aiLimiter, ...staff, controller.aiQuality);
router.post('/exams/:examId/ai/pass-rate', aiLimiter, ...staff, controller.aiPassRate);
router.post('/exams/:examId/ai/summary', aiLimiter, ...staff, controller.aiSummary);

module.exports = router;
