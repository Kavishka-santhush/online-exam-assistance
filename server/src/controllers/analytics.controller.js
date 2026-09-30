/**
 * Analytics controller — instructor dashboards, per-question / topic statistics,
 * candidate trends and the AI analysis helpers.
 */

const analytics = require('../services/analytics.service');
const { asyncHandler, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Exam-scoped
// ---------------------------------------------------------------------------

/** GET /api/analytics/exams/:examId/overview */
const overview = asyncHandler(async (req, res) => {
  const result = await analytics.examOverview(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/score-distribution */
const scoreDistribution = asyncHandler(async (req, res) => {
  const result = await analytics.scoreDistribution(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/time */
const timeAnalysis = asyncHandler(async (req, res) => {
  const result = await analytics.timeAnalysis(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/questions */
const questionAnalytics = asyncHandler(async (req, res) => {
  const result = await analytics.questionAnalytics(req.params.examId, listQuery(req), actor(req));
  return paged(res, result);
});

/** GET /api/analytics/exams/:examId/topics */
const topicPerformance = asyncHandler(async (req, res) => {
  const result = await analytics.topicPerformance(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/candidates */
const candidateComparison = asyncHandler(async (req, res) => {
  const result = await analytics.candidateComparison(req.params.examId, listQuery(req), actor(req));
  return paged(res, result);
});

/** GET /api/analytics/exams/:examId/violations */
const violationAnalytics = asyncHandler(async (req, res) => {
  const result = await analytics.violationAnalytics(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/trend */
const attemptTrend = asyncHandler(async (req, res) => {
  const result = await analytics.attemptTrend(req.params.examId, { granularity: req.query.granularity ?? 'day' }, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/survey */
const surveyResults = asyncHandler(async (req, res) => {
  const result = await analytics.surveyResults(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/export/analytics?format=pdf|csv */
const exportAnalytics = asyncHandler(async (req, res) => {
  const result = await analytics.exportExamAnalytics(req.params.examId, { format: req.query.format ?? 'pdf' }, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/exams/:examId/export/results */
const exportResults = asyncHandler(async (req, res) => {
  const result = await analytics.exportExamResults(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// AI-scoped
// ---------------------------------------------------------------------------

/** POST /api/analytics/exams/:examId/ai/quality */
const aiQuality = asyncHandler(async (req, res) => {
  const result = await analytics.aiQualityAnalysis(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/analytics/exams/:examId/ai/pass-rate */
const aiPassRate = asyncHandler(async (req, res) => {
  const result = await analytics.aiPassRatePrediction(req.params.examId, { cohort: req.body?.cohort }, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/analytics/exams/:examId/ai/summary */
const aiSummary = asyncHandler(async (req, res) => {
  const result = await analytics.generateExamSummaryReport(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Candidate + organization
// ---------------------------------------------------------------------------

/** GET /api/analytics/me/history */
const myHistory = asyncHandler(async (req, res) => {
  const result = await analytics.candidateHistory(req.userId, listQuery(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/candidates/:userId/history */
const candidateHistory = asyncHandler(async (req, res) => {
  const result = await analytics.candidateHistory(req.params.userId, listQuery(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/analytics/organization */
const organizationAnalytics = asyncHandler(async (req, res) => {
  const result = await analytics.organizationAnalytics(req.organizationId, actor(req));
  return sendSuccess(res, { data: result });
});

module.exports = {
  aiPassRate,
  aiQuality,
  aiSummary,
  attemptTrend,
  candidateComparison,
  candidateHistory,
  exportAnalytics,
  exportResults,
  myHistory,
  organizationAnalytics,
  overview,
  questionAnalytics,
  scoreDistribution,
  surveyResults,
  timeAnalysis,
  topicPerformance,
  violationAnalytics,
};
