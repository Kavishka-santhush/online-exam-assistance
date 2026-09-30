/**
 * Notification service.
 *
 * One dispatch path for every event type:
 *   notifyUser()  -> persists a `Notification` row, pushes it over the socket,
 *                    and (when the user's preferences allow) queues an email.
 *
 * Nothing in this module requires another service, so anything can depend on
 * it without creating an import cycle.
 */

const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { queueMail } = require('../config/mailer');
const { ApiError } = require('../utils/response.util');

/** Default channel routing per notification type. */
const TYPE_DEFAULTS = {
  EXAM_ASSIGNED: { channels: ['IN_APP', 'EMAIL'], priority: 1 },
  EXAM_REMINDER: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  EXAM_STARTING: { channels: ['IN_APP'], priority: 3 },
  EXAM_WINDOW_CLOSING: { channels: ['IN_APP'], priority: 3 },
  RESULTS_RELEASED: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  GRADING_COMPLETED: { channels: ['IN_APP'], priority: 1 },
  CERTIFICATE_ISSUED: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  VIOLATION_FLAGGED: { channels: ['IN_APP'], priority: 3 },
  PROCTOR_MESSAGE: { channels: ['IN_APP'], priority: 3 },
  NEW_EXAM_PUBLISHED: { channels: ['IN_APP'], priority: 0 },
  REGISTRATION_CONFIRMED: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  PAYMENT_RECEIVED: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  PAYMENT_FAILED: { channels: ['IN_APP', 'EMAIL'], priority: 3 },
  ORGANIZATION_INVITE: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
  ANNOUNCEMENT: { channels: ['IN_APP'], priority: 0 },
  AI_LIMIT_WARNING: { channels: ['IN_APP'], priority: 1 },
  SUBSCRIPTION_WARNING: { channels: ['IN_APP', 'EMAIL'], priority: 2 },
};

const EMAIL_TEMPLATES = {
  EXAM_ASSIGNED: 'ExamAssigned',
  EXAM_REMINDER: 'ExamReminder',
  RESULTS_RELEASED: 'ResultsReleased',
  CERTIFICATE_ISSUED: 'CertificateIssued',
  ORGANIZATION_INVITE: 'OrganizationInvite',
  PAYMENT_RECEIVED: 'PaymentReceipt',
  PAYMENT_FAILED: 'PaymentFailed',
  REGISTRATION_CONFIRMED: 'RegistrationConfirmed',
  SUBSCRIPTION_WARNING: 'SubscriptionWarning',
  ANNOUNCEMENT: 'Announcement',
};

/**
 * Socket push is best-effort: an offline candidate still gets the persisted row
 * (and an email) and will see it on next load.
 */
function pushToUser(userId, event, payload) {
  try {
    // Lazy require: index.socket -> *.socket -> services -> this module.
    const { emitToUser } = require('../socket/index.socket');
    emitToUser(userId, event, payload);
  } catch (error) {
    logger.debug('socket push skipped', { event, userId, error: error.message });
  }
}

function pushToRoom(room, event, payload) {
  try {
    const { emitToRoom } = require('../socket/index.socket');
    emitToRoom(room, event, payload);
  } catch (error) {
    logger.debug('socket broadcast skipped', { event, room, error: error.message });
  }
}

/**
 * Create and route a notification.
 * `delivery.channels` overrides the type defaults; `delivery.emailProps` are
 * the React-Email component props when an email is warranted.
 */
async function notifyUser({
  userId,
  type,
  title,
  body,
  data = {},
  actionUrl = null,
  imageUrl = null,
  channels = null,
  priority = null,
  emailProps = null,
  sendEmail = null,
}) {
  if (!type) throw ApiError.badRequest('Notification type is required');
  const defaults = TYPE_DEFAULTS[type] ?? { channels: ['IN_APP'], priority: 0 };
  const preferences = await getPreferences(userId);

  const wanted = (channels ?? defaults.channels).filter((channel) => allowsChannel(preferences, type, channel));
  const notification = await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body: body ?? null,
      data: data ?? {},
      channel: wanted[0] ?? 'IN_APP',
      priority: priority ?? defaults.priority,
      actionUrl,
      imageUrl,
      sentAt: new Date(),
    },
  });

  pushToUser(userId, 'notification:new', {
    id: notification.id,
    type,
    title,
    body: body ?? null,
    actionUrl,
    createdAt: notification.createdAt.toISOString(),
  });

  const shouldEmail = (sendEmail ?? wanted.includes('EMAIL')) && preferences?.emailDigest !== 'OFF';
  if (shouldEmail && EMAIL_TEMPLATES[type]) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, firstName: true } });
    if (user?.email) {
      queueMail({
        to: user.email,
        subject: title,
        template: EMAIL_TEMPLATES[type],
        props: {
          userName: user.displayName ?? user.firstName ?? 'there',
          title,
          body: body ?? null,
          actionUrl: actionUrl ? absoluteUrl(actionUrl) : null,
          ...(emailProps ?? {}),
        },
      });
      await prisma.notification.update({ where: { id: notification.id }, data: { deliveredAt: new Date() } }).catch(() => null);
    }
  }

  return notification;
}

function allowsChannel(preferences, type, channel) {
  if (!preferences) return channel === 'IN_APP';
  if (preferences.unsubscribeAll) return false;
  if (Array.isArray(preferences.mutedTypes) && preferences.mutedTypes.includes(type)) return false;
  if (channel === 'IN_APP') return true;
  if (channel === 'EMAIL') return preferences.channels?.EMAIL !== false;
  if (channel === 'SMS') return preferences.smsEnabled === true;
  if (channel === 'PUSH') return preferences.pushEnabled === true;
  return false;
}

function absoluteUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${env.CLIENT_URL.replace(/\/$/, '')}/${String(pathOrUrl).replace(/^\//, '')}`;
}

/** Fan-out helper: one row per user, sequential so a single failure is logged. */
async function notifyMany({ userIds = [], ...rest }) {
  const created = [];
  for (const userId of new Set(userIds.filter(Boolean))) {
    try {
      created.push(await notifyUser({ userId, ...rest }));
    } catch (error) {
      logger.warn('notification dispatch failed', { userId, type: rest.type, error: error.message });
    }
  }
  return created;
}

/**
 * Invite emails. `results` comes straight from organization.service and mixes
 * `INVITED` (needs a link) with `MEMBER_ADDED` (just a heads-up).
 */
async function sendInvites({ organization, results = [], message, invitedBy = null, resent = false }) {
  const invited = results.filter((entry) => entry.status === 'INVITED');
  const added = results.filter((entry) => entry.status === 'MEMBER_ADDED');

  for (const entry of invited) {
    const invite = await prisma.organizationInvite.findUnique({ where: { id: entry.inviteId } });
    if (!invite) continue;
    const link = absoluteUrl(`/invite/${invite.token}`);
    const existingUser = await prisma.user.findUnique({ where: { email: entry.email } });

    if (existingUser) {
      await notifyUser({
        userId: existingUser.id,
        type: 'ORGANIZATION_INVITE',
        title: `You have been added to ${organization.name}`,
        body: message ?? `${invitedBy ?? 'An administrator'} gave you ${invite.role.replace('_', ' ').toLowerCase()} access.`,
        actionUrl: `/org/${organization.slug}`,
        emailProps: { organizationName: organization.name, role: invite.role, message, invitedBy, link, resent },
      });
      continue;
    }

    queueMail({
      to: entry.email,
      subject: `${invitedBy ?? organization.name} invited you to join ${organization.name}`,
      template: 'OrganizationInvite',
      props: {
        organizationName: organization.name,
        organizationLogoUrl: organization.logoUrl,
        role: invite.role,
        message,
        invitedBy,
        link,
        expiresAt: invite.expiresAt,
        resent,
      },
    });
  }

  if (added.length && organization.settings?.notifyOnAutoAdd !== false) {
    await notifyMany({
      userIds: added.map((entry) => entry.userId).filter(Boolean),
      type: 'ORGANIZATION_INVITE',
      title: `You now have access to ${organization.name}`,
      body: message ?? null,
      actionUrl: `/org/${organization.slug}`,
    });
  }

  return { emailed: invited.length, inApp: added.length };
}

async function listNotifications({ userId, unreadOnly = false, type, archived = false, page = 1, limit = 20 }) {
  const where = { userId };
  if (unreadOnly) where.readAt = null;
  if (type) where.type = type;
  where.archivedAt = archived ? { not: null } : null;

  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null, archivedAt: null } }),
  ]);

  return { items, total, page, limit, unreadCount: unread };
}

async function markRead({ userId, notificationId, read = true }) {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) throw ApiError.notFound('Notification not found');
  if (notification.userId !== userId) throw ApiError.forbidden('This notification is not yours');
  return prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: read ? new Date() : null },
  });
}

async function markAllRead(userId) {
  return prisma.notification.updateMany({
    where: { userId, readAt: null, archivedAt: null },
    data: { readAt: new Date() },
  });
}

async function archive({ userId, notificationId }) {
  return prisma.notification.updateMany({
    where: { userId, id: notificationId },
    data: { archivedAt: new Date(), readAt: new Date() },
  });
}

async function clearRead(userId) {
  return prisma.notification.deleteMany({ where: { userId, readAt: { not: null } } });
}

/** Preferences are created lazily so a new user has no extra write. */
async function getPreferences(userId) {
  return prisma.notificationPreference.findUnique({ where: { userId } });
}

async function updatePreferences(userId, payload = {}) {
  const data = {};
  if (payload.channels) data.channels = payload.channels;
  if (payload.mutedTypes) data.mutedTypes = payload.mutedTypes.map(String);
  if (payload.emailDigest !== undefined) data.emailDigest = payload.emailDigest;
  if (payload.quietHoursStart !== undefined) data.quietHoursStart = payload.quietHoursStart;
  if (payload.quietHoursEnd !== undefined) data.quietHoursEnd = payload.quietHoursEnd;
  if (payload.smsEnabled !== undefined) data.smsEnabled = Boolean(payload.smsEnabled);
  if (payload.smsNumber !== undefined) data.smsNumber = payload.smsNumber;
  if (payload.pushEnabled !== undefined) data.pushEnabled = Boolean(payload.pushEnabled);
  if (payload.unsubscribeAll !== undefined) data.unsubscribeAll = Boolean(payload.unsubscribeAll);
  if (payload.timezone !== undefined) data.timezone = payload.timezone;

  return prisma.notificationPreference.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

/** Announcements: platform-wide banners plus organization/exam scoped ones. */
async function listAnnouncements({ userId, organizationId = null, examId = null, limit = 10 } = {}) {
  const audiences = ['ALL_USERS'];
  if (organizationId) audiences.push('ORGANIZATION');
  if (examId) audiences.push('EXAM_CANDIDATES');

  const where = {
    isPublished: true,
    audience: { in: audiences },
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ],
  };

  const scoped = [];
  if (organizationId) scoped.push({ organizationId }, { organizationId: null });
  else scoped.push({ organizationId: null });

  const items = await prisma.announcement.findMany({
    where: {
      ...where,
      AND: scoped.length ? [{ OR: scoped }] : undefined,
    },
    include: { createdBy: { select: { displayName: true, imageUrl: true } } },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });

  if (userId && items.length) {
    await prisma.announcement.updateMany({
      where: { id: { in: items.map((item) => item.id) } },
      data: { viewCount: { increment: 1 } },
    }).catch(() => null);
  }

  return items;
}

async function createAnnouncement(payload, actor) {
  const announcement = await prisma.announcement.create({
    data: {
      title: payload.title,
      body: payload.body,
      audience: payload.audience ?? 'ALL_USERS',
      organizationId: payload.organizationId ?? null,
      examId: payload.examId ?? null,
      bannerUrl: payload.bannerUrl ?? null,
      actionUrl: payload.actionUrl ?? null,
      isPublished: payload.isPublished !== false,
      publishedAt: payload.isPublished === false ? null : new Date(),
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      createdById: actor.userId,
    },
  });

  if (announcement.isPublished) {
    const recipients = await resolveAudience(announcement);
    await notifyMany({
      userIds: recipients,
      type: 'ANNOUNCEMENT',
      title: announcement.title,
      body: announcement.body,
      actionUrl: announcement.actionUrl,
      imageUrl: announcement.bannerUrl,
    });
  }

  return announcement;
}

async function resolveAudience(announcement) {
  if (announcement.audience === 'EXAM_CANDIDATES' && announcement.examId) {
    const rows = await prisma.examCandidate.findMany({
      where: { examId: announcement.examId, status: { not: 'WITHDRAWN' } },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  if (announcement.organizationId) {
    const where = { organizationId: announcement.organizationId, status: 'ACTIVE' };
    if (announcement.audience === 'INSTRUCTORS') where.role = { in: ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'] };
    const rows = await prisma.organizationMember.findMany({ where, select: { userId: true } });
    return rows.map((row) => row.userId);
  }

  const rows = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function dismissAnnouncement({ userId, announcementId }) {
  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement) throw ApiError.notFound('Announcement not found');

  // A per-user "seen" row with a deterministic id: re-dismissing is a no-op and
  // the banner filter (hide anything already read) needs no extra table.
  const id = `dismiss:${userId}:${announcementId}`;
  const existing = await prisma.notification.findUnique({ where: { id } });
  if (existing) return { dismissed: true, alreadySeen: true };

  await prisma.notification.create({
    data: {
      id,
      userId,
      type: 'ANNOUNCEMENT',
      title: announcement.title,
      data: { announcementId, dismissed: true },
      readAt: new Date(),
    },
  });
  return { dismissed: true };
}

/** Broadcast to every proctor watching an exam's monitoring room. */
function broadcastToProctors(examId, event, payload) {
  pushToRoom(`exam:${examId}:proctors`, event, payload);
}

function broadcastToExam(examId, event, payload) {
  pushToRoom(`exam:${examId}`, event, payload);
}

function broadcastToOrganization(organizationId, event, payload) {
  pushToRoom(`org:${organizationId}`, event, payload);
}

/** Used by the reminder cron and the exam lifecycle transitions. */
async function notifyExamCandidates(examId, { type, title, body, actionUrl, emailProps }) {
  const registrations = await prisma.examCandidate.findMany({
    where: { examId, status: { in: ['REGISTERED', 'PAID', 'INVITED', 'COMPLETED'] } },
    select: { userId: true },
  });
  const attemptsOnly = await prisma.attempt.findMany({ where: { examId }, select: { userId: true }, distinct: ['userId'] });
  const userIds = new Set([...registrations.map((row) => row.userId), ...attemptsOnly.map((row) => row.userId)]);
  return notifyMany({ userIds: [...userIds], type, title, body, actionUrl, emailProps });
}

async function notificationStats(userId) {
  const [total, unread, byType] = await Promise.all([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.groupBy({ by: ['type'], where: { userId }, _count: { _all: true } }),
  ]);
  return { total, unread, byType: byType.map((row) => ({ type: row.type, count: row._count._all })) };
}

module.exports = {
  TYPE_DEFAULTS,
  absoluteUrl,
  archive,
  broadcastToExam,
  broadcastToOrganization,
  broadcastToProctors,
  clearRead,
  createAnnouncement,
  dismissAnnouncement,
  getPreferences,
  listAnnouncements,
  listNotifications,
  markAllRead,
  markRead,
  notificationStats,
  notifyExamCandidates,
  notifyMany,
  notifyUser,
  pushToRoom,
  pushToUser,
  sendInvites,
  updatePreferences,
};
