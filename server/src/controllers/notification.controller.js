/**
 * Notification controller — the in-app inbox, per-user preferences and the
 * staff announcement / broadcast surface.
 */

const notifications = require('../services/notification.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** GET /api/notifications */
const list = asyncHandler(async (req, res) => {
  const result = await notifications.listNotifications(listQuery(req, { userId: req.userId }));
  return paged(res, result);
});

/** GET /api/notifications/stats */
const stats = asyncHandler(async (req, res) => {
  const result = await notifications.notificationStats(req.userId);
  return sendSuccess(res, { data: result });
});

/** POST /api/notifications/:id/read */
const markRead = asyncHandler(async (req, res) => {
  const result = await notifications.markRead({
    userId: req.userId,
    notificationId: req.params.id,
    read: req.body?.read !== false,
  });
  return sendSuccess(res, { data: result, message: 'Notification updated' });
});

/** POST /api/notifications/read-all */
const markAllRead = asyncHandler(async (req, res) => {
  const result = await notifications.markAllRead(req.userId);
  return sendSuccess(res, { data: result, message: 'All notifications marked read' });
});

/** POST /api/notifications/:id/archive */
const archive = asyncHandler(async (req, res) => {
  const result = await notifications.archive({ userId: req.userId, notificationId: req.params.id });
  return sendSuccess(res, { data: result, message: 'Notification archived' });
});

/** DELETE /api/notifications/clear-read */
const clearRead = asyncHandler(async (req, res) => {
  const result = await notifications.clearRead(req.userId);
  return sendSuccess(res, { data: result, message: 'Read notifications cleared' });
});

/** GET /api/notifications/preferences */
const getPreferences = asyncHandler(async (req, res) => {
  const result = await notifications.getPreferences(req.userId);
  return sendSuccess(res, { data: result ?? {} });
});

/** PUT /api/notifications/preferences */
const updatePreferences = asyncHandler(async (req, res) => {
  const result = await notifications.updatePreferences(req.userId, req.body ?? {});
  return sendSuccess(res, { data: result, message: 'Preferences saved' });
});

// ---------------------------------------------------------------------------
// Announcements + broadcasts (staff)
// ---------------------------------------------------------------------------

/** GET /api/notifications/announcements */
const listAnnouncements = asyncHandler(async (req, res) => {
  const result = await notifications.listAnnouncements({
    userId: req.userId,
    organizationId: req.organizationId ?? null,
    examId: req.query.examId ?? null,
    limit: Number(req.query.limit ?? 10),
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/notifications/announcements */
const createAnnouncement = asyncHandler(async (req, res) => {
  const result = await notifications.createAnnouncement({ ...(req.body ?? {}), organizationId: req.organizationId }, actor(req));
  return sendCreated(res, result, 'Announcement published');
});

/** POST /api/notifications/announcements/:id/dismiss */
const dismissAnnouncement = asyncHandler(async (req, res) => {
  const result = await notifications.dismissAnnouncement({ userId: req.userId, announcementId: req.params.id });
  return sendSuccess(res, { data: result, message: 'Announcement dismissed' });
});

/** POST /api/notifications/broadcast/exams/:examId — message every registrant. */
const broadcastToExam = asyncHandler(async (req, res) => {
  if (!req.body?.title) throw ApiError.badRequest('A title is required');
  const result = await notifications.notifyExamCandidates(req.params.examId, {
    type: req.body?.type ?? 'ANNOUNCEMENT',
    title: req.body.title,
    body: req.body?.body ?? null,
    actionUrl: req.body?.actionUrl ?? null,
    emailProps: req.body?.emailProps ?? null,
  });
  return sendCreated(res, result, 'Broadcast queued');
});

module.exports = {
  archive,
  broadcastToExam,
  clearRead,
  createAnnouncement,
  dismissAnnouncement,
  getPreferences,
  list,
  listAnnouncements,
  markAllRead,
  markRead,
  stats,
  updatePreferences,
};
