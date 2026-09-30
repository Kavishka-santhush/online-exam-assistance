/**
 * Report controller — Puppeteer PDF / CSV document generation.
 *
 * These are "render a document and hand back the stored URL" endpoints. Access
 * control lives in the route (staff for exam-wide exports, session for personal
 * documents); the renderers themselves are pure presentation.
 */

const report = require('../services/report.service');
const { ApiError, asyncHandler, sendSuccess } = require('../utils/response.util');

/** POST /api/reports/certificate-pdf */
const certificatePdf = asyncHandler(async (req, res) => {
  const certificateId = req.body?.certificateId ?? req.params.certificateId;
  if (!certificateId) throw ApiError.badRequest('certificateId is required');
  const result = await report.renderCertificatePdf({ certificateId });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/invoice-pdf */
const invoicePdf = asyncHandler(async (req, res) => {
  const invoiceId = req.body?.invoiceId ?? req.params.invoiceId;
  if (!invoiceId) throw ApiError.badRequest('invoiceId is required');
  const result = await report.renderInvoicePdf({ invoiceId });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/result-pdf */
const resultPdf = asyncHandler(async (req, res) => {
  const attemptId = req.body?.attemptId ?? req.params.attemptId;
  if (!attemptId) throw ApiError.badRequest('attemptId is required');
  const result = await report.renderResultPdf({ attemptId });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/answer-sheet-pdf */
const answerSheetPdf = asyncHandler(async (req, res) => {
  const examId = req.body?.examId ?? req.params.examId;
  if (!examId) throw ApiError.badRequest('examId is required');
  const result = await report.renderAnswerSheetPdf({ examId });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/analytics-pdf */
const analyticsPdf = asyncHandler(async (req, res) => {
  const examId = req.body?.examId ?? req.params.examId;
  if (!examId) throw ApiError.badRequest('examId is required');
  const result = await report.renderAnalyticsPdf({ examId, statistics: req.body?.statistics ?? null });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/generic-pdf — render an arbitrary HTML document. */
const genericPdf = asyncHandler(async (req, res) => {
  if (!req.body?.html) throw ApiError.badRequest('html is required');
  const result = await report.renderGenericPdf({
    html: req.body.html,
    fileName: req.body?.fileName ?? 'document',
    format: req.body?.format ?? 'A4',
    landscape: req.body?.landscape === true,
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/results-csv */
const resultsCsv = asyncHandler(async (req, res) => {
  const examId = req.body?.examId ?? req.params.examId;
  if (!examId) throw ApiError.badRequest('examId is required');
  const result = await report.exportResultsCsv({ examId });
  return sendSuccess(res, { data: result });
});

/** POST /api/reports/analytics-csv */
const analyticsCsv = asyncHandler(async (req, res) => {
  const examId = req.body?.examId ?? req.params.examId;
  if (!examId) throw ApiError.badRequest('examId is required');
  const result = await report.exportAnalyticsCsv({ examId });
  return sendSuccess(res, { data: result });
});

module.exports = {
  analyticsCsv,
  analyticsPdf,
  answerSheetPdf,
  certificatePdf,
  genericPdf,
  invoicePdf,
  resultPdf,
  resultsCsv,
};
