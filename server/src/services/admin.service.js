/**
 * Admin service (Super Admin + Organization Admin).
 *
 * Platform-wide management: organizations, users, exam catalog, subscriptions,
 * AI usage monitoring, announcements, audit logs, and feature/system settings.
 *
 * Every mutating function writes an `AuditLog` entry.
 */

const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { notifyUser, notifyMany } = require('./notification.service');

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertSuperAdmin(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  if (actor.platformRole !== 'SUPER_ADMIN') throw ApiError.forbidden('Super Admin access required');
}

function assertAdmin(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  const isAdmin = actor.platformRole === 'SUPER_ADMIN' || actor.platformRole === 'ADMIN' || actor.role === 'ORG_ADMIN';
  if (!isAdmin) throw ApiError.forbidden('Admin access required');
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const MEMBER_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE'];

/** `AuditLog.actorRole` is a MemberRole enum - anything else must be dropped. */
function auditActorRole(actor = {}) {
  return MEMBER_ROLES.includes(actor.role) ? actor.role : null;
}

async function recordAudit({ action, entityType, entityId = null, organizationId = null, actor = {}, metadata = {}, isSensitive = false, ipAddress = null, userAgent = null }) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actor.userId ?? null,
        actorRole: auditActorRole(actor),
        action,
        entityType,
        entityId,
        organizationId,
        ipAddress,
        userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
        metadata,
        isSensitive,
      },
    });
  } catch (error) {
    logger.warn('audit log write failed', { action, entityType, error: error.message });
  }
}

async function listAuditLogs({ action, entityType, entityId, actorId, organizationId, from, to, page = 1, limit = 50 } = {}, reqActor = {}) {
  assertAdmin(reqActor);
  const where = {};
  if (reqActor.platformRole !== 'SUPER_ADMIN') where.organizationId = reqActor.organizationId;
  else if (organizationId) where.organizationId = organizationId;
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (actorId) where.actorId = actorId;
  if (from || to) where.createdAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { actor: { select: { id: true, email: true, displayName: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// Platform overview (super admin dashboard)
// ---------------------------------------------------------------------------

async function platformOverview(actor = {}) {
  assertSuperAdmin(actor);

  const utcMidnight = new Date(); utcMidnight.setUTCHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const [totalOrgs, activeOrgs, totalUsers, totalExams, activeExams, totalAttempts, attemptsToday, revenueAgg, aiAgg, certCount, violationCount] = await Promise.all([
    prisma.organization.count(),
    prisma.organization.count({ where: { isSuspended: false, isApproved: true } }),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.exam.count(),
    prisma.exam.count({ where: { status: { in: ['PUBLISHED', 'ACTIVE'] } } }),
    prisma.attempt.count(),
    prisma.attempt.count({ where: { createdAt: { gte: utcMidnight } } }),
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED', paidAt: { gte: thirtyDaysAgo } }, _sum: { amountCents: true, netCents: true } }),
    prisma.aiUsageLog.aggregate({ where: { createdAt: { gte: thirtyDaysAgo } }, _sum: { costUsd: true, totalTokens: true }, _count: { _all: true } }),
    prisma.certificate.count({ where: { status: 'ISSUED' } }),
    prisma.violation.count({ where: { occurredAt: { gte: thirtyDaysAgo } } }),
  ]);

  return {
    organizations: { total: totalOrgs, active: activeOrgs },
    users: totalUsers,
    exams: { total: totalExams, active: activeExams },
    attempts: { total: totalAttempts, today: attemptsToday },
    revenue30d: { grossCents: revenueAgg._sum.amountCents ?? 0, netCents: revenueAgg._sum.netCents ?? 0 },
    ai30d: { calls: aiAgg._count._all, costUsd: Number(aiAgg._sum.costUsd ?? 0), tokens: aiAgg._sum.totalTokens ?? 0 },
    certificates: certCount,
    violations30d: violationCount,
  };
}

// ---------------------------------------------------------------------------
// Organization management
// ---------------------------------------------------------------------------

async function listOrganizations({ status, search, plan, page = 1, limit = 30, sort = 'createdAt' } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const where = {};
  if (status === 'suspended') where.isSuspended = true;
  else if (status === 'pending') where.isApproved = false;
  else if (status === 'active') { where.isSuspended = false; where.isApproved = true; }
  if (search) {
    where.OR = [{ name: { contains: String(search), mode: 'insensitive' } }, { slug: { contains: String(search), mode: 'insensitive' } }];
  }
  if (plan) where.subscription = { plan: { code: plan } };

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const sortField = ['createdAt', 'name', 'updatedAt'].includes(sort) ? sort : 'createdAt';

  const [items, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      orderBy: [{ [sortField]: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      include: { subscription: { include: { plan: { select: { code: true, name: true } } } }, createdBy: { select: { id: true, email: true, displayName: true } }, _count: { select: { members: true, exams: true, attempts: true, certificates: true } } },
    }),
    prisma.organization.count({ where }),
  ]);

  return { items, total, page: safePage, limit: safeLimit };
}

async function getOrganization(organizationId, actor = {}) {
  assertAdmin(actor);
  if (actor.platformRole !== 'SUPER_ADMIN' && actor.organizationId !== organizationId) throw ApiError.forbidden('Access denied');
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: { include: { plan: true } }, createdBy: { select: { id: true, email: true, displayName: true } }, _count: { select: { members: true, exams: true, attempts: true, certificates: true, payments: true } } },
  });
  if (!org) throw ApiError.notFound('Organization not found');
  return org;
}

async function approveOrganization(organizationId, actor = {}) {
  assertSuperAdmin(actor);
  const org = await prisma.organization.update({ where: { id: organizationId }, data: { isApproved: true } });
  if (org.createdById) {
    await notifyUser({ userId: org.createdById, type: 'ANNOUNCEMENT', title: 'Your organization is approved', body: `${org.name} has been approved and is now active.` }).catch(() => null);
  }
  await recordAudit({ action: 'ORG_APPROVED', entityType: 'Organization', entityId: organizationId, organizationId, actor });
  logger.info('organization approved', { organizationId, by: actor.userId });
  return { approved: true, organizationId };
}

async function suspendOrganization(organizationId, { reason = null } = {}, actor = {}) {
  assertSuperAdmin(actor);
  await prisma.organization.update({ where: { id: organizationId }, data: { isSuspended: true, suspendedAt: new Date() } });
  const members = await prisma.organizationMember.findMany({ where: { organizationId }, select: { userId: true } });
  await notifyMany({ userIds: members.map((m) => m.userId), type: 'ANNOUNCEMENT', title: 'Organization suspended', body: reason ?? 'This organization has been suspended. Contact support for details.' }).catch(() => null);
  await recordAudit({ action: 'ORG_SUSPENDED', entityType: 'Organization', entityId: organizationId, organizationId, actor, metadata: { reason } });
  return { suspended: true, organizationId };
}

async function reactivateOrganization(organizationId, actor = {}) {
  assertSuperAdmin(actor);
  await prisma.organization.update({ where: { id: organizationId }, data: { isSuspended: false, isApproved: true, suspendedAt: null } });
  await recordAudit({ action: 'ORG_REACTIVATED', entityType: 'Organization', entityId: organizationId, organizationId, actor });
  return { active: true, organizationId };
}

async function deleteOrganization(organizationId, { confirmSlug } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, include: { _count: { select: { exams: true, attempts: true, payments: true } } } });
  if (!org) throw ApiError.notFound('Organization not found');
  if (confirmSlug !== org.slug) throw ApiError.badRequest('Type the organization slug to confirm this irreversible deletion', { slug: org.slug });
  if (org._count.payments > 0) throw ApiError.conflict('Organization has payment history and cannot be hard-deleted; suspend it instead');

  await prisma.organization.delete({ where: { id: organizationId } });
  await recordAudit({ action: 'ORG_DELETED', entityType: 'Organization', entityId: organizationId, organizationId, actor, metadata: { slug: org.slug }, isSensitive: true });
  logger.warn('organization deleted', { organizationId, slug: org.slug, by: actor.userId });
  return { deleted: true, organizationId };
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

async function listUsers({ status, search, platformRole, page = 1, limit = 30 } = {}, actor = {}) {
  assertAdmin(actor);
  const where = {};
  if (status) where.status = status;
  if (platformRole) where.platformRole = platformRole;
  if (search) {
    where.OR = [
      { email: { contains: String(search), mode: 'insensitive' } },
      { displayName: { contains: String(search), mode: 'insensitive' } },
      { firstName: { contains: String(search), mode: 'insensitive' } },
      { lastName: { contains: String(search), mode: 'insensitive' } },
    ];
  }
  // Non-super-admins can only see users in their organization.
  if (actor.platformRole !== 'SUPER_ADMIN') {
    where.memberships = { some: { organizationId: actor.organizationId } };
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: { id: true, email: true, displayName: true, firstName: true, lastName: true, imageUrl: true, platformRole: true, status: true, emailVerified: true, lastActiveAt: true, createdAt: true, suspendedAt: true, _count: { select: { attempts: true, exams: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

async function getUser(userId, actor = {}) {
  assertAdmin(actor);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true } } } }, _count: { select: { attempts: true, exams: true, certificates: true, questions: true } } },
  });
  if (!user) throw ApiError.notFound('User not found');
  if (actor.platformRole !== 'SUPER_ADMIN') {
    const inOrg = (user.memberships ?? []).some((m) => m.organizationId === actor.organizationId);
    if (!inOrg) throw ApiError.forbidden('Access denied');
  }
  const { memberships, ...rest } = user;
  void memberships;
  return { ...rest, organizations: memberships.map((m) => ({ id: m.organization?.id, name: m.organization?.name, role: m.role })) };
}

async function setUserRole(userId, { platformRole }, actor = {}) {
  assertSuperAdmin(actor);
  if (!['SUPER_ADMIN', 'ADMIN', 'USER'].includes(platformRole)) throw ApiError.badRequest('Invalid platform role', { allowed: ['SUPER_ADMIN', 'ADMIN', 'USER'] });
  const updated = await prisma.user.update({ where: { id: userId }, data: { platformRole } });
  await recordAudit({ action: 'USER_ROLE_CHANGED', entityType: 'User', entityId: userId, actor, metadata: { platformRole }, isSensitive: true });
  logger.warn('platform role changed', { userId, platformRole, by: actor.userId });
  return { userId, platformRole: updated.platformRole };
}

async function suspendUser(userId, { reason = null } = {}, actor = {}) {
  assertAdmin(actor);
  await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
  await notifyUser({ userId, type: 'ANNOUNCEMENT', title: 'Account suspended', body: reason ?? 'Your account has been suspended. Contact support for details.' }).catch(() => null);
  await recordAudit({ action: 'USER_SUSPENDED', entityType: 'User', entityId: userId, actor, metadata: { reason } });
  return { suspended: true, userId };
}

async function reactivateUser(userId, actor = {}) {
  assertAdmin(actor);
  await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE', suspendedAt: null, deactivatedAt: null } });
  await recordAudit({ action: 'USER_REACTIVATED', entityType: 'User', entityId: userId, actor });
  return { active: true, userId };
}

async function deleteUser(userId, actor = {}) {
  assertSuperAdmin(actor);
  if (userId === actor.userId) throw ApiError.badRequest('You cannot delete your own account here');
  const attemptCount = await prisma.attempt.count({ where: { userId } });
  if (attemptCount > 0) throw ApiError.conflict('User has attempt history; suspend instead of deleting', { attemptCount });
  await prisma.user.delete({ where: { id: userId } });
  await recordAudit({ action: 'USER_DELETED', entityType: 'User', entityId: userId, actor, isSensitive: true });
  return { deleted: true, userId };
}

// ---------------------------------------------------------------------------
// Exam catalog management (public catalog)
// ---------------------------------------------------------------------------

async function listPublicExamCatalog({ search, category, page = 1, limit = 30 } = {}, actor = {}) {
  assertAdmin(actor);
  const where = { accessControl: 'PUBLIC', status: { in: ['PUBLISHED', 'ACTIVE', 'CLOSED'] } };
  if (search) where.OR = [{ title: { contains: String(search), mode: 'insensitive' } }, { description: { contains: String(search), mode: 'insensitive' } }];
  if (category) where.categoryId = category;

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: { id: true, title: true, slug: true, type: true, status: true, thumbnailUrl: true, description: true, durationMinutes: true, questionCount: true, totalMarks: true, passingPercent: true, examFeeCents: true, totalAttempts: true, totalRegistrations: true, averageScore: true, passRate: true, publishedAt: true, isProctored: true, organization: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.exam.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// Subscription / plan / revenue management
// ---------------------------------------------------------------------------

async function listAllSubscriptions({ status, plan, page = 1, limit = 30 } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const where = {};
  if (status) where.status = status;
  if (plan) where.planId = (await prisma.subscriptionPlan.findUnique({ where: { code: plan }, select: { id: true } }))?.id ?? '__none__';

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.organizationSubscription.findMany({
      where,
      orderBy: { currentPeriodEnd: 'asc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      include: { plan: { select: { code: true, name: true, priceMonthly: true } }, organization: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.organizationSubscription.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

async function updatePlan(planCode, patch = {}, actor = {}) {
  assertSuperAdmin(actor);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
  if (!plan) throw ApiError.notFound('Plan not found');
  const data = {};
  const numericFields = ['priceMonthly', 'priceYearly', 'maxExams', 'maxCandidatesPerExam', 'maxAiRequestsPerDay', 'maxStorageMb', 'sortOrder'];
  for (const field of numericFields) if (patch[field] !== undefined) data[field] = Number(patch[field]);
  const boolFields = ['isProctoringIncluded', 'isWhiteLabelIncluded', 'isAdaptiveIncluded', 'isLiveQuizIncluded', 'isPopular', 'isActive'];
  for (const field of boolFields) if (patch[field] !== undefined) data[field] = Boolean(patch[field]);
  if (patch.name !== undefined) data.name = String(patch.name);
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.features !== undefined) data.features = patch.features;
  if (patch.limits !== undefined) data.limits = patch.limits;
  if (patch.stripePriceId !== undefined) data.stripePriceId = patch.stripePriceId;

  const updated = await prisma.subscriptionPlan.update({ where: { id: plan.id }, data });
  await recordAudit({ action: 'PLAN_UPDATED', entityType: 'SubscriptionPlan', entityId: plan.id, actor, metadata: { planCode, changed: Object.keys(data) } });
  return updated;
}

async function platformRevenueSummary({ from, to } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const where = { status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] } };
  if (from || to) where.paidAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  const [aggregate, byPurpose, byProvider, topOrgs] = await Promise.all([
    prisma.payment.aggregate({ where, _sum: { amountCents: true, feeCents: true, netCents: true, refundedCents: true }, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['purpose'], where, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['provider'], where, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['organizationId'], where, _sum: { amountCents: true }, _count: { _all: true }, orderBy: { _sum: { amountCents: 'desc' } }, take: 10 }),
  ]);

  const orgIds = topOrgs.map((row) => row.organizationId).filter(Boolean);
  const orgs = await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, slug: true } });
  const orgMap = Object.fromEntries(orgs.map((org) => [org.id, org.name]));

  return {
    grossCents: aggregate._sum.amountCents ?? 0,
    feeCents: aggregate._sum.feeCents ?? 0,
    netCents: aggregate._sum.netCents ?? 0,
    refundedCents: aggregate._sum.refundedCents ?? 0,
    transactionCount: aggregate._count._all,
    byPurpose: byPurpose.map((row) => ({ purpose: row.purpose, totalCents: row._sum.amountCents ?? 0, count: row._count._all })),
    byProvider: byProvider.map((row) => ({ provider: row.provider, totalCents: row._sum.amountCents ?? 0, count: row._count._all })),
    topOrganizations: topOrgs.map((row) => ({ organizationId: row.organizationId, name: orgMap[row.organizationId] ?? 'Unknown', totalCents: row._sum.amountCents ?? 0, count: row._count._all })),
  };
}

// ---------------------------------------------------------------------------
// AI usage monitoring
// ---------------------------------------------------------------------------

async function aiUsageMonitor({ organizationId, feature, days = 30 } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const since = new Date(Date.now() - Math.min(Number(days) || 30, 365) * 86_400_000);
  const where = { createdAt: { gte: since } };
  if (organizationId) where.organizationId = organizationId;
  if (feature) where.feature = feature;

  const [byOrg, byFeature, total, recent] = await Promise.all([
    prisma.aiUsageLog.groupBy({ by: ['organizationId'], where, _count: { _all: true }, _sum: { costUsd: true, totalTokens: true } }),
    prisma.aiUsageLog.groupBy({ by: ['feature'], where, _count: { _all: true }, _sum: { costUsd: true } }),
    prisma.aiUsageLog.aggregate({ where, _sum: { costUsd: true, promptTokens: true, completionTokens: true }, _count: { _all: true }, _avg: { latencyMs: true } }),
    prisma.aiUsageLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, feature: true, aiModel: true, status: true, costUsd: true, totalTokens: true, latencyMs: true, createdAt: true, organizationId: true } }),
  ]);

  const orgIds = byOrg.map((row) => row.organizationId).filter(Boolean);
  const orgs = await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, slug: true } });
  const orgMap = Object.fromEntries(orgs.map((org) => [org.id, org.name]));

  return {
    windowDays: Math.min(Number(days) || 30, 365),
    totalCalls: total._count._all,
    totalCostUsd: Number(total._sum.costUsd ?? 0),
    totalTokens: (total._sum.promptTokens ?? 0) + (total._sum.completionTokens ?? 0),
    averageLatencyMs: total._avg.latencyMs ?? null,
    byOrganization: byOrg.map((row) => ({ organizationId: row.organizationId, name: orgMap[row.organizationId] ?? 'Unknown', calls: row._count._all, costUsd: Number(row._sum.costUsd ?? 0), tokens: row._sum.totalTokens ?? 0 })),
    byFeature: byFeature.map((row) => ({ feature: row.feature, calls: row._count._all, costUsd: Number(row._sum.costUsd ?? 0) })),
    recent,
  };
}

// ---------------------------------------------------------------------------
// Proctoring incidents overview
// ---------------------------------------------------------------------------

async function proctoringIncidents({ days = 30, organizationId, severity, page = 1, limit = 30 } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const since = new Date(Date.now() - Math.min(Number(days) || 30, 365) * 86_400_000);
  const where = { occurredAt: { gte: since } };
  if (organizationId) where.attempt = { exam: { organizationId } };
  if (severity) where.severity = severity;

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [totalViolations, byType, bySeverity, items, total] = await Promise.all([
    prisma.violation.count({ where: { occurredAt: { gte: since } } }),
    prisma.violation.groupBy({ by: ['type'], where: { occurredAt: { gte: since } }, _count: { _all: true } }),
    prisma.violation.groupBy({ by: ['severity'], where: { occurredAt: { gte: since } }, _count: { _all: true } }),
    prisma.violation.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, select: { id: true, type: true, severity: true, occurredAt: true, attemptId: true, examId: true, userId: true, isResolved: true, description: true } }),
    prisma.violation.count({ where }),
  ]);

  return {
    windowDays: Math.min(Number(days) || 30, 365),
    totalViolations,
    byType: byType.map((row) => ({ type: row.type, count: row._count._all })).sort((a, b) => b.count - a.count),
    bySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row._count._all])),
    items,
    total,
    page: safePage,
    limit: safeLimit,
  };
}

// ---------------------------------------------------------------------------
// Platform announcements
// ---------------------------------------------------------------------------

async function createAnnouncement(input = {}, actor = {}) {
  assertAdmin(actor);
  const audience = input.audience ?? 'ALL_USERS';
  if (audience !== 'ALL_USERS') assertSuperAdmin(actor);

  const announcement = await prisma.announcement.create({
    data: {
      title: String(input.title).slice(0, 200),
      body: String(input.body),
      audience,
      organizationId: audience === 'ORGANIZATION' ? (input.organizationId ?? actor.organizationId) : null,
      examId: audience === 'EXAM_CANDIDATES' ? input.examId ?? null : null,
      bannerUrl: input.bannerUrl ?? null,
      actionUrl: input.actionUrl ?? null,
      isPublished: input.publish !== false,
      publishedAt: input.publish !== false ? new Date() : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: actor.userId,
    },
  });

  await recordAudit({ action: 'ANNOUNCEMENT_CREATED', entityType: 'Announcement', entityId: announcement.id, actor, organizationId: announcement.organizationId });

  if (announcement.isPublished && audience === 'ALL_USERS') {
    const users = await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 10_000 });
    await notifyMany({ userIds: users.map((u) => u.id), type: 'ANNOUNCEMENT', title: announcement.title, body: announcement.body, actionUrl: announcement.actionUrl }).catch(() => null);
  }

  return announcement;
}

async function listAnnouncements({ organizationId, examId, page = 1, limit = 20 } = {}, actor = {}) {
  assertAdmin(actor);
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') {
    where.OR = [{ audience: 'ALL_USERS' }, ...(actor.organizationId ? [{ organizationId: actor.organizationId }] : [])];
  } else if (organizationId) where.organizationId = organizationId;
  if (examId) where.examId = examId;

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.announcement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { createdBy: { select: { displayName: true } } } }),
    prisma.announcement.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

async function updateAnnouncement(announcementId, patch = {}, actor = {}) {
  assertAdmin(actor);
  const existing = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  if (existing.audience === 'ALL_USERS') assertSuperAdmin(actor);
  const data = {};
  if (patch.title !== undefined) data.title = String(patch.title).slice(0, 200);
  if (patch.body !== undefined) data.body = String(patch.body);
  if (patch.isPublished !== undefined) { data.isPublished = patch.isPublished; if (patch.isPublished) data.publishedAt = new Date(); }
  if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
  return prisma.announcement.update({ where: { id: announcementId }, data });
}

async function deleteAnnouncement(announcementId, actor = {}) {
  assertAdmin(actor);
  const existing = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  if (existing.audience === 'ALL_USERS') assertSuperAdmin(actor);
  await prisma.announcement.delete({ where: { id: announcementId } });
  return { deleted: true, announcementId };
}

// ---------------------------------------------------------------------------
// Platform settings + feature flags
// ---------------------------------------------------------------------------

async function listSettings(groupName, actor = {}) {
  assertAdmin(actor);
  const where = groupName ? { groupName } : {};
  return prisma.platformSetting.findMany({ where, orderBy: { key: 'asc' } });
}

async function updateSetting(key, value, { groupName = 'general', description = null } = {}, actor = {}) {
  assertSuperAdmin(actor);
  const setting = await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value, groupName, description, updatedById: actor.userId },
    update: { value, groupName, description, updatedById: actor.userId },
  });
  await recordAudit({ action: 'SETTING_UPDATED', entityType: 'PlatformSetting', entityId: setting.id, actor, metadata: { key }, isSensitive: true });
  return setting;
}

async function listFeatureFlags(actor = {}) {
  assertAdmin(actor);
  return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

async function setFeatureFlag(key, patch = {}, actor = {}) {
  assertSuperAdmin(actor);
  const existing = await prisma.featureFlag.findUnique({ where: { key } });
  const data = {
    key,
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.rolloutPercent !== undefined ? { rolloutPercent: Math.max(0, Math.min(100, Number(patch.rolloutPercent))) } : {}),
    ...(patch.planTiers !== undefined ? { planTiers: patch.planTiers } : {}),
    ...(patch.config !== undefined ? { config: patch.config } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    updatedById: actor.userId,
  };
  const flag = existing
    ? await prisma.featureFlag.update({ where: { id: existing.id }, data })
    : await prisma.featureFlag.create({ data });
  await recordAudit({ action: 'FEATURE_FLAG_UPDATED', entityType: 'FeatureFlag', entityId: flag.id, actor, metadata: { key, enabled: flag.enabled } });
  return flag;
}

// ---------------------------------------------------------------------------
// Certificate verification system management
// ---------------------------------------------------------------------------

async function pendingCertificateVerifications({ page = 1, limit = 30 } = {}, actor = {}) {
  assertAdmin(actor);
  const where = { status: 'PENDING' };
  if (actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;

  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.certificate.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, select: { id: true, certificateNo: true, candidateName: true, examTitle: true, scorePercent: true, issuedAt: true, createdAt: true, examId: true, organizationId: true } }),
    prisma.certificate.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// System health check
// ---------------------------------------------------------------------------

async function systemHealth(actor = {}) {
  assertSuperAdmin(actor);
  const startedAt = Date.now();
  const results = {};

  // Database roundtrip.
  try { await prisma.$queryRaw`SELECT 1`; results.database = { ok: true, latencyMs: Date.now() - startedAt }; }
  catch (e) { results.database = { ok: false, error: e.message }; }

  // Puppeteer availability.
  try {
    const puppeteer = require('../config/puppeteer');
    results.pdf = { ok: puppeteer.isAvailable(), reason: puppeteer.isAvailable() ? null : 'CHROMIUM_NOT_INSTALLED' };
  } catch (e) { results.pdf = { ok: false, error: e.message }; }

  // Stripe availability.
  const stripe = require('../config/stripe');
  results.stripe = { ok: Boolean(stripe.stripe), reason: stripe.stripe ? null : 'NOT_CONFIGURED' };

  // AI / OpenRouter availability.
  const openrouter = require('../config/openrouter');
  results.ai = { ok: openrouter.isConfigured(), reason: openrouter.isConfigured() ? null : 'NOT_CONFIGURED' };

  results.config = {
    isProduction: env.isProduction,
    uploadRoot: env.uploadRoot,
    maxFileBytes: env.maxFileBytes,
    aiDailyLimitFree: env.AI_DAILY_LIMIT_FREE,
    aiDailyLimitStarter: env.AI_DAILY_LIMIT_STARTER,
  };
  results.uptimeSec = Math.round(process.uptime());

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  assertSuperAdmin,
  assertAdmin,
  recordAudit,
  listAuditLogs,
  platformOverview,
  listOrganizations,
  getOrganization,
  approveOrganization,
  suspendOrganization,
  reactivateOrganization,
  deleteOrganization,
  listUsers,
  getUser,
  setUserRole,
  suspendUser,
  reactivateUser,
  deleteUser,
  listPublicExamCatalog,
  listAllSubscriptions,
  updatePlan,
  platformRevenueSummary,
  aiUsageMonitor,
  proctoringIncidents,
  createAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  deleteAnnouncement,
  listSettings,
  updateSetting,
  listFeatureFlags,
  setFeatureFlag,
  pendingCertificateVerifications,
  systemHealth,
};
