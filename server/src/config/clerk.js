/**
 * Clerk configuration and server-side user lookups.
 *
 * Clerk owns credentials, MFA and OAuth - the platform never stores a
 * password. The API only ever needs to (a) verify an incoming JWT and
 * (b) resolve the Clerk subject to the local `User` row created by the
 * `user.created` webhook.
 */

const { createClerkClient } = require('@clerk/backend');
const env = require('./env');
const prisma = require('./prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');

const clerkClient = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  userAgent: 'exam-platform-api/1.0',
});

/** Resolve a Clerk userId (`sub` claim) to the local user row. */
async function findLocalUserByClerkId(clerkId) {
  if (!clerkId) return null;
  return prisma.user.findUnique({
    where: { clerkId },
    include: {
      memberships: {
        include: { organization: { include: { subscription: { include: { plan: true } }, settingRows: true } } },
      },
      candidateProfile: true,
      instructorProfile: true,
    },
  });
}

async function requireLocalUser(clerkId) {
  const user = await findLocalUserByClerkId(clerkId);
  if (!user) {
    // The webhook has not landed yet (or was lost): pull the profile once.
    const synced = await syncUserFromClerk(clerkId).catch((error) => {
      logger.error('clerk sync-on-read failed', { clerkId, error: error.message });
      return null;
    });
    if (!synced) throw ApiError.unauthorized('Your account is still being provisioned - reload in a moment');
    return synced;
  }
  if (user.status === 'SUSPENDED') throw ApiError.forbidden('Your account is suspended. Contact your organization admin.');
  if (user.status === 'DEACTIVATED' || user.deactivatedAt) throw ApiError.forbidden('Your account is deactivated.');
  return user;
}

/**
 * Upsert a local user from Clerk data. Called by the webhook handler and by
 * the read-through path above.
 */
async function syncUserFromClerk(clerkUserOrId) {
  const clerkUser = typeof clerkUserOrId === 'string'
    ? await clerkClient.users.getUser(clerkUserOrId)
    : clerkUserOrId;

  const primaryEmailEntry =
    clerkUser.primaryEmailAddressId
      ? clerkUser.emailAddresses?.find((email) => email.id === clerkUser.primaryEmailAddressId)
      : clerkUser.emailAddresses?.[0];
  const email = primaryEmailEntry?.emailAddress ?? clerkUser.primaryEmailAddress ?? null;

  if (!email) throw ApiError.badRequest('Clerk user has no email address - cannot provision an account');

  const data = {
    clerkId: clerkUser.id,
    email: email.toLowerCase(),
    primaryEmail: email.toLowerCase(),
    firstName: clerkUser.firstName ?? null,
    lastName: clerkUser.lastName ?? null,
    displayName: clerkUser.fullName ?? clerkUser.username ?? email.split('@')[0],
    imageUrl: clerkUser.imageUrl ?? null,
    language: clerkUser.locale?.split('-')[0] ?? 'en',
    emailVerified: Boolean(primaryEmailEntry?.verified),
    lastActiveAt: new Date(),
  };

  const user = await prisma.user.upsert({
    where: { clerkId: clerkUser.id },
    update: data,
    create: { ...data, platformRole: await guessPlatformRole(data.email) },
    include: { memberships: { include: { organization: { include: { subscription: { include: { plan: true } } } } } } },
  });

  // Secondary addresses stay on the Clerk side; the local row keeps the
  // primary one which is what search, invites and receipts use.
  await ensureProfileRows(user);
  return user;
}

/** Bootstrapped super admins are claimed by email before any UI exists. */
async function guessPlatformRole(email) {
  const allowList = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (allowList.includes(String(email).toLowerCase())) return 'SUPER_ADMIN';
  const existing = await prisma.user.count({ where: { platformRole: { in: ['SUPER_ADMIN', 'ADMIN'] } } });
  return existing === 0 ? 'SUPER_ADMIN' : 'USER';
}

/** Candidates and instructors always get the profile row their role expects. */
async function ensureProfileRows(user) {
  const roles = new Set((user.memberships ?? []).map((membership) => membership.role));
  const isCandidate = roles.size === 0 || roles.has('CANDIDATE');
  const isInstructor = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].some((role) => roles.has(role));

  if (isCandidate && !user.candidateProfile) {
    await prisma.candidateProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
  }
  if (isInstructor && !user.instructorProfile) {
    await prisma.instructorProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
  }
}

async function deleteLocalUser(clerkId) {
  const user = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!user) return null;
  // Soft delete: attempts and certificates must survive for auditability.
  return prisma.user.update({
    where: { id: user.id },
    data: { status: 'DEACTIVATED', deactivatedAt: new Date(), lastActiveAt: new Date() },
  });
}

module.exports = {
  clerkClient,
  deleteLocalUser,
  ensureProfileRows,
  findLocalUserByClerkId,
  requireLocalUser,
  syncUserFromClerk,
};
