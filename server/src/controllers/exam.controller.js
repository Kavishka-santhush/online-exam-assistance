/**
 * Exam controller — builder, sections, question wiring, candidate roster and
 * publishing. Authorization is enforced by the route middleware (requireAuthor /
 * requireStaff); the service adds a second org-scoping guard internally.
 */

const exam = require('../services/exam.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** GET /api/exams — staff see their organization's exams. */
const list = asyncHandler(async (req, res) => {
  const result = await exam.listExams(listQuery(req, {
    organizationId: req.query.mine ? undefined : req.organizationId,
    createdById: req.query.owned === 'true' ? req.userId : undefined,
  }));
  return paged(res, result);
});

/** GET /api/exams/mine — exams assigned to / available for the candidate. */
const mine = asyncHandler(async (req, res) => {
  const result = await exam.myExams(req.userId, listQuery(req));
  return paged(res, result);
});

/** GET /api/exams/catalog — public catalog (guest browsable). */
const catalog = asyncHandler(async (req, res) => {
  const result = await exam.listCatalog(listQuery(req));
  return paged(res, result);
});

/** GET /api/exams/author-overview — counts for the instructor home widget. */
const authorOverview = asyncHandler(async (req, res) => {
  const result = await exam.authorOverview(req.organizationId, req.userId);
  return sendSuccess(res, { data: result });
});

/** GET /api/exams/invite?token= — resolve an exam from an invite link. */
const findByToken = asyncHandler(async (req, res) => {
  const token = req.query.token ?? req.query.inviteToken ?? req.params.token;
  if (!token) throw ApiError.badRequest('A token is required');
  const result = await exam.findByToken({
    inviteToken: req.query.accessCode ? null : String(token),
    accessCode: req.query.accessCode ? String(token) : null,
  });
  if (!result) throw ApiError.notFound('No exam matches that link');
  return sendSuccess(res, { data: exam.stripAnswerKeys ? exam.stripAnswerKeys(result) : result });
});

/** POST /api/exams */
const create = asyncHandler(async (req, res) => {
  const result = await exam.createExam({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Exam created');
});

/** GET /api/exams/:id */
const getOne = asyncHandler(async (req, res) => {
  const result = await exam.getExam(req.params.id, { actor: actor(req), includeAnswers: req.query.answers === 'true' });
  return sendSuccess(res, { data: result });
});

/** PATCH /api/exams/:id */
const update = asyncHandler(async (req, res) => {
  const result = await exam.updateExam(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam updated' });
});

/** DELETE /api/exams/:id */
const destroy = asyncHandler(async (req, res) => {
  const result = await exam.deleteExam(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam deleted' });
});

/** POST /api/exams/:id/publish */
const publish = asyncHandler(async (req, res) => {
  const result = await exam.publishExam(req.params.id, {
    notify: req.body?.notify !== false,
    publishedAtMessage: req.body?.message ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Exam published' });
});

/** POST /api/exams/:id/clone */
const clone = asyncHandler(async (req, res) => {
  const result = await exam.cloneExam(req.params.id, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Exam duplicated');
});

/** GET /api/exams/:id/versions */
const listVersions = asyncHandler(async (req, res) => {
  const result = await exam.listVersions(req.params.id);
  return sendSuccess(res, { data: result });
});

/** POST /api/exams/:id/versions/:version/restore */
const restoreVersion = asyncHandler(async (req, res) => {
  const result = await exam.restoreVersion({ examId: req.params.id, version: req.params.version }, actor(req));
  return sendSuccess(res, { data: result, message: 'Version restored' });
});

/** POST /api/exams/:id/questions */
const addQuestions = asyncHandler(async (req, res) => {
  const result = await exam.addQuestions(req.params.id, req.body ?? {}, actor(req));
  await exam.recomputeTotals(req.params.id);
  return sendCreated(res, result, 'Questions added');
});

/** DELETE /api/exams/:id/questions */
const removeQuestion = asyncHandler(async (req, res) => {
  const result = await exam.removeQuestion(req.params.id, req.body ?? {}, actor(req));
  await exam.recomputeTotals(req.params.id);
  return sendSuccess(res, { data: result, message: 'Question removed' });
});

/** POST /api/exams/:id/questions/reorder */
const reorderQuestions = asyncHandler(async (req, res) => {
  const result = await exam.reorderQuestions(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Questions reordered' });
});

/** POST /api/exams/:id/sections */
const createSections = asyncHandler(async (req, res) => {
  const sections = Array.isArray(req.body?.sections) ? req.body.sections : (Array.isArray(req.body) ? req.body : [req.body]);
  const result = await exam.createSections(req.params.id, sections, actor(req));
  return sendCreated(res, result, 'Sections created');
});

/** POST /api/exams/:id/sections/reorder */
const reorderSections = asyncHandler(async (req, res) => {
  const result = await exam.reorderSections(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Sections reordered' });
});

/** PATCH /api/exams/sections/:sectionId */
const updateSection = asyncHandler(async (req, res) => {
  const result = await exam.updateSection(req.params.sectionId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Section updated' });
});

/** DELETE /api/exams/sections/:sectionId */
const deleteSection = asyncHandler(async (req, res) => {
  const result = await exam.deleteSection(req.params.sectionId, actor(req));
  return sendSuccess(res, { data: result, message: 'Section deleted' });
});

/** PUT /api/exams/sections/:sectionId/questions */
const setSectionQuestions = asyncHandler(async (req, res) => {
  const result = await exam.setSectionQuestions(req.params.sectionId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Section questions set' });
});

/** POST /api/exams/sections/:sectionId/pool */
const setSectionPool = asyncHandler(async (req, res) => {
  const result = await exam.setSectionPool(req.params.sectionId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Random pool configured' });
});

/** GET /api/exams/:id/candidates */
const listCandidates = asyncHandler(async (req, res) => {
  const result = await exam.listCandidates(listQuery(req, { examId: req.params.id }));
  return paged(res, result);
});

/** POST /api/exams/:id/candidates */
const assignCandidates = asyncHandler(async (req, res) => {
  const result = await exam.assignCandidates(req.params.id, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Candidates assigned');
});

/** DELETE /api/exams/:id/candidates */
const removeCandidate = asyncHandler(async (req, res) => {
  const result = await exam.removeCandidate(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Candidate removed' });
});

/** GET /api/exams/:id/dashboard */
const dashboard = asyncHandler(async (req, res) => {
  const result = await exam.examDashboard(req.params.id, { actor: actor(req) });
  return sendSuccess(res, { data: result });
});

/** POST /api/exams/:id/tokens/regenerate */
const regenerateTokens = asyncHandler(async (req, res) => {
  const result = await exam.regenerateAccessTokens(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Access tokens regenerated' });
});

/** GET /api/exams/:id/eligibility — can the current user take this exam? */
const eligibility = asyncHandler(async (req, res) => {
  const result = await exam.evaluateEligibility(req.params.id, req.userId);
  return sendSuccess(res, { data: result });
});

/** POST /api/exams/:id/recompute — recalculate section/total marks. */
const recompute = asyncHandler(async (req, res) => {
  const result = await exam.recomputeTotals(req.params.id);
  return sendSuccess(res, { data: result, message: 'Totals recomputed' });
});

module.exports = {
  addQuestions,
  assignCandidates,
  authorOverview,
  catalog,
  clone,
  create,
  createSections,
  dashboard,
  deleteSection,
  destroy,
  eligibility,
  findByToken,
  getOne,
  list,
  listCandidates,
  listVersions,
  mine,
  publish,
  recompute,
  regenerateTokens,
  removeCandidate,
  removeQuestion,
  reorderQuestions,
  reorderSections,
  restoreVersion,
  setSectionQuestions,
  setSectionPool,
  update,
  updateSection,
};
