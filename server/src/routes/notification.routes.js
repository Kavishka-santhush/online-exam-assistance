/**
 * Notification routes — mounted at `/api/notifications`.
 *
 * The inbox and preferences are per-user (a session is all that is required).
 * Announcements and exam broadcasts are staff-only. Static paths precede the
 * `/:id` inbox-item wildcard.
 */

const express = require('express');
const controller = require('../controllers/notification.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireStaff } = require('../middleware/role.middleware');

const router = express.Router();

const staff = [authenticate, resolveOrganization, requireStaff()];

router.use(authenticate);

router.get('/', controller.list);
router.get('/stats', controller.stats);
router.post('/read-all', controller.markAllRead);
router.delete('/clear-read', controller.clearRead);
router.get('/preferences', controller.getPreferences);
router.put('/preferences', controller.updatePreferences);

router.get('/announcements', controller.listAnnouncements);
router.post('/announcements', ...staff, controller.createAnnouncement);
router.post('/announcements/:id/dismiss', controller.dismissAnnouncement);
router.post('/broadcast/exams/:examId', ...staff, controller.broadcastToExam);

router.post('/:id/read', controller.markRead);
router.post('/:id/archive', controller.archive);

module.exports = router;
