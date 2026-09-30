/**
 * Certificate routes — mounted at `/api/certificates`.
 *
 * Verification is public (an employer checking a credential has no session);
 * the candidate wallet needs a session; issuing, lifecycle and templates are
 * staff-only. Public + static paths are declared before the `/:id` wildcard.
 */

const express = require('express');
const controller = require('../controllers/certificate.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireStaff } = require('../middleware/role.middleware');

const router = express.Router();

const staff = [authenticate, resolveOrganization, requireStaff()];

// ---- public verification ----
router.get('/verify/:token', controller.verifyByToken);
router.post('/verify', controller.verifyByNumber);
router.post('/verify-signature', controller.verifySignature);
router.get('/badge/:certificateNo', controller.badge);

// ---- candidate wallet ----
router.get('/mine', authenticate, controller.mine);

// ---- templates (staff) ----
router.get('/templates', ...staff, controller.listTemplates);
router.post('/templates', ...staff, controller.createTemplate);
router.patch('/templates/:templateId', ...staff, controller.updateTemplate);
router.delete('/templates/:templateId', ...staff, controller.deleteTemplate);
router.post('/templates/:templateId/default', ...staff, controller.setDefaultTemplate);
router.post('/templates/:templateId/preview', ...staff, controller.previewTemplate);

// ---- stats (staff) ----
router.get('/stats/issuance', ...staff, controller.stats);
router.get('/stats/verification', ...staff, controller.verificationStats);

// ---- issuing (staff) ----
router.get('/', ...staff, controller.list);
router.post('/issue', ...staff, controller.issueForAttempt);
router.post('/exams/:examId/issue-bulk', ...staff, controller.issueBulk);
router.post('/exams/:examId/email-all', ...staff, controller.emailForExam);

// ---- single certificate ----
router.get('/:id', authenticate, controller.getOne);
router.get('/:id/download', authenticate, controller.download);
router.post('/:id/linkedin', authenticate, controller.linkedIn);
router.post('/:id/revoke', ...staff, controller.revoke);
router.post('/:id/restore', ...staff, controller.restore);
router.post('/:id/reissue', ...staff, controller.reissue);
router.post('/:id/email', ...staff, controller.email);

module.exports = router;
