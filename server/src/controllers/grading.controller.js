/**
 * Grading controller — manual grading queue, rubrics, AI-assisted scoring,
 * overrides, feedback and grade release.
 */

const grading = require('../services/grading.service');
const { asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Queues + assignment
// ---------------------------------------------------------------------------

/** GET /api/grading/queue */
const queue = asyncHandler(async (req, res) => {
  const result = await grading.gradingQueue(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return paged(res, result);
});

/** GET /api/grading/my-queue */
const myQueue = asyncHandler(async (req, res) => {
  const result = await grading.myGradingQueue(req.userId, listQuery(req));
  return paged(res, result);
});

/** GET /api/grading/assignments */
const listAssignments = asyncHandler(async (req, res) => {
  const result = await grading.listAssignments(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return paged(res, result);
});

/** POST /api/grading/exams/:examId/bulk-assign */
const bulkAssign = asyncHandler(async (req, res) => {
  const result = await grading.bulkAssign(req.params.examId, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Grading assigned');
});

/** DELETE /api/grading/assignments/:assignmentId */
const unassign = asyncHandler(async (req, res) => {
  const result = await grading.unassignGrader(req.params.assignmentId, actor(req));
  return sendSuccess(res, { data: result, message: 'Assignment removed' });
});

// ---------------------------------------------------------------------------
// Exam-scoped stats
// ---------------------------------------------------------------------------

/** GET /api/grading/exams/:examId/stats */
const stats = asyncHandler(async (req, res) => {
  const result = await grading.gradingStats(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/grading/exams/:examId/forecast */
const forecast = asyncHandler(async (req, res) => {
  const result = await grading.gradingForecast(req.params.examId);
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Submissions + scoring
// ---------------------------------------------------------------------------

/** GET /api/grading/answers/:answerId/submission */
const submission = asyncHandler(async (req, res) => {
  const result = await grading.submissionForGrading(req.params.answerId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/grading/attempts/:attemptId/submissions */
const attemptSubmissions = asyncHandler(async (req, res) => {
  const result = await grading.attemptSubmissions(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/grading/grade */
const grade = asyncHandler(async (req, res) => {
  const result = await grading.gradeSubmission(req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Submission graded' });
});

/** POST /api/grading/grade-many */
const gradeMany = asyncHandler(async (req, res) => {
  const result = await grading.gradeMany(req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Bulk grading applied' });
});

/** POST /api/grading/answers/:answerId/rubric-scores */
const rubricScores = asyncHandler(async (req, res) => {
  const result = await grading.saveRubricScores(req.params.answerId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Rubric scores saved' });
});

/** POST /api/grading/answers/:answerId/ai-essay */
const aiEssay = asyncHandler(async (req, res) => {
  const result = await grading.aiGradeEssay(req.params.answerId, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/grading/answers/:answerId/ai-code */
const aiCode = asyncHandler(async (req, res) => {
  const result = await grading.aiCodeReview(req.params.answerId, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

/** POST /api/grading/rubrics */
const createRubric = asyncHandler(async (req, res) => {
  const result = await grading.createRubric(req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Rubric created');
});

/** GET /api/grading/exams/:examId/rubrics */
const listRubrics = asyncHandler(async (req, res) => {
  const result = await grading.listRubrics(req.params.examId, actor(req));
  return sendSuccess(res, { data: result });
});

/** PATCH /api/grading/rubrics/:rubricId */
const updateRubric = asyncHandler(async (req, res) => {
  const result = await grading.updateRubric(req.params.rubricId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Rubric updated' });
});

/** DELETE /api/grading/rubrics/:rubricId */
const deleteRubric = asyncHandler(async (req, res) => {
  const result = await grading.deleteRubric(req.params.rubricId, actor(req));
  return sendSuccess(res, { data: result, message: 'Rubric deleted' });
});

// ---------------------------------------------------------------------------
// Overrides + history
// ---------------------------------------------------------------------------

/** POST /api/grading/attempts/:attemptId/override */
const override = asyncHandler(async (req, res) => {
  const result = await grading.overrideGrade({ attemptId: req.params.attemptId, ...(req.body ?? {}) }, actor(req));
  return sendSuccess(res, { data: result, message: 'Grade overridden' });
});

/** GET /api/grading/attempts/:attemptId/overrides */
const listOverrides = asyncHandler(async (req, res) => {
  const result = await grading.listOverrides(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/grading/attempts/:attemptId/history */
const history = asyncHandler(async (req, res) => {
  const result = await grading.gradingHistory(req.params.attemptId, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** POST /api/grading/attempts/:attemptId/finalise */
const finalise = asyncHandler(async (req, res) => {
  const result = await grading.finaliseGrading(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Grading finalised' });
});

/** POST /api/grading/attempts/:attemptId/feedback */
const addFeedback = asyncHandler(async (req, res) => {
  const result = await grading.addFeedback(req.params.attemptId, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Feedback added');
});

/** GET /api/grading/attempts/:attemptId/feedback */
const listFeedback = asyncHandler(async (req, res) => {
  const result = await grading.listFeedback(req.params.attemptId, { kind: req.query.kind ?? null }, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/grading/attempts/:attemptId/personalised-feedback */
const personalisedFeedback = asyncHandler(async (req, res) => {
  const result = await grading.generatePersonalisedFeedback(req.params.attemptId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Exam completion + release
// ---------------------------------------------------------------------------

/** POST /api/grading/exams/:examId/complete */
const complete = asyncHandler(async (req, res) => {
  const result = await grading.completeGradingForExam(req.params.examId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam grading completed' });
});

/** POST /api/grading/exams/:examId/regrade */
const regrade = asyncHandler(async (req, res) => {
  const result = await grading.regradeExam(req.params.examId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam regraded' });
});

/** POST /api/grading/exams/:examId/release */
const release = asyncHandler(async (req, res) => {
  const result = await grading.releaseGrades(req.params.examId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Grades released' });
});

/** POST /api/grading/exams/:examId/hold */
const hold = asyncHandler(async (req, res) => {
  const result = await grading.holdGrades(req.params.examId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Grades held' });
});

/** POST /api/grading/exams/:examId/schedule-release */
const scheduleRelease = asyncHandler(async (req, res) => {
  const result = await grading.scheduleGradeRelease(req.params.examId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Release scheduled' });
});

module.exports = {
  addFeedback,
  aiCode,
  aiEssay,
  attemptSubmissions,
  bulkAssign,
  complete,
  createRubric,
  deleteRubric,
  finalise,
  forecast,
  grade,
  gradeMany,
  history,
  hold,
  listAssignments,
  listFeedback,
  listOverrides,
  listRubrics,
  myQueue,
  override,
  personalisedFeedback,
  queue,
  regrade,
  release,
  rubricScores,
  scheduleRelease,
  stats,
  submission,
  unassign,
  updateRubric,
};
