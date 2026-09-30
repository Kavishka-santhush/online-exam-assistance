/**
 * Authentication / identity service.
 *
 * Clerk owns credentials, so this service is about the *local* projection of
 * an identity: the `User` row, its organization memberships, the candidate or
 * instructor profile, and the webhook that keeps the two systems in step.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const env = require('../config/env');
const { clerkClient, deleteLocalUser, syncUserFromClerk } = require('../config/clerk');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');

/**
 * Everything the SPA needs after sign-in. Deliberately one round trip: the
 * client stores this verbatim in `authSlice`.
 */
async function getSession(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      candidateProfile: true,
      instructorProfile: true,
      notificationPrefs: true,
      memberships: {
        where: { status: { in: ['ACTIVE', 'PENDING'] } },
        include: {
          organization: {
            include: { subscription: { include: { plan: true } } },
          },
        },
        orderBy: { joinedAt: 'asc' },
      },
    },
  });
  if (!user) throw ApiError.notFound('User not found');

  const [pendingInvites, unreadNotifications, activeAttempts, createdExams] = await Promise.all([
    prisma.organizationInvite.count({ where: { email: user.email.toLowerCase(), status: 'PENDING' } }),
    prisma.notification.count({ where: { userId, readAt: null, archivedAt: null } }),
    prisma.attempt.count({ where: { userId, status: { in: ['IN_PROGRESS', 'PAUSED'] } } }),
    prisma.exam.count({ where: { createdById: userId, status: { not: 'ARCHIVED' } } }),
  ]);

  return {
    user: publicUser(user),
    memberships: user.memberships.map((membership) => ({
      id: membership.id,
      role: membership.role,
      status: membership.status,
      department: membership.department,
      permissions: normalisePermissions(membership.permissions),
      organization: summariseOrganization(membership.organization),
    })),
    counts: { pendingInvites, unreadNotifications, activeAttempts, createdExams },
    features: resolveFeatureFlags(user),
  };
}

/** Trim everything the client must never see (tokens, internal counters). */
function publicUser(user) {
  if (!user) return null;
  const { passwordHash, searchVector, ...rest } = user;
  return rest;
}

function summariseOrganization(organization) {
  if (!organization) return null;
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logoUrl: organization.logoUrl,
    branding: organization.branding ?? {},
    isWhiteLabel: organization.isWhiteLabel,
    isApproved: organization.isApproved,
    isSuspended: organization.isSuspended,
    plan: organization.subscription
      ? {
        code: organization.subscription.plan?.code,
        name: organization.subscription.plan?.name,
        status: organization.subscription.status,
        seats: organization.subscription.seats,
        currentPeriodEnd: organization.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: organization.subscription.cancelAtPeriodEnd,
      }
      : null,
  };
}

function normalisePermissions(permissions) {
  if (Array.isArray(permissions)) return permissions.map(String);
  if (permissions && typeof permissions === 'object') {
    return Object.entries(permissions).filter(([, value]) => value === true).map(([key]) => key);
  }
  return [];
}

/** Platform feature switches the client UI reads at boot. */
function resolveFeatureFlags(user) {
  return {
    proctoring: env.ENABLE_WEBSOCKET_PROCTORING,
    adaptive: env.ENABLE_ADAPTIVE_TESTING,
    liveQuiz: env.ENABLE_LIVE_QUIZ,
    publicCatalog: env.ENABLE_PUBLIC_EXAM_CATALOG,
    ai: Boolean(env.OPENROUTER_API_KEY),
    payments: Boolean(env.STRIPE_SECRET_KEY),
    isSuperAdmin: user.platformRole === 'SUPER_ADMIN',
  };
}

/** Profile fields the user owns; role/organization are changed by admins only. */
const PROFILE_FIELDS = [
  'firstName', 'lastName', 'displayName', 'bio', 'headline', 'phone',
  'country', 'timezone', 'language', 'imageUrl', 'coverImageUrl', 'isPublicProfile',
];

async function updateProfile(userId, payload = {}) {
  const data = {};
  for (const field of PROFILE_FIELDS) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }
  if (!Object.keys(data).length) throw ApiError.badRequest('No updatable profile fields supplied');

  const user = await prisma.user.update({ where: { id: userId }, data });

  // `headline`/`bio` live on the role profile as well; keep them in sync so the
  // candidate and instructor cards never disagree with the avatar menu.
  if (data.headline !== undefined || data.bio !== undefined) {
    await prisma.candidateProfile.updateMany({
      where: { userId },
      data: { ...(data.headline !== undefined ? { headline: data.headline } : {}) },
    });
    await prisma.instructorProfile.updateMany({
      where: { userId },
      data: { ...(data.bio !== undefined ? { bio: data.bio } : {}) },
    });
  }

  // Clerk is the source of truth for the name shown in the org switcher.
  await clerkClient.users
    .updateUser(userId.startsWith('user_') ? userId : user.clerkId, {
      firstName: data.firstName,
      lastName: data.lastName,
      profileImageUrl: data.imageUrl,
    })
    .catch((error) => logger.warn('clerk profile sync failed', { userId, error: error.message }));

  return publicUser(user);
}

/** Candidate onboarding: education, skills, goals, target exams. */
async function saveCandidateProfile(userId, payload = {}) {
  const data = pick(payload, [
    'headline', 'institution', 'degree', 'graduationYear', 'goals',
    'educationJson', 'skillsJson', 'interestsJson',
  ]);

  const profile = await prisma.candidateProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { timezone: payload.timezone ?? undefined, language: payload.language ?? undefined },
  }).catch(() => null);

  return profile;
}

async function getCandidateProfile(userId) {
  return prisma.candidateProfile.findUnique({ where: { userId } });
}

/** Instructor onboarding: expertise list, website, public bio. */
async function saveInstructorProfile(userId, payload = {}) {
  const data = pick(payload, ['expertise', 'bio', 'website']);
  if (Array.isArray(data.expertise)) data.expertise = data.expertise.map((entry) => String(entry).trim()).filter(Boolean);
  return prisma.instructorProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
}

/**
 * Accept an organization invitation by token. The email must match unless an
 * admin explicitly allowed account-less invites.
 */
async function acceptInvite({ token, userId }) {
  const invite = await prisma.organizationInvite.findUnique({
    where: { token },
    include: { organization: true },
  });
  if (!invite) throw ApiError.notFound('This invitation is not valid');
  if (invite.status !== 'PENDING') throw ApiError.conflict(`This invitation was already ${invite.status.toLowerCase()}`);
  if (invite.expiresAt < new Date()) {
    await prisma.organizationInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
    throw ApiError.conflict('This invitation has expired - ask your admin to send a new one');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('User not found');

  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw ApiError.forbidden('This invitation was sent to a different email address');
  }

  const member = await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: invite.organizationId, userId } },
    update: { role: invite.role, status: 'ACTIVE' },
    create: {
      organizationId: invite.organizationId,
      userId,
      role: invite.role,
      status: 'ACTIVE',
      invitedById: invite.invitedById,
    },
  });

  await prisma.organizationInvite.update({
    where: { id: invite.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedById: userId },
  });

  await ensureProfileRowsForMember(userId, invite.role);
  await recordAudit({ actorId: userId, action: 'org.invite.accepted', entityType: 'OrganizationInvite', entityId: invite.id, organizationId: invite.organizationId });

  return { membership: member, organization: summariseOrganization(invite.organization) };
}

/** Candidates must exist as instructors too when they are given a staff role. */
async function ensureProfileRowsForMember(userId, role) {
  if (['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(role)) {
    await prisma.instructorProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  }
}

/** Anyone can leave an organization they are not the last admin of. */
async function leaveOrganization({ userId, organizationId }) {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!membership) throw ApiError.notFound('You are not a member of this organization');

  if (membership.role === 'ORG_ADMIN') {
    const otherAdmins = await prisma.organizationMember.count({
      where: { organizationId, role: 'ORG_ADMIN', status: 'ACTIVE', id: { not: membership.id } },
    });
    if (otherAdmins === 0) throw ApiError.conflict('Transfer ownership before leaving - this organization has no other admin');
  }

  await prisma.organizationMember.delete({ where: { id: membership.id } });
  await recordAudit({ actorId: userId, action: 'org.member.left', entityType: 'OrganizationMember', entityId: membership.id, organizationId });
  return { left: true, organizationId };
}

/**
 * Soft account deletion: Clerk is told to remove the user, the local row is
 * flagged DEACTIVATED, and every attempt/certificate survives for audit.
 */
async function deactivateAccount(userId, { reason } = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('User not found');

  const blockingAdmin = await prisma.organizationMember.count({
    where: { userId, role: 'ORG_ADMIN', status: 'ACTIVE' },
  });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { status: 'DEACTIVATED', deactivatedAt: new Date(), isPublicProfile: false },
    }),
    prisma.organizationMember.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'DEACTIVATED' },
    }),
    prisma.attempt.updateMany({
      where: { userId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
      data: { status: 'EXPIRED' },
    }),
  ]);

  await clerkClient.users.deleteUser(user.clerkId).catch((error) => {
    logger.warn('clerk user deletion failed', { userId, error: error.message });
  });

  await recordAudit({
    actorId: userId,
    action: 'user.deactivated',
    entityType: 'User',
    entityId: userId,
    metadata: { reason: reason ?? null, blockingAdmin },
    isSensitive: true,
  });

  return { deactivated: true, sessionsRevoked: true, attemptsClosed: true };
}

/** Re-open a deactivated account from the "we missed you" email link. */
async function reactivateAccount(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: { status: 'ACTIVE', deactivatedAt: null },
  });
}

/**
 * Clerk webhook entry point. Returns quickly - the processing is idempotent on
 * `WebhookEvent.externalId` so retries and out-of-order events are harmless.
 */
async function handleClerkWebhook({ event, payload }) {
  const type = event?.type ?? event?.event_type;
  if (!type) throw ApiError.badRequest('Webhook payload has no event type');

  const data = payload?.data ?? payload ?? {};

  switch (type) {
    case 'user.created':
      return syncUserFromClerk(data);
    case 'user.updated':
      return syncUserFromClerk(data);
    case 'user.deleted':
      return deleteLocalUser(data.id);
    case 'email_address.created':
    case 'email_address.updated':
      return touchUserFromEmailEvent(data);
    case 'session.created':
    case 'session.removed':
      logger.debug('clerk session event', { type, sessionId: data.id });
      return { ignored: true, type };
    default:
      logger.debug('unhandled clerk event', { type });
      return { ignored: true, type };
  }
}

/** Secondary addresses are informational; we only refresh the primary. */
async function touchUserFromEmailEvent(data) {
  if (!data?.linkedUserId) return { ignored: true };
  const user = await prisma.user.findUnique({ where: { clerkId: data.linkedUserId } });
  if (!user) return { ignored: true };
  if (data.id === user.clerkId) return { ignored: true };
  return { refreshed: true, userId: user.id };
}

/**
 * Idempotency guard used by every webhook handler: returns the stored event row
 * when this delivery has already been processed.
 */
async function claimWebhookEvent({ provider, externalId, type, payload }) {
  if (!externalId) {
    return { claimed: true, event: null };
  }
  try {
    const event = await prisma.webhookEvent.create({
      data: { provider, externalId, type: type ?? 'unknown', payload: payload ?? {} },
    });
    return { claimed: true, event };
  } catch (error) {
    if (error.code === 'P2002') return { claimed: false, event: null };
    throw error;
  }
}

async function markWebhookEventProcessed(id, { status = 'PROCESSED', error } = {}) {
  if (!id) return null;
  return prisma.webhookEvent.update({
    where: { id },
    data: { status, error: error ?? null, processedAt: status === 'PROCESSED' ? new Date() : null },
  });
}

/** Audit helper shared by the identity flows (admin.service exposes the query). */
async function recordAudit({ actorId, action, entityType, entityId, organizationId, metadata, isSensitive = false, req }) {
  try {
    return await prisma.auditLog.create({
      data: {
        actorId: actorId ?? null,
        action,
        entityType,
        entityId: entityId ?? null,
        organizationId: organizationId ?? null,
        metadata: metadata ?? {},
        isSensitive,
        ipAddress: req?.ip ?? null,
        userAgent: req?.headers?.['user-agent'] ?? null,
      },
    });
  } catch (error) {
    logger.warn('audit log write failed', { action, error: error.message });
    return null;
  }
}

/** Anonymous guest attempts get a throwaway local user. */
async function ensureGuestUser(email) {
  const clerkId = `guest_${crypto.randomBytes(12).toString('hex')}`;
  return prisma.user.create({
    data: {
      clerkId,
      email: email.toLowerCase(),
      primaryEmail: email.toLowerCase(),
      displayName: email.split('@')[0],
      platformRole: 'USER',
      status: 'ACTIVE',
    },
  });
}

/** Verify an email address (Clerk does the sending; we just record it). */
async function markEmailVerified(userId) {
  return prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

module.exports = {
  acceptInvite,
  claimWebhookEvent,
  deactivateAccount,
  ensureGuestUser,
  ensureProfileRowsForMember,
  getCandidateProfile,
  handleClerkWebhook,
  leaveOrganization,
  markEmailVerified,
  markWebhookEventProcessed,
  publicUser,
  reactivateAccount,
  recordAudit,
  resolveFeatureFlags,
  saveCandidateProfile,
  saveInstructorProfile,
  summariseOrganization,
  updateProfile,
};
