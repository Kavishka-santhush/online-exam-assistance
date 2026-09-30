/**
 * Authorization middleware: platform roles, organization roles, ownership and
 * subscription-plan gates.
 *
 * Role vocabulary comes straight from the Prisma enums (`PlatformRole`,
 * `MemberRole`) so a typo here fails loudly rather than silently granting
 * access.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { isSuperAdmin } = require('./auth.middleware');

/** ORG_ADMIN and INSTRUCTOR may both build exams; CANDIDATE may not. */
const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];
const AUTHOR_ROLES = ['ORG_ADMIN', 'INSTRUCTOR'];
const ADMIN_ROLES = ['ORG_ADMIN'];

function requirePlatformRole(...roles) {
  const allowed = new Set(roles.flat());
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (allowed.has(req.user.platformRole)) return next();
    return next(ApiError.forbidden(`Requires platform role ${[...allowed].join(' or ')}`));
  };
}

const requireSuperAdmin = () => requirePlatformRole('SUPER_ADMIN');

/**
 * Organization role guard. A platform SUPER_ADMIN always passes so support
 * engineers can debug a tenant, and every pass is logged.
 */
function requireOrgRole(...roles) {
  const allowed = new Set(roles.flat());
  return async (req, res, next) => {
    try {
      if (!req.user) throw ApiError.unauthorized();
      if (isSuperAdmin(req.user)) {
        logger.warn('super admin bypassed an organization role check', {
          userId: req.user.id,
          path: req.originalUrl,
          required: [...allowed],
        });
        req.orgRole = req.orgRole ?? 'ORG_ADMIN';
        return next();
      }

      const membership = req.membership
        ?? (req.organizationId
          ? await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: req.organizationId, userId: req.user.id } },
          })
          : null);

      if (!membership) throw ApiError.forbidden('You are not a member of this organization');
      if (membership.status !== 'ACTIVE') throw ApiError.forbidden(`Your membership is ${membership.status.toLowerCase()}`);
      if (!allowed.has(membership.role)) throw ApiError.forbidden(`Requires organization role ${[...allowed].join(' or ')}`);

      req.membership = membership;
      req.orgRole = membership.role;
      req.permissions = normalisePermissions(membership.permissions);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const requireStaff = () => requireOrgRole(STAFF_ROLES);
const requireAuthor = () => requireOrgRole(AUTHOR_ROLES);
const requireOrgAdmin = () => requireOrgRole(ADMIN_ROLES);
const requireProctor = () => requireOrgRole(['PROCTOR', 'ORG_ADMIN']);

/** Plan capability shortcuts used across the route files. */
const requireProctoringPlan = () => requirePlan({ capability: 'isProctoringIncluded' });
const requireAdaptivePlan = () => requirePlan({ capability: 'isAdaptiveIncluded' });
const requireLiveQuizPlan = () => requirePlan({ capability: 'isLiveQuizIncluded' });
const requireWhiteLabelPlan = () => requirePlan({ capability: 'isWhiteLabelIncluded' });

/**
 * Fine-grained permission check. `OrganizationMember.permissions` holds a JSON
 * array such as ["exams.publish", "grading.review"]; an ORG_ADMIN implicitly
 * holds everything.
 */
function requirePermission(...keys) {
  const wanted = keys.flat();
  return async (req, res, next) => {
    try {
      if (!req.user) throw ApiError.unauthorized();
      if (isSuperAdmin(req.user) || req.orgRole === 'ORG_ADMIN') return next();

      const membership = req.membership
        ?? (req.organizationId
          ? await prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: req.organizationId, userId: req.user.id } },
          })
          : null);

      const granted = new Set(normalisePermissions(membership?.permissions));
      const missing = wanted.filter((key) => !granted.has(key) && !granted.has(`${key.split('.')[0]}.*`));
      if (missing.length) throw ApiError.forbidden(`Missing permission(s): ${missing.join(', ')}`);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function normalisePermissions(permissions) {
  if (Array.isArray(permissions)) return permissions.map(String);
  if (permissions && typeof permissions === 'object') {
    return Object.entries(permissions)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
  }
  return [];
}

/**
 * Resource ownership guard. `resolve` maps the route params to
 * `{ ownerId, organizationId }`; staff of the owning organization pass.
 */
function requireResourceOwner(resolve, { message = 'You do not own this resource' } = {}) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw ApiError.unauthorized();
      const owner = await resolve(req);
      if (!owner) throw ApiError.notFound('Resource not found');

      if (isSuperAdmin(req.user)) return next();
      if (owner.ownerId && owner.ownerId === req.user.id) return next();
      if (req.membership && owner.organizationId && req.organizationId === owner.organizationId && STAFF_ROLES.includes(req.orgRole)) return next();

      throw ApiError.forbidden(message);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Plan gate. `capability` is either a `isXIncluded` column on SubscriptionPlan
 * or a key inside its `features`/`limits` JSON; `limit` names a numeric column
 * (maxExams, maxCandidatesPerExam, maxAiRequestsPerDay, maxStorageMb) and is
 * compared against the current usage - a negative cap means unlimited.
 */
function requirePlan({ capability, limit, currentCount } = {}) {
  return async (req, res, next) => {
    try {
      const plan = req.plan ?? (req.organizationId ? await loadPlanFor(req.organizationId) : null);
      if (!plan) throw ApiError.planLimit('This organization has no active subscription plan');
      if (plan.isActive === false) throw ApiError.planLimit(`The ${plan.name} plan has been retired - contact support`);

      const periodEnd = req.subscription?.currentPeriodEnd;
      if (periodEnd && new Date(periodEnd) < new Date()) {
        throw ApiError.planLimit('The subscription period has ended - renew to continue');
      }

      if (capability && !planIncludes(plan, capability)) {
        throw ApiError.planLimit(`The ${plan.name} plan does not include ${capability}`, {
          capability,
          plan: plan.code,
          upgradeUrl: '/billing/plans',
        });
      }

      if (limit && plan[limit] !== undefined && Number(plan[limit]) >= 0) {
        const used = typeof currentCount === 'function' ? await currentCount(req) : Number(currentCount ?? 0);
        if (used >= Number(plan[limit])) {
          throw ApiError.planLimit(`${limit} cap of ${plan[limit]} reached on the ${plan.name} plan`, {
            limit,
            allowed: Number(plan[limit]),
            used,
          });
        }
      }

      req.plan = plan;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Resolve a capability against columns, then the `features` / `limits` JSON. */
function planIncludes(plan, capability) {
  if (Object.prototype.hasOwnProperty.call(plan, capability)) return plan[capability] === true;
  const features = Array.isArray(plan.features) ? plan.features.map(String) : [];
  if (features.includes(capability)) return true;
  const limits = plan.limits && typeof plan.limits === 'object' ? plan.limits : {};
  return Boolean(limits[capability]);
}

async function loadPlanFor(organizationId) {
  const subscription = await prisma.organizationSubscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  return subscription?.plan ?? null;
}

/** Blocks candidate-side routes unless the exam window is open. */
function requireExamWindowOpen(req, res, next) {
  const exam = req.exam ?? req.attempt?.exam;
  if (!exam) return next(ApiError.notFound('Exam not found'));
  const now = Date.now();
  if (exam.startsAt && now < new Date(exam.startsAt).getTime()) {
    return next(ApiError.locked('This exam has not opened yet', { opensAt: exam.startsAt }));
  }
  if (exam.endsAt && now > new Date(exam.endsAt).getTime()) {
    return next(ApiError.locked('The exam window has closed', { closedAt: exam.endsAt }));
  }
  if (!['PUBLISHED', 'ACTIVE', 'SCHEDULED'].includes(exam.status)) {
    return next(ApiError.forbidden('This exam is not available'));
  }
  return next();
}

module.exports = {
  ADMIN_ROLES,
  AUTHOR_ROLES,
  STAFF_ROLES,
  loadPlanFor,
  normalisePermissions,
  requireAuthor,
  requireExamWindowOpen,
  requireOrgAdmin,
  requireOrgRole,
  requirePermission,
  requirePlatformRole,
  requirePlan,
  requireProctor,
  requireProctoringPlan,
  requireResourceOwner,
  requireStaff,
  requireSuperAdmin,
  requireLiveQuizPlan,
  requireAdaptivePlan,
  requireWhiteLabelPlan,
  planIncludes,
};
