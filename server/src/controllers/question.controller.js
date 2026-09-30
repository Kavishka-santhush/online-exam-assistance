/**
 * Question controller — CRUD, search, versioning and the review workflow.
 */

const question = require('../services/question.service');
const { asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** GET /api/questions */
const list = asyncHandler(async (req, res) => {
  const result = await question.listQuestions(listQuery(req, { organizationId: req.organizationId }));
  return paged(res, result);
});

/** GET /api/questions/search?q= */
const search = asyncHandler(async (req, res) => {
  const result = await question.searchQuestions({
    organizationId: req.organizationId,
    term: req.query.q ?? req.query.term,
    bankId: req.query.bankId ?? null,
    type: req.query.type ?? null,
    limit: Number(req.query.limit ?? 25),
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/questions/search-semantic — pg_trgm / AI natural-language search. */
const nlSearch = asyncHandler(async (req, res) => {
  const result = await question.nlSearch({
    organizationId: req.organizationId,
    questionText: req.body?.questionText ?? req.body?.term,
    filters: req.body?.filters ?? {},
    limit: req.body?.limit ?? 20,
  });
  return sendSuccess(res, { data: result });
});

/** GET /api/questions/facets */
const facets = asyncHandler(async (req, res) => {
  const result = await question.questionFacets(req.organizationId, req.query.bankId ?? null);
  return sendSuccess(res, { data: result });
});

/** GET /api/questions/review-queue */
const reviewQueue = asyncHandler(async (req, res) => {
  const result = await question.listReviewQueue(listQuery(req, { organizationId: req.organizationId }));
  return paged(res, result);
});

/** GET /api/questions/:id */
const getOne = asyncHandler(async (req, res) => {
  const result = await question.getQuestion(req.params.id, { actorOrganizationId: req.organizationId });
  return sendSuccess(res, { data: result });
});

/** POST /api/questions */
const create = asyncHandler(async (req, res) => {
  const result = await question.createQuestion({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Question created');
});

/** PATCH /api/questions/:id */
const update = asyncHandler(async (req, res) => {
  const result = await question.updateQuestion(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Question updated' });
});

/** POST /api/questions/:id/duplicate */
const duplicate = asyncHandler(async (req, res) => {
  const result = await question.duplicateQuestion(req.params.id, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Question duplicated');
});

/** POST /api/questions/:id/archive */
const archive = asyncHandler(async (req, res) => {
  const result = await question.archiveQuestion(req.params.id, { archive: req.body?.archive !== false }, actor(req));
  return sendSuccess(res, { data: result, message: 'Question archive state updated' });
});

/** DELETE /api/questions/:id */
const destroy = asyncHandler(async (req, res) => {
  const result = await question.deleteQuestion(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Question deleted' });
});

/** POST /api/questions/bulk — bulk edit / move / archive. */
const bulkUpdate = asyncHandler(async (req, res) => {
  const result = await question.bulkUpdate(req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Bulk update applied' });
});

/** POST /api/questions/move-to-bank */
const moveToBank = asyncHandler(async (req, res) => {
  const result = await question.moveToBank(req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Questions moved' });
});

/** POST /api/questions/:id/review — approve / reject / request changes. */
const review = asyncHandler(async (req, res) => {
  const result = await question.reviewQuestion({
    questionId: req.params.id,
    action: req.body?.action,
    comment: req.body?.comment ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Review recorded' });
});

/** GET /api/questions/:id/versions */
const listVersions = asyncHandler(async (req, res) => {
  const result = await question.listVersions(req.params.id);
  return sendSuccess(res, { data: result });
});

/** POST /api/questions/:id/versions/:version/restore */
const restoreVersion = asyncHandler(async (req, res) => {
  const result = await question.restoreVersion({ questionId: req.params.id, version: req.params.version }, actor(req));
  return sendSuccess(res, { data: result, message: 'Version restored' });
});

/** GET /api/questions/:id/related */
const related = asyncHandler(async (req, res) => {
  const result = await question.relatedQuestions(req.params.id, { limit: Number(req.query.limit ?? 8) });
  return sendSuccess(res, { data: result });
});

module.exports = {
  archive,
  bulkUpdate,
  create,
  destroy,
  duplicate,
  facets,
  getOne,
  list,
  listVersions,
  moveToBank,
  nlSearch,
  related,
  restoreVersion,
  review,
  reviewQueue,
  search,
  update,
};
