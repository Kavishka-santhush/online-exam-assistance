/**
 * AI controller — thin proxies over the OpenRouter features in ai.service.
 *
 * Every feature takes a single options object; the controller merges the
 * caller's organization / user scope into the request body and returns the
 * model output. Plan limits + usage accounting are enforced inside the service.
 */

const ai = require('../services/ai.service');
const { asyncHandler, sendSuccess } = require('../utils/response.util');
const { listQuery } = require('./controller.util');

/** Build a handler that forwards the scoped body to one AI feature function. */
function feature(fn) {
  return asyncHandler(async (req, res) => {
    const result = await fn({
      ...(req.body ?? {}),
      organizationId: req.body?.organizationId ?? req.organizationId,
      userId: req.userId,
    });
    return sendSuccess(res, { data: result });
  });
}

/** GET /api/ai/status */
const status = asyncHandler(async (req, res) => {
  return sendSuccess(res, { data: { configured: ai.isConfigured(), models: ai.FEATURE_MODELS } });
});

const generateQuestions = feature(ai.generateQuestions);
const gradeEssay = feature(ai.gradeEssay);
const reviewCode = feature(ai.reviewCode);
const cheatingRisk = feature(ai.cheatingRiskAnalysis);
const calibrateDifficulty = feature(ai.calibrateDifficulty);
const checkQuality = feature(ai.checkQuestionQuality);
const adaptiveSelect = feature(ai.selectAdaptiveQuestion);
const personalizedFeedback = feature(ai.personalizedFeedback);
const retakeRecommendation = feature(ai.retakeRecommendation);
const blueprint = feature(ai.generateBlueprint);
const validateAnswerKey = feature(ai.validateAnswerKey);
const recommendQuestions = feature(ai.recommendBankQuestions);
const nlSearch = feature(ai.naturalLanguageSearch);
const predictPassRate = feature(ai.predictPassRate);
const summaryReport = feature(ai.generateSummaryReport);
const proctorAssistant = feature(ai.proctorAssistantAnalysis);
const faceMatch = feature(ai.faceMatchScore);

/** GET /api/ai/usage — cost + call rollup. */
const usage = asyncHandler(async (req, res) => {
  const result = await ai.usageSummary(listQuery(req, { organizationId: req.organizationId }));
  return sendSuccess(res, { data: result });
});

/** GET /api/ai/usage/daily — per-day counters for the current period. */
const dailyUsage = asyncHandler(async (req, res) => {
  const result = await ai.aiDailyUsage(req.organizationId);
  return sendSuccess(res, { data: result });
});

module.exports = {
  adaptiveSelect,
  blueprint,
  calibrateDifficulty,
  checkQuality,
  cheatingRisk,
  dailyUsage,
  faceMatch,
  generateQuestions,
  gradeEssay,
  nlSearch,
  personalizedFeedback,
  predictPassRate,
  proctorAssistant,
  recommendQuestions,
  retakeRecommendation,
  reviewCode,
  status,
  summaryReport,
  usage,
  validateAnswerKey,
};
