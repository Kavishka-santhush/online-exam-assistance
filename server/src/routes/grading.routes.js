/**
 * Grading routes — mounted at `/api/grading`.
 *
 * Grading is a staff-only surface (`INSTRUCTOR` / `ORG_ADMIN`); the working
 * organization is resolved first so `assertCanGrade` inside the service can
 * scope every exam, attempt and answer. AI-assisted endpoints are rate limited.
 */

const express = require('express');
const controller = require('../controllers/grading.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor } = require('../middleware/role.middleware');
const { aiLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const grader = [authenticate, resolveOrganization, requireAuthor()];

// ---- queues + assignment ----
router.get('/queue', ...grader, controller.queue);
router.get('/my-queue', ...grader, controller.myQueue);
router.get('/assignments', ...grader, controller.listAssignments);
router.delete('/assignments/:assignmentId', ...grader, controller.unassign);

// ---- scoring ----
router.post('/grade', ...grader, controller.grade);
router.post('/grade-many', ...grader, controller.gradeMany);

// ---- rubrics ----
router.post('/rubrics', ...grader, controller.createRubric);
router.patch('/rubrics/:rubricId', ...grader, controller.updateRubric);
router.delete('/rubrics/:rubricId', ...grader, controller.deleteRubric);

// ---- answer-scoped ----
router.get('/answers/:answerId/submission', ...grader, controller.submission);
router.post('/answers/:answerId/rubric-scores', ...grader, controller.rubricScores);
router.post('/answers/:answerId/ai-essay', aiLimiter, ...grader, controller.aiEssay);
router.post('/answers/:answerId/ai-code', aiLimiter, ...grader, controller.aiCode);

// ---- attempt-scoped ----
router.get('/attempts/:attemptId/submissions', ...grader, controller.attemptSubmissions);
router.post('/attempts/:attemptId/finalise', ...grader, controller.finalise);
router.post('/attempts/:attemptId/override', ...grader, controller.override);
router.get('/attempts/:attemptId/overrides', ...grader, controller.listOverrides);
router.get('/attempts/:attemptId/history', ...grader, controller.history);
router.post('/attempts/:attemptId/feedback', ...grader, controller.addFeedback);
router.get('/attempts/:attemptId/feedback', ...grader, controller.listFeedback);
router.post('/attempts/:attemptId/personalised-feedback', aiLimiter, ...grader, controller.personalisedFeedback);

// ---- exam-scoped ----
router.get('/exams/:examId/stats', ...grader, controller.stats);
router.get('/exams/:examId/forecast', ...grader, controller.forecast);
router.get('/exams/:examId/rubrics', ...grader, controller.listRubrics);
router.post('/exams/:examId/bulk-assign', ...grader, controller.bulkAssign);
router.post('/exams/:examId/complete', ...grader, controller.complete);
router.post('/exams/:examId/regrade', ...grader, controller.regrade);
router.post('/exams/:examId/release', ...grader, controller.release);
router.post('/exams/:examId/hold', ...grader, controller.hold);
router.post('/exams/:examId/schedule-release', ...grader, controller.scheduleRelease);

module.exports = router;
