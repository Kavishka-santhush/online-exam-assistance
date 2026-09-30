/**
 * Proctoring routes — mounted at `/api/proctoring`.
 *
 * Candidate-facing endpoints (setup, presence, recordings, replies) only need a
 * session; the service enforces attempt ownership. Proctor / staff endpoints
 * additionally resolve the working organization and require the `PROCTOR` or
 * `ORG_ADMIN` role. Static segments precede the `/attempts/:attemptId` group.
 */

const express = require('express');
const controller = require('../controllers/proctoring.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireProctor, requireStaff } = require('../middleware/role.middleware');
const { proctorLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const candidate = [authenticate];
const proctor = [authenticate, resolveOrganization, requireProctor()];
const staff = [authenticate, resolveOrganization, requireStaff()];

// ---- proctor dashboard / aggregate views ----
router.get('/sessions', ...proctor, controller.listSessions);
router.get('/stats', ...proctor, controller.stats);
router.get('/violations', ...staff, controller.listViolations);
router.get('/review-queue', ...proctor, controller.reviewQueue);
router.get('/review-summary', ...proctor, controller.reviewSummary);
router.get('/exams/:examId/dashboard', ...proctor, controller.dashboard);

// ---- session-level controls (approve / reject / review setup) ----
router.post('/sessions/:sessionId/approve', ...proctor, controller.approveSetup);
router.post('/sessions/:sessionId/reject', ...proctor, controller.rejectSetup);
router.post('/sessions/:sessionId/review', ...proctor, controller.reviewSession);

// ---- recording lifecycle ----
router.post('/recordings/:recordingId/finalise', ...candidate, controller.finaliseRecording);

// ---- attempt-scoped: candidate setup + monitoring ----
router.get('/attempts/:attemptId/setup-requirements', ...candidate, controller.setupRequirements);
router.post('/attempts/:attemptId/setup-complete', ...candidate, controller.completeSetup);
router.post('/attempts/:attemptId/setup-retry', ...candidate, controller.retrySetup);
router.post('/attempts/:attemptId/presence', proctorLimiter, ...candidate, controller.reportPresence);
router.get('/attempts/:attemptId/monitor-state', ...candidate, controller.monitorState);
router.post('/attempts/:attemptId/end-session', ...candidate, controller.endSession);
router.post('/attempts/:attemptId/recordings', ...candidate, controller.saveRecording);
router.get('/attempts/:attemptId/recordings', ...staff, controller.listRecordings);
router.get('/attempts/:attemptId/recording-gallery', ...staff, controller.recordingGallery);
router.get('/attempts/:attemptId/violations', ...staff, controller.violationTimeline);
router.get('/attempts/:attemptId/snapshot', ...staff, controller.snapshot);
router.get('/attempts/:attemptId/messages', ...candidate, controller.listMessages);
router.post('/attempts/:attemptId/messages/reply', ...candidate, controller.replyToProctor);

// ---- attempt-scoped: proctor controls ----
router.post('/attempts/:attemptId/messages', ...proctor, controller.sendProctorMessage);
router.post('/attempts/:attemptId/flag', ...proctor, controller.flagAttempt);
router.post('/attempts/:attemptId/risk', ...proctor, controller.riskAssessment);
router.post('/attempts/:attemptId/pause', ...proctor, controller.pauseExam);
router.post('/attempts/:attemptId/resume', ...proctor, controller.resumeExam);
router.post('/attempts/:attemptId/extra-time', ...proctor, controller.extraTime);
router.post('/attempts/:attemptId/terminate', ...proctor, controller.terminateExam);

module.exports = router;
