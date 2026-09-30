/**
 * Attempt routes — mounted at `/api/attempts`.
 *
 * The runtime group (answers, autosave, navigation, submit) sits behind
 * `loadActiveAttempt`, which resolves `:attemptId`, checks the caller owns the
 * attempt (or is staff) and rejects it unless the attempt is still live.
 * Static paths (`/mine`, `/shared/:token`, `/live`, `/exams/:examId`) are
 * declared before the `/:attemptId` wildcard.
 */

const express = require('express');
const controller = require('../controllers/attempt.controller');
const { authenticate, loadActiveAttempt, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor, requireStaff } = require('../middleware/role.middleware');
const { autosaveLimiter, proctorLimiter, submitLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const live = [authenticate, loadActiveAttempt];
const author = [authenticate, resolveOrganization, requireAuthor()];

// ---- registration / start (exam-scoped) ----
router.post('/exams/:examId/register', authenticate, controller.register);
router.post('/exams/:examId/start', authenticate, submitLimiter, controller.start);

// ---- public shared result ----
router.get('/shared/:token', controller.shared);

// ---- listing ----
router.get('/mine', authenticate, controller.mine);
router.get('/', authenticate, resolveOrganization, requireStaff(), controller.list);

// ---- live quiz ----
router.post('/live/exams/:examId/sessions', ...author, controller.createLiveQuiz);
router.get('/live/join/:code', authenticate, controller.liveSession);
router.post('/live/join/:code', authenticate, controller.joinLive);
router.post('/live/leave/:code', authenticate, controller.leaveLive);
router.post('/live/sessions/:sessionId/advance', authenticate, controller.advanceLive);
router.post('/live/sessions/:sessionId/close-question', authenticate, controller.closeLiveQuestion);
router.post('/live/sessions/:sessionId/end', authenticate, controller.endLive);
router.post('/live/sessions/:sessionId/answer', authenticate, proctorLimiter, controller.submitLiveAnswer);
router.get('/live/sessions/:sessionId/leaderboard', controller.liveLeaderboard);

// ---- attempt-scoped detail / results (may be a finished attempt) ----
router.get('/:attemptId', authenticate, controller.detail);
router.get('/:attemptId/results', authenticate, controller.results);
router.get('/:attemptId/review', authenticate, controller.review);
router.post('/:attemptId/share', authenticate, controller.share);

// ---- attempt-scoped runtime (must be live) ----
router.post('/:attemptId/clock/start', ...live, controller.beginClock);
router.get('/:attemptId/runtime', ...live, controller.runtime);
router.post('/:attemptId/answers', ...live, proctorLimiter, controller.saveAnswer);
router.post('/:attemptId/autosave', ...live, autosaveLimiter, controller.autosave);
router.post('/:attemptId/sync', ...live, autosaveLimiter, controller.sync);
router.post('/:attemptId/navigate', ...live, controller.navigate);
router.post('/:attemptId/mark-review', ...live, controller.toggleMarkForReview);
router.post('/:attemptId/hints', ...live, controller.revealHint);
router.post('/:attemptId/run-tests', ...live, submitLimiter, controller.runTests);
router.post('/:attemptId/pause', ...live, controller.pause);
router.post('/:attemptId/resume', ...live, controller.resume);
router.post('/:attemptId/submit', ...live, submitLimiter, controller.submit);

module.exports = router;
