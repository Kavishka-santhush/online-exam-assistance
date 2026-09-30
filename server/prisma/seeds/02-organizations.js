const { slugify } = require('./lib/utils');
const { organizations } = require('./data/organizations');

/** One user deliberately belongs to two organizations with different roles. */
const MULTI_ORG_EMAILS = new Set(['cand.01@mail.example', 'proctor.kowalski@northgate.example.edu']);

function clerkIdFor(email) {
  return `seed_user_${slugify(email.split('@')[0])}`;
}

function splitName(displayName) {
  const parts = String(displayName || '').replace(/^(Prof\.|Dr\.)\s*/i, '').split(' ');
  return { firstName: parts.shift() ?? displayName, lastName: parts.join(' ') || 'User' };
}

module.exports = async function seed(prisma, ctx) {
  const orgs = {};
  let userCount = ctx.userCount ?? 0;

  for (const fixture of organizations) {
    const plan = ctx.plans[fixture.planCode];

    const org = await prisma.organization.upsert({
      where: { slug: fixture.key },
      update: {
        name: fixture.name,
        description: fixture.description,
        industry: fixture.industry,
        website: fixture.website,
        contactEmail: fixture.contactEmail,
        city: fixture.city,
        country: fixture.country,
        isApproved: fixture.isApproved,
        isWhiteLabel: fixture.isWhiteLabel ?? false,
        branding: fixture.branding,
        defaultExamSettings: fixture.defaultExamSettings,
        settings: fixture.settings,
        createdById: ctx.superAdmin.id,
      },
      create: {
        slug: fixture.key,
        name: fixture.name,
        description: fixture.description,
        industry: fixture.industry,
        website: fixture.website,
        contactEmail: fixture.contactEmail,
        city: fixture.city,
        country: fixture.country,
        logoUrl: fixture.branding.logoUrl ?? null,
        emailSender: fixture.branding.emailSenderName ?? fixture.name,
        isApproved: fixture.isApproved,
        isWhiteLabel: fixture.isWhiteLabel ?? false,
        customDomain: fixture.customDomain ?? null,
        branding: fixture.branding,
        defaultExamSettings: fixture.defaultExamSettings,
        settings: fixture.settings,
        createdById: ctx.superAdmin.id,
      },
    });

    for (const [key, value] of Object.entries(fixture.settings)) {
      await prisma.organizationSetting.upsert({
        where: { organizationId_key: { organizationId: org.id, key } },
        update: { value },
        create: { organizationId: org.id, key, value },
      });
    }

    await prisma.organizationSubscription.upsert({
      where: { organizationId: org.id },
      update: { planId: plan.id, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      create: {
        organizationId: org.id,
        planId: plan.id,
        status: 'ACTIVE',
        seats: fixture.members.length * 4,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        stripeCustomerId: `cus_seed_${slugify(fixture.key)}`,
        stripeSubscriptionId: `sub_seed_${slugify(fixture.key)}`,
      },
    });

    const members = {};
    for (const member of fixture.members) {
      const email = member.email.trim();
      const clerkId = clerkIdFor(email);
      const { firstName, lastName } = splitName(member.displayName);

      const user = await prisma.user.upsert({
        where: { clerkId },
        update: { email, displayName: member.displayName, status: 'ACTIVE' },
        create: {
          clerkId,
          email,
          firstName,
          lastName,
          displayName: member.displayName,
          emailVerified: true,
          status: 'ACTIVE',
          timezone: fixture.settings.timezone,
          language: fixture.settings.language,
          imageUrl: `/uploads/avatars/${slugify(member.displayName)}.svg`,
        },
      });
      userCount += 1;

      if (member.role === 'CANDIDATE') {
        await prisma.candidateProfile.upsert({
          where: { userId: user.id },
          update: {},
          create: {
            userId: user.id,
            headline: 'Candidate',
            institution: fixture.name,
            degree: member.department ?? 'Not specified',
            graduationYear: 2026,
            educationJson: [{ institution: fixture.name, degree: 'BSc', year: 2024 }],
            skillsJson: ['communication', 'time-management'],
            interestsJson: ['online-learning', 'certifications'],
            goals: 'Pass certification exams and collect verifiable certificates.',
          },
        });
      }

      if (member.role === 'INSTRUCTOR' || member.role === 'ORG_ADMIN') {
        await prisma.instructorProfile.upsert({
          where: { userId: user.id },
          update: { expertise: [fixture.industry, member.department ?? 'general'] },
          create: {
            userId: user.id,
            expertise: [fixture.industry, member.department ?? 'general'],
            bio: `${member.displayName} - ${member.department ?? 'faculty'} at ${fixture.name}.`,
            website: fixture.website,
            rating: 4.5,
            ratingCount: 24,
            verified: true,
          },
        });
      }

      await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: { role: member.role, status: 'ACTIVE', department: member.department ?? null },
        create: {
          organizationId: org.id,
          userId: user.id,
          role: member.role,
          department: member.department ?? null,
          displayName: member.displayName,
          permissions: [],
          invitedById: ctx.superAdmin.id,
        },
      });

      members[email] = user;
      ctx[email] = user;
      ctx[`${fixture.key}:${member.role}`] = ctx[`${fixture.key}:${member.role}`] ?? user;
    }

    // Candidate pools: bulk-imported candidates that are not members yet
    await prisma.organizationInvite.upsert({
      where: { token: `seed-invite-${fixture.key}-instructor` },
      update: {},
      create: {
        organizationId: org.id,
        email: `pending.instructor@${slugify(fixture.name)}.example.org`,
        role: 'INSTRUCTOR',
        token: `seed-invite-${fixture.key}-instructor`,
        message: 'You have been invited to join the instructor team.',
        status: 'PENDING',
        invitedById: members[fixture.members[0].email.trim()]?.id ?? ctx.superAdmin.id,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });

    orgs[fixture.key] = { org, members, plan, fixture };
    ctx[fixture.key] = org;
  }

  ctx.orgs = orgs;
  ctx.organizationCount = Object.keys(orgs).length;
  ctx.userCount = userCount;
  console.log(`  · ${ctx.organizationCount} organizations, ${userCount} users, memberships + invites`);

  // Cross-organization membership is exercised by MULTI_ORG_EMAILS above: the
  // same seeded user id is attached to more than one organization row.
  for (const email of MULTI_ORG_EMAILS) {
    const user = ctx[email];
    if (!user) continue;
    const extraOrg = email.startsWith('cand.') ? ctx.orgs['vertex-cloud'].org : ctx.orgs['meridian-institute'].org;
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: extraOrg.id, userId: user.id } },
      update: {},
      create: {
        organizationId: extraOrg.id,
        userId: user.id,
        role: email.startsWith('cand.') ? 'CANDIDATE' : 'PROCTOR',
        displayName: user.displayName,
      },
    });
  }
};
