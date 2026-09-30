/**
 * Exam routes — mounted at `/api/exams`.
 *
 * Static collection paths are declared before the `/:id` parameter so they are
 * not shadowed. Authoring endpoints resolve the working organization first
 * (`resolveOrganization`) then require the `INSTRUCTOR`/`ORG_ADMIN` role;
 * candidate-facing endpoints only require a session.
 */

const express = require('express');
const prisma = require('../config/prisma');
const controller = require('../controllers/exam.controller');
const { authenticate, optionalAuthenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor, requirePlan, requireStaff } = require('../middleware/role.middleware');
const { apiLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const author = [authenticate, resolveOrganization, requireAuthor()];
const staff = [authenticate, resolveOrganization, requireStaff()];

/** Count the organization's exams for the `maxExams` plan cap. */
const countExams = async (req) => prisma.exam.count({
  where: { organizationId: req.organizationId, status: { not: 'ARCHIVED' } },
});

router.use(apiLimiter);

// ---- public / candidate ----
router.get('/catalog', optionalAuthenticate, controller.catalog);
router.get('/invite', optionalAuthenticate, controller.findByToken);
router.get('/mine', authenticate, controller.mine);

// ---- authoring overview ----
router.get('/author-overview', ...staff, controller.authorOverview);

// ---- create (plan-gated) ----
router.post('/', ...author, requirePlan({ limit: 'maxExams', currentCount: countExams }), controller.create);

// ---- single exam ----
router.get('/:id', authenticate, controller.getOne);
router.patch('/:id', ...author, controller.update);
router.delete('/:id', ...author, controller.destroy);
router.post('/:id/publish', ...author, controller.publish);
router.post('/:id/clone', ...author, controller.clone);
router.post('/:id/recompute', ...author, controller.recompute);

router.get('/:id/versions', ...staff, controller.listVersions);
router.post('/:id/versions/:version/restore', ...author, controller.restoreVersion);

// ---- questions on the exam ----
router.post('/:id/questions', ...author, controller.addQuestions);
router.delete('/:id/questions', ...author, controller.removeQuestion);
router.post('/:id/questions/reorder', ...author, controller.reorderQuestions);

// ---- sections (exam-scoped) ----
router.post('/:id/sections', ...author, controller.createSections);
router.post('/:id/sections/reorder', ...author, controller.reorderSections);

// ---- candidate roster ----
router.get('/:id/candidates', ...staff, controller.listCandidates);
router.post('/:id/candidates', ...author, controller.assignCandidates);
router.delete('/:id/candidates', ...author, controller.removeCandidate);

// ---- dashboards / access ----
router.get('/:id/dashboard', ...staff, controller.dashboard);
router.post('/:id/tokens/regenerate', ...author, controller.regenerateTokens);
router.get('/:id/eligibility', authenticate, controller.eligibility);

// ---- section-scoped (nested, keeps the service's own org guard) ----
router.patch('/sections/:sectionId', ...author, controller.updateSection);
router.delete('/sections/:sectionId', ...author, controller.deleteSection);
router.put('/sections/:sectionId/questions', ...author, controller.setSectionQuestions);
router.post('/sections/:sectionId/pool', ...author, controller.setSectionPool);

module.exports = router;
