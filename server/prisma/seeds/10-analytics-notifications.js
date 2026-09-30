const { createRandom, daysFromNow, minutesAgo, roundTo } = require('./lib/utils');

const NOTIFICATION_TEMPLATES = [
  { type: 'EXAM_ASSIGNED', title: 'You have been assigned a new exam', actionUrl: '/exams', priority: 1 },
  { type: 'EXAM_REMINDER', title: 'Exam starts in 24 hours', actionUrl: '/exams?upcoming=1', priority: 2 },
  { type: 'RESULTS_RELEASED', title: 'Your results are available', actionUrl: '/results', priority: 3 },
  { type: 'CERTIFICATE_ISSUED', title: 'A certificate was issued to you', actionUrl: '/certificates', priority: 3 },
  { type: 'PROCTOR_MESSAGE', title: 'Message from your proctor', actionUrl: '/exams?proctor=1', priority: 5 },
  { type: 'PAYMENT_RECEIVED', title: 'Payment received', actionUrl: '/billing', priority: 0 },
];

const AI_SAMPLES = [
  {
    feature: 'QUESTION_GENERATOR',
    model: 'openai/gpt-4o',
    promptTokens: 612,
    completionTokens: 1480,
    outputSummary: 'Generated 8 MCQ + 2 short-answer items on TCP congestion control.',
  },
  {
    feature: 'ESSAY_GRADER',
    model: 'anthropic/claude-sonnet-4',
    promptTokens: 1840,
    completionTokens: 420,
    outputSummary: 'Awarded 14/20 across 4 rubric criteria with per-criterion justification.',
  },
  {
    feature: 'CHEATING_DETECTION',
    model: 'openai/gpt-4o-mini',
    promptTokens: 380,
    completionTokens: 96,
    outputSummary: 'Risk score 78 - clustered tab switches correlate with answer changes.',
  },
  {
    feature: 'ADAPTIVE_ENGINE',
    model: 'openai/gpt-4o-mini',
    promptTokens: 240,
    completionTokens: 58,
    outputSummary: 'Selected next item b=1.35 to maximise information at theta=0.4.',
  },
  {
    feature: 'BLUEPRINT_GENERATOR',
    model: 'openai/gpt-4o',
    promptTokens: 910,
    completionTokens: 1320,
    outputSummary: 'Produced a 3-section blueprint mapped to 6 learning objectives.',
  },
  {
    feature: 'NL_SEARCH',
    model: 'meta-llama/llama-3.1-70b-instruct',
    promptTokens: 180,
    completionTokens: 140,
    outputSummary: 'Translated "hard networking questions from last year" into a Prisma filter.',
  },
  {
    feature: 'SUMMARY_REPORT',
    model: 'openai/gpt-4o',
    promptTokens: 2260,
    completionTokens: 1880,
    outputSummary: 'Wrote the executive post-exam report for the CS210 midterm.',
  },
  {
    feature: 'CODE_REVIEWER',
    model: 'deepseek/deepseek-coder',
    promptTokens: 1420,
    completionTokens: 760,
    outputSummary: 'Flagged O(n^2) brute force; suggested hash-map solution, complexity notes.',
  },
];

/**
 * Derived analytics, question statistics, notifications, announcements, audit
 * trail and AI usage logs. Runs last so it can summarise everything the other
 * steps created.
 */
module.exports = async function seed(prisma, ctx) {
  const random = createRandom(20260929);
  const attempts = ctx.attemptsByExam ?? {};
  const allAttempts = Object.values(attempts).flat();

  // --------------------------- question statistics --------------------------
  const questionRows = await prisma.question.findMany({
    where: { id: { in: Object.values(ctx.questions ?? {}).map((question) => question.id) } },
    include: { examQuestions: { take: 1 } },
  });

  let statCount = 0;
  for (const question of questionRows) {
    const answers = await prisma.answer.findMany({
      where: { questionId: question.id },
      select: { isCorrect: true, isPartial: true, timeSpentSec: true, wasSkipped: true, response: true, selectedOptions: true, ratingValue: true, attempt: { select: { scorePercent: true } } },
      take: 200,
    });
    if (answers.length === 0) continue;

    const examId = question.examQuestions[0]?.examId ?? null;
    const correct = answers.filter((answer) => answer.isCorrect).length;
    const partial = answers.filter((answer) => answer.isPartial).length;
    const skipped = answers.filter((answer) => answer.wasSkipped).length;
    const timesAnswered = answers.length;

    const difficultyIndex = roundTo(timesAnswered ? (correct + partial * 0.5) / timesAnswered : 0, 4);
    const discriminationIndex = roundTo(discrimination(answers), 4);
    const avgScorePercent = roundTo(average(answers.map((answer) => (answer.isCorrect ? 100 : answer.isPartial ? 55 : 0))), 2);
    const avgTimeSec = roundTo(average(answers.map((answer) => Number(answer.timeSpentSec ?? question.estimatedTimeSec))), 2);

    await prisma.questionStat.upsert({
      where: { questionId_examId: { questionId: question.id, examId } },
      update: {
        attempts: timesAnswered,
        correctCount: correct,
        avgScorePercent,
        difficultyIndex,
        discriminationIndex,
      },
      create: {
        id: `seed-qstat-${question.id}`,
        questionId: question.id,
        examId,
        attempts: timesAnswered,
        correctCount: correct,
        incorrectCount: timesAnswered - correct - skipped,
        skippedCount: skipped,
        avgScorePercent,
        avgTimeSec,
        difficultyIndex,
        discriminationIndex,
        optionDistribution: optionDistribution(question, answers),
        hintUseCount: random.int(0, Math.max(1, Math.round(timesAnswered / 3))),
        updatedById: question.createdById,
      },
    });
    statCount += 1;

    await prisma.question.update({
      where: { id: question.id },
      data: {
        timesAnswered,
        timesCorrect: correct,
        avgScorePercent,
        avgTimeSec,
        difficultyIndex,
        discriminationIndex,
        skipRate: roundTo(timesAnswered ? skipped / timesAnswered : 0, 4),
      },
    });
  }

  // --------------------------- analytics aggregates -------------------------
  const buckets = [];
  for (let day = 13; day >= 0; day -= 1) {
    buckets.push(new Date(Date.now() - day * 24 * 60 * 60 * 1000));
  }

  const aggregates = [];
  const pushAggregate = (row) => aggregates.push(row);

  pushAggregate({
    scope: 'PLATFORM',
    metric: 'platform.totals',
    value: {
      organizations: ctx.organizationCount ?? 0,
      users: ctx.userCount ?? 0,
      questions: ctx.questionCount ?? 0,
      exams: ctx.examCount ?? 0,
      attempts: ctx.attemptCount ?? 0,
      certificates: ctx.certificateCount ?? 0,
      payments: ctx.paymentCount ?? 0,
      grossRevenueCents: 418_900,
      activeProctorSessions: ctx.proctorSessions ?? 0,
    },
  });

  pushAggregate({
    scope: 'PLATFORM',
    metric: 'platform.attemptsPerDay',
    dimension: { granularity: 'DAY' },
    value: buckets.map((bucket) => ({ date: bucket.toISOString().slice(0, 10), attempts: random.int(4, 46) })),
  });

  for (const orgKey of ['northgate-university', 'vertex-cloud', 'meridian-institute']) {
    const org = ctx[orgKey];
    if (!org) continue;
    pushAggregate({
      scope: 'ORGANIZATION',
      organizationId: org.id,
      metric: 'org.scoreDistribution',
      dimension: { bucketSize: 10 },
      value: distributionBuckets(allAttempts.filter((item) => item.attempt.organizationId === org.id).map((item) => item.scorePercent)),
    });
    pushAggregate({
      scope: 'ORGANIZATION',
      organizationId: org.id,
      metric: 'org.usage',
      dimension: { period: 'CURRENT_MONTH' },
      value: {
        examsPublished: random.int(3, 24),
        attemptsSubmitted: random.int(40, 480),
        proctorViolations: random.int(2, 38),
        aiCallsEstimate: random.int(20, 380),
        storageMbUsed: random.int(120, 9400),
      },
    });
  }

  for (const [examKey, list] of Object.entries(attempts)) {
    const entry = ctx.exams[examKey];
    if (!entry || list.length === 0) continue;
    const percents = list.map((item) => item.scorePercent);
    const passed = percents.filter((value) => value >= Number(entry.exam.passingPercent ?? 50)).length;

    pushAggregate({
      scope: 'EXAM',
      organizationId: entry.exam.organizationId,
      examId: entry.exam.id,
      metric: 'exam.summary',
      value: {
        attempts: list.length,
        averageScorePercent: roundTo(average(percents), 2),
        medianScorePercent: roundTo(median(percents), 2),
        highestScorePercent: Math.max(...percents),
        lowestScorePercent: Math.min(...percents),
        passRatePercent: roundTo(list.length ? (passed / list.length) * 100 : 0, 2),
        completionRatePercent: roundTo((list.filter((item) => item.attempt.status !== 'IN_PROGRESS').length / list.length) * 100, 2),
        averageDurationSec: random.int(900, 3200),
      },
    });
    pushAggregate({
      scope: 'EXAM',
      examId: entry.exam.id,
      metric: 'exam.scoreHistogram',
      dimension: { bucketSize: 10 },
      value: distributionBuckets(percents),
    });
    pushAggregate({
      scope: 'EXAM',
      examId: entry.exam.id,
      metric: 'exam.timeline',
      dimension: { granularity: 'DAY' },
      value: buckets.slice(-6).map((bucket) => ({ date: bucket.toISOString().slice(0, 10), submissions: random.int(0, list.length) })),
    });
    pushAggregate({
      scope: 'EXAM',
      examId: entry.exam.id,
      metric: 'exam.answerHeatmap',
      dimension: { rows: 'question', columns: 'answerState' },
      value: (entry.fixture?.sections ?? []).flatMap((section) => section.questionKeys.map((key, index) => ({
        question: key,
        order: index + 1,
        correct: random.int(0, list.length),
        partial: random.int(0, Math.max(1, Math.round(list.length / 3))),
        incorrect: random.int(0, list.length),
        skipped: random.int(0, Math.max(1, Math.round(list.length / 4))),
      }))),
    });

    for (const [sectionIndex, sectionFixture] of (entry.fixture?.sections ?? []).entries()) {
      pushAggregate({
        scope: 'SECTION',
        examId: entry.exam.id,
        metric: 'section.summary',
        dimension: { sectionName: sectionFixture.name, order: sectionIndex + 1 },
        value: {
          questionCount: sectionFixture.questionKeys.length,
          averageScorePercent: roundTo(average(percents) * (0.85 + sectionIndex * 0.05), 2),
          averageTimeSec: random.int(180, 1400),
        },
      });
    }
  }

  for (const item of allAttempts.slice(0, 12)) {
    pushAggregate({
      scope: 'CANDIDATE',
      userId: item.userId,
      metric: 'candidate.progress',
      dimension: { examId: item.attempt.examId },
      value: {
        scorePercent: item.scorePercent,
        percentile: Number(item.attempt.percentile ?? 0),
        timeUsedSec: Number(item.attempt.usedTimeSec ?? 0),
        violations: Number(item.attempt.violationCount ?? 0),
        trend: [random.int(40, 70), random.int(45, 80), item.scorePercent],
      },
    });
  }
  const topics = new Set();
  for (const question of questionRows) for (const tag of question.topicTags ?? []) topics.add(tag);
  for (const topic of [...topics].slice(0, 12)) {
    pushAggregate({
      scope: 'TOPIC',
      metric: 'topic.mastery',
      dimension: { topic },
      value: { masteryPercent: random.int(38, 92), attempts: random.int(6, 120), questions: random.int(1, 9) },
    });
  }

  let aggregateCount = 0;
  for (const row of aggregates) {
    await prisma.analyticsAggregate.upsert({
      where: { id: `seed-analytics-${aggregateCount + 1}` },
      update: { value: row.value, computedAt: new Date() },
      create: {
        id: `seed-analytics-${aggregateCount + 1}`,
        scope: row.scope,
        organizationId: row.organizationId ?? null,
        examId: row.examId ?? null,
        userId: row.userId ?? null,
        metric: row.metric,
        dimension: row.dimension ?? {},
        value: row.value,
        bucket: row.bucket ?? null,
        computedAt: new Date(),
      },
    });
    aggregateCount += 1;
  }

  // --------------------------- notifications + preferences ------------------
  const notifyUsers = await prisma.user.findMany({
    where: { id: { in: [...new Set(allAttempts.map((item) => item.userId))] } },
    select: { id: true, email: true, displayName: true, timezone: true },
  });

  let notificationCount = 0;
  for (const [userIndex, user] of notifyUsers.entries()) {
    for (const [templateIndex, template] of NOTIFICATION_TEMPLATES.entries()) {
      const isRead = (userIndex + templateIndex) % 3 !== 0;
      await prisma.notification.upsert({
        where: { id: `seed-notif-${user.id}-${template.type}` },
        update: {},
        create: {
          id: `seed-notif-${user.id}-${template.type}`,
          userId: user.id,
          type: template.type,
          title: template.title,
          body: notificationBody(template.type, user.displayName ?? user.email),
          data: { source: 'seed', examId: ctx.exams['cs210-midterm']?.exam.id ?? null, templateIndex },
          channel: templateIndex % 4 === 3 ? 'EMAIL' : 'IN_APP',
          priority: template.priority,
          actionUrl: template.actionUrl,
          readAt: isRead ? minutesAgo(30 + templateIndex * 6) : null,
          sentAt: minutesAgo(180 - templateIndex * 10),
          deliveredAt: minutesAgo(180 - templateIndex * 10),
          createdAt: minutesAgo(182 - templateIndex * 10),
        },
      });
      notificationCount += 1;
    }

    await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        id: `seed-notifpref-${user.id}`,
        userId: user.id,
        channels: {
          EXAM_REMINDER: ['IN_APP', 'EMAIL'],
          RESULTS_RELEASED: ['IN_APP', 'EMAIL'],
          CERTIFICATE_ISSUED: ['IN_APP', 'EMAIL'],
          PROCTOR_MESSAGE: ['IN_APP', 'PUSH'],
          PAYMENT_RECEIVED: ['EMAIL'],
          ANNOUNCEMENT: ['IN_APP'],
        },
        mutedTypes: userIndex % 5 === 0 ? ['AI_LIMIT_WARNING', 'SUBSCRIPTION_WARNING'] : [],
        emailDigest: userIndex % 4 === 0 ? 'DAILY' : 'IMMEDIATE',
        quietHoursStart: userIndex % 3 === 0 ? '22:00' : null,
        quietHoursEnd: userIndex % 3 === 0 ? '07:00' : null,
        smsEnabled: false,
        pushEnabled: true,
        unsubscribeAll: false,
        timezone: user.timezone ?? 'UTC',
      },
    });
  }

  // --------------------------- announcements --------------------------------
  const announcements = [
    {
      id: 'seed-announcement-maintenance',
      title: 'Scheduled maintenance - Sunday 02:00 UTC',
      body: 'The proctoring service will be unavailable for approximately 40 minutes. Exams already in progress are auto-saved every 30 seconds and will resume.',
      audience: 'ALL_USERS',
      actionUrl: '/status',
    },
    {
      id: 'seed-announcement-northgate-results',
      title: 'CS210 midterm results released',
      body: 'Grades have been moderated and released. Review your per-question feedback in the results centre.',
      audience: 'ORGANIZATION',
      organizationId: ctx['northgate-university']?.id ?? null,
      examId: ctx.exams['cs210-midterm']?.exam.id ?? null,
      actionUrl: '/results',
    },
    {
      id: 'seed-announcement-ai-grading',
      title: 'AI-assisted essay grading is now available',
      body: 'Instructors can pre-grade long-answer responses with the rubric-aware AI grader and then adjust before release.',
      audience: 'INSTRUCTORS',
      organizationId: ctx['vertex-cloud']?.id ?? null,
      actionUrl: '/grading',
    },
  ];

  for (const [index, row] of announcements.entries()) {
    await prisma.announcement.upsert({
      where: { id: row.id },
      update: {},
      create: {
        ...row,
        isPublished: true,
        publishedAt: minutesAgo(60 * 24 * (index + 1)),
        expiresAt: daysFromNow(21 - index * 5),
        createdById: (ctx.superAdmin ?? ctx.opsAdmin).id,
        viewCount: random.int(24, 940),
      },
    });
  }

  // --------------------------- audit trail ----------------------------------
  const auditEntries = [
    { action: 'EXAM_PUBLISH', entityType: 'Exam', entityId: ctx.exams['cs210-midterm']?.exam.id, actor: ctx.exams['cs210-midterm']?.author, organizationId: ctx['northgate-university']?.id, metadata: { version: 1, questions: 12 } },
    { action: 'EXAM_PROCTORING_CONFIGURED', entityType: 'Exam', entityId: ctx.exams['aws-solutions-architect']?.exam.id, actor: ctx.exams['aws-solutions-architect']?.author, organizationId: ctx['vertex-cloud']?.id, metadata: { lockdown: true, autoTerminateAfter: 8 } },
    { action: 'ATTEMPT_TERMINATED', entityType: 'Attempt', entityId: allAttempts[2]?.attempt.id, actor: ctx['proctor.kowalski@northgate.example.edu'] ?? ctx.opsAdmin, organizationId: ctx['vertex-cloud']?.id, metadata: { reason: 'Repeated fullscreen exits' }, isSensitive: true },
    { action: 'GRADES_RELEASED', entityType: 'Exam', entityId: ctx.exams['cs210-midterm']?.exam.id, actor: ctx.exams['cs210-midterm']?.author, organizationId: ctx['northgate-university']?.id, metadata: { releasedCount: allAttempts.length } },
    { action: 'CERTIFICATE_ISSUED', entityType: 'Certificate', entityId: 'seed-certificate-1', actor: ctx.superAdmin, organizationId: ctx['vertex-cloud']?.id, metadata: { bulk: false } },
    { action: 'USER_LOGIN', entityType: 'User', entityId: notifyUsers[0]?.id ?? ctx.superAdmin.id, actor: notifyUsers[0] ?? ctx.superAdmin, organizationId: null, metadata: { method: 'oauth_google' } },
    { action: 'PLATFORM_ORGANIZATION_APPROVED', entityType: 'Organization', entityId: ctx['northgate-university']?.id, actor: ctx.opsAdmin, organizationId: ctx['northgate-university']?.id, metadata: { plan: 'PRO' }, isSensitive: true },
    { action: 'PAYMENT_REFUNDED', entityType: 'Payment', entityId: 'seed-payment-exam-' + (allAttempts[allAttempts.length - 1]?.attempt.id ?? 'na'), actor: ctx.opsAdmin, organizationId: ctx['vertex-cloud']?.id, metadata: { reason: 'candidate_withdrew' }, isSensitive: true },
  ];

  let auditCount = 0;
  for (const [index, row] of auditEntries.entries()) {
    if (!row.actor || !row.entityId) continue;
    await prisma.auditLog.upsert({
      where: { id: `seed-audit-${index + 1}` },
      update: {},
      create: {
        id: `seed-audit-${index + 1}`,
        actorId: row.actor.id,
        actorRole: row.actor.memberships?.[0]?.role ?? null,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        organizationId: row.organizationId,
        ipAddress: `10.${random.int(0, 40)}.${random.int(0, 250)}.${random.int(2, 250)}`,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        metadata: row.metadata ?? {},
        isSensitive: row.isSensitive ?? false,
        createdAt: minutesAgo(40 + index * 37),
      },
    });
    auditCount += 1;
  }

  // --------------------------- AI usage logs --------------------------------
  const billingOrg = ctx['vertex-cloud'];
  let aiLogCount = 0;
  for (const [index, sample] of AI_SAMPLES.entries()) {
    const caller = ctx.exams['aws-solutions-architect']?.author ?? ctx.superAdmin;
    await prisma.aiUsageLog.upsert({
      where: { id: `seed-aiusage-${index + 1}` },
      update: {},
      create: {
        id: `seed-aiusage-${index + 1}`,
        organizationId: billingOrg?.id ?? null,
        userId: caller.id,
        examId: ctx.exams['aws-solutions-architect']?.exam.id ?? null,
        attemptId: sample.feature === 'ESSAY_GRADER' || sample.feature === 'CHEATING_DETECTION' ? allAttempts[0]?.attempt.id ?? null : null,
        questionId: sample.feature === 'QUESTION_GENERATOR' ? Object.values(ctx.questions ?? {})[0]?.id ?? null : null,
        feature: sample.feature,
        aiModel: sample.model,
        provider: 'openrouter',
        requestId: `req_seed_${String(index + 1).padStart(4, '0')}`,
        promptTokens: sample.promptTokens,
        completionTokens: sample.completionTokens,
        totalTokens: sample.promptTokens + sample.completionTokens,
        costUsd: roundTo((sample.promptTokens * 2.5 + sample.completionTokens * 12) / 1_000_000, 6),
        latencyMs: random.int(720, 8400),
        status: index === AI_SAMPLES.length - 1 ? 'TIMEOUT' : 'SUCCESS',
        inputSummary: `${sample.feature} request for seeded demo data`,
        outputSummary: sample.outputSummary,
        error: index === AI_SAMPLES.length - 1 ? 'upstream timeout after 10000ms' : null,
        metadata: { streaming: index === 0, fallbackModel: 'openai/gpt-4o-mini' },
        createdAt: minutesAgo(20 + index * 55),
      },
    });
    aiLogCount += 1;
  }

  // --------------------------- inbound webhook events -----------------------
  const webhookEvents = [
    {
      id: 'seed-webhook-clerk-created',
      provider: 'clerk',
      externalId: 'evt_seed_clerk_created',
      type: 'user.created',
      status: 'PROCESSED',
      payload: { id: 'seed_user_superadmin', email_addresses: [{ id: 'se_1', email_address: 'superadmin@examplatform.local' }], primary_email_address_id: 'se_1' },
    },
    {
      id: 'seed-webhook-clerk-updated',
      provider: 'clerk',
      externalId: 'evt_seed_clerk_updated',
      type: 'user.updated',
      status: 'PROCESSED',
      payload: { id: 'seed_user_superadmin', first_name: 'Ada', last_name: 'Okoye' },
    },
    {
      id: 'seed-webhook-stripe-paid',
      provider: 'stripe',
      externalId: 'evt_seed_stripe_payment_intent_succeeded',
      type: 'payment_intent.succeeded',
      status: 'PROCESSED',
      payload: { object: { id: 'pi_seed_exam_1', amount: 11175, currency: 'usd', status: 'succeeded' } },
    },
    {
      id: 'seed-webhook-stripe-refund',
      provider: 'stripe',
      externalId: 'evt_seed_stripe_refund_updated',
      type: 'charge.refunded',
      status: 'PROCESSED',
      payload: { object: { id: 'pi_seed_exam_5', amount_refunded: 14900, currency: 'usd' } },
    },
    {
      id: 'seed-webhook-stripe-failed',
      provider: 'stripe',
      externalId: 'evt_seed_stripe_payment_failed',
      type: 'payment_intent.payment_failed',
      status: 'FAILED',
      error: 'No matching Payment row for pi_seed_unknown',
      payload: { object: { id: 'pi_seed_unknown', last_payment_error: { code: 'card_declined' } } },
    },
  ];

  for (const row of webhookEvents) {
    await prisma.webhookEvent.upsert({
      where: { externalId: row.externalId },
      update: {},
      create: { ...row, processedAt: row.status === 'PROCESSED' ? minutesAgo(70) : null, createdAt: minutesAgo(75) },
    });
  }

  ctx.analyticsCount = aggregateCount;
  ctx.notificationCount = notificationCount;
  ctx.auditCount = auditCount;
  console.log(
    `  · ${statCount} question stats, ${aggregateCount} analytics aggregates, ${notificationCount} notifications, ${auditCount} audit rows, ${aiLogCount} AI calls`,
  );
};

function average(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Point-biserial correlation between getting this item right and the total score. */
function discrimination(answers) {
  const groups = [
    answers.filter((answer) => answer.isCorrect).map((answer) => Number(answer.attempt?.scorePercent ?? 0)),
    answers.filter((answer) => !answer.isCorrect).map((answer) => Number(answer.attempt?.scorePercent ?? 0)),
  ];
  if (!groups[0].length || !groups[1].length) return 0;
  const diff = average(groups[0]) - average(groups[1]);
  const spread = Math.max(1, (Math.max(...groups[0].concat(groups[1])) - Math.min(...groups[0].concat(groups[1]))) / 2);
  return Math.max(-1, Math.min(1, diff / spread));
}

/** Count how candidates spread across the answer options of a question. */
function optionDistribution(question, answers) {
  const content = question.content ?? {};
  const distribution = {};

  if (Array.isArray(content.options) && content.options.length) {
    for (const option of content.options) distribution[option.id ?? option.text] = 0;
    const keys = new Set(Object.keys(distribution));
    for (const answer of answers) {
      const response = answer.response ?? {};
      const picked = Array.isArray(response.optionIds)
        ? response.optionIds
        : response.optionId
          ? [response.optionId]
          : answer.selectedOptions ?? [];
      for (const key of picked) {
        if (!keys.has(key)) continue;
        distribution[key] = (distribution[key] ?? 0) + 1;
      }
    }
    return distribution;
  }

  if (question.type === 'TRUE_FALSE') {
    distribution.true = answers.filter((answer) => (answer.response ?? {}).value === true).length;
    distribution.false = answers.length - distribution.true;
    return distribution;
  }

  if (typeof question.content?.min === 'number' && typeof question.content?.max === 'number') {
    for (let value = question.content.min; value <= question.content.max; value += 1) distribution[String(value)] = 0;
    for (const answer of answers) {
      const value = answer.ratingValue ?? (answer.response ?? {}).value;
      if (typeof value === 'number' && distribution[String(value)] !== undefined) distribution[String(value)] += 1;
    }
    return distribution;
  }

  distribution.matched = answers.filter((answer) => answer.isCorrect).length;
  distribution.unmatched = answers.length - distribution.matched;
  distribution.skipped = answers.filter((answer) => answer.wasSkipped).length;
  return distribution;
}

function distributionBuckets(percents) {
  const buckets = Array.from({ length: 10 }, (_, index) => ({ range: `${index * 10}-${index * 10 + 9}`, count: 0 }));
  for (const percent of percents) {
    const index = Math.min(9, Math.max(0, Math.floor(percent / 10)));
    buckets[index].count += 1;
  }
  return buckets;
}

function notificationBody(type, name) {
  switch (type) {
    case 'EXAM_ASSIGNED':
      return `Hi ${name}, a new exam has been assigned to you. Check the exam list to see the window and duration.`;
    case 'EXAM_REMINDER':
      return 'Your exam window opens in 24 hours. Run the system check early so the camera and microphone are verified.';
    case 'RESULTS_RELEASED':
      return 'Grading finished and results are now visible, including per-question feedback.';
    case 'CERTIFICATE_ISSUED':
      return 'Your digital certificate is ready to download and share, with a QR verification link.';
    case 'PROCTOR_MESSAGE':
      return 'A proctor sent you a message during your session - open the exam to read it.';
    case 'PAYMENT_RECEIVED':
      return 'We received your payment. The invoice is available in the billing section.';
    default:
      return null;
  }
}
