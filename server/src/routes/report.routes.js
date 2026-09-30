/**
 * Report routes — mounted at `/api/reports`.
 *
 * Personal documents (certificate / invoice / result PDFs) require only a
 * session; exam-wide exports (answer sheet, analytics, results CSV) and the
 * generic renderer are staff-only because they expose other candidates' data.
 */

const express = require('express');
const controller = require('../controllers/report.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireStaff } = require('../middleware/role.middleware');

const router = express.Router();

const staff = [authenticate, resolveOrganization, requireStaff()];

// ---- personal documents ----
router.post('/certificate-pdf', authenticate, controller.certificatePdf);
router.post('/invoice-pdf', authenticate, controller.invoicePdf);
router.post('/result-pdf', authenticate, controller.resultPdf);

// ---- exam-wide exports (staff) ----
router.post('/answer-sheet-pdf', ...staff, controller.answerSheetPdf);
router.post('/analytics-pdf', ...staff, controller.analyticsPdf);
router.post('/results-csv', ...staff, controller.resultsCsv);
router.post('/analytics-csv', ...staff, controller.analyticsCsv);
router.post('/generic-pdf', ...staff, controller.genericPdf);

module.exports = router;
