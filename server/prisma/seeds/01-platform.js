const { slugify } = require('./lib/utils');
const { platformAdmins, subscriptionPlans } = require('./data/organizations');

const PLATFORM_SETTINGS = [
  { key: 'platform.name', groupName: 'general', value: { name: 'Exam Platform', tagline: 'Assess anywhere, proctor everything', supportEmail: 'support@examplatform.local' } },
  { key: 'platform.legal', groupName: 'general', value: { termsUrl: '/legal/terms', privacyUrl: '/legal/privacy', dataRetentionDays: 730 } },
  {
    key: 'platform.plans',
    groupName: 'billing',
    value: { defaultPlan: 'FREE', trialDays: 14, dunningDays: [3, 7, 14], annualDiscountPercent: 20 },
  },
  {
    key: 'platform.ai',
    groupName: 'ai',
    value: {
      defaultModel: 'openai/gpt-4o',
      maxInputChars: 24000,
      monthlyBudgetUsdPerOrg: { FREE: 0, STARTER: 15, PRO: 250, ENTERPRISE: 2000 },
      essayGradingEnabled: true,
      proctorAssistEnabled: true,
      requireHumanReviewOfAiGrades: true,
    },
  },
  {
    key: 'platform.proctoring',
    groupName: 'proctoring',
    value: {
      maxActiveSessionsPerProctor: 40,
      violationAutoTerminateCount: 8,
      recordingRetentionDays: 90,
      idVerificationRequiredPlans: ['PRO', 'ENTERPRISE'],
      blockedShortcuts: ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Shift+I', 'F12', 'Alt+Tab', 'Meta+Shift+C'],
    },
  },
  {
    key: 'platform.upload',
    groupName: 'storage',
    value: { maxFileMb: 50, allowedImage: ['png', 'jpg', 'jpeg', 'webp', 'gif'], allowedDocs: ['pdf', 'docx', 'xlsx', 'csv', 'zip'], allowedMedia: ['webm', 'mp3', 'wav', 'mp4'] },
  },
  { key: 'platform.certificates', groupName: 'certificates', value: { defaultValidityYears: 3, verificationBaseUrl: '/verify', digitalSignatureEnabled: true } },
];

const FEATURE_FLAGS = [
  { key: 'adaptive-testing', description: 'IRT-based adaptive exam path', enabled: true, rolloutPercent: 100, planTiers: ['PRO', 'ENTERPRISE'] },
  { key: 'live-quiz', description: 'Kahoot-style instructor hosted sessions', enabled: true, rolloutPercent: 100, planTiers: ['PRO', 'ENTERPRISE'] },
  { key: 'ai-essay-grader', description: 'OpenRouter essay scoring with human review', enabled: true, rolloutPercent: 50, planTiers: ['STARTER', 'PRO', 'ENTERPRISE'] },
  { key: 'ai-proctor-assistant', description: 'Real-time webcam behaviour analysis', enabled: false, rolloutPercent: 10, planTiers: ['ENTERPRISE'] },
  { key: 'white-label', description: 'Organization branding on the exam interface', enabled: true, rolloutPercent: 100, planTiers: ['PRO', 'ENTERPRISE'] },
  { key: 'coding-questions', description: 'Monaco editor + sandboxed test runner', enabled: true, rolloutPercent: 100, planTiers: ['STARTER', 'PRO', 'ENTERPRISE'] },
  { key: 'second-grader', description: 'Double marking with disagreement flag', enabled: true, rolloutPercent: 100, planTiers: ['ENTERPRISE'] },
  { key: 'open-badges', description: 'JSON-LD badge metadata alongside certificates', enabled: false, rolloutPercent: 0, planTiers: ['PRO', 'ENTERPRISE'] },
];

module.exports = async function seed(prisma, ctx) {
  const plans = {};
  for (const plan of subscriptionPlans) {
    plans[plan.code] = await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: plan,
      create: { ...plan, slug: slugify(plan.name) },
    });
  }
  console.log(`  · ${Object.keys(plans).length} subscription plans`);

  for (const setting of PLATFORM_SETTINGS) {
    await prisma.platformSetting.upsert({
      where: { key: setting.key },
      update: { value: setting.value, groupName: setting.groupName },
      create: setting,
    });
  }
  console.log(`  · ${PLATFORM_SETTINGS.length} platform settings`);

  for (const flag of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { enabled: flag.enabled, rolloutPercent: flag.rolloutPercent, planTiers: flag.planTiers },
      create: flag,
    });
  }
  console.log(`  · ${FEATURE_FLAGS.length} feature flags`);

  const admins = [];
  for (const admin of platformAdmins) {
    const user = await prisma.user.upsert({
      where: { clerkId: admin.clerkId },
      update: {
        email: admin.email,
        displayName: admin.displayName,
        platformRole: admin.platformRole,
        status: 'ACTIVE',
        emailVerified: true,
      },
      create: {
        clerkId: admin.clerkId,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        displayName: admin.displayName,
        platformRole: admin.platformRole,
        status: 'ACTIVE',
        emailVerified: true,
        timezone: 'UTC',
        language: 'en',
        bio: admin.bio,
      },
    });
    admins.push(user);
    ctx[user.email] = user;
  }
  console.log(`  · ${admins.length} platform admins`);

  ctx.plans = plans;
  ctx.superAdmin = admins.find((user) => user.platformRole === 'SUPER_ADMIN');
  ctx.opsAdmin = admins.find((user) => user.platformRole === 'ADMIN');
  ctx.userCount = admins.length;
};
