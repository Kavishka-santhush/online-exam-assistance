/**
 * Authentication + organization-scoping middleware.
 *
 * Clerk verifies the JWT (mounted as `clerkMiddleware()` in app.js); this
 * module turns the `sub` claim into the local `User` row, resolves which
 * organization the request operates on, and exposes a small helper surface
 * (`req.user`, `req.org`, `req.membership`, `req.plan`, `isSuperAdmin`) that
 * controllers and services read instead of re-resolving.
 */

const { getAuth } = require('@clerk/express');
const env = require('../config/env');
const prisma = require('../config/prisma');
const { requireLocalUser } = require('../config/clerk');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');

const ORG_HEADER = 'x-organization-id';

/**
 * `getAuth` requires Clerk's middleware to have run. When CLERK_* keys are
 * placeholders the mount is skipped, so treat a throwing/absent auth object
 * as "no session" (401 downstream) instead of a 500.
 */
function safeGetAuth(req) {
  try {
    return getAuth(req) ?? {};
  } catch {
    return {};
  }
}

/** Used only to pick a default organization when a user has several. */
const ROLE_PRECEDENCE = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE'];

/** Reject suspended accounts and anonymous visitors. */
async function authenticate(req, res, next) {
  try {
    const { userId: clerkId } = safeGetAuth(req);
    if (!clerkId) throw ApiError.unauthorized('Sign in to continue');

    const user = await requireLocalUser(clerkId);
    req.clerkId = clerkId;
    req.user = user;
    req.userId = user.id;
    req.platformRole = user.platformRole;
    res.setHeader('X-User-Id', user.id);

    if (user.status !== 'ACTIVE' && user.status !== 'PENDING') {
      throw ApiError.forbidden(`Your account is ${user.status.toLowerCase()}`);
    }

    await touchLastActive(user.id);
    next();
  } catch (error) {
    next(error);
  }
}

/** Same as `authenticate` but continues as a guest when there is no session. */
async function optionalAuthenticate(req, res, next) {
  try {
    const { userId: clerkId } = safeGetAuth(req);
    if (clerkId) {
      const user = await requireLocalUser(clerkId).catch(() => null);
      if (user) {
        req.clerkId = clerkId;
        req.user = user;
        req.userId = user.id;
        req.platformRole = user.platformRole;
      }
    }
    if (!req.user) req.isGuest = true;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Resolve the working organization.
 *
 * Precedence: `?organizationId`/header (must be a membership) → the single
 * membership the user has → super admin may target any organization → 400.
 */
async function resolveOrganization(req, res, next) {
  try {
    if (!req.user) throw ApiError.unauthorized('Sign in to continue');

    const requested = req.headers[ORG_HEADER] ?? req.query.organizationId ?? req.body?.organizationId ?? null;

    if (isSuperAdmin(req.user) && requested) {
      const organization = await prisma.organization.findUnique({
        where: { id: String(requested) },
        include: { subscription: { include: { plan: true } }, settingRows: true },
      });
      if (!organization) throw ApiError.notFound('Organization not found');
      attachOrganization(req, organization, null);
      return next();
    }

    const memberships = req.user.memberships ?? [];
    if (requested) {
      const membership = memberships.find((entry) => entry.organizationId === String(requested));
      if (!membership) throw ApiError.forbidden('You are not a member of that organization');
      attachOrganization(req, membership.organization, membership);
      return next();
    }

    if (memberships.length === 1) {
      attachOrganization(req, memberships[0].organization, memberships[0]);
      return next();
    }

    if (memberships.length > 1) {
      // `OrganizationMember` has no "default" column, so fall back to the
      // membership with the most privileges - that is what the user is most
      // likely acting as.
      const preferred = [...memberships].sort(rankMembership)[0];
      attachOrganization(req, preferred.organization, preferred);
      return next();
    }

    if (isSuperAdmin(req.user)) return next(); // platform-scope endpoints
    throw ApiError.badRequest('Select an organization to continue');
  } catch (error) {
    next(error);
  }
}

function rankMembership(a, b) {
  return ROLE_PRECEDENCE.indexOf(a.role) - ROLE_PRECEDENCE.indexOf(b.role);
}

function attachOrganization(req, organization, membership) {
  if (organization && !organization.isApproved && !isSuperAdmin(req.user)) {
    throw ApiError.forbidden('This organization is awaiting platform approval');
  }
  if (organization?.isSuspended) throw ApiError.forbidden('This organization is suspended');
  req.organization = organization ?? null;
  req.organizationId = organization?.id ?? null;
  req.membership = membership ?? null;
  req.orgRole = membership?.role ?? (isSuperAdmin(req.user) ? 'ORG_ADMIN' : 'CANDIDATE');
  req.plan = organization?.subscription?.plan ?? null;
  req.subscription = organization?.subscription ?? null;
  req.branding = organization?.branding ?? null;
  req.orgSettings = organisationSettingsById(organization);
}

/** Fold the keyed `OrganizationSetting` rows into a plain object. */
function organisationSettingsById(organization) {
  const rows = organization?.settingRows;
  if (!Array.isArray(rows)) return null;
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

/** Mark presence for the "last active" column without blocking the response. */
function touchLastActive(userId) {
  prisma.user
    .update({ where: { id: userId }, data: { lastActiveAt: new Date() } })
    .catch((error) => logger.debug('lastActiveAt update failed', { error: error.message }));
}

function isSuperAdmin(user) {
  return user?.platformRole === 'SUPER_ADMIN';
}

/** Service-token auth for internal cron workers and webhooks. */
function internalOnly(req, res, next) {
  const token = req.headers['x-internal-token'] ?? req.query.internalToken;
  if (!env.INTERNAL_API_TOKEN || token !== env.INTERNAL_API_TOKEN) {
    return next(ApiError.forbidden('Internal service token required'));
  }
  return next();
}

/** Load `req.attempt` and assert the session is still live (exam routes). */
async function loadActiveAttempt(req, res, next) {
  try {
    const attemptId = req.params.attemptId ?? req.body.attemptId ?? req.query.attemptId;
    if (!attemptId) throw ApiError.badRequest('attemptId is required');

    const attempt = await prisma.attempt.findUnique({
      where: { id: String(attemptId) },
      include: { exam: { include: { organization: { include: { subscription: { include: { plan: true } } } } } } },
    });
    if (!attempt) throw ApiError.notFound('Attempt not found');

    const isOwner = attempt.userId === req.userId;
    const isStaff = (attempt.exam.createdById === req.userId)
      || req.orgRole === 'ORG_ADMIN'
      || req.orgRole === 'PROCTOR'
      || isSuperAdmin(req.user);
    if (!isOwner && !isStaff) throw ApiError.forbidden('This attempt belongs to another candidate');

    req.attempt = attempt;
    req.isAttemptOwner = isOwner;
    if (isOwner && !['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
      throw ApiError.locked(`The attempt is already ${attempt.status.toLowerCase()}`);
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  ORG_HEADER,
  attachOrganization,
  authenticate,
  internalOnly,
  isSuperAdmin,
  loadActiveAttempt,
  optionalAuthenticate,
  resolveOrganization,
  ROLE_PRECEDENCE,
};
