const { createRandom, minutesAgo } = require('./lib/utils');

const VIOLATION_PLAYBOOK = [
  { type: 'TAB_SWITCH', severity: 'MINOR', description: 'Focus left the exam window for 6 seconds', weight: 6 },
  { type: 'FULLSCREEN_EXIT', severity: 'MAJOR', description: 'Candidate exited fullscreen mode', weight: 4 },
  { type: 'FACE_NOT_DETECTED', severity: 'MAJOR', description: 'No face detected in webcam frame for 12 seconds', weight: 3 },
  { type: 'MULTIPLE_FACES', severity: 'MAJOR', description: 'Two faces detected in the same frame', weight: 2 },
  { type: 'COPY_PASTE', severity: 'MINOR', description: 'Clipboard paste attempt blocked', weight: 3 },
  { type: 'RIGHT_CLICK', severity: 'WARNING', description: 'Context menu suppressed', weight: 4 },
  { type: 'KEYBOARD_SHORTCUT', severity: 'MINOR', description: 'Ctrl+Shift+I pressed - DevTools blocked', weight: 2 },
  { type: 'DEVTOOLS_OPENED', severity: 'CRITICAL', description: 'Developer tools panel detected open', weight: 1 },
  { type: 'AUDIO_DETECTED', severity: 'MAJOR', description: 'Speech detected while candidate was answering', weight: 2 },
  { type: 'SECOND_DEVICE', severity: 'MAJOR', description: 'Phone glow detected below the frame', weight: 1 },
];

module.exports = async function seed(prisma, ctx) {
  const random = createRandom(90210);
  const proctored = ctx.exams['aws-solutions-architect'];
  if (!proctored) {
    console.log('  · skipped (no proctored exam seeded)');
    return;
  }

  const exam = proctored.exam;
  const attemptList = ctx.attemptsByExam['aws-solutions-architect'] ?? [];
  const proctor = ctx['proctor.kowalski@northgate.example.edu'] ?? ctx['sec.proctor@vertex.example.com'];
  const instructor = proctored.author;
  let sessionCount = 0;
  let violationCount = 0;

  for (const [index, item] of attemptList.entries()) {
    const attemptId = item.attempt.id;
    const userId = item.userId;

    const session = await prisma.proctorSession.upsert({
      where: { attemptId },
      update: {},
      create: {
        id: `seed-proctor-${attemptId}`,
        attemptId,
        examId: exam.id,
        userId,
        status: index === 2 ? 'PENDING_REVIEW' : 'ACTIVE',
        systemCheck: {
          browser: 'Chrome 131',
          camera: 'OK',
          microphone: 'OK',
          screenShare: 'OK',
          networkMbpsDown: random.int(18, 140),
          networkMbpsUp: random.int(6, 60),
          bandwidthOk: true,
          os: 'Ubuntu 24.04',
          resolution: '1920x1080',
        },
        idDocFrontUrl: `/uploads/proctoring/${attemptId}/id-front.jpg`,
        idDocBackUrl: `/uploads/proctoring/${attemptId}/id-back.jpg`,
        selfieUrl: `/uploads/proctoring/${attemptId}/selfie.jpg`,
        environmentUrls: [
          `/uploads/proctoring/${attemptId}/env-01.jpg`,
          `/uploads/proctoring/${attemptId}/env-02.jpg`,
          `/uploads/proctoring/${attemptId}/env-03.jpg`,
        ],
        faceMatchScore: random.int(78, 99),
        termsAccepted: true,
        termsAcceptedAt: minutesAgo(240 - index * 10),
        recordingConsent: true,
        lockdownEnabled: true,
        fullscreenRequired: true,
        browserInfo: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0', plugins: ['internal'], webgl: true },
        reviewedById: instructor.id,
        reviewedAt: minutesAgo(230 - index * 10),
        reviewNote: index === 2 ? 'ID photo is blurry - re-check requested.' : 'Identity verified against registrar record.',
        startedAt: minutesAgo(225 - index * 10),
        endedAt: null,
      },
    });
    sessionCount += 1;

    // Violation log: heavier for one attempt so the risk model has a signal
    const violationTotal = index === 2 ? 7 : index === 1 ? 4 : 2;
    let recorded = 0;
    for (const playbook of VIOLATION_PLAYBOOK) {
      const times = Math.min(playbook.weight, Math.max(0, violationTotal - recorded));
      if (times <= 0) break;
      for (let occurrence = 0; occurrence < times; occurrence += 1) {
        await prisma.violation.upsert({
          where: { id: `seed-violation-${attemptId}-${playbook.type}-${occurrence}` },
          update: {},
          create: {
            id: `seed-violation-${attemptId}-${playbook.type}-${occurrence}`,
            attemptId,
            proctorSessionId: session.id,
            examId: exam.id,
            userId,
            type: playbook.type,
            severity: playbook.severity,
            occurredAt: minutesAgo(200 - recorded * 7 - occurrence),
            count: times,
            description: playbook.description,
            evidenceUrls: [`/uploads/proctoring/${attemptId}/evidence-${playbook.type.toLowerCase()}-${occurrence}.jpg`],
            screenshotUrl: `/uploads/proctoring/${attemptId}/screenshot-${recorded}.jpg`,
            details: {
              durationMs: random.int(900, 14_000),
              currentQuestionOrder: (recorded % 5) + 1,
              visibilityState: 'hidden',
              aiConfidence: random.int(62, 99) / 100,
            },
            isResolved: occurrence === 0,
            resolvedById: occurrence === 0 ? proctor?.id ?? instructor.id : null,
            resolvedAt: occurrence === 0 ? minutesAgo(150) : null,
            resolution: occurrence === 0 ? 'Warning issued via chat - candidate resumed.' : null,
            aiRiskScore: random.int(20, 95),
            aiReason: 'Pattern matches known tab-switch cheating signature.',
            manualFlag: playbook.severity === 'CRITICAL',
          },
        });
        recorded += 1;
        violationCount += 1;
      }
    }

    await prisma.attempt.update({
      where: { id: attemptId },
      data: {
        violationCount: recorded,
        isFlagged: recorded >= 4,
        riskScore: Math.min(100, recorded * 12 + (recorded >= 6 ? 25 : 0)),
        ...(recorded >= 7
          ? {
              status: 'TERMINATED',
              isTerminated: true,
              terminatedById: proctor?.id ?? instructor.id,
              terminationReason: 'Repeated fullscreen exits and DevTools usage - terminated by proctor.',
              terminatedAt: minutesAgo(90),
            }
          : {}),
      },
    });

    if (proctor) {
      for (const [messageIndex, kind] of ['WARNING', 'MESSAGE', 'EXTRA_TIME'].entries()) {
        await prisma.proctorMessage.upsert({
          where: { id: `seed-msg-${attemptId}-${kind}` },
          update: {},
          create: {
            id: `seed-msg-${attemptId}-${kind}`,
            attemptId,
            proctorSessionId: session.id,
            examId: exam.id,
            fromUserId: proctor.id,
            toUserId: userId,
            kind,
            body:
              kind === 'WARNING'
                ? 'Please keep the exam window in fullscreen for the entire session.'
                : kind === 'EXTRA_TIME'
                  ? 'You have been granted 5 minutes of extra time.'
                  : 'Everything looks fine - continue.',
            readAt: messageIndex === 0 ? minutesAgo(120) : null,
            deliveredAt: minutesAgo(125 - messageIndex),
            createdAt: minutesAgo(126 - messageIndex),
            metadata: { extraTimeSeconds: kind === 'EXTRA_TIME' ? 300 : undefined, channel: 'socket.io' },
          },
        });
      }
      if (recorded >= 4) {
        await prisma.proctorMessage.upsert({
          where: { id: `seed-msg-${attemptId}-PAUSE` },
          update: {},
          create: {
            id: `seed-msg-${attemptId}-PAUSE`,
            attemptId,
            proctorSessionId: session.id,
            examId: exam.id,
            fromUserId: proctor.id,
            toUserId: userId,
            kind: 'PAUSE',
            body: 'Your session has been paused pending an integrity check.',
            createdAt: minutesAgo(60),
            metadata: { pausedByProctor: true },
          },
        });
      }
    }

    for (const kind of ['WEBCAM', 'SCREEN']) {
      await prisma.examRecording.upsert({
        where: { id: `seed-rec-${attemptId}-${kind}` },
        update: {},
        create: {
          id: `seed-rec-${attemptId}-${kind}`,
          attemptId,
          proctorSessionId: session.id,
          examId: exam.id,
          userId,
          kind,
          url: `/uploads/recordings/${attemptId}/${kind.toLowerCase()}-main.webm`,
          storagePath: `uploads/recordings/${attemptId}/${kind.toLowerCase()}-main.webm`,
          mimeType: 'video/webm',
          sizeBytes: BigInt(random.int(4_000_000, 240_000_000)),
          chunkIndex: 0,
          startedAt: minutesAgo(220),
          endedAt: minutesAgo(95),
          durationSec: random.int(1500, 4200),
          status: 'AVAILABLE',
          metadata: { fps: 15, resolution: kind === 'WEBCAM' ? '640x480' : '1920x1080' },
        },
      });
    }
  }

  ctx.proctorSessions = sessionCount;
  ctx.violationCount = violationCount;
  console.log(`  · ${sessionCount} proctoring sessions, ${violationCount} violations, recordings + proctor chat`);
};
