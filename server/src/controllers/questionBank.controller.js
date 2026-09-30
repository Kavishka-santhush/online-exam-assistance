/**
 * Question bank controller — collections, categories, sharing, import/export.
 */

const bank = require('../services/questionBank.service');
const { asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** GET /api/question-banks */
const list = asyncHandler(async (req, res) => {
  const result = await bank.listBanks(listQuery(req, { organizationId: req.organizationId }));
  return paged(res, result);
});

/** GET /api/question-banks/accessible — owned + shared + org banks. */
const accessible = asyncHandler(async (req, res) => {
  const result = await bank.listAccessibleBanks({ userId: req.userId, organizationId: req.organizationId });
  return sendSuccess(res, { data: result });
});

/** POST /api/question-banks */
const create = asyncHandler(async (req, res) => {
  const result = await bank.createBank({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Question bank created');
});

/** GET /api/question-banks/:id */
const getOne = asyncHandler(async (req, res) => {
  const result = await bank.getBank(req.params.id, { actor: actor(req) });
  return sendSuccess(res, { data: result });
});

/** PATCH /api/question-banks/:id */
const update = asyncHandler(async (req, res) => {
  const result = await bank.updateBank(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Question bank updated' });
});

/** DELETE /api/question-banks/:id */
const destroy = asyncHandler(async (req, res) => {
  const result = await bank.deleteBank(req.params.id, { archiveOnly: req.query.purge !== 'true' }, actor(req));
  return sendSuccess(res, { data: result, message: 'Question bank removed' });
});

/** POST /api/question-banks/:id/recount */
const recount = asyncHandler(async (req, res) => {
  const result = await bank.recountBank(req.params.id);
  return sendSuccess(res, { data: result, message: 'Question count refreshed' });
});

/** GET /api/question-banks/:id/insights */
const insights = asyncHandler(async (req, res) => {
  const result = await bank.bankInsights(req.params.id, { actor: actor(req) });
  return sendSuccess(res, { data: result });
});

/** GET /api/question-banks/:id/duplicates */
const duplicates = asyncHandler(async (req, res) => {
  const result = await bank.findDuplicates(req.params.id, { threshold: Number(req.query.threshold ?? 0.85) });
  return sendSuccess(res, { data: result });
});

/** POST /api/question-banks/:id/share */
const share = asyncHandler(async (req, res) => {
  const result = await bank.shareBank({
    bankId: req.params.id,
    userIds: req.body?.userIds ?? [],
    access: req.body?.access ?? 'VIEW',
  }, actor(req));
  return sendCreated(res, result, 'Bank shared');
});

/** DELETE /api/question-banks/:id/share?userId= */
const revokeShare = asyncHandler(async (req, res) => {
  const result = await bank.revokeShare({ bankId: req.params.id, userId: req.query.userId ?? req.body?.userId });
  return sendSuccess(res, { data: result, message: 'Share revoked' });
});

/** GET /api/question-banks/categories/list */
const listCategories = asyncHandler(async (req, res) => {
  const result = await bank.listCategories(req.organizationId, {
    parentId: req.query.parentId ?? null,
    includeCounts: req.query.counts === 'true',
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/question-banks/categories */
const createCategory = asyncHandler(async (req, res) => {
  const result = await bank.createCategory({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Category created');
});

/** PATCH /api/question-banks/categories/:categoryId */
const updateCategory = asyncHandler(async (req, res) => {
  const result = await bank.updateCategory(req.params.categoryId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Category updated' });
});

/** DELETE /api/question-banks/categories/:categoryId */
const deleteCategory = asyncHandler(async (req, res) => {
  const result = await bank.deleteCategory(req.params.categoryId, actor(req));
  return sendSuccess(res, { data: result, message: 'Category deleted' });
});

/**
 * POST /api/question-banks/:id/import — multipart CSV/XLSX.
 * `dryRun` (default true via query) validates without persisting.
 */
const importQuestions = asyncHandler(async (req, res) => {
  const result = await bank.parseImportFile({
    filePath: req.file?.path ?? null,
    originalName: req.file?.originalname ?? null,
    bankId: req.params.id,
    actor: actor(req),
    dryRun: req.query.dryRun !== 'false',
  });
  return sendSuccess(res, { data: result, message: req.query.dryRun === 'false' ? 'Import complete' : 'Import validated' });
});

/** GET /api/question-banks/export */
const exportQuestions = asyncHandler(async (req, res) => {
  const result = await bank.exportQuestions({
    bankId: req.query.bankId ?? null,
    organizationId: req.organizationId,
    format: req.query.format ?? 'csv',
    type: req.query.type ?? null,
    difficulty: req.query.difficulty ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result });
});

module.exports = {
  accessible,
  create,
  createCategory,
  deleteCategory,
  destroy,
  duplicates,
  exportQuestions,
  getOne,
  importQuestions,
  insights,
  list,
  listCategories,
  recount,
  revokeShare,
  share,
  update,
  updateCategory,
};
