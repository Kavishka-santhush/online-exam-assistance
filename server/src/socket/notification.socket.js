/**
 * Notification socket handlers.
 *
 * The personal room (`user:<id>`) is joined centrally by index.socket; this
 * module only adds the client -> server side of the inbox: marking items read
 * over the socket (cheaper than a REST round-trip for a badge counter) and
 * replaying the current unread count on demand so a reconnecting client can
 * resync without hammering the REST list endpoint.
 *
 * Everything here delegates to `notification.service`, so the socket path and
 * the REST path share one implementation and one set of ownership checks.
 */

const notification = require('../services/notification.service');
const logger = require('../utils/logger.util');

/** Resolve when the socket carries an authenticated user, else ack an error. */
function requireUser(socket, ack) {
  const user = socket.data.user;
  if (!user) {
    if (typeof ack === 'function') ack({ ok: false, error: 'unauthenticated' });
    return null;
  }
  return user;
}

function registerNotificationHandlers(io, socket) {
  const userId = socket.data.user?.id ?? null;

  // Immediately push the unread badge so the client does not need a REST call.
  if (userId) {
    notification
      .notificationStats(userId)
      .then((stats) => socket.emit('notification:unread', { unread: stats?.unread ?? 0, total: stats?.total ?? 0 }))
      .catch((error) => logger.debug('notification stats replay failed', { error: error.message }));
  }

  socket.on('notification:read', async (payload = {}, ack) => {
    const user = requireUser(socket, ack);
    if (!user) return;
    try {
      const result = await notification.markRead({ userId: user.id, notificationId: payload.notificationId ?? payload.id, read: payload.read !== false });
      if (typeof ack === 'function') ack({ ok: true, data: result });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('notification:read-all', async (payload = {}, ack) => {
    const user = requireUser(socket, ack);
    if (!user) return;
    try {
      const result = await notification.markAllRead(user.id);
      // Nudge other tabs of the same user to clear their badge.
      io.to(`user:${user.id}`).emit('notification:all-read', { at: new Date().toISOString() });
      if (typeof ack === 'function') ack({ ok: true, data: result });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('notification:unread', async (payload = {}, ack) => {
    const user = requireUser(socket, ack);
    if (!user) return;
    try {
      const stats = await notification.notificationStats(user.id);
      if (typeof ack === 'function') ack({ ok: true, unread: stats?.unread ?? 0, total: stats?.total ?? 0 });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });

  socket.on('notification:list', async (payload = {}, ack) => {
    const user = requireUser(socket, ack);
    if (!user) return;
    try {
      const result = await notification.listNotifications({
        userId: user.id,
        unreadOnly: payload.unreadOnly === true,
        type: payload.type ?? undefined,
        page: Number(payload.page) || 1,
        limit: Math.min(50, Number(payload.limit) || 20),
      });
      if (typeof ack === 'function') ack({ ok: true, data: result });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerNotificationHandlers };
