/**
 * Proctoring controller — candidate setup/monitoring, proctor dashboard,
 * violation log, chat, recordings and remote session controls.
 */

const proctoring = require('../services/proctoring.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Candidate setup + monitoring
// ---------------------------------------------------------------------------

/** GET /api/proctoring/attempts/:attemptId/setup-requirements */
const setupRequirements = asyncHandler(async (req, res) => {
  const result = await proctoring.setupRequirements(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/proctoring/attempts/:attemptId/setup-complete */
const completeSetup = asyncHandler(async (req, res) => {
  const result = await proctoring.completeProctorSetup(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Setup submitted for review' });
});

/** POST /api/proctoring/attempts/:attemptId/setup-retry */
const retrySetup = asyncHandler(async (req, res) => {
  const result = await proctoring.retryProctorSetup(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/proctoring/attempts/:attemptId/presence */
const reportPresence = asyncHandler(async (req, res) => {
  const result = await proctoring.reportPresence(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/attempts/:attemptId/monitor-state */
const monitorState = asyncHandler(async (req, res) => {
  const result = await proctoring.candidateMonitorState(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/proctoring/attempts/:attemptId/end-session */
const endSession = asyncHandler(async (req, res) => {
  const result = await proctoring.endProctorSession(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Proctoring session ended' });
});

/** GET /api/proctoring/attempts/:attemptId/messages */
const listMessages = asyncHandler(async (req, res) => {
  const result = await proctoring.listProctorMessages(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/proctoring/attempts/:attemptId/messages/reply — candidate reply. */
const replyToProctor = asyncHandler(async (req, res) => {
  const result = await proctoring.replyToProctor(req.params.attemptId, { body: req.body?.body }, actor(req));
  return sendCreated(res, result);
});

/** POST /api/proctoring/attempts/:attemptId/recordings — register a clip. */
const saveRecording = asyncHandler(async (req, res) => {
  const result = await proctoring.saveRecording(req.params.attemptId, req.body ?? {}, actor(req));
  return sendCreated(res, result);
});

// ---------------------------------------------------------------------------
// Proctor / staff views
// ---------------------------------------------------------------------------

/** GET /api/proctoring/sessions */
const listSessions = asyncHandler(async (req, res) => {
  const result = await proctoring.listLiveSessions(listQuery(req, { organizationId: req.organizationId }));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/exams/:examId/dashboard */
const dashboard = asyncHandler(async (req, res) => {
  const result = await proctoring.proctorDashboard(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/stats */
const stats = asyncHandler(async (req, res) => {
  const result = await proctoring.proctoringStats(listQuery(req, { organizationId: req.organizationId }));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/violations */
const listViolations = asyncHandler(async (req, res) => {
  const result = await proctoring.listViolations(listQuery(req, { organizationId: req.organizationId }));
  return paged(res, result);
});

/** GET /api/proctoring/attempts/:attemptId/violations */
const violationTimeline = asyncHandler(async (req, res) => {
  const result = await proctoring.violationTimeline(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/attempts/:attemptId/snapshot */
const snapshot = asyncHandler(async (req, res) => {
  const result = await proctoring.proctoringSnapshot(req.params.attemptId);
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/attempts/:attemptId/recordings */
const listRecordings = asyncHandler(async (req, res) => {
  const result = await proctoring.listRecordings(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/attempts/:attemptId/recording-gallery */
const recordingGallery = asyncHandler(async (req, res) => {
  const result = await proctoring.recordingGallery(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/review-queue */
const reviewQueue = asyncHandler(async (req, res) => {
  const result = await proctoring.reviewQueue(listQuery(req, { organizationId: req.organizationId }));
  return sendSuccess(res, { data: result });
});

/** GET /api/proctoring/review-summary */
const reviewSummary = asyncHandler(async (req, res) => {
  const result = await proctoring.reviewSummary(listQuery(req, { organizationId: req.organizationId }));
  return sendSuccess(res, { data: result });
});

/** POST /api/proctoring/attempts/:attemptId/risk — AI cheating risk score. */
const riskAssessment = asyncHandler(async (req, res) => {
  const result = await proctoring.aiRiskAssessment(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Proctor controls
// ---------------------------------------------------------------------------

/** POST /api/proctoring/attempts/:attemptId/messages — proctor → candidate. */
const sendProctorMessage = asyncHandler(async (req, res) => {
  const result = await proctoring.sendProctorMessage(req.params.attemptId, req.body ?? {}, actor(req));
  return sendCreated(res, result);
});

/** POST /api/proctoring/attempts/:attemptId/flag */
const flagAttempt = asyncHandler(async (req, res) => {
  const result = await proctoring.flagAttempt(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Attempt flagged' });
});

/** POST /api/proctoring/attempts/:attemptId/pause */
const pauseExam = asyncHandler(async (req, res) => {
  const result = await proctoring.pauseCandidateExam(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam paused' });
});

/** POST /api/proctoring/attempts/:attemptId/resume */
const resumeExam = asyncHandler(async (req, res) => {
  const result = await proctoring.resumeCandidateExam(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam resumed' });
});

/** POST /api/proctoring/attempts/:attemptId/extra-time */
const extraTime = asyncHandler(async (req, res) => {
  const result = await proctoring.grantExtraTime(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Extra time granted' });
});

/** POST /api/proctoring/attempts/:attemptId/terminate */
const terminateExam = asyncHandler(async (req, res) => {
  const result = await proctoring.terminateCandidateExam(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam terminated' });
});

/** POST /api/proctoring/sessions/:sessionId/approve */
const approveSetup = asyncHandler(async (req, res) => {
  const result = await proctoring.approveProctorSetup(req.params.sessionId, {
    note: req.body?.note ?? null,
    faceMatchScore: req.body?.faceMatchScore ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Setup approved' });
});

/** POST /api/proctoring/sessions/:sessionId/reject */
const rejectSetup = asyncHandler(async (req, res) => {
  const result = await proctoring.rejectProctorSetup(req.params.sessionId, {
    reason: req.body?.reason ?? 'Identity verification failed',
    reviewNote: req.body?.reviewNote ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Setup rejected' });
});

/** POST /api/proctoring/sessions/:sessionId/review — post-exam review decision. */
const reviewSession = asyncHandler(async (req, res) => {
  const result = await proctoring.reviewProctorSession(req.params.sessionId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Session reviewed' });
});

/** POST /api/proctoring/recordings/:recordingId/finalise */
const finaliseRecording = asyncHandler(async (req, res) => {
  if (!req.params.recordingId) throw ApiError.badRequest('recordingId is required');
  const result = await proctoring.finaliseRecording(req.params.recordingId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Recording finalised' });
});

module.exports = {
  approveSetup,
  completeSetup,
  dashboard,
  endSession,
  extraTime,
  finaliseRecording,
  flagAttempt,
  listMessages,
  listRecordings,
  listSessions,
  listViolations,
  monitorState,
  pauseExam,
  recordingGallery,
  rejectSetup,
  replyToProctor,
  reportPresence,
  reviewQueue,
  reviewSession,
  reviewSummary,
  riskAssessment,
  saveRecording,
  sendProctorMessage,
  setupRequirements,
  snapshot,
  stats,
  terminateExam,
  retrySetup,
  resumeExam,
  violationTimeline,
};
