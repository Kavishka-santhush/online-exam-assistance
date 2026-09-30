/**
 * Question routes — mounted at `/api/questions`.
 *
 * The question bank is a staff-only surface; candidates never list or create
 * questions directly (they only see them through attempts). Static collection
 * paths precede `/:id`.
 */

const express = require('express');
const controller = require('../controllers/question.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor, requireStaff } = require('../middleware/role.middleware');

const router = express.Router();

const author = [authenticate, resolveOrganization, requireAuthor()];
const staff = [authenticate, resolveOrganization, requireStaff()];

router.get('/', ...staff, controller.list);
router.get('/search', ...staff, controller.search);
router.post('/search-semantic', ...staff, controller.nlSearch);
router.get('/facets', ...staff, controller.facets);
router.get('/review-queue', ...staff, controller.reviewQueue);

router.post('/', ...author, controller.create);
router.post('/bulk', ...author, controller.bulkUpdate);
router.post('/move-to-bank', ...author, controller.moveToBank);

router.get('/:id', ...staff, controller.getOne);
router.patch('/:id', ...author, controller.update);
router.delete('/:id', ...author, controller.destroy);
router.post('/:id/duplicate', ...author, controller.duplicate);
router.post('/:id/archive', ...author, controller.archive);
router.post('/:id/review', ...author, controller.review);
router.get('/:id/versions', ...staff, controller.listVersions);
router.post('/:id/versions/:version/restore', ...author, controller.restoreVersion);
router.get('/:id/related', ...staff, controller.related);

module.exports = router;
