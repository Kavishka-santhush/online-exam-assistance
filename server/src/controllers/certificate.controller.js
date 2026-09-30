/**
 * Certificate controller — the candidate wallet, public verification, issuing,
 * lifecycle (revoke / restore / reissue), email delivery and templates.
 */

const certificate = require('../services/certificate.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Candidate wallet
// ---------------------------------------------------------------------------

/** GET /api/certificates/mine */
const mine = asyncHandler(async (req, res) => {
  const result = await certificate.myCertificates(listQuery(req, { userId: req.userId }));
  return paged(res, result);
});

/** GET /api/certificates/:id */
const getOne = asyncHandler(async (req, res) => {
  const result = await certificate.getCertificate(req.params.id, actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/certificates/:id/download — resolve the PDF location. */
const download = asyncHandler(async (req, res) => {
  const result = await certificate.downloadCertificate(req.params.id, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/certificates/:id/linkedin — pre-filled share payload. */
const linkedIn = asyncHandler(async (req, res) => {
  const result = await certificate.linkedInShare(req.params.id, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Public verification (no auth)
// ---------------------------------------------------------------------------

/** GET /api/certificates/verify/:token */
const verifyByToken = asyncHandler(async (req, res) => {
  const result = await certificate.verifyByToken(req.params.token);
  return sendSuccess(res, { data: result });
});

/** POST /api/certificates/verify — by certificate number (+ optional surname). */
const verifyByNumber = asyncHandler(async (req, res) => {
  const result = await certificate.verifyByNumber({
    certificateNo: req.body?.certificateNo ?? req.query.certificateNo,
    lastName: req.body?.lastName ?? req.query.lastName ?? null,
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/certificates/verify-signature — offline authenticity check. */
const verifySignature = asyncHandler(async (req, res) => {
  const result = await certificate.verifySignature(req.body ?? {});
  return sendSuccess(res, { data: result });
});

/** GET /api/certificates/badge/:certificateNo — JSON-LD open badge assertion. */
const badge = asyncHandler(async (req, res) => {
  const result = await certificate.badgeAssertion(req.params.certificateNo);
  if (!result) throw ApiError.notFound('No badge for that certificate number');
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Issuing + lifecycle (staff)
// ---------------------------------------------------------------------------

/** GET /api/certificates */
const list = asyncHandler(async (req, res) => {
  const result = await certificate.listCertificates(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return paged(res, result);
});

/** POST /api/certificates/issue — issue for a single attempt. */
const issueForAttempt = asyncHandler(async (req, res) => {
  const result = await certificate.issueForAttempt({
    attemptId: req.body?.attemptId,
    templateId: req.body?.templateId ?? null,
    issuedById: req.userId,
    generatePdf: req.body?.generatePdf !== false,
    force: req.body?.force === true,
    notify: req.body?.notify !== false,
  });
  return sendCreated(res, result, 'Certificate issued');
});

/** POST /api/certificates/exams/:examId/issue-bulk */
const issueBulk = asyncHandler(async (req, res) => {
  const result = await certificate.issueBulk(req.params.examId, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Bulk issuance complete');
});

/** POST /api/certificates/:id/revoke */
const revoke = asyncHandler(async (req, res) => {
  const result = await certificate.revokeCertificate(req.params.id, { reason: req.body?.reason ?? null }, actor(req));
  return sendSuccess(res, { data: result, message: 'Certificate revoked' });
});

/** POST /api/certificates/:id/restore */
const restore = asyncHandler(async (req, res) => {
  const result = await certificate.restoreCertificate(req.params.id, { reason: req.body?.reason ?? null }, actor(req));
  return sendSuccess(res, { data: result, message: 'Certificate restored' });
});

/** POST /api/certificates/:id/reissue */
const reissue = asyncHandler(async (req, res) => {
  const result = await certificate.reissueCertificate(req.params.id, req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Certificate reissued');
});

/** POST /api/certificates/:id/email */
const email = asyncHandler(async (req, res) => {
  const result = await certificate.emailCertificate(req.params.id, actor(req), {
    to: req.body?.to ?? null,
    force: req.body?.force === true,
    message: req.body?.message ?? null,
  });
  return sendSuccess(res, { data: result, message: 'Certificate emailed' });
});

/** POST /api/certificates/exams/:examId/email-all */
const emailForExam = asyncHandler(async (req, res) => {
  const result = await certificate.emailCertificatesForExam(req.params.examId, actor(req), req.body ?? {});
  return sendSuccess(res, { data: result, message: 'Certificates queued for delivery' });
});

/** GET /api/certificates/stats/issuance */
const stats = asyncHandler(async (req, res) => {
  const result = await certificate.certificateStats(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/certificates/stats/verification */
const verificationStats = asyncHandler(async (req, res) => {
  const result = await certificate.verificationStats(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Templates (staff)
// ---------------------------------------------------------------------------

/** GET /api/certificates/templates */
const listTemplates = asyncHandler(async (req, res) => {
  const result = await certificate.listTemplates({
    examId: req.query.examId ?? null,
    organizationId: req.organizationId,
    includeShared: req.query.shared === 'true',
  }, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/certificates/templates */
const createTemplate = asyncHandler(async (req, res) => {
  const result = await certificate.createTemplate({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Template created');
});

/** PATCH /api/certificates/templates/:templateId */
const updateTemplate = asyncHandler(async (req, res) => {
  const result = await certificate.updateTemplate(req.params.templateId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Template updated' });
});

/** DELETE /api/certificates/templates/:templateId */
const deleteTemplate = asyncHandler(async (req, res) => {
  const result = await certificate.deleteTemplate(req.params.templateId, actor(req));
  return sendSuccess(res, { data: result, message: 'Template deleted' });
});

/** POST /api/certificates/templates/:templateId/default */
const setDefaultTemplate = asyncHandler(async (req, res) => {
  const result = await certificate.setDefaultTemplate(req.params.templateId, actor(req));
  return sendSuccess(res, { data: result, message: 'Default template set' });
});

/** POST /api/certificates/templates/:templateId/preview */
const previewTemplate = asyncHandler(async (req, res) => {
  const result = await certificate.templatePreview(req.params.templateId, req.body ?? {});
  return sendSuccess(res, { data: result });
});

module.exports = {
  badge,
  createTemplate,
  deleteTemplate,
  download,
  email,
  emailForExam,
  getOne,
  issueBulk,
  issueForAttempt,
  linkedIn,
  list,
  listTemplates,
  mine,
  previewTemplate,
  reissue,
  restore,
  revoke,
  setDefaultTemplate,
  stats,
  updateTemplate,
  verificationStats,
  verifyByNumber,
  verifyByToken,
  verifySignature,
};
