/**
 * Organization service: tenants, members, invites, settings and subscription
 * metadata. Every method is organization-scoped - nothing here crosses tenants
 * except the platform-admin listing at the bottom.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { sendInvites } = require('./notification.service');

const MEMBER_INCLUDE = {
  user: {
    select: {
      id: true, email: true, firstName: true, lastName: true, displayName: true,
      imageUrl: true, status: true, timezone: true, lastActiveAt: true, platformRole: true,
    },
  },
  inviter: { select: { id: true, displayName: true, email: true } },
};

const DEFAULT_ORG_SETTINGS = {
  allowSelfRegistration: true,
  requireEmailVerification: false,
  defaultExamAccess: 'ORGANIZATION',
  resultsVisibility: 'AFTER_GRADING',
  candidateSeeCorrectAnswers: false,
  certificateAutoIssue: true,
  proctoringDefault: 'STANDARD',
  locale: 'en',
  timezone: 'UTC',
  gradingDeadlineDays: 7,
};

const DEFAULT_BRANDING = {
  primaryColor: '#4f46e5',
  accentColor: '#0ea5e9',
  logoUrl: null,
  faviconUrl: null,
  emailSenderName: null,
  applicationName: null,
  hidePlatformBranding: false,
};

/**
 * Create the tenant and its FREE subscription in one transaction, then make the
 * creator an ORG_ADMIN so the UI always has an owner.
 */
async function createOrganization({ payload, actor }) {
  const slug = await uniqueSlug(payload.slug || payload.name);
  const freePlan = await prisma.subscriptionPlan.findFirst({ where: { code: 'FREE' } });

  const organization = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: {
        name: payload.name,
        slug,
        description: payload.description ?? null,
        website: payload.website ?? null,
        contactEmail: payload.contactEmail ?? actor.email ?? null,
        contactPhone: payload.contactPhone ?? null,
        industry: payload.industry ?? null,
        addressLine1: payload.addressLine1 ?? null,
        city: payload.city ?? null,
        country: payload.country ?? null,
        taxId: payload.taxId ?? null,
        logoUrl: payload.logoUrl ?? null,
        emailSender: payload.emailSender ?? null,
        branding: { ...DEFAULT_BRANDING, ...(payload.branding ?? {}) },
        settings: { ...DEFAULT_ORG_SETTINGS, ...(payload.settings ?? {}) },
        defaultExamSettings: payload.defaultExamSettings ?? {},
        // Self-serve tenants are live as soon as a plan row exists; a platform
        // admin can still revoke access through the admin dashboard.
        isApproved: payload.isApproved === undefined ? Boolean(freePlan) : Boolean(payload.isApproved),
        createdById: actor.userId,
      },
    });

    if (freePlan) {
      await tx.organizationSubscription.create({
        data: {
          organizationId: created.id,
          planId: freePlan.id,
          status: 'ACTIVE',
          seats: Math.max(1, Number(payload.seats) || 10),
          currentPeriodStart: new Date(),
          currentPeriodEnd: endOfPeriod(new Date(), 'year'),
        },
      });
    }

    await tx.organizationMember.create({
      data: { organizationId: created.id, userId: actor.userId, role: 'ORG_ADMIN', status: 'ACTIVE' },
    });

    return created;
  });

  logger.info('organization created', { organizationId: organization.id, actorId: actor.userId });
  return getOrganization(organization.id, actor.userId);
}

async function uniqueSlug(base) {
  const cleaned = normaliseSlug(base) || `org-${crypto.randomBytes(3).toString('hex')}`;
  let candidate = cleaned;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!existing) return candidate;
    candidate = `${cleaned}-${attempt}`;
  }
}

function normaliseSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-|-$/g, '');
}

function endOfPeriod(from, interval) {
  const date = new Date(from);
  if (interval === 'year') date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  date.setDate(date.getDate() - 1);
  return date;
}

/** Full organization detail, including the caller's own membership. */
async function getOrganization(organizationId, requesterId) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: { include: { plan: true } },
      settingRows: true,
      createdBy: { select: { id: true, displayName: true, email: true } },
      _count: { select: { members: true, exams: true, attempts: true, questionBanks: true, certificates: true } },
    },
  });
  if (!organization) throw ApiError.notFound('Organization not found');

  const membership = requesterId
    ? await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: requesterId } },
    })
    : null;

  const [storage, activeExams] = await Promise.all([
    prisma.uploadedFile.aggregate({
      where: { organizationId },
      _sum: { sizeBytes: true },
      _count: { _all: true },
    }),
    prisma.exam.count({ where: { organizationId, status: { in: ['PUBLISHED', 'ACTIVE', 'SCHEDULED'] } } }),
  ]);

  return {
    ...organization,
    settingRows: undefined,
    settings: { ...DEFAULT_ORG_SETTINGS, ...(organization.settings ?? {}), ...rowsToObject(organization.settingRows) },
    branding: { ...DEFAULT_BRANDING, ...(organization.branding ?? {}) },
    membership: membership ? { role: membership.role, permissions: membership.permissions } : null,
    usage: {
      members: organization._count.members,
      exams: organization._count.exams,
      activeExams,
      attempts: organization._count.attempts,
      certificates: organization._count.certificates,
      banks: organization._count.questionBanks,
      storageBytes: storage._sum.sizeBytes ?? 0,
      files: storage._count._all,
    },
  };
}

function rowsToObject(rows = []) {
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

async function listOrganizations({ search, page = 1, limit = 20, userId } = {}) {
  const where = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
      { industry: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (userId) {
    where.members = { some: { userId, status: 'ACTIVE' } };
  }

  const [items, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      include: {
        subscription: { include: { plan: { select: { code: true, name: true } } } },
        _count: { select: { members: true, exams: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.organization.count({ where }),
  ]);

  return { items, total, page, limit };
}

/** Organizations the user belongs to - drives the tenant switcher. */
async function listMyOrganizations(userId) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, status: { in: ['ACTIVE', 'PENDING'] } },
    include: {
      organization: { include: { subscription: { include: { plan: { select: { code: true, name: true } } } } } },
    },
    orderBy: { joinedAt: 'asc' },
  });
  return memberships.map((membership) => ({
    id: membership.organizationId,
    role: membership.role,
    status: membership.status,
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      logoUrl: membership.organization.logoUrl,
      branding: membership.organization.branding,
      planCode: membership.organization.subscription?.plan?.code ?? 'FREE',
    },
  }));
}

const EDITABLE_FIELDS = [
  'name', 'description', 'website', 'contactEmail', 'contactPhone', 'addressLine1',
  'city', 'country', 'industry', 'taxId', 'logoUrl', 'emailSender', 'customDomain',
];

async function updateOrganization(organizationId, payload = {}) {
  const data = {};
  for (const field of EDITABLE_FIELDS) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }
  if (payload.branding) data.branding = { ...DEFAULT_BRANDING, ...(payload.branding ?? {}) };
  if (payload.settings) data.settings = { ...DEFAULT_ORG_SETTINGS, ...(payload.settings ?? {}) };
  if (payload.defaultExamSettings) data.defaultExamSettings = payload.defaultExamSettings;
  if (payload.isWhiteLabel !== undefined) data.isWhiteLabel = Boolean(payload.isWhiteLabel);

  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');

  if (payload.slug) {
    const slug = normaliseSlug(payload.slug);
    const clash = await prisma.organization.findFirst({ where: { slug, id: { not: organizationId } } });
    if (clash) throw ApiError.conflict('That URL is already taken by another organization');
    data.slug = slug;
  }

  return prisma.organization.update({ where: { id: organizationId }, data });
}

/**
 * Key/value settings live in `OrganizationSetting` when they must be indexed or
 * audited individually; anything else stays in the `settings` JSON blob.
 */
async function upsertSettings(organizationId, entries = {}, actorId) {
  const pairs = Object.entries(entries);
  if (!pairs.length) throw ApiError.badRequest('Provide at least one setting key');

  await prisma.$transaction(pairs.map(([key, value]) => prisma.organizationSetting.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { value: value ?? null },
    create: { organizationId, key, value: value ?? null },
  })));

  // Mirror onto the JSON blob so single-read consumers stay cheap.
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  const merged = { ...(organization.settings ?? {}), ...entries };
  await prisma.organization.update({ where: { id: organizationId }, data: { settings: merged } });

  logger.debug('organization settings updated', { organizationId, actorId, keys: pairs.map(([key]) => key) });
  return merged;
}

async function listMembers({ organizationId, search, role, status, page = 1, limit = 25 }) {
  const where = { organizationId };
  if (role) where.role = role;
  if (status) where.status = status;
  if (search) {
    where.user = {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.organizationMember.findMany({
      where,
      include: MEMBER_INCLUDE,
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.organizationMember.count({ where }),
  ]);

  return { items, total, page, limit };
}

async function getMember(organizationId, userId) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: MEMBER_INCLUDE,
  });
  if (!member) throw ApiError.notFound('That person is not a member of this organization');
  return member;
}

/** Change role / permissions / department. Never demote the last admin here. */
async function updateMember({ organizationId, userId, role, permissions, department, employeeId, displayName, status }, actor) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!member) throw ApiError.notFound('Member not found');

  const data = {};
  if (role && role !== member.role) {
    if (member.role === 'ORG_ADMIN') {
      const remaining = await prisma.organizationMember.count({
        where: { organizationId, role: 'ORG_ADMIN', status: 'ACTIVE', id: { not: member.id } },
      });
      if (remaining === 0) throw ApiError.conflict('This organization must keep at least one active admin');
    }
    data.role = role;
  }
  if (permissions !== undefined) data.permissions = permissions;
  if (department !== undefined) data.department = department;
  if (employeeId !== undefined) data.employeeId = employeeId;
  if (displayName !== undefined) data.displayName = displayName;
  if (status !== undefined) data.status = status;

  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');

  const updated = await prisma.organizationMember.update({ where: { id: member.id }, data, include: MEMBER_INCLUDE });
  await ensureProfileRowsForMember(userId, data.role ?? member.role);

  logger.info('organization member updated', { organizationId, userId, actorId: actor?.userId, changes: Object.keys(data) });
  return updated;
}

async function ensureProfileRowsForMember(userId, role) {
  if (!role) return;
  if (['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(role)) {
    await prisma.instructorProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  } else {
    await prisma.candidateProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  }
}

/** Removing a member keeps their attempts - FKs are SetNull/Cascade by design. */
async function removeMember({ organizationId, userId, reason }, actor) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!member) throw ApiError.notFound('Member not found');

  if (member.role === 'ORG_ADMIN') {
    const remaining = await prisma.organizationMember.count({
      where: { organizationId, role: 'ORG_ADMIN', status: 'ACTIVE', id: { not: member.id } },
    });
    if (remaining === 0) throw ApiError.conflict('Transfer ownership before removing the last admin');
  }

  await prisma.organizationMember.delete({ where: { id: member.id } });
  logger.info('organization member removed', { organizationId, userId, actorId: actor?.userId, reason: reason ?? null });
  return { removed: true, userId };
}

/**
 * Invite by email. An existing user gets a member row straight away (PENDING);
 * a stranger gets an `OrganizationInvite` that is accepted through auth.service.
 */
async function inviteMembers({ organizationId, invites = [], message }, actor) {
  if (!invites.length) throw ApiError.badRequest('Add at least one email address');
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!organization) throw ApiError.notFound('Organization not found');

  const results = [];
  for (const invite of invites) {
    const email = String(invite.email).trim().toLowerCase();
    const role = invite.role ?? 'CANDIDATE';
    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      const membership = await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId, userId: existingUser.id } },
        update: { role, status: 'PENDING' },
        create: { organizationId, userId: existingUser.id, role, status: 'PENDING', invitedById: actor?.userId ?? null },
      });
      results.push({ email, status: 'MEMBER_ADDED', membershipId: membership.id, userId: membership.userId });
      continue;
    }

    const existing = await prisma.organizationInvite.findFirst({
      where: { organizationId, email, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const refreshed = await prisma.organizationInvite.update({
        where: { id: existing.id },
        data: {
          role,
          message: message ?? existing.message,
          invitedById: actor?.userId ?? existing.invitedById,
          expiresAt: addDays(new Date(), 14),
        },
      });
      results.push({ email, status: 'INVITED', inviteId: refreshed.id });
      continue;
    }

    const token = crypto.randomBytes(24).toString('hex');
    const record = await prisma.organizationInvite.create({
      data: {
        organizationId,
        email,
        role,
        token,
        message: message ?? null,
        invitedById: actor?.userId ?? null,
        expiresAt: addDays(new Date(), 14),
      },
    });
    results.push({ email, status: 'INVITED', inviteId: record.id });
  }

  await sendInvites({ organization, results, message, invitedBy: actor?.displayName ?? actor?.email ?? null })
    .catch((error) => logger.warn('invite mail dispatch failed', { organizationId, error: error.message }));

  return results;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function listInvites({ organizationId, status, page = 1, limit = 25 }) {
  const where = { organizationId };
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.organizationInvite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.organizationInvite.count({ where }),
  ]);
  return { items, total, page, limit };
}

async function resendInvite({ organizationId, inviteId }) {
  const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.organizationId !== organizationId) throw ApiError.notFound('Invitation not found');
  if (invite.status === 'ACCEPTED') throw ApiError.conflict('That invitation has already been accepted');

  const updated = await prisma.organizationInvite.update({
    where: { id: invite.id },
    data: { status: 'PENDING', expiresAt: addDays(new Date(), 14) },
  });

  await sendInvites({
    organization: await prisma.organization.findUnique({ where: { id: organizationId } }),
    results: [{ email: invite.email, status: 'INVITED', inviteId: invite.id }],
    message: invite.message,
    resent: true,
  }).catch((error) => logger.warn('invite resend failed', { inviteId, error: error.message }));

  return updated;
}

async function revokeInvite({ organizationId, inviteId }) {
  const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.organizationId !== organizationId) throw ApiError.notFound('Invitation not found');
  return prisma.organizationInvite.update({ where: { id: invite.id }, data: { status: 'REVOKED' } });
}

/** Departments for the roster filter chips. */
async function listDepartments(organizationId) {
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId, department: { not: null } },
    select: { department: true },
    distinct: ['department'],
    orderBy: { department: 'asc' },
  });
  return rows.map((row) => row.department).filter(Boolean);
}

/** Seat/usage summary for the billing page. */
async function getSubscription(organizationId) {
  const subscription = await prisma.organizationSubscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  if (!subscription) throw ApiError.notFound('This organization has no subscription yet');

  const [members, exams, questions, storage] = await Promise.all([
    prisma.organizationMember.count({ where: { organizationId, status: 'ACTIVE' } }),
    prisma.exam.count({ where: { organizationId } }),
    prisma.question.count({ where: { organizationId } }),
    prisma.uploadedFile.aggregate({ where: { organizationId }, _sum: { sizeBytes: true } }),
  ]);

  return {
    ...subscription,
    usage: {
      seatsUsed: members,
      seatsPurchased: subscription.seats,
      examsUsed: exams,
      questionsCreated: questions,
      storageUsedMb: Math.round(((storage._sum.sizeBytes ?? 0) / (1024 * 1024)) * 10) / 10,
      aiRequestsToday: subscription.aiRequestsUsedToday,
    },
    plan: {
      ...subscription.plan,
      isExpired: subscription.currentPeriodEnd < new Date() && subscription.status !== 'ACTIVE',
    },
  };
}

/** Manual plan assignment by a super admin (no Stripe involved). */
async function assignPlan({ organizationId, planCode, seats, months = 12, note }, actor) {
  const plan = await prisma.subscriptionPlan.findFirst({ where: { code: planCode } });
  if (!plan) throw ApiError.notFound(`Unknown plan ${planCode}`);

  const start = new Date();
  const data = {
    planId: plan.id,
    status: 'ACTIVE',
    currentPeriodStart: start,
    currentPeriodEnd: addDays(start, Math.max(1, Number(months)) * 30),
    seats: seats ? Number(seats) : undefined,
  };

  const subscription = await prisma.organizationSubscription.upsert({
    where: { organizationId },
    update: data,
    create: { organizationId, ...data, seats: seats ? Number(seats) : 10 },
    include: { plan: true },
  });

  logger.info('plan assigned', { organizationId, planCode, actorId: actor?.userId, note: note ?? null });
  return subscription;
}

async function suspendOrganization(organizationId, { suspended, reason }, actor) {
  const organization = await prisma.organization.update({
    where: { id: organizationId },
    data: { isSuspended: Boolean(suspended), suspendedAt: suspended ? new Date() : null },
  });
  await prisma.exam.updateMany({
    where: { organizationId, status: { in: ['PUBLISHED', 'ACTIVE', 'SCHEDULED'] } },
    data: suspended ? { status: 'CLOSED', closedAt: new Date() } : {},
  });
  logger.warn('organization suspension changed', { organizationId, suspended: Boolean(suspended), reason, actorId: actor?.userId });
  return organization;
}

/** Danger zone: only super admins reach this; everything cascades. */
async function deleteOrganization(organizationId, actor) {
  const counts = await prisma.exam.count({ where: { organizationId } });
  if (counts > 0) {
    throw ApiError.conflict('Archive the exams first - deleting an organization with exams is not offered in the API');
  }
  await prisma.organization.delete({ where: { id: organizationId } });
  logger.warn('organization deleted', { organizationId, actorId: actor?.userId });
  return { deleted: true, organizationId };
}

/** Public "sign up with your school" lookup used by the registration flow. */
async function findBySlugOrDomain(identifier) {
  const slug = normaliseSlug(identifier);
  return prisma.organization.findFirst({
    where: { OR: [{ slug }, { customDomain: identifier }] },
    include: { subscription: { include: { plan: { select: { code: true, name: true, features: true } } } } },
  });
}

module.exports = {
  DEFAULT_BRANDING,
  DEFAULT_ORG_SETTINGS,
  assignPlan,
  createOrganization,
  deleteOrganization,
  findBySlugOrDomain,
  getMember,
  getOrganization,
  getSubscription,
  inviteMembers,
  listDepartments,
  listInvites,
  listMembers,
  listMyOrganizations,
  listOrganizations,
  removeMember,
  resendInvite,
  revokeInvite,
  suspendOrganization,
  updateMember,
  updateOrganization,
  upsertSettings,
};
