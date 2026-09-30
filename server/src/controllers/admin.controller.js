/**
 * Admin controller — platform-wide super-admin / org-admin management surface.
 *
 * Thin HTTP adapters over `admin.service`. The service re-checks the caller's
 * platform role (assertSuperAdmin / assertAdmin) on every call, so the route
 * guard is defence-in-depth rather than the only gate. Mutating handlers pass
 * the authenticated `actor`; the service writes the AuditLog row itself.
 */

const admin = require('../services/admin.service');
const { asyncHandler, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

// ---------------------------------------------------------------------------
// Overview + health
// ---------------------------------------------------------------------------

/** GET /api/admin/overview */
const overview = asyncHandler(async (req, res) => {
  const result = await admin.platformOverview(actor(req));
  return sendSuccess(res, { data: result });
});

/** GET /api/admin/health */
const health = asyncHandler(async (req, res) => {
  const result = await admin.systemHealth(actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** GET /api/admin/audit-logs */
const auditLogs = asyncHandler(async (req, res) => {
  const result = await admin.listAuditLogs(listQuery(req), actor(req));
  return paged(res, result);
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/** GET /api/admin/organizations */
const listOrganizations = asyncHandler(async (req, res) => {
  const result = await admin.listOrganizations(listQuery(req), actor(req));
  return paged(res, result);
});

/** GET /api/admin/organizations/:id */
const getOrganization = asyncHandler(async (req, res) => {
  const result = await admin.getOrganization(req.params.id, actor(req));
  return sendSuccess(res, { data: result });
});

/** POST /api/admin/organizations/:id/approve */
const approveOrganization = asyncHandler(async (req, res) => {
  const result = await admin.approveOrganization(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization approved' });
});

/** POST /api/admin/organizations/:id/suspend */
const suspendOrganization = asyncHandler(async (req, res) => {
  const result = await admin.suspendOrganization(req.params.id, { reason: req.body?.reason ?? null }, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization suspended' });
});

/** POST /api/admin/organizations/:id/reactivate */
const reactivateOrganization = asyncHandler(async (req, res) => {
  const result = await admin.reactivateOrganization(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization reactivated' });
});

/** DELETE /api/admin/organizations/:id */
const deleteOrganization = asyncHandler(async (req, res) => {
  const result = await admin.deleteOrganization(req.params.id, { confirmSlug: req.body?.confirmSlug }, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization deleted' });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** GET /api/admin/users */
const listUsers = asyncHandler(async (req, res) => {
  const result = await admin.listUsers(listQuery(req), actor(req));
  return paged(res, result);
});

/** GET /api/admin/users/:userId */
const getUser = asyncHandler(async (req, res) => {
  const result = await admin.getUser(req.params.userId, actor(req));
  return sendSuccess(res, { data: result });
});

/** PATCH /api/admin/users/:userId/role */
const setUserRole = asyncHandler(async (req, res) => {
  const result = await admin.setUserRole(req.params.userId, { platformRole: req.body?.platformRole }, actor(req));
  return sendSuccess(res, { data: result, message: 'Platform role updated' });
});

/** POST /api/admin/users/:userId/suspend */
const suspendUser = asyncHandler(async (req, res) => {
  const result = await admin.suspendUser(req.params.userId, { reason: req.body?.reason ?? null }, actor(req));
  return sendSuccess(res, { data: result, message: 'User suspended' });
});

/** POST /api/admin/users/:userId/reactivate */
const reactivateUser = asyncHandler(async (req, res) => {
  const result = await admin.reactivateUser(req.params.userId, actor(req));
  return sendSuccess(res, { data: result, message: 'User reactivated' });
});

/** DELETE /api/admin/users/:userId */
const deleteUser = asyncHandler(async (req, res) => {
  const result = await admin.deleteUser(req.params.userId, actor(req));
  return sendSuccess(res, { data: result, message: 'User deleted' });
});

// ---------------------------------------------------------------------------
// Catalog + subscriptions + revenue
// ---------------------------------------------------------------------------

/** GET /api/admin/exams/catalog */
const publicExamCatalog = asyncHandler(async (req, res) => {
  const result = await admin.listPublicExamCatalog(listQuery(req), actor(req));
  return paged(res, result);
});

/** GET /api/admin/subscriptions */
const listSubscriptions = asyncHandler(async (req, res) => {
  const result = await admin.listAllSubscriptions(listQuery(req), actor(req));
  return paged(res, result);
});

/** PATCH /api/admin/plans/:planCode */
const updatePlan = asyncHandler(async (req, res) => {
  const result = await admin.updatePlan(req.params.planCode, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Plan updated' });
});

/** GET /api/admin/revenue */
const revenue = asyncHandler(async (req, res) => {
  const result = await admin.platformRevenueSummary({ from: req.query.from, to: req.query.to }, actor(req));
  return sendSuccess(res, { data: result });
});

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

/** GET /api/admin/ai-usage */
const aiUsage = asyncHandler(async (req, res) => {
  const result = await admin.aiUsageMonitor(
    { organizationId: req.query.organizationId, feature: req.query.feature, days: Number(req.query.days) || 30 },
    actor(req),
  );
  return sendSuccess(res, { data: result });
});

/** GET /api/admin/proctoring-incidents */
const proctoringIncidents = asyncHandler(async (req, res) => {
  const result = await admin.proctoringIncidents(
    { days: Number(req.query.days) || 30, organizationId: req.query.organizationId, severity: req.query.severity, page: Number(req.query.page) || 1, limit: Number(req.query.limit) || 30 },
    actor(req),
  );
  return paged(res, result);
});

/** GET /api/admin/certificates/pending */
const pendingCertificates = asyncHandler(async (req, res) => {
  const result = await admin.pendingCertificateVerifications({ page: Number(req.query.page) || 1, limit: Number(req.query.limit) || 30 }, actor(req));
  return paged(res, result);
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/** POST /api/admin/announcements */
const createAnnouncement = asyncHandler(async (req, res) => {
  const result = await admin.createAnnouncement(req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, status: 201, message: 'Announcement published' });
});

/** GET /api/admin/announcements */
const listAnnouncements = asyncHandler(async (req, res) => {
  const result = await admin.listAnnouncements(listQuery(req), actor(req));
  return paged(res, result);
});

/** PATCH /api/admin/announcements/:id */
const updateAnnouncement = asyncHandler(async (req, res) => {
  const result = await admin.updateAnnouncement(req.params.id, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Announcement updated' });
});

/** DELETE /api/admin/announcements/:id */
const deleteAnnouncement = asyncHandler(async (req, res) => {
  const result = await admin.deleteAnnouncement(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Announcement deleted' });
});

// ---------------------------------------------------------------------------
// Settings + feature flags
// ---------------------------------------------------------------------------

/** GET /api/admin/settings */
const listSettings = asyncHandler(async (req, res) => {
  const result = await admin.listSettings(req.query.group, actor(req));
  return sendSuccess(res, { data: result });
});

/** PUT /api/admin/settings/:key */
const updateSetting = asyncHandler(async (req, res) => {
  const result = await admin.updateSetting(
    req.params.key,
    req.body?.value,
    { groupName: req.body?.groupName ?? 'general', description: req.body?.description ?? null },
    actor(req),
  );
  return sendSuccess(res, { data: result, message: 'Setting updated' });
});

/** GET /api/admin/feature-flags */
const listFeatureFlags = asyncHandler(async (req, res) => {
  const result = await admin.listFeatureFlags(actor(req));
  return sendSuccess(res, { data: result });
});

/** PATCH /api/admin/feature-flags/:key */
const setFeatureFlag = asyncHandler(async (req, res) => {
  const result = await admin.setFeatureFlag(req.params.key, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Feature flag updated' });
});

module.exports = {
  aiUsage,
  approveOrganization,
  auditLogs,
  createAnnouncement,
  deleteAnnouncement,
  deleteOrganization,
  deleteUser,
  getOrganization,
  getUser,
  health,
  listAnnouncements,
  listFeatureFlags,
  listOrganizations,
  listSettings,
  listSubscriptions,
  listUsers,
  overview,
  pendingCertificates,
  proctoringIncidents,
  publicExamCatalog,
  reactivateOrganization,
  reactivateUser,
  revenue,
  setUserRole,
  setFeatureFlag,
  suspendOrganization,
  suspendUser,
  updateAnnouncement,
  updatePlan,
  updateSetting,
};
