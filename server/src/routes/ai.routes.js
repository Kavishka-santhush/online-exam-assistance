/**
 * AI routes — mounted at `/api/ai`.
 *
 * Every feature calls OpenRouter and is therefore rate limited and restricted
 * to authors (instructors / org admins). The service additionally enforces the
 * organization's daily AI request budget from its subscription plan.
 */

const express = require('express');
const controller = require('../controllers/ai.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor, requireStaff } = require('../middleware/role.middleware');
const { aiLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const author = [authenticate, resolveOrganization, requireAuthor()];
const staff = [authenticate, resolveOrganization, requireStaff()];

router.get('/status', authenticate, controller.status);
router.get('/usage', ...staff, controller.usage);
router.get('/usage/daily', ...staff, controller.dailyUsage);

router.post('/generate-questions', aiLimiter, ...author, controller.generateQuestions);
router.post('/grade-essay', aiLimiter, ...author, controller.gradeEssay);
router.post('/review-code', aiLimiter, ...author, controller.reviewCode);
router.post('/cheating-risk', aiLimiter, ...author, controller.cheatingRisk);
router.post('/calibrate-difficulty', aiLimiter, ...author, controller.calibrateDifficulty);
router.post('/check-quality', aiLimiter, ...author, controller.checkQuality);
router.post('/adaptive-select', aiLimiter, ...author, controller.adaptiveSelect);
router.post('/personalized-feedback', aiLimiter, ...author, controller.personalizedFeedback);
router.post('/retake-recommendation', aiLimiter, ...author, controller.retakeRecommendation);
router.post('/blueprint', aiLimiter, ...author, controller.blueprint);
router.post('/validate-answer-key', aiLimiter, ...author, controller.validateAnswerKey);
router.post('/recommend-questions', aiLimiter, ...author, controller.recommendQuestions);
router.post('/nl-search', aiLimiter, ...author, controller.nlSearch);
router.post('/predict-pass-rate', aiLimiter, ...author, controller.predictPassRate);
router.post('/summary-report', aiLimiter, ...author, controller.summaryReport);
router.post('/proctor-assistant', aiLimiter, ...author, controller.proctorAssistant);
router.post('/face-match', aiLimiter, ...author, controller.faceMatch);

module.exports = router;
