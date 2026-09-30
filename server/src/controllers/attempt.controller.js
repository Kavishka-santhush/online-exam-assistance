/**
 * Attempt controller — the candidate exam-taking runtime, results/review and the
 * Kahoot-style live quiz host/participant flows.
 */

const attempt = require('../services/attempt.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Registration + start
// ---------------------------------------------------------------------------

/** POST /api/attempts/exams/:examId/register */
const register = asyncHandler(async (req, res) => {
  const result = await attempt.registerForExam(req.params.examId, {
    accessCode: req.body?.accessCode ?? null,
    inviteToken: req.body?.inviteToken ?? null,
  }, actor(req));
  return sendCreated(res, result, 'Registered for exam');
});

/** POST /api/attempts/exams/:examId/start */
const start = asyncHandler(async (req, res) => {
  const result = await attempt.startAttempt(req.params.examId, {
    accessCode: req.body?.accessCode ?? null,
    inviteToken: req.body?.inviteToken ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    deviceInfo: req.body?.deviceInfo ?? {},
  }, actor(req));
  return sendCreated(res, result, 'Attempt started');
});

/** POST /api/attempts/:attemptId/clock/start — begin the countdown (after proctoring setup). */
const beginClock = asyncHandler(async (req, res) => {
  const result = await attempt.beginClock(req.params.attemptId, { extraSec: Number(req.body?.extraSec ?? 0) });
  return sendSuccess(res, { data: result });
});

/** GET /api/attempts/:attemptId/runtime — full snapshot the player hydrates from. */
const runtime = asyncHandler(async (req, res) => {
  const result = await attempt.getRuntimeState(req.params.attemptId, { actor: actor(req) });
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Answering / autosave / navigation
// ---------------------------------------------------------------------------

/** POST /api/attempts/:attemptId/answers */
const saveAnswer = asyncHandler(async (req, res) => {
  const result = await attempt.saveAnswer(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/autosave */
const autosave = asyncHandler(async (req, res) => {
  const result = await attempt.autosave(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/sync — replay an offline operation queue. */
const sync = asyncHandler(async (req, res) => {
  const result = await attempt.syncOfflineQueue(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/navigate */
const navigate = asyncHandler(async (req, res) => {
  const result = await attempt.navigate(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/mark-review */
const toggleMarkForReview = asyncHandler(async (req, res) => {
  const result = await attempt.toggleMarkForReview(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/hints */
const revealHint = asyncHandler(async (req, res) => {
  const result = await attempt.revealHint(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/run-tests — Monaco sample-test runner. */
const runTests = asyncHandler(async (req, res) => {
  const result = await attempt.runSampleTests(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/pause */
const pause = asyncHandler(async (req, res) => {
  const result = await attempt.pauseAttempt(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Attempt paused' });
});

/** POST /api/attempts/:attemptId/resume */
const resume = asyncHandler(async (req, res) => {
  const result = await attempt.resumeAttempt(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result, message: 'Attempt resumed' });
});

/** POST /api/attempts/:attemptId/submit */
const submit = asyncHandler(async (req, res) => {
  const result = await attempt.submitAttempt(req.params.attemptId, {
    answers: req.body?.answers ?? [],
    ip: req.ip,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Attempt submitted' });
});

// ---------------------------------------------------------------------------
// Results / review / listing
// ---------------------------------------------------------------------------

/** GET /api/attempts/mine */
const mine = asyncHandler(async (req, res) => {
  const result = await attempt.listMyAttempts(req.userId, listQuery(req));
  return paged(res, result);
});

/** GET /api/attempts?examId= — staff roster of attempts. */
const list = asyncHandler(async (req, res) => {
  const result = await attempt.listAttempts(listQuery(req, {
    examId: req.query.examId ?? null,
    organizationId: req.organizationId,
  }), actor(req));
  return paged(res, result);
});

/** GET /api/attempts/:attemptId */
const detail = asyncHandler(async (req, res) => {
  const result = await attempt.getAttemptDetail(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/attempts/:attemptId/results */
const results = asyncHandler(async (req, res) => {
  const result = await attempt.candidateResults(req.params.attemptId, { actor: actor(req) });
  return sendSuccess(res, { data: result });
});

/** GET /api/attempts/:attemptId/review — question-by-question (if enabled). */
const review = asyncHandler(async (req, res) => {
  const result = await attempt.questionReview(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/:attemptId/share */
const share = asyncHandler(async (req, res) => {
  const result = await attempt.shareResult(req.params.attemptId, { enable: req.body?.enable !== false }, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/attempts/shared/:token — public shared score card. */
const shared = asyncHandler(async (req, res) => {
  const result = await attempt.getSharedResult(req.params.token);
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Live quiz (Kahoot-style)
// ---------------------------------------------------------------------------

/** POST /api/attempts/live/exams/:examId/sessions — host opens a session. */
const createLiveQuiz = asyncHandler(async (req, res) => {
  const result = await attempt.createLiveQuiz(req.params.examId, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Live quiz session started');
});

/** GET /api/attempts/live/join/:code — session preview for the join screen. */
const liveSession = asyncHandler(async (req, res) => {
  const result = await attempt.getLiveSession({ code: req.params.code });
  if (!result) throw ApiError.notFound('No live session with that code');
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/live/join/:code */
const joinLive = asyncHandler(async (req, res) => {
  const result = await attempt.joinLiveQuiz(req.params.code, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Joined live quiz');
});

/** POST /api/attempts/live/leave/:code */
const leaveLive = asyncHandler(async (req, res) => {
  const result = await attempt.leaveLiveQuiz(req.params.code, actor(req));
  return sendSuccess(res, { data: result, message: 'Left live quiz' });
});

/** POST /api/attempts/live/sessions/:sessionId/advance */
const advanceLive = asyncHandler(async (req, res) => {
  const result = await attempt.advanceLiveQuiz(req.params.sessionId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/live/sessions/:sessionId/close-question */
const closeLiveQuestion = asyncHandler(async (req, res) => {
  const result = await attempt.closeLiveQuestion(req.params.sessionId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/attempts/live/sessions/:sessionId/end */
const endLive = asyncHandler(async (req, res) => {
  const result = await attempt.endLiveQuiz(req.params.sessionId, actor(req));
  return sendSuccess(res, { data: result, message: 'Live quiz ended' });
});

/** POST /api/attempts/live/sessions/:sessionId/answer */
const submitLiveAnswer = asyncHandler(async (req, res) => {
  const result = await attempt.submitLiveAnswer(req.params.sessionId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/attempts/live/sessions/:sessionId/leaderboard */
const liveLeaderboard = asyncHandler(async (req, res) => {
  const result = await attempt.liveLeaderboard(req.params.sessionId);
  return sendSuccess(res, { data: result });
});

module.exports = {
  advanceLive,
  autosave,
  beginClock,
  closeLiveQuestion,
  createLiveQuiz,
  detail,
  endLive,
  joinLive,
  leaveLive,
  list,
  liveLeaderboard,
  liveSession,
  mine,
  navigate,
  pause,
  register,
  results,
  resume,
  review,
  revealHint,
  runTests,
  runtime,
  saveAnswer,
  share,
  shared,
  start,
  submit,
  submitLiveAnswer,
  sync,
  toggleMarkForReview,
};
