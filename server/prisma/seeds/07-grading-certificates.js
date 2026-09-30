const { createRandom, daysFromNow, minutesAgo } = require('./lib/utils');

module.exports = async function seed(prisma, ctx) {
  const random = createRandom(31337);
  const certEntry = ctx.exams['aws-solutions-architect'];
  const quizEntry = ctx.exams['cs210-midterm'];
  const attempts = ctx.attemptsByExam ?? {};

  // --------------------------- rubrics ------------------------------------
  const essayQuestion = ctx.questions['q-essay-cloud-native'];
  const rubric = await prisma.gradingRubric.upsert({
    where: { id: 'seed-rubric-essay-arch' },
    update: {},
    create: {
      id: 'seed-rubric-essay-arch',
      examId: certEntry.exam.id,
      questionId: essayQuestion?.id ?? null,
      name: 'Architecture essay rubric',
      description: 'Four weighted criteria, marked 0-6 each.',
      totalMarks: 20,
      requireSecondGrader: true,
      createdById: certEntry.author.id,
      criteria: [
        { id: 'c1', name: 'Accuracy', maxMarks: 6, levels: [{ label: 'Excellent', min: 5 }, { label: 'Adequate', min: 3 }, { label: 'Weak', min: 0 }] },
        { id: 'c2', name: 'Coherence', maxMarks: 5, levels: [{ label: 'Excellent', min: 4 }, { label: 'Adequate', min: 2 }] },
        { id: 'c3', name: 'Depth', maxMarks: 6, levels: [{ label: 'Excellent', min: 5 }, { label: 'Adequate', min: 3 }] },
        { id: 'c4', name: 'Grammar', maxMarks: 3, levels: [{ label: 'Excellent', min: 3 }, { label: 'Adequate', min: 1 }] },
      ],
    },
  });

  // --------------------------- manual grading queue -------------------------
  const pending = await prisma.answer.findMany({
    where: { needsManualGrading: true, gradingStatus: { in: ['UNGRADED', 'IN_PROGRESS'] } },
    include: { attempt: { include: { user: true } }, question: true },
    take: 40,
  });

  let gradedCount = 0;
  for (const answer of pending) {
    const isSurvey = answer.attempt.examId === ctx.exams['training-feedback-survey']?.exam.id;
    if (isSurvey) continue;

    const gradeBy = certEntry.author;
    const maxMarks = Number(answer.maxMarks);
    const aiScore = answer.aiScore === null || answer.aiScore === undefined ? null : Number(answer.aiScore);
    const manualScore = aiScore !== null ? Math.min(maxMarks, aiScore + random.int(-2, 2)) : round(random.next() * maxMarks);
    const status = answer.question.type === 'LONG_ANSWER' || answer.question.type === 'CODING' ? 'GRADED' : 'IN_PROGRESS';

    await prisma.answer.update({
      where: { id: answer.id },
      data: {
        manualScore: status === 'GRADED' ? manualScore : null,
        finalScore: status === 'GRADED' ? manualScore : null,
        gradingStatus: status,
        gradedById: status === 'GRADED' ? gradeBy.id : null,
        gradedAt: status === 'GRADED' ? minutesAgo(random.int(20, 400)) : null,
        graderNote: status === 'GRADED' ? 'Covered cost and reliability well; team-topology argument was thin.' : 'Partially reviewed.',
        feedback: status === 'GRADED' ? 'Strong analysis of operational cost; add a migration rollback plan next time.' : null,
        isCorrect: manualScore >= maxMarks * 0.5,
        isPartial: manualScore > 0 && manualScore < maxMarks,
        secondScore: status === 'GRADED' && rubric.requireSecondGrader ? round(manualScore * (0.9 + random.next() * 0.15)) : null,
        secondGraderNote: status === 'GRADED' && rubric.requireSecondGrader ? 'Agree within tolerance.' : null,
        secondGradedById: status === 'GRADED' && rubric.requireSecondGrader ? (ctx['arch.trainer@vertex.example.com'] ?? gradeBy).id : null,
        disagreement: false,
      },
    });
    gradedCount += 1;

    if (status === 'GRADED' && answer.question.type === 'LONG_ANSWER') {
      const criteria = rubric.criteria ?? [];
      for (const criterion of criteria) {
        await prisma.rubricScore.upsert({
          where: { id: `seed-rubric-score-${answer.id}-${criterion.id}` },
          update: {},
          create: {
            id: `seed-rubric-score-${answer.id}-${criterion.id}`,
            answerId: answer.id,
            rubricId: rubric.id,
            criterionId: criterion.id,
            criterionName: criterion.name,
            marksAwarded: round((Number(criterion.maxMarks) * manualScore) / Math.max(1, maxMarks)),
            maxMarks: criterion.maxMarks,
            comment: `${criterion.name}: meets the expected standard for a pass.`,
            graderId: gradeBy.id,
          },
        });
      }
    }

    await prisma.gradingAssignment.upsert({
      where: {
        examId_graderId_attemptId: {
          examId: answer.attempt.examId,
          graderId: gradeBy.id,
          attemptId: answer.attemptId,
        },
      },
      update: { status },
      create: {
        examId: answer.attempt.examId,
        attemptId: answer.attemptId,
        questionId: answer.questionId,
        graderId: gradeBy.id,
        assignedById: certEntry.org.createdById ?? gradeBy.id,
        status,
        dueAt: daysFromNow(5),
        completedAt: status === 'GRADED' ? new Date() : null,
      },
    });
  }

  // --------------------------- one grade override --------------------------
  const overrideTarget = await prisma.answer.findFirst({
    where: { gradingStatus: 'GRADED', manualScore: { not: null } },
    orderBy: { gradedAt: 'desc' },
  });
  if (overrideTarget) {
    await prisma.gradeOverride.upsert({
      where: { id: `seed-override-${overrideTarget.id}` },
      update: {},
      create: {
        id: `seed-override-${overrideTarget.id}`,
        attemptId: overrideTarget.attemptId,
        answerId: overrideTarget.id,
        previousScore: Number(overrideTarget.finalScore ?? 0),
        newScore: round(Math.min(Number(overrideTarget.maxMarks), Number(overrideTarget.finalScore ?? 0) + 2)),
        reason: 'Second grader flagged over-penalised grammar; marks adjusted after moderation.',
        overrideById: certEntry.author.id,
      },
    });
  }

  // --------------------------- AI feedback per attempt ----------------------
  for (const [examKey, list] of Object.entries(attempts)) {
    const entry = ctx.exams[examKey];
    for (const [index, item] of list.slice(0, 3).entries()) {
      const weakTopics = ['congestion control', 'subnetting', 'TLS handshake'].slice(0, (index % 3) + 1);
      await prisma.attemptFeedback.upsert({
        where: { id: `seed-feedback-${item.attempt.id}-AI_PERSONALIZED` },
        update: {},
        create: {
          id: `seed-feedback-${item.attempt.id}-AI_PERSONALIZED`,
          attemptId: item.attempt.id,
          kind: 'AI_PERSONALIZED',
          createdById: entry.author.id,
          content: `You scored ${item.scorePercent}% overall. Strongest area: protocol identification. Focus next on ${weakTopics.join(', ')}.`,
          meta: { model: 'openai/gpt-4o', weakTopics, generatedAt: new Date().toISOString() },
        },
      });
      await prisma.attemptFeedback.upsert({
        where: { id: `seed-feedback-${item.attempt.id}-AI_RETAKE_COACH` },
        update: {},
        create: {
          id: `seed-feedback-${item.attempt.id}-AI_RETAKE_COACH`,
          attemptId: item.attempt.id,
          kind: 'AI_RETAKE_COACH',
          createdById: entry.author.id,
          content: 'Recommended study path: 1) TCP state machine flashcards, 2) two timed section mocks, 3) re-attempt after 5 days.',
          meta: { estimatedHours: 6, resources: ['/library/tcp-basics', '/library/subnetting-drills'] },
        },
      });
    }
  }

  // --------------------------- certificates ---------------------------------
  const templates = [];
  for (const orgKey of ['northgate-university', 'vertex-cloud', 'meridian-institute']) {
    const org = ctx[orgKey];
    if (!org) continue;
    const template = await prisma.certificateTemplate.upsert({
      where: { id: `seed-cert-template-${orgKey}` },
      update: {},
      create: {
        id: `seed-cert-template-${orgKey}`,
        organizationId: org.id,
        name: `${org.name} - standard certificate`,
        description: 'A4 landscape, org logo, two signatories, guilloche border.',
        isDefault: true,
        backgroundImageUrl: '/uploads/certificates/guilloche-border.svg',
        config: {
          size: 'A4',
          orientation: 'landscape',
          primaryColor: org.branding?.primaryColor ?? '#1d4ed8',
          accentColor: org.branding?.accentColor ?? '#0ea5e9',
          logoUrl: org.branding?.logoUrl ?? null,
          heading: 'Certificate of Completion',
          body: 'This certifies that {candidateName} has successfully passed {examTitle}',
          footNote: 'Verify this certificate at {verificationUrl}',
          signatories: [
            { name: 'Dr. Elena Vasquez', title: 'Registrar', signatureUrl: '/uploads/certificates/signature-registrar.svg' },
            { name: 'Prof. Ian Hartley', title: 'Head of Department', signatureUrl: '/uploads/certificates/signature-hod.svg' },
          ],
          borderStyle: 'guilloche',
          sealUrl: '/uploads/certificates/seal.svg',
          validityYears: org.settings?.certificateValidityYears ?? 3,
        },
      },
    });
    templates.push(template);
    ctx[template.id] = template;
  }

  const certTemplateForVertex = templates.find((template) => template.organizationId === ctx['vertex-cloud'].id);
  await prisma.certificateTemplate.update({
    where: { id: certTemplateForVertex.id },
    data: { examId: certEntry.exam.id, name: 'Vertex Solutions Architect certificate' },
  });

  let certificateCount = 0;
  const passEntries = [
    ...(attempts['aws-solutions-architect'] ?? []),
    ...(attempts['cs210-midterm'] ?? []),
  ].filter((item) => item.scorePercent >= 50);

  for (const [index, item] of passEntries.entries()) {
    const attempt = await prisma.attempt.findUnique({ where: { id: item.attempt.id }, include: { exam: true, user: true } });
    if (!attempt) continue;
    const isCertification = attempt.exam.type === 'CERTIFICATION';
    const template = isCertification ? certTemplateForVertex : templates.find((entry) => entry.organizationId === attempt.organizationId) ?? templates[0];
    const certificateNo = `EXAM-${new Date().getFullYear()}-${String(index + 1).padStart(6, '0')}`;
    const verifyToken = `seed-verify-${certificateNo.toLowerCase()}`;
    const signatureHash = Buffer.from(`${certificateNo}|${attempt.id}|seed-signature`).toString('base64');

    const certificate = await prisma.certificate.upsert({
      where: { certificateNo },
      update: {},
      create: {
        id: `seed-certificate-${index + 1}`,
        certificateNo,
        verifyToken,
        attemptId: attempt.id,
        examId: attempt.examId,
        userId: attempt.userId,
        organizationId: attempt.organizationId ?? attempt.exam.organizationId,
        templateId: template.id,
        candidateName: attempt.user.displayName ?? attempt.user.email,
        examTitle: attempt.exam.title,
        scorePercent: item.scorePercent,
        gradeLetter: attempt.gradeLetter ?? 'C',
        status: 'ISSUED',
        issuedAt: minutesAgo(60 + index * 12),
        expiresAt: isCertification ? daysFromNow((template.config.validityYears ?? 3) * 365) : null,
        pdfUrl: `/uploads/certificates/${certificateNo}.pdf`,
        qrDataUrl: `/uploads/certificates/${certificateNo}-qr.png`,
        signatureHash,
        digitalSignature: { algorithm: 'HMAC-SHA256', keyId: 'seed-signing-key-1', hash: signatureHash },
        validityYears: template.config.validityYears ?? 3,
        issuedById: attempt.exam.createdById,
        emailSentAt: minutesAgo(59 + index * 12),
        linkedInUrl: `https://www.linkedin.com/add-to-profile?url=${encodeURIComponent(`https://examplatform.local/verify/${verifyToken}`)}`,
        metadata: { autoIssued: !isCertification },
      },
    });
    certificateCount += 1;

    if (isCertification) {
      await prisma.badge.upsert({
        where: { certificateId: certificate.id },
        update: {},
        create: {
          id: `seed-badge-${certificate.id}`,
          certificateId: certificate.id,
          name: 'Vertex Solutions Architect',
          description: 'Demonstrated architecture, cost and reliability judgement under proctoring.',
          imageUrl: '/uploads/badges/vertex-architect.svg',
          recipientEmail: attempt.user.email,
          providerUrl: 'https://vertex.example.com',
          criteria: { evidence: `Certificate ${certificate.certificateNo}`, assessmentType: 'PROCTORED_EXAM', passingScore: Number(attempt.exam.passingPercent) },
          contextJson: {
            '@context': 'https://w3id.org/openbadges/v3',
            type: 'Assertion',
            id: `https://examplatform.local/badges/${certificate.certificateNo}`,
            name: 'Vertex Solutions Architect',
            achievement: { id: `https://vertex.example.com/badges/arch`, name: 'Solutions Architect', description: 'Certified architect' },
            verification: { type: 'HostedVerification', verifyURL: `https://examplatform.local/verify/${certificate.verifyToken}` },
            issuedOn: certificate.issuedAt.toISOString(),
          },
          issuedAt: certificate.issuedAt,
        },
      });
    }
  }

  // One revoked certificate so the verification page has an invalid example
  if (certificateCount > 0) {
    const last = await prisma.certificate.findFirst({ where: { status: 'ISSUED' }, orderBy: { issuedAt: 'desc' } });
    if (last) {
      await prisma.certificate.update({
        where: { id: last.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedById: ctx.superAdmin.id,
          revokeReason: 'Proctoring review confirmed unauthorized collaboration.',
        },
      });
    }
  }

  await prisma.exam.update({
    where: { id: certEntry.exam.id },
    data: { gradesReleasedAt: minutesAgo(45), status: 'ACTIVE' },
  });
  if (quizEntry) {
    await prisma.exam.update({ where: { id: quizEntry.exam.id }, data: { gradesReleasedAt: daysFromNow(2) } });
  }

  ctx.rubric = rubric;
  ctx.certificateCount = certificateCount;
  ctx.gradedAnswerCount = gradedCount;
  console.log(`  · ${gradedCount} answers graded (rubric + second grader), ${certificateCount} certificates issued`);
};

function round(value) {
  return Math.round(value * 100) / 100;
}
