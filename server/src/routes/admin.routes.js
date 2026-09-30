/**
 * Admin routes — mounted at `/api/admin`.
 *
 * Platform-wide management. Mutating endpoints require a platform SUPER_ADMIN;
 * read-only dashboards (audit log, users, organizations, subscriptions,
 * monitoring) also accept a platform ADMIN so support staff can investigate a
 * tenant. `admin.service` re-asserts the role on every call regardless.
 */

const express = require('express');
const controller = require('../controllers/admin.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requirePlatformRole, requireSuperAdmin } = require('../middleware/role.middleware');

const router = express.Router();

const superUser = [authenticate, requireSuperAdmin()];
const adminRead = [authenticate, requirePlatformRole('SUPER_ADMIN', 'ADMIN')];

// ---- overview + health ----
router.get('/overview', ...superUser, controller.overview);
router.get('/health', ...adminRead, controller.health);
router.get('/audit-logs', ...adminRead, controller.auditLogs);

// ---- organizations ----
router.get('/organizations', ...adminRead, controller.listOrganizations);
router.get('/organizations/:id', ...adminRead, controller.getOrganization);
router.post('/organizations/:id/approve', ...superUser, controller.approveOrganization);
router.post('/organizations/:id/suspend', ...superUser, controller.suspendOrganization);
router.post('/organizations/:id/reactivate', ...superUser, controller.reactivateOrganization);
router.delete('/organizations/:id', ...superUser, controller.deleteOrganization);

// ---- users ----
router.get('/users', ...adminRead, controller.listUsers);
router.get('/users/:userId', ...adminRead, controller.getUser);
router.patch('/users/:userId/role', ...superUser, controller.setUserRole);
router.post('/users/:userId/suspend', ...superUser, controller.suspendUser);
router.post('/users/:userId/reactivate', ...superUser, controller.reactivateUser);
router.delete('/users/:userId', ...superUser, controller.deleteUser);

// ---- catalog + subscriptions + revenue ----
router.get('/exams/catalog', ...adminRead, controller.publicExamCatalog);
router.get('/subscriptions', ...adminRead, controller.listSubscriptions);
router.patch('/plans/:planCode', ...superUser, controller.updatePlan);
router.get('/revenue', ...adminRead, controller.revenue);

// ---- monitoring ----
router.get('/ai-usage', ...adminRead, controller.aiUsage);
router.get('/proctoring-incidents', ...adminRead, controller.proctoringIncidents);
router.get('/certificates/pending', ...adminRead, controller.pendingCertificates);

// ---- announcements ----
router.get('/announcements', ...adminRead, controller.listAnnouncements);
router.post('/announcements', ...superUser, controller.createAnnouncement);
router.patch('/announcements/:id', ...superUser, controller.updateAnnouncement);
router.delete('/announcements/:id', ...superUser, controller.deleteAnnouncement);

// ---- settings + feature flags ----
router.get('/settings', ...superUser, controller.listSettings);
router.put('/settings/:key', ...superUser, controller.updateSetting);
router.get('/feature-flags', ...superUser, controller.listFeatureFlags);
router.patch('/feature-flags/:key', ...superUser, controller.setFeatureFlag);

module.exports = router;
