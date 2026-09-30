const { daysFromNow } = require('./lib/utils');
const { examFixtures } = require('./data/exams');

const EXAM_CATEGORIES = [
  { orgKey: 'northgate-university', slug: 'computer-science', name: 'Computer Science' },
  { orgKey: 'northgate-university', slug: 'mathematics', name: 'Mathematics' },
  { orgKey: 'vertex-cloud', slug: 'cloud-certification', name: 'Cloud Certification' },
  { orgKey: 'meridian-institute', slug: 'professional-skills', name: 'Professional Skills' },
];

module.exports = async function seed(prisma, ctx) {
  const categories = {};
  for (const item of EXAM_CATEGORIES) {
    const org = ctx[item.orgKey];
    const category = await prisma.examCategory.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: item.slug } },
      update: { name: item.name },
      create: { organizationId: org.id, slug: item.slug, name: item.name, createdById: ctx.superAdmin.id },
    });
    categories[`${item.orgKey}:${item.slug}`] = category;
  }

  const exams = {};
  for (const fixture of examFixtures) {
    const org = ctx[fixture.orgKey];
    const author = ctx[fixture.authorEmail];
    const extraSettings = {
      ...(fixture.settings ?? {}),
      liveQuiz: fixture.liveQuizConfig ?? null,
      survey: fixture.surveyConfig ?? null,
      isLiveQuiz: Boolean(fixture.isLiveQuiz),
      isAnonymous: Boolean(fixture.isAnonymous),
    };

    const exam = await prisma.exam.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: fixture.key } },
      update: { status: fixture.status },
      create: {
        id: `seed-exam-${fixture.key}`,
        organizationId: org.id,
        createdById: author.id,
        categoryId: categories[`${fixture.orgKey}:${fixture.categorySlug}`]?.id ?? null,
        slug: fixture.key,
        title: fixture.title,
        description: fixture.description,
        instructions: fixture.instructions,
        thumbnailUrl: `/uploads/exams/${fixture.key}-cover.svg`,
        type: fixture.type,
        status: fixture.status,
        language: fixture.language,
        languages: fixture.languages ?? [fixture.language],
        accessControl: fixture.accessControl,
        accessCode: fixture.accessCode ?? null,
        inviteToken: fixture.accessControl === 'INVITE_LINK' ? `seed-invite-${fixture.key}` : null,
        previewToken: `seed-preview-${fixture.key}`,
        examFeeCents: fixture.examFeeCents ?? 0,
        certificationFeeCents: fixture.certificationFeeCents ?? 0,
        currency: 'usd',
        refundPolicy: fixture.refundPolicy ?? 'NO_REFUND',
        totalMarks: fixture.totalMarks,
        passingPercent: fixture.passingPercent,
        durationMinutes: fixture.durationMinutes,
        attemptLimit: fixture.attemptLimit,
        startsAt: daysFromNow(fixture.startsAtOffsetDays),
        endsAt: daysFromNow(fixture.endsAtOffsetDays, 18),
        resultsVisibleAt: fixture.resultsVisibleOffsetDays ? daysFromNow(fixture.resultsVisibleOffsetDays) : null,
        resultVisibility: fixture.resultVisibility,
        gradeBoundaries: fixture.gradeBoundaries ?? { A: 90, B: 80, C: 70, D: 60, F: 0 },
        settings: extraSettings,
        proctoringConfig: fixture.proctoringConfig ?? { enabled: false },
        adaptiveConfig: fixture.adaptiveConfig ?? { enabled: false },
        scoringConfig: {
          negativeMarkingPercent: fixture.negativeMarking ? 25 : 0,
          partialMarking: true,
          rounding: 'HALF_UP',
          scoreSource: 'WEIGHTED_SUM',
        },
        accessibilityConfig: { fontScale: true, highContrast: true, screenReader: true, extraTimePercentDefault: 25 },
        isProctored: Boolean(fixture.isProctored),
        isAdaptive: Boolean(fixture.isAdaptive),
        isAutoGraded: fixture.type !== 'SURVEY',
        answerReviewEnabled: fixture.answerReviewEnabled ?? false,
        shuffleQuestions: Boolean(fixture.shuffleQuestions),
        shuffleOptions: Boolean(fixture.shuffleOptions),
        negativeMarking: Boolean(fixture.negativeMarking),
        partialMarking: true,
        calculatorAllowed: Boolean(fixture.calculatorAllowed),
        scratchpadAllowed: Boolean(fixture.scratchpadAllowed),
        attachmentAllowed: Boolean(fixture.attachmentAllowed),
        requireCamera: Boolean(fixture.requireCamera),
        requireScreenShare: Boolean(fixture.requireScreenShare),
        recordWebcam: Boolean(fixture.recordWebcam),
        recordScreen: Boolean(fixture.recordScreen),
        maxCandidates: 1000,
        version: 1,
        publishedAt: fixture.status === 'DRAFT' ? null : daysFromNow(fixture.startsAtOffsetDays - 7),
      },
    });

    // ---- sections + questions --------------------------------------------
    let order = 0;
    let totalMarks = 0;
    for (const [sectionIndex, sectionFixture] of (fixture.sections ?? []).entries()) {
      const section = await prisma.examSection.upsert({
        where: { id: `seed-section-${fixture.key}-${sectionIndex + 1}` },
        update: {},
        create: {
          id: `seed-section-${fixture.key}-${sectionIndex + 1}`,
          examId: exam.id,
          name: sectionFixture.name,
          instructions: sectionFixture.instructions,
          order: sectionFixture.order ?? sectionIndex + 1,
          durationMinutes: sectionFixture.durationMinutes ?? null,
          questionCount: sectionFixture.questionKeys.length,
          randomFromPool: Boolean(sectionFixture.randomFromPool),
          poolSize: sectionFixture.poolSize ?? null,
          pickCount: sectionFixture.pickCount ?? null,
          canNavigateBack: !(fixture.settings?.oneWayNavigation ?? false),
          settings: { locked: false },
        },
      });

      for (const questionKey of sectionFixture.questionKeys) {
        const question = ctx.questions[questionKey];
        if (!question) continue;
        order += 1;
        totalMarks += Number(question.marks);
        await prisma.examQuestion.upsert({
          where: { examId_questionId: { examId: exam.id, questionId: question.id } },
          update: { order, marks: question.marks, sectionId: section.id },
          create: {
            examId: exam.id,
            sectionId: section.id,
            questionId: question.id,
            order,
            marks: question.marks,
            weightage: 1,
            isRequired: fixture.type !== 'SURVEY',
            negativePercent: fixture.negativeMarking ? 25 : 0,
          },
        });
        await prisma.question.update({ where: { id: question.id }, data: { usageCount: { increment: 1 } } });
      }

      if (sectionFixture.randomFromPool) {
        const bank = ctx.banks[sectionFixture.bankKey];
        if (bank) {
          await prisma.examPool.upsert({
            where: { id: `seed-pool-${fixture.key}-${sectionIndex + 1}` },
            update: {},
            create: {
              id: `seed-pool-${fixture.key}-${sectionIndex + 1}`,
              sectionId: section.id,
              bankId: bank.id,
              pickCount: sectionFixture.pickCount ?? 3,
              filters: { difficulty: ['EASY', 'MEDIUM'], status: 'APPROVED' },
            },
          });
        }
      }
    }

    await prisma.exam.update({ where: { id: exam.id }, data: { questionCount: order, totalMarks: fixture.totalMarks || totalMarks } });

    await prisma.examVersion.upsert({
      where: { id: `seed-exam-version-${fixture.key}-1` },
      update: {},
      create: {
        id: `seed-exam-version-${fixture.key}-1`,
        examId: exam.id,
        version: 1,
        createdById: author.id,
        changeNote: 'Initial publication',
        snapshot: { exam: { title: exam.title, totalMarks: fixture.totalMarks, durationMinutes: exam.durationMinutes }, sections: fixture.sections?.length ?? 0, questions: order },
      },
    });

    // ---- registrations ----------------------------------------------------
    const memberEntries = ctx.orgs[fixture.orgKey].members;
    const candidates = Object.entries(memberEntries).filter(([email]) => email.includes('cand.'));
    for (const [index, [email, user]] of candidates.entries()) {
      const needsPayment = (fixture.examFeeCents ?? 0) > 0;
      await prisma.examCandidate.upsert({
        where: { examId_userId: { examId: exam.id, userId: user.id } },
        update: {},
        create: {
          examId: exam.id,
          userId: user.id,
          status: needsPayment ? 'PENDING' : 'REGISTERED',
          assignedById: author.id,
          inviteToken: `seed-reg-${fixture.key}-${index + 1}`,
          seatNumber: index + 1,
          registeredAt: daysFromNow(fixture.startsAtOffsetDays + index),
          accessGrantedAt: needsPayment ? null : daysFromNow(fixture.startsAtOffsetDays + index),
        },
      });
    }

    exams[fixture.key] = { exam, fixture, author, org, candidateIds: candidates.map(([, user]) => user.id) };
    ctx[fixture.key] = exam;
  }

  // ---- reusable exam template --------------------------------------------
  const templateSource = exams['cs210-midterm'];
  await prisma.examTemplate.upsert({
    where: { id: 'seed-template-midterm' },
    update: {},
    create: {
      id: 'seed-template-midterm',
      organizationId: templateSource.org.id,
      name: 'Semester midterm template',
      description: 'Two sections, 60 minutes, 50% pass mark, shuffled questions.',
      createdById: templateSource.author.id,
      structure: {
        type: 'TEST',
        durationMinutes: 60,
        passingPercent: 50,
        attemptLimit: 1,
        sections: (templateSource.fixture.sections ?? []).map((section) => ({
          name: section.name,
          instructions: section.instructions,
          questionCount: section.questionKeys.length,
        })),
      },
    },
  });

  ctx.exams = exams;
  ctx.examCount = Object.keys(exams).length;
  ctx.examCategories = categories;
  console.log(`  · ${ctx.examCount} exams (${Object.keys(exams).join(', ')})`);
};
