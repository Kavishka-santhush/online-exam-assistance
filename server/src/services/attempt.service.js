/**
 * Attempt service: everything that happens while a candidate sits an exam.
 *
 * Three rules hold this module together:
 *
 * 1. The server owns the truth. The question plan is resolved and frozen the
 *    moment an attempt starts (random pools included), so a refresh cannot
 *    re-roll a harder set and the client cannot ask for a question that was
 *    never assigned.
 * 2. The clock is server-side (`timer.service` computes `expiresAt` from
 *    `startedAt`); the client only ever displays it.
 * 3. Saves are idempotent and timestamped, because the browser queues them while
 *    offline and flushes the whole queue on reconnect.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { gradeAnswer, isEmptyResponse, round } = require('../utils/scoring.util');
const { runCode } = require('../utils/codeRunner.util');
const timer = require('./timer.service');
const scoring = require('./scoring.service');
const { notifyUser, pushToRoom, pushToUser } = require('./notification.service');
const {
  EXAM_SETTING_DEFAULTS, PROCTORING_DEFAULTS, checkAccess, drawFromPool, seededRandom, stripAnswerKeys,
} = require('./exam.service');

/** A queued save older than this is dropped rather than applied. */
const MAX_OFFLINE_OPERATIONS = 500;
const SAVE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

const ATTEMPT_LIST_SELECT = {
  id: true,
  examId: true,
  userId: true,
  attemptNumber: true,
  status: true,
  gradingStatus: true,
  startedAt: true,
  submittedAt: true,
  expiresAt: true,
  usedTimeSec: true,
  finalScore: true,
  scorePercent: true,
  passed: true,
  gradeLetter: true,
  percentile: true,
  answeredCount: true,
  violationCount: true,
  riskScore: true,
  isFlagged: true,
  autoSubmitted: true,
  isTerminated: true,
  exam: { select: { id: true, title: true, slug: true, totalMarks: true, passingPercent: true } },
  user: { select: { id: true, displayName: true, email: true, imageUrl: true } },
};

/** Columns needed to rebuild a runtime view. */
const EXAM_FOR_PLAN_INCLUDE = {
  organization: { select: { id: true, slug: true, branding: true, defaultExamSettings: true } },
  sections: { orderBy: { order: 'asc' }, include: { pools: true } },
  examQuestions: {
    orderBy: { order: 'asc' },
    select: { id: true, questionId: true, sectionId: true, order: true, marks: true, isRequired: true, negativePercent: true },
  },
};

// ---------------------------------------------------------------------------
// Starting an attempt
// ---------------------------------------------------------------------------

/**
 * Resolve this attempt's question set: explicit links + one draw per random
 * pool, optionally shuffled, then numbered from 1.
 */
async function buildPlan(exam, seed) {
  const entries = [];

  for (const link of exam.examQuestions) {
    if (link.sectionId && exam.sections.some((section) => section.id === link.sectionId && section.randomFromPool)) continue;
    entries.push({
      questionId: link.questionId,
      examQuestionId: link.id,
      sectionId: link.sectionId ?? null,
      marks: Number(link.marks ?? 1),
      isRequired: link.isRequired !== false,
      negativePercent: link.negativePercent == null ? null : Number(link.negativePercent),
    });
  }

  for (const section of exam.sections.filter((row) => row.randomFromPool)) {
    const pool = section.pools[0];
    if (!pool) continue;
    const drawn = drawFromPool(pool, { seed: seededSeed(seed, section.id) });
    if (!drawn.length) continue;
    const marks = new Map(
      (await prisma.question.findMany({ where: { id: { in: drawn } }, select: { id: true, marks: true } }))
        .map((row) => [row.id, Number(row.marks ?? 1)]),
    );
    for (const questionId of drawn) {
      entries.push({
        questionId,
        examQuestionId: null,
        sectionId: section.id,
        marks: marks.get(questionId) ?? 1,
        isRequired: true,
        negativePercent: null,
      });
    }
  }

  const order = exam.shuffleQuestions ? shuffle(entries, seededRandom(seed)) : entries;
  const numbered = order.map((entry, index) => ({ ...entry, order: index + 1 }));

  // The plan carries the question type: the player, the progress counter and the
  // grader all read it without another round trip.
  const metaRows = await prisma.question.findMany({
    where: { id: { in: [...new Set(numbered.map((entry) => entry.questionId))] } },
    select: { id: true, type: true, marks: true },
  });
  const metaById = new Map(metaRows.map((row) => [row.id, row]));
  return numbered.map((entry) => ({
    ...entry,
    type: metaById.get(entry.questionId)?.type ?? 'SHORT_ANSWER',
    marks: entry.marks ?? Number(metaById.get(entry.questionId)?.marks ?? 1),
  }));
}

/** Per-section PRNG so two pools in one exam never draw the same tail. */
function seededSeed(base, salt) {
  let mixed = Number(base) >>> 0;
  for (const char of String(salt)) mixed = (mixed ^ char.charCodeAt(0)) >>> 0;
  return (mixed + 0x9e3779b9) >>> 0;
}

function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function optionOrdersFor(planEntries, questions, seed, enabled) {
  if (!enabled) return {};
  const random = seededRandom(seed);
  const orders = {};
  for (const entry of planEntries) {
    const options = questions.get(entry.questionId)?.content?.options;
    if (!Array.isArray(options) || options.length < 2) continue;
    orders[entry.questionId] = shuffle(options.map((option) => option.id), random);
  }
  return orders;
}

/**
 * Start (or resume) an attempt.
 *
 * Proctored exams return `requiresProctorSetup: true` with the clock parked:
 * `proctoring.service` calls `beginClock()` once the candidate clears setup.
 */
async function startAttempt(examId, options = {}, actor = {}) {
  const {
    accessCode = null, inviteToken = null, ip = null, userAgent = null, deviceInfo = {},
  } = options;
  const userId = actor.userId;
  if (!userId) throw ApiError.unauthorized('Sign in before starting an attempt');

  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: EXAM_FOR_PLAN_INCLUDE });
  if (!exam) throw ApiError.notFound('Exam not found');

  const access = await checkAccess(exam, { userId, accessCode, inviteToken });
  if (!access.allowed) {
    if (access.code === 'PAYMENT_REQUIRED') {
      throw ApiError.paymentRequired(access.reason ?? 'The exam fee has not been paid', { examFeeCents: exam.examFeeCents, currency: exam.currency });
    }
    throw new ApiError(403, access.code ?? 'FORBIDDEN', access.reason ?? 'You cannot take this exam');
  }

  const live = await prisma.attempt.findFirst({
    where: { examId, userId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
    orderBy: { startedAt: 'desc' },
  });
  if (live) {
    if (timer.isExpired(live, exam)) {
      logger.info('stale attempt auto-submitted on re-entry', { attemptId: live.id });
      await finaliseAttempt(live.id, { autoSubmitted: true, reason: 'TIME_UP' });
    } else {
      return getRuntimeState(live.id, { actor, exam });
    }
  }

  const priorAttempts = await prisma.attempt.count({ where: { examId, userId } });
  if (exam.attemptLimit && priorAttempts >= exam.attemptLimit) {
    throw ApiError.forbidden(`You have used all ${exam.attemptLimit} allowed attempt(s) for this exam`, { attemptLimit: exam.attemptLimit });
  }

  const settings = runtimeSettings(exam);
  const registration = await ensureRegistration(exam, userId, { accessCode });
  const paid = exam.examFeeCents > 0 ? ['PAID', 'COMPLETED'].includes(registration.status) || registration.paidAmountCents >= exam.examFeeCents : true;
  if (!paid) throw ApiError.paymentRequired('The exam fee has not been paid', { examFeeCents: exam.examFeeCents, currency: exam.currency });

  const seatTaken = exam.maxCandidates
    ? await prisma.attempt.count({ where: { examId, userId: { not: userId }, status: { in: ['IN_PROGRESS', 'PAUSED'] } } })
    : 0;
  if (exam.maxCandidates && registration?.seatNumber && seatTaken >= exam.maxCandidates && access.role !== 'STAFF') {
    throw ApiError.locked('All seats for this exam are currently in use', { maxCandidates: exam.maxCandidates });
  }

  const seed = crypto.randomBytes(4).readUInt32BE(0);
  const plan = await buildPlan(exam, seed);
  if (!plan.length) throw ApiError.unprocessable('This exam has no questions yet');

  const isSurvey = exam.type === 'SURVEY';
  const now = new Date();
  const proctored = Boolean(exam.isProctored);

  const attempt = await prisma.attempt.create({
    data: {
      examId,
      examVersion: exam.version,
      userId,
      organizationId: exam.organizationId,
      registrationId: registration.id,
      attemptNumber: priorAttempts + 1,
      status: 'IN_PROGRESS',
      gradingStatus: isSurvey ? 'NOT_REQUIRED' : 'UNGRADED',
      startedAt: now,
      // Parked until the proctor setup finishes; `beginClock()` sets it.
      expiresAt: null,
      timeLimitSec: timer.computeLimitSec({ timeLimitSec: null }, exam) || null,
      isAdaptive: Boolean(exam.isAdaptive),
      adaptiveState: exam.isAdaptive ? { theta: 0, stdErr: 1, shown: [], seed } : {},
      answerOrder: plan.map((entry) => entry.questionId),
      markedForReview: [],
      hintsRevealed: [],
      isAnonymous: Boolean(settings.anonymousResponses) || isSurvey,
      ip,
      userAgent,
      deviceInfo: sanitiseDeviceInfo(deviceInfo),
      lastActivityAt: now,
      metadata: {
        clockStarted: !proctored,
        pendingProctorSetup: proctored,
        planSeed: seed,
        questionPlan: plan,
        optionOrders: {},
        pausedTotalSec: 0,
        timeAdjustments: [],
      },
    },
    include: { exam: true },
  });

  // Option shuffling needs the question bodies, so it happens after the row.
  const questions = await questionMapFor(plan);
  const optionOrders = optionOrdersFor(plan, questions, seed, exam.shuffleOptions);
  await prisma.attempt.update({
    where: { id: attempt.id },
    data: { metadata: { ...attempt.metadata, optionOrders } },
  });

  if (proctored) {
    await prisma.proctorSession.create({
      data: { attemptId: attempt.id, examId, userId, status: 'PENDING_SETUP' },
    });
  }

  await prisma.exam.update({ where: { id: examId }, data: { totalAttempts: { increment: 1 } } });
  if (exam.isProctored) pushToRoom(`exam:${examId}:proctors`, 'proctor:candidate-started', { attemptId: attempt.id, userId, at: now.toISOString() });

  if (!proctored) return getRuntimeState(attempt.id, { actor, exam: { ...exam, ...attempt.exam } });

  return {
    attemptId: attempt.id,
    examId,
    requiresProctorSetup: true,
    proctoring: { ...PROCTORING_DEFAULTS, ...(exam.proctoringConfig ?? {}) },
    status: attempt.status,
  };
}

/** Called by proctoring.service once system/id checks are cleared. */
async function beginClock(attemptId, { extraSec = 0 } = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const now = new Date();
  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      startedAt: now,
      lastActivityAt: now,
      metadata: { ...attempt.metadata, clockStarted: true, pendingProctorSetup: false, clockStartedAt: now.toISOString() },
    },
  });

  const { timer: started } = await timer.startClock(attemptId, { accessibilityExtraSec: extraSec });
  const refreshed = await prisma.attempt.findUnique({ where: { id: attemptId } });
  pushToUser(attempt.userId, 'exam:clock-started', { attemptId, timer: started });
  return { attemptId, timer: timer.timeSnapshot(refreshed, attempt.exam, now), expiresAt: refreshed.expiresAt };
}

/** Create the registration row for self-serve exams (PUBLIC / code / link). */
async function ensureRegistration(exam, userId, { accessCode = null } = {}) {
  const existing = await prisma.examCandidate.findUnique({ where: { examId_userId: { examId: exam.id, userId } } });
  if (existing) return existing;

  if (!['PUBLIC', 'ACCESS_CODE', 'INVITE_LINK'].includes(exam.accessControl)) {
    throw ApiError.forbidden('You must be registered for this exam');
  }

  const count = await prisma.examCandidate.count({ where: { examId: exam.id } });
  try {
    const created = await prisma.examCandidate.create({
      data: {
        examId: exam.id,
        userId,
        status: exam.examFeeCents > 0 ? 'PENDING' : 'REGISTERED',
        seatNumber: exam.maxCandidates && count + 1 <= exam.maxCandidates ? count + 1 : null,
        accessGrantedAt: accessCode ? new Date() : null,
        registeredAt: new Date(),
      },
    });
    await prisma.exam.update({ where: { id: exam.id }, data: { totalRegistrations: { increment: 1 } } });
    return created;
  } catch (error) {
    // Unique race (`@@unique([examId, userId])`): another request won it.
    if (error?.code !== 'P2002') throw error;
    return prisma.examCandidate.findUniqueOrThrow({ where: { examId_userId: { examId: exam.id, userId } } });
  }
}

/** Self-enrolment endpoint backing the "Register" button on the exam intro. */
async function registerForExam(examId, { accessCode = null, inviteToken = null } = {}, actor = {}) {
  if (!actor.userId) throw ApiError.unauthorized('Sign in first');
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');

  const access = await checkAccess(exam, { userId: actor.userId, accessCode, inviteToken, requireWindow: false });
  if (!access.allowed && access.code !== 'PAYMENT_REQUIRED') {
    throw new ApiError(403, access.code ?? 'FORBIDDEN', access.reason ?? 'You cannot register for this exam');
  }

  const registration = await ensureRegistration(exam, actor.userId, { accessCode });
  if (exam.examFeeCents > 0) {
    return { registrationId: registration.id, status: registration.status, amountCents: exam.examFeeCents, currency: exam.currency, requiresPayment: true };
  }
  return { registrationId: registration.id, status: registration.status, requiresPayment: false };
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** Merge organization defaults under the exam's own settings. */
function runtimeSettings(exam) {
  return {
    ...EXAM_SETTING_DEFAULTS,
    ...(exam.organization?.defaultExamSettings ?? {}),
    ...(exam.settings ?? {}),
  };
}

async function questionMapFor(plan) {
  const ids = [...new Set(plan.map((entry) => entry.questionId))];
  if (!ids.length) return new Map();
  const rows = await prisma.question.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, type: true, prompt: true, content: true, marks: true, difficulty: true,
      topicTags: true, estimatedTimeSec: true, currentVersion: true, hint: true, hintCostMarks: true,
      imageUrls: true, audioUrl: true, videoUrl: true, language: true,
    },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The full payload the exam player needs: questions (without answer keys),
 * saved answers, timer, and navigation rules.
 */
async function getRuntimeState(attemptId, { actor = {}, exam = null } = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { exam: { include: EXAM_FOR_PLAN_INCLUDE }, proctorSession: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);

  const record = exam ?? attempt.exam;
  const settings = runtimeSettings(record);
  const plan = planOf(attempt);

  if (attempt.metadata?.pendingProctorSetup && attempt.proctorSession?.status !== 'ACTIVE') {
    return {
      attemptId: attempt.id,
      examId: attempt.examId,
      requiresProctorSetup: true,
      proctorSession: attempt.proctorSession ?? null,
      status: attempt.status,
    };
  }

  const questions = await questionMapFor(plan);
  const answers = await prisma.answer.findMany({
    where: { attemptId: attempt.id },
    select: {
      id: true, questionId: true, response: true, textAnswer: true, selectedOptions: true, matchedPairs: true,
      orderedItems: true, blankAnswers: true, hotspotClicks: true, codeLanguage: true, codeSource: true,
      mathLatex: true, ratingValue: true, matrixResponses: true, wordCount: true, timeSpentSec: true,
      isMarkedForReview: true, wasSkipped: true, answeredAt: true, maxMarks: true,
      files: { select: { id: true, url: true, originalName: true, mimeType: true, kind: true } },
    },
  });
  const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

  const timerState = timer.timeSnapshot(attempt, record);
  const revealed = new Map((attempt.hintsRevealed ?? []).map((hint) => [hint.questionId, hint]));

  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    userId: attempt.userId,
    status: attempt.status,
    attemptNumber: attempt.attemptNumber,
    requiresProctorSetup: false,
    proctorSession: attempt.proctorSession ?? null,
    settings: {
      ...settings,
      calculatorAllowed: record.calculatorAllowed || settings.allowCalculator,
      scratchpadAllowed: record.scratchpadAllowed || settings.allowScratchpad,
      attachmentAllowed: record.attachmentAllowed || settings.allowAttachments,
      perQuestionSec: record.perQuestionSec ?? null,
      negativeMarking: record.negativeMarking,
      partialMarking: record.partialMarking,
      examType: record.type,
      isSurvey: record.type === 'SURVEY',
    },
    proctoring: { ...PROCTORING_DEFAULTS, ...(record.proctoringConfig ?? {}) },
    accessibility: record.accessibilityConfig ?? {},
    exam: {
      id: record.id,
      title: record.title,
      slug: record.slug,
      instructions: record.instructions,
      totalMarks: Number(record.totalMarks ?? 0),
      durationMinutes: record.durationMinutes,
      language: record.language,
      version: attempt.examVersion,
    },
    sections: record.sections.map((section) => ({
      id: section.id,
      name: section.name,
      instructions: section.instructions,
      order: section.order,
      durationMinutes: section.durationMinutes,
      canNavigateBack: section.canNavigateBack,
      isLocked: section.isLocked,
      questionCount: plan.filter((entry) => entry.sectionId === section.id).length,
    })),
    questions: plan.map((entry) => {
      const question = questions.get(entry.questionId);
      if (!question) return { questionId: entry.questionId, order: entry.order, missing: true };
      const content = stripAnswerKeys(question.content);
      const optionOrder = attempt.metadata?.optionOrders?.[entry.questionId];
      const orderedContent = optionOrder && Array.isArray(content?.options)
        ? { ...content, options: optionOrder.map((id) => content.options.find((option) => option.id === id)).filter(Boolean) }
        : content;
      return {
        questionId: entry.questionId,
        examQuestionId: entry.examQuestionId,
        sectionId: entry.sectionId,
        order: entry.order,
        marks: entry.marks,
        isRequired: entry.isRequired,
        negativePercent: entry.negativePercent,
        type: question.type,
        prompt: question.prompt,
        difficulty: question.difficulty,
        topicTags: question.topicTags,
        estimatedTimeSec: question.estimatedTimeSec,
        content: orderedContent,
        hints: hintListFor(question),
        hintRevealed: revealed.has(entry.questionId),
        media: { images: question.imageUrls, audio: question.audioUrl, video: question.videoUrl },
        language: question.language,
        questionVersion: question.currentVersion,
      };
    }),
    answers: answers.map((answer) => ({ ...answer, maxMarks: Number(answer.maxMarks ?? 0) })),
    progress: progressOf(plan, answers, attempt),
    markedForReview: attempt.markedForReview ?? [],
    scratchpad: attempt.metadata?.scratchpad ?? '',
    currentSectionId: attempt.currentSectionId,
    currentQuestionOrder: attempt.currentQuestionOrder ?? 1,
    timer: timerState,
    lastAutoSaveAt: attempt.lastAutoSaveAt,
    violationCount: attempt.violationCount,
  };
}

function planOf(attempt) {
  const plan = Array.isArray(attempt.metadata?.questionPlan) ? attempt.metadata.questionPlan : [];
  if (plan.length) return plan;
  // Fallback for rows created before the plan was frozen.
  return (attempt.answerOrder ?? []).map((questionId, index) => ({
    questionId,
    examQuestionId: null,
    sectionId: null,
    marks: 1,
    isRequired: true,
    negativePercent: null,
    order: index + 1,
  }));
}

function progressOf(plan, answers, attempt) {
  const answered = answers.filter((answer) => !answer.wasSkipped && !isEmptyResponse(answerType(plan, answer.questionId), answer.response)).length;
  const skipped = answers.filter((answer) => answer.wasSkipped).length;
  return {
    total: plan.length,
    answered,
    skipped,
    unanswered: Math.max(0, plan.length - answered - skipped),
    markedForReview: Array.isArray(attempt.markedForReview) ? attempt.markedForReview.length : 0,
    percent: plan.length ? Math.round((answered / plan.length) * 100) : 0,
  };
}

function answerType(plan, questionId) {
  return plan.find((entry) => entry.questionId === questionId)?.type ?? 'SHORT_ANSWER';
}

/** Hints come from `content.hints` or the single `hint` column. */
function hintListFor(question) {
  const configured = Array.isArray(question.content?.hints) ? question.content.hints : [];
  if (configured.length) {
    return configured.map((hint, index) => ({
      index,
      text: hint.text ?? String(hint),
      costPercent: Number(hint.costPercent ?? hint.cost ?? 0) || 0,
    }));
  }
  if (!question.hint) return [];
  return [{ index: 0, text: question.hint, costPercent: Number(question.hintCostMarks ?? 0) || 0 }];
}

/** Reconnect helper: same payload as the runtime state plus the timer. */
async function resumeAttempt(attemptId, actor) {
  const state = await getRuntimeState(attemptId, { actor });
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (attempt && ['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    await prisma.attempt.update({ where: { id: attemptId }, data: { lastActivityAt: new Date() } });
  }
  return { ...state, resumedAt: new Date().toISOString(), timer: timer.timeSnapshot(attempt, attempt?.exam) };
}

/** Cheap heartbeat: keeps `lastActivityAt` fresh and returns the clock. */
async function recordActivity(attemptId, { currentSectionId = null, currentQuestionOrder = null } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);
  assertLive(attempt);

  const data = { lastActivityAt: new Date() };
  if (currentSectionId !== null) data.currentSectionId = currentSectionId;
  if (currentQuestionOrder !== null) data.currentQuestionOrder = Number(currentQuestionOrder) || null;
  const updated = await prisma.attempt.update({ where: { id: attemptId }, data });

  const snapshot = timer.timeSnapshot(updated, attempt.exam);
  const warnings = timer.dueWarnings(attempt.remainingTimeSec, snapshot.remainingSec, attempt.exam);
  if (warnings.length) {
    await prisma.attempt.update({ where: { id: attemptId }, data: { remainingTimeSec: snapshot.remainingSec } });
    for (const seconds of warnings) {
      pushToUser(attempt.userId, 'exam:time-warning', { attemptId, remainingSec: snapshot.remainingSec, thresholdSec: seconds });
    }
  }
  return { timer: snapshot, warnings, lastActivityAt: updated.lastActivityAt };
}

// ---------------------------------------------------------------------------
// Answer capture
// ---------------------------------------------------------------------------

/**
 * Push the free-form `response` blob into the typed Answer columns so the
 * graders, the answer-sheet PDF and analytics can read them without JSON maths.
 */
function deriveColumns({ type, response = {} }) {
  const columns = { response };

  switch (type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      columns.selectedOptions = [response.optionId ?? response.value].filter((value) => value !== undefined && value !== null).map(String);
      columns.textAnswer = null;
      break;
    case 'MULTIPLE_ANSWER':
      columns.selectedOptions = (response.optionIds ?? response.selectedOptions ?? []).map(String);
      break;
    case 'SHORT_ANSWER':
      columns.textAnswer = String(response.text ?? response.value ?? '');
      break;
    case 'LONG_ANSWER':
    case 'ESSAY':
    case 'REFLECTIVE':
      columns.textAnswer = String(response.text ?? response.html ?? '');
      break;
    case 'FILL_BLANK':
      columns.blankAnswers = response.blanks ?? [];
      break;
    case 'DROPDOWN':
      columns.blankAnswers = response.answers ?? [];
      break;
    case 'MATCHING':
      columns.matchedPairs = response.pairs ?? [];
      break;
    case 'ORDERING':
      columns.orderedItems = response.order ?? [];
      break;
    case 'HOTSPOT':
    case 'IMAGE_LABELLING':
      columns.hotspotClicks = response.clicks ?? [];
      break;
    case 'CODING':
      columns.codeSource = String(response.code ?? '');
      columns.codeLanguage = response.language ?? null;
      columns.testRunResults = response.runResults ?? [];
      break;
    case 'MATH_FORMULA':
      columns.mathLatex = String(response.latex ?? response.text ?? '');
      break;
    case 'RATING_SCALE':
    case 'LIKERT_SCALE':
      columns.ratingValue = Number(response.value ?? response.rating) || null;
      break;
    case 'MATRIX':
      columns.matrixResponses = response.answers ?? {};
      break;
    case 'FILE_UPLOAD':
    case 'AUDIO_RESPONSE':
    case 'VIDEO_RESPONSE':
    case 'DRAWING':
      columns.textAnswer = response.caption ? String(response.caption) : null;
      break;
    default:
      if (typeof response.text === 'string') columns.textAnswer = response.text;
      break;
  }

  columns.wordCount = countWords(columns.textAnswer ?? response.text ?? '');
  return columns;
}

function countWords(text) {
  if (!text) return 0;
  return String(text).replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Apply one answer write. `source` is only used for logging so an offline flush
 * can be told apart from a live autosave.
 */
async function applyAnswerWrite(attempt, { questionId, response, wasSkipped = null, timeSpentSec = null, clientSavedAt = null, order = null }) {
  const plan = planOf(attempt);
  const entry = plan.find((row) => row.questionId === questionId);
  if (!entry) throw ApiError.badRequest('That question is not part of this attempt', { questionId });

  const question = await prisma.question.findUnique({ where: { id: questionId }, select: { id: true, type: true, marks: true, currentVersion: true } });
  if (!question) throw ApiError.notFound('Question not found');

  const payload = response ?? {};
  const columns = deriveColumns({ type: question.type, response: payload });
  const empty = isEmptyResponse(question.type, payload);
  const maxMarks = entry.marks ?? Number(question.marks ?? 1);

  const data = {
    ...columns,
    examQuestionId: entry.examQuestionId,
    sectionId: entry.sectionId,
    order: order ?? entry.order,
    maxMarks,
    questionVersion: question.currentVersion ?? 1,
    wasSkipped: wasSkipped === null ? empty : Boolean(wasSkipped),
    answeredAt: empty ? null : new Date(),
    gradingStatus: 'UNGRADED',
    needsManualGrading: false,
  };
  if (timeSpentSec !== null && timeSpentSec !== undefined) data.timeSpentSec = Math.max(0, Math.min(36000, Number(timeSpentSec) || 0));

  const existing = await prisma.answer.findUnique({ where: { attemptId_questionId: { attemptId: attempt.id, questionId } }, select: { id: true, updatedAt: true, timeSpentSec: true } });

  // Never let a stale queued save overwrite newer work.
  if (existing && clientSavedAt && new Date(clientSavedAt).getTime() + SAVE_CLOCK_TOLERANCE_MS < existing.updatedAt.getTime()) {
    return { applied: false, reason: 'STALE', answerId: existing.id, questionId };
  }
  if (existing && timeSpentSec != null) data.timeSpentSec = (existing.timeSpentSec ?? 0) + data.timeSpentSec;

  const answer = existing
    ? await prisma.answer.update({ where: { id: existing.id }, data })
    : await prisma.answer.create({ data: { attemptId: attempt.id, questionId, ...data } });

  await attachAnswerFiles(answer.id, payload.fileIds);

  logger.debug('answer saved', { attemptId: attempt.id, questionId, source: empty ? 'cleared' : 'stored' });
  return { applied: true, answerId: answer.id, questionId, isBlank: empty };
}

/** Link uploads that were created through the media endpoint to this answer. */
async function attachAnswerFiles(answerId, fileIds = []) {
  if (!Array.isArray(fileIds) || !fileIds.length) return 0;
  const result = await prisma.uploadedFile.updateMany({
    where: { id: { in: fileIds.slice(0, 10) }, answerId: null },
    data: { answerId },
  });
  return result.count;
}

async function saveAnswer(attemptId, payload = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const result = await applyAnswerWrite(attempt, payload);
  const touched = await prisma.attempt.update({
    where: { id: attemptId },
    data: { lastActivityAt: new Date(), lastAutoSaveAt: new Date() },
  });
  const answeredCount = await prisma.answer.count({ where: { attemptId, wasSkipped: false } });
  if (answeredCount !== attempt.answeredCount) {
    await prisma.attempt.update({ where: { id: attemptId }, data: { answeredCount } });
  }
  return { ...result, answeredCount, savedAt: touched.lastAutoSaveAt };
}

/** Autosave: the 30-second bulk flush of whatever the player holds. */
async function autosave(attemptId, { answers = [], markedForReview, scratchpad, currentSectionId = null, currentQuestionOrder = null } = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const applied = [];
  for (const entry of answers.slice(0, MAX_OFFLINE_OPERATIONS)) {
    if (!entry?.questionId) continue;
    applied.push(await applyAnswerWrite(attempt, entry));
  }

  const data = { lastAutoSaveAt: new Date(), lastActivityAt: new Date() };
  if (Array.isArray(markedForReview)) data.markedForReview = markedForReview.slice(0, 500);
  if (typeof scratchpad === 'string') data.metadata = { ...attempt.metadata, scratchpad: scratchpad.slice(0, 20000) };
  if (currentSectionId) data.currentSectionId = currentSectionId;
  if (currentQuestionOrder) data.currentQuestionOrder = Number(currentQuestionOrder) || null;

  await prisma.attempt.update({ where: { id: attemptId }, data });
  const answeredCount = await prisma.answer.count({ where: { attemptId, wasSkipped: false } });
  await prisma.attempt.update({ where: { id: attemptId }, data: { answeredCount } });

  return { saved: applied.filter((row) => row.applied).length, skipped: applied.filter((row) => !row.applied).length, answeredCount, savedAt: data.lastAutoSaveAt };
}

/**
 * Flush the browser's offline queue. Operations are applied oldest first and a
 * stale write is reported instead of overwriting newer work, so the client can
 * drop it from the queue.
 */
async function syncOfflineQueue(attemptId, { operations = [], clientNow = null } = {}, actor = {}) {
  if (!Array.isArray(operations) || !operations.length) return { applied: 0, stale: 0, results: [] };
  if (operations.length > MAX_OFFLINE_OPERATIONS) throw ApiError.badRequest(`Queue at most ${MAX_OFFLINE_OPERATIONS} operations per sync`);

  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);

  const ordered = [...operations].sort((a, b) => new Date(a.clientSavedAt ?? 0) - new Date(b.clientSavedAt ?? 0));
  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    return { applied: 0, stale: 0, results: [{ applied: false, reason: 'ATTEMPT_CLOSED' }], status: attempt.status };
  }

  const results = [];
  for (const operation of ordered) {
    try {
      results.push(await applyAnswerWrite(attempt, operation));
    } catch (error) {
      logger.warn('offline operation rejected', { attemptId, questionId: operation.questionId, error: error.message });
      results.push({ applied: false, reason: 'REJECTED', questionId: operation.questionId, message: error.message });
    }
  }

  const exam = await prisma.exam.findUnique({ where: { id: attempt.examId } });
  const stale = results.filter((row) => row.reason === 'STALE').length;
  const answeredCount = await prisma.answer.count({ where: { attemptId, wasSkipped: false } });
  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      answeredCount,
      lastActivityAt: new Date(),
      metadata: { ...attempt.metadata, lastOfflineSyncAt: new Date().toISOString(), clientNow: clientNow ?? null, staleSyncs: Number(attempt.metadata?.staleSyncs ?? 0) + stale },
    },
  });

  return { applied: results.filter((row) => row.applied).length, stale, results, timer: timer.timeSnapshot(attempt, exam) };
}

/** Navigation: records where the candidate is and enforces the section rules. */
async function navigate(attemptId, { questionOrder = null, sectionId = null, direction = null } = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const exam = await prisma.exam.findUnique({ where: { id: attempt.examId }, include: EXAM_FOR_PLAN_INCLUDE });
  const plan = planOf(attempt);
  const settings = runtimeSettings(exam);

  let target = attempt.currentQuestionOrder ?? 1;
  if (questionOrder) target = Math.min(plan.length, Math.max(1, Number(questionOrder)));
  if (direction === 'next') target = Math.min(plan.length, target + 1);
  if (direction === 'prev') target = Math.max(1, target - 1);

  const entry = plan.find((row) => row.order === target);
  if (!entry) throw ApiError.badRequest('No such question in this attempt', { questionOrder: target });

  if (sectionId && exam.sections.length) {
    const current = exam.sections.find((section) => section.id === attempt.currentSectionId);
    const next = exam.sections.find((section) => section.id === sectionId);
    if (current && next && !settings.allowNavigation && next.order < current.order) {
      throw ApiError.forbidden('Back navigation is disabled for this exam');
    }
    if (next?.isLocked) throw ApiError.locked('That section is locked');
  }

  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: { currentQuestionOrder: target, currentSectionId: entry.sectionId ?? sectionId ?? attempt.currentSectionId, lastActivityAt: new Date() },
  });

  return {
    order: target,
    questionId: entry.questionId,
    sectionId: entry.sectionId,
    perQuestion: timer.questionDeadline(updated, exam, target),
    timer: timer.timeSnapshot(updated, exam),
  };
}

/** Flag a question for review (the colour-coded navigation panel). */
async function toggleMarkForReview(attemptId, { questionId, order = null, marked = null } = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const plan = planOf(attempt);
  if (!plan.some((entry) => entry.questionId === questionId)) throw ApiError.badRequest('That question is not part of this attempt');

  const current = new Set(Array.isArray(attempt.markedForReview) ? attempt.markedForReview : []);
  const next = marked === null ? !current.has(questionId) : Boolean(marked);
  if (next) current.add(questionId);
  else current.delete(questionId);

  await prisma.answer.updateMany({ where: { attemptId, questionId }, data: { isMarkedForReview: next } });
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { markedForReview: [...current], currentQuestionOrder: order ?? attempt.currentQuestionOrder, lastActivityAt: new Date() },
  });

  return { questionId, markedForReview: next, total: current.size };
}

/** Reveal a hint; the configured mark penalty is recorded for the grader. */
async function revealHint(attemptId, { questionId, hintIndex = 0 } = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: { content: true, hint: true, hintCostMarks: true },
  });
  const hints = hintListFor(question ?? {});
  if (!hints.length) throw ApiError.notFound('This question has no hints');

  const already = (attempt.hintsRevealed ?? []).find((hint) => hint.questionId === questionId && Number(hint.hintIndex) === Number(hintIndex));
  if (already) return { hint: hints[Number(hintIndex)] ?? hints[hints.length - 1], alreadyRevealed: true, costPercent: already.costPercent ?? 0 };

  const hint = hints[Number(hintIndex)] ?? hints[0];
  const revealed = [...(attempt.hintsRevealed ?? []), {
    questionId,
    hintIndex: Number(hintIndex),
    costPercent: Number(hint.costPercent ?? 0) || 0,
    at: new Date().toISOString(),
  }];
  await prisma.attempt.update({ where: { id: attemptId }, data: { hintsRevealed: revealed, lastActivityAt: new Date() } });

  return { hint, alreadyRevealed: false, costPercent: Number(hint.costPercent ?? 0) || 0, hintsRevealed: revealed.length };
}

/** "Run sample tests" in the Monaco editor - never executes hidden cases. */
async function runSampleTests(attemptId, { questionId, code, language = null } = {}, actor = {}) {
  const attempt = await assertLiveAttempt(attemptId, actor);
  const plan = planOf(attempt).find((entry) => entry.questionId === questionId);
  if (!plan) throw ApiError.badRequest('That question is not part of this attempt');

  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: { type: true, codeConfig: true, content: true },
  });
  if (question?.type !== 'CODING') throw ApiError.badRequest('Only coding questions can be executed');

  const config = question.codeConfig ?? question.content?.codeConfig ?? question.content ?? {};
  const samples = (Array.isArray(config.testCases) ? config.testCases : []).filter((test) => test.isSample !== false);
  const run = await runCode({
    language: language ?? config.defaultLanguage ?? 'javascript',
    code: String(code ?? ''),
    testCases: samples,
    entryFunction: config.entryFunction ?? 'solution',
    timeLimitMs: config.timeLimitMs ?? env.CODE_EXECUTION_TIMEOUT_MS,
    memoryLimitMb: config.memoryLimitMb ?? env.CODE_EXECUTION_MEMORY_MB,
    includeHidden: false,
  });

  return {
    status: run.status,
    passedCount: run.passedCount,
    totalCount: run.totalCount,
    results: (run.results ?? []).map((result) => ({
      testId: result.testId,
      passed: result.passed,
      timedOut: result.timedOut,
      expected: result.expected,
      actual: result.actual,
      durationMs: result.durationMs,
      error: result.error ?? null,
    })),
    compileOutput: run.compileOutput ?? null,
    logs: run.logs ?? [],
    reason: run.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Guards and small shared helpers
// ---------------------------------------------------------------------------

async function assertLiveAttempt(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);
  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    throw ApiError.conflict('This attempt is already finished', { status: attempt.status });
  }
  if (attempt.metadata?.pendingProctorSetup) {
    throw ApiError.forbidden('Complete the proctoring check before answering');
  }
  if (timer.isExpired(attempt, attempt.exam)) {
    throw ApiError.conflict('The time limit for this attempt has expired', { expired: true, expiresAt: attempt.expiresAt });
  }
  return attempt;
}

function assertOwnershipOrStaff(attempt, actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in to access this attempt');
  if (attempt.userId === actor.userId) return;
  const staff = ['SUPER_ADMIN', 'ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(actor.platformRole)
    || (actor.organizationId && actor.organizationId === attempt.organizationId && ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(actor.role));
  if (!staff) throw ApiError.forbidden('This attempt belongs to another candidate');
}

function sanitiseDeviceInfo(deviceInfo = {}) {
  const allowed = ['browser', 'os', 'platform', 'screen', 'timezone', 'language', 'canvas', 'ramGb', 'cpuCores', 'touchCapable'];
  const out = {};
  for (const key of allowed) {
    if (deviceInfo[key] !== undefined) out[key] = typeof deviceInfo[key] === 'object' ? deviceInfo[key] : String(deviceInfo[key]).slice(0, 120);
  }
  return out;
}

function deserialiseAttempt(attempt) {
  if (!attempt) return attempt;
  const out = { ...attempt };
  for (const field of ['rawScore', 'negativeDeducted', 'partialAwarded', 'totalMarks', 'finalScore', 'scorePercent', 'percentile', 'abilityScore', 'abilityStdErr', 'riskScore']) {
    if (out[field] !== undefined && out[field] !== null) out[field] = Number(out[field]);
  }
  if (Array.isArray(out.answers)) {
    out.answers = out.answers.map((answer) => deserialiseAnswer(answer));
  }
  return out;
}

function deserialiseAnswer(answer) {
  const out = { ...answer };
  for (const field of ['maxMarks', 'autoScore', 'manualScore', 'finalScore', 'secondScore', 'aiScore']) {
    if (out[field] !== undefined && out[field] !== null) out[field] = Number(out[field]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/** Candidate pressed "Submit" (the confirm modal posts any last answers). */
async function submitAttempt(attemptId, { answers = [], ip = null } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);

  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    return { attemptId, status: attempt.status, alreadySubmitted: true, result: await candidateResults(attemptId, { actor }) };
  }

  for (const entry of (Array.isArray(answers) ? answers : []).slice(0, MAX_OFFLINE_OPERATIONS)) {
    if (!entry?.questionId) continue;
    try {
      await applyAnswerWrite(attempt, entry);
    } catch (error) {
      logger.warn('final answer write rejected', { attemptId, questionId: entry.questionId, error: error.message });
    }
  }

  return finaliseAttempt(attemptId, { autoSubmitted: false, submittedBy: actor.userId ?? null, ip });
}

/**
 * Close an attempt: stop the clock, auto-grade what can be graded, queue the
 * rest for a human, then release or withhold the result per exam settings.
 */
async function finaliseAttempt(attemptId, { autoSubmitted = false, submittedBy = null, reason = null, ip = null } = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: { include: EXAM_FOR_PLAN_INCLUDE } } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    return { attemptId, status: attempt.status, alreadySubmitted: true };
  }

  const exam = attempt.exam;
  const settings = runtimeSettings(exam);
  const plan = planOf(attempt);
  const now = new Date();

  const answerRows = await prisma.answer.findMany({ where: { attemptId }, select: { questionId: true, wasSkipped: true } });
  const answeredIds = new Set(answerRows.filter((row) => !row.wasSkipped).map((row) => row.questionId));
  const missingRequired = plan.filter((entry) => entry.isRequired && !answeredIds.has(entry.questionId)).map((entry) => entry.order);

  if (settings.requireAllAnswers && !autoSubmitted && missingRequired.length) {
    throw ApiError.unprocessable('Answer every required question before submitting', { missingOrders: missingRequired });
  }

  const pausedSec = timer.computePausedSec(attempt, now);
  const usedTimeSec = Math.max(0, timer.secondsBetween(attempt.startedAt, now) - pausedSec);
  const snapshot = timer.timeSnapshot(attempt, exam, now);
  const wasPaused = Boolean(attempt.pausedAt && !attempt.resumedAt);

  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      status: autoSubmitted ? 'AUTO_SUBMITTED' : 'SUBMITTED',
      submittedAt: now,
      usedTimeSec,
      remainingTimeSec: snapshot.remainingSec ?? 0,
      totalMarks: round(plan.reduce((sum, entry) => sum + Number(entry.marks ?? 0), 0), 2),
      autoSubmitted: Boolean(autoSubmitted),
      lastActivityAt: now,
      // A pause left hanging when the timer ran out ends here.
      pausedAt: attempt.pausedAt,
      resumedAt: wasPaused ? now : attempt.resumedAt,
      metadata: {
        ...attempt.metadata,
        clockStarted: true,
        submittedVia: autoSubmitted ? (reason ?? 'TIMER') : 'CANDIDATE',
        autoSubmittedReason: autoSubmitted ? reason : null,
        submitIp: ip ?? null,
        missingRequired,
      },
    },
  });

  if (attempt.registrationId) {
    await prisma.examCandidate.update({ where: { id: attempt.registrationId }, data: { status: 'COMPLETED', completedAt: now } });
  }

  // The proctoring session ends with the attempt.
  await prisma.proctorSession.updateMany({
    where: { attemptId, status: { in: ['ACTIVE', 'PENDING_SETUP'] } },
    data: { status: 'ENDED', endedAt: now },
  });

  let grading = { pendingManual: 0, gradingStatus: 'NOT_REQUIRED', summary: null };
  if (exam.type !== 'SURVEY') {
    grading = await scoring.autoGradeAttempt(attemptId, { commit: true, gradedBy: autoSubmitted ? 'auto-submit' : 'submission' });
  } else {
    await prisma.attempt.update({ where: { id: attemptId }, data: { gradingStatus: 'NOT_REQUIRED', passed: null } });
  }

  const released = await maybeReleaseResults(attemptId, { exam, grading });
  await closeOutNotifications(attemptId, { exam, released, autoSubmitted });

  pushToRoom(`exam:${exam.id}:proctors`, 'proctor:attempt-submitted', { attemptId, autoSubmitted, at: now.toISOString() });
  pushToUser(attempt.userId, 'exam:submitted', { attemptId, released });

  const stored = await prisma.attempt.findUnique({ where: { id: attemptId } });
  return {
    attemptId,
    status: stored.status,
    gradingStatus: stored.gradingStatus,
    pendingManual: grading.pendingManual,
    resultVisible: released.visible,
    summary: grading.summary ?? null,
    submittedAt: stored.submittedAt,
  };
}

/**
 * Decide whether the candidate may see the result yet, stamping `releasedAt`
 * the first time it becomes visible, and issuing the certificate when the exam
 * awards one.
 */
async function maybeReleaseResults(attemptId, { exam, grading }) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (grading.gradingStatus === 'IN_PROGRESS') {
    return { visible: false, reason: 'Your answers are still being reviewed', releasedAt: null };
  }
  if (['GRADED', 'RELEASED'].includes(attempt.gradingStatus) === false) {
    return { visible: false, reason: 'Your answers are still being reviewed', releasedAt: null };
  }
  if (exam.resultVisibility === 'NEVER') {
    return { visible: false, reason: 'Results for this exam are not published', releasedAt: null };
  }
  if (exam.resultVisibility === 'ON_DATE') {
    const at = exam.resultsVisibleAt ? new Date(exam.resultsVisibleAt) : null;
    if (!at || at > new Date()) return { visible: false, reason: 'Results will be published later', releasedAt: at };
  }
  if (exam.resultVisibility === 'AFTER_ALL_SUBMIT') {
    const open = await prisma.attempt.count({ where: { examId: exam.id, status: { in: ['IN_PROGRESS', 'PAUSED'] } } });
    if (open > 0) return { visible: false, reason: 'Results appear once every candidate has submitted', releasedAt: null };
  }
  if (exam.gradesReleasedAt && new Date(exam.gradesReleasedAt) > new Date()) {
    return { visible: false, reason: 'The instructor has not released grades yet', releasedAt: new Date(exam.gradesReleasedAt) };
  }

  if (!attempt.releasedAt) {
    await prisma.attempt.update({ where: { id: attemptId }, data: { releasedAt: new Date(), gradingStatus: 'RELEASED' } });
  }

  await maybeIssueCertificate(attemptId);
  return { visible: true, releasedAt: attempt.releasedAt ?? new Date() };
}

/** Certificates live in certificate.service; a failure must not lose a score. */
async function maybeIssueCertificate(attemptId) {
  try {
    const certificateService = require('./certificate.service');
    return await certificateService.issueForAttempt({ attemptId });
  } catch (error) {
    logger.warn('certificate issuance skipped', { attemptId, error: error.message });
    return null;
  }
}

/** Manual-grading queue + candidate notification. */
async function closeOutNotifications(attemptId, { exam, released, autoSubmitted }) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { userId: true, gradingStatus: true, scorePercent: true, examId: true },
  });

  if (attempt.gradingStatus === 'IN_PROGRESS') {
    try {
      const gradingService = require('./grading.service');
      await gradingService.queueForAttempt(attemptId);
    } catch (error) {
      logger.warn('grading queue assignment skipped', { attemptId, error: error.message });
    }
  }

  if (autoSubmitted) {
    await notifyUser({
      userId: attempt.userId,
      type: 'EXAM_WINDOW_CLOSING',
      title: `"${exam.title}" was submitted automatically`,
      body: 'Your attempt was submitted when the timer ran out.',
      actionUrl: `/results/${attemptId}`,
    }).catch((error) => logger.warn('auto-submit notification failed', { attemptId, error: error.message }));
    return;
  }

  if (released.visible) {
    await notifyUser({
      userId: attempt.userId,
      type: 'RESULTS_RELEASED',
      title: `Your result for "${exam.title}" is ready`,
      body: `You scored ${Number(attempt.scorePercent ?? 0).toFixed(1)}%.`,
      actionUrl: `/results/${attemptId}`,
    }).catch((error) => logger.warn('result notification failed', { attemptId, error: error.message }));
  } else {
    await notifyUser({
      userId: attempt.userId,
      type: 'GRADING_COMPLETED',
      title: `"${exam.title}" submitted`,
      body: released.reason ?? 'We will notify you when the result is available.',
      actionUrl: `/results/${attemptId}`,
    }).catch((error) => logger.warn('submission notification failed', { attemptId, error: error.message }));
  }
}

/** Sweep used by jobs/autoSubmit.job.js. */
async function autoSubmitExpired({ limit = 50, graceSec = 0 } = {}) {
  const expired = await timer.findExpiredAttempts({ graceSec, limit });
  const submitted = [];
  const failed = [];

  for (const attempt of expired) {
    try {
      const result = await finaliseAttempt(attempt.id, { autoSubmitted: true, reason: 'TIME_UP' });
      submitted.push({ attemptId: attempt.id, status: result.status });
      await notifyUser({
        userId: attempt.userId,
        type: 'EXAM_WINDOW_CLOSING',
        title: 'Your exam time expired',
        body: 'The attempt was submitted automatically.',
        actionUrl: `/results/${attempt.id}`,
      }).catch(() => null);
    } catch (error) {
      logger.error('auto-submit failed', { attemptId: attempt.id, error: error.message });
      failed.push({ attemptId: attempt.id, error: error.message });
    }
  }

  return { scanned: expired.length, submitted: submitted.length, failed };
}

/** Proctor force-stop: what has been answered is graded, the rest is lost. */
async function terminateAttempt(attemptId, { reason = 'Terminated by the proctor', terminatedBy = null } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    throw ApiError.conflict('This attempt is already finished', { status: attempt.status });
  }

  const now = new Date();
  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      isTerminated: true,
      terminatedById: terminatedBy ?? actor.userId ?? null,
      terminationReason: reason,
      terminatedAt: now,
      metadata: { ...attempt.metadata, terminated: { reason, by: terminatedBy ?? actor.userId ?? null, at: now.toISOString() } },
    },
  });

  const result = await finaliseAttempt(attemptId, { autoSubmitted: true, reason: 'TERMINATED', submittedBy: terminatedBy ?? null });
  await prisma.attempt.update({ where: { id: attemptId }, data: { status: 'TERMINATED' } });

  await notifyUser({
    userId: attempt.userId,
    type: 'VIOLATION_FLAGGED',
    title: 'Your exam session was ended',
    body: reason,
    actionUrl: `/results/${attemptId}`,
  }).catch((error) => logger.warn('termination notification failed', { attemptId, error: error.message }));

  return { attemptId, terminated: true, ...result };
}

/** Candidate-side pause when the exam allows it. */
async function pauseAttempt(attemptId, { reason = 'CANDIDATE_REQUEST', note = null } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);
  return timer.pauseAttempt(attemptId, { reason, note }, { userId: actor.userId, orgRole: actor.role });
}

async function resumeClock(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);
  return timer.resumeAttempt(attemptId, { userId: actor.userId, orgRole: actor.role });
}

// ---------------------------------------------------------------------------
// Results and review
// ---------------------------------------------------------------------------

/**
 * Whether a released result may be shown right now, honouring the exam's
 * visibility mode and the instructor's manual grade release.
 */
async function releaseStateFor(attempt, exam) {
  if (['GRADED', 'RELEASED'].includes(attempt.gradingStatus) === false) {
    return { visible: false, reason: 'Your answers are still being reviewed', releasedAt: null };
  }
  if (exam.resultVisibility === 'NEVER') {
    return { visible: false, reason: 'Results for this exam are not published', releasedAt: null };
  }
  if (exam.resultVisibility === 'ON_DATE') {
    const at = exam.resultsVisibleAt ? new Date(exam.resultsVisibleAt) : null;
    return at && at <= new Date()
      ? { visible: true, releasedAt: attempt.releasedAt ?? at }
      : { visible: false, reason: 'Results will be published later', releasedAt: at };
  }
  if (exam.resultVisibility === 'AFTER_ALL_SUBMIT') {
    const open = await prisma.attempt.count({ where: { examId: exam.id, status: { in: ['IN_PROGRESS', 'PAUSED'] } } });
    if (open > 0) return { visible: false, reason: 'Results appear once every candidate has submitted', releasedAt: null };
  }
  if (exam.gradesReleasedAt && new Date(exam.gradesReleasedAt) > new Date()) {
    return { visible: false, reason: 'The instructor has not released grades yet', releasedAt: new Date(exam.gradesReleasedAt) };
  }
  if (!attempt.releasedAt) {
    await prisma.attempt.update({ where: { id: attempt.id }, data: { releasedAt: new Date() } });
  }
  return { visible: true, releasedAt: attempt.releasedAt ?? new Date() };
}

/** Everything the result page shows. */
async function candidateResults(attemptId, { actor = {} } = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      exam: {
        select: {
          id: true, title: true, slug: true, type: true, totalMarks: true, passingPercent: true, gradeBoundaries: true,
          resultVisibility: true, resultsVisibleAt: true, gradesReleasedAt: true, answerReviewEnabled: true, settings: true, organizationId: true,
        },
      },
      certificates: { select: { id: true, certificateNo: true, status: true, pdfUrl: true, verifyToken: true, issuedAt: true } },
      feedback: { orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, content: true, meta: true, createdAt: true } },
      user: { select: { id: true, displayName: true } },
    },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);

  const exam = attempt.exam;
  const release = await releaseStateFor(attempt, exam);

  const base = {
    attemptId: attempt.id,
    exam: { id: exam.id, title: exam.title, slug: exam.slug, type: exam.type, totalMarks: Number(exam.totalMarks ?? 0), passingPercent: Number(exam.passingPercent ?? 0) },
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    gradingStatus: attempt.gradingStatus,
    submittedAt: attempt.submittedAt,
    autoSubmitted: attempt.autoSubmitted,
    usedTimeSec: attempt.usedTimeSec,
    resultsVisible: release.visible,
    resultsReason: release.reason,
    resultsAvailableAt: release.releasedAt,
  };

  if (!release.visible) {
    return { ...base, score: null, breakdown: null, reviewEnabled: false, certificates: [], feedback: [] };
  }

  const breakdown = exam.type === 'SURVEY' ? null : await scoring.scoreBreakdown(attemptId, { includeResponses: false });
  return {
    ...base,
    score: {
      finalScore: Number(attempt.finalScore ?? 0),
      totalMarks: Number(attempt.totalMarks ?? 0),
      scorePercent: Number(attempt.scorePercent ?? 0),
      passed: attempt.passed,
      gradeLetter: attempt.gradeLetter,
      percentile: attempt.percentile == null ? null : Number(attempt.percentile),
      abilityScore: attempt.abilityScore == null ? null : Number(attempt.abilityScore),
    },
    breakdown,
    reviewEnabled: Boolean(exam.answerReviewEnabled) && runtimeSettings(exam).showCorrectAnswers !== false,
    certificates: attempt.certificates,
    feedback: attempt.feedback,
    candidate: attempt.user,
  };
}

/** Question-by-question review: candidate answer vs correct answer. */
async function questionReview(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      exam: {
        select: {
          id: true, title: true, type: true, answerReviewEnabled: true, settings: true, organizationId: true,
          resultVisibility: true, resultsVisibleAt: true, gradesReleasedAt: true,
        },
      },
    },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const exam = attempt.exam;
  const isStaff = actor.platformRole === 'SUPER_ADMIN'
    || Boolean(actor.organizationId && actor.organizationId === attempt.organizationId);
  if (attempt.userId !== actor.userId && !isStaff) throw ApiError.forbidden('This attempt belongs to another candidate');

  const settings = { ...EXAM_SETTING_DEFAULTS, ...(exam.settings ?? {}) };
  if (!isStaff) {
    if (!exam.answerReviewEnabled || settings.showCorrectAnswers === false) {
      throw ApiError.forbidden('The instructor has not enabled answer review for this exam');
    }
    const release = await releaseStateFor(attempt, exam);
    if (!release.visible) throw ApiError.forbidden(release.reason ?? 'Results are not available yet');
  }

  const answers = await prisma.answer.findMany({
    where: { attemptId },
    orderBy: { order: 'asc' },
    include: {
      question: { select: { id: true, type: true, prompt: true, content: true, explanation: true, solution: true, topicTags: true, marks: true, currentVersion: true, rubricCriteria: true } },
      files: { select: { id: true, url: true, originalName: true, mimeType: true, kind: true } },
      rubricScores: { orderBy: { createdAt: 'asc' } },
    },
  });

  return {
    attemptId,
    examTitle: exam.title,
    isSurvey: exam.type === 'SURVEY',
    showExplanations: isStaff || settings.showExplanation !== false,
    items: answers.map((answer) => ({
      questionId: answer.questionId,
      order: answer.order,
      sectionId: answer.sectionId,
      type: answer.question.type,
      prompt: answer.question.prompt,
      topicTags: answer.question.topicTags,
      response: answer.response,
      displayAnswer: answerDisplay(answer),
      maxMarks: Number(answer.maxMarks ?? 0),
      autoScore: answer.autoScore == null ? null : Number(answer.autoScore),
      manualScore: answer.manualScore == null ? null : Number(answer.manualScore),
      finalScore: answer.finalScore == null ? null : Number(answer.finalScore),
      isCorrect: answer.isCorrect,
      isPartial: answer.isPartial,
      wasSkipped: answer.wasSkipped,
      timeSpentSec: answer.timeSpentSec,
      needsManualGrading: answer.needsManualGrading,
      graderNote: answer.graderNote,
      feedback: answer.feedback,
      aiFeedback: answer.aiFeedback,
      rubricScores: answer.rubricScores,
      files: answer.files,
      correctAnswer: answerKeyOf(answer.question),
      explanation: answer.question.explanation,
      solution: isStaff ? answer.question.solution : null,
    })),
  };
}

/** Pull the answer key out of the question content for the review screen. */
function answerKeyOf(question) {
  const content = question.content ?? {};
  switch (question.type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE': {
      const id = content.correctOptionId ?? content.options?.find?.((option) => option.correct)?.id;
      return { optionId: id ?? null, text: content.options?.find?.((option) => option.id === id)?.text ?? null };
    }
    case 'MULTIPLE_ANSWER': {
      const ids = content.correctOptionIds ?? content.options?.filter?.((option) => option.correct).map((option) => option.id) ?? [];
      return { optionIds: ids, texts: (content.options ?? []).filter((option) => ids.includes(option.id)).map((option) => option.text) };
    }
    case 'SHORT_ANSWER':
      return { accepted: content.answers ?? content.acceptedAnswers ?? [], keywords: content.keywords ?? [] };
    case 'FILL_BLANK':
      return { blanks: (content.blanks ?? []).map((blank) => ({ index: blank.index, answers: blank.answers ?? [] })) };
    case 'DROPDOWN':
      return { answers: (content.dropdowns ?? []).map((dropdown) => ({ index: dropdown.index, correct: dropdown.correctAnswer })) };
    case 'MATCHING':
      return { pairs: content.correctPairs ?? [] };
    case 'ORDERING':
      return { order: content.correctOrder ?? [] };
    case 'HOTSPOT':
      return { zones: (content.zones ?? []).filter((zone) => zone.correct) };
    case 'CODING':
      return { solution: content.solution ?? question.solution ?? null, testCount: (content.testCases ?? []).length };
    case 'MATH_FORMULA':
      return { latex: content.correctLatex ?? null, numeric: content.numericAnswer ?? null };
    case 'MATRIX':
      return { cells: (content.cells ?? []).filter((cell) => cell.correct) };
    default:
      return { text: content.modelAnswer ?? content.answer ?? question.solution ?? null, rubric: content.rubric ?? question.rubricCriteria ?? [] };
  }
}

/** A human-readable version of whatever the candidate typed or clicked. */
function answerDisplay(answer) {
  const response = answer.response ?? {};
  if (Array.isArray(response.optionIds) && response.optionIds.length) return response.optionIds.join(', ');
  if (response.optionId !== undefined) return String(response.optionId);
  if (typeof response.value === 'boolean') return response.value ? 'True' : 'False';
  if (typeof response.value === 'string' && response.value.trim()) return response.value;
  if (typeof response.text === 'string' && response.text.trim()) return response.text.replace(/<[^>]*>/g, ' ').slice(0, 2000);
  if (typeof response.code === 'string' && response.code.trim()) return `${answer.codeLanguage ?? 'code'} submission (${response.code.split('\n').length} lines)`;
  if (Array.isArray(response.blanks) && response.blanks.length) return response.blanks.map((blank) => blank.text ?? '').join(' / ');
  if (Array.isArray(response.answers) && response.answers.length) return response.answers.map((entry) => entry.value ?? '').join(' / ');
  if (Array.isArray(response.pairs) && response.pairs.length) return response.pairs.map((pair) => `${pair.leftId} -> ${pair.rightId}`).join(', ');
  if (Array.isArray(response.order) && response.order.length) return response.order.join(' > ');
  if (Array.isArray(response.clicks) && response.clicks.length) return `${response.clicks.length} mark(s) on the image`;
  if (response.latex) return String(response.latex);
  if (answer.textAnswer) return answer.textAnswer.slice(0, 2000);
  if (answer.wasSkipped) return '(skipped)';
  return '(no answer)';
}

// ---------------------------------------------------------------------------
// Listing and staff views
// ---------------------------------------------------------------------------

async function listAttempts({ examId, organizationId, userId, status, statuses, gradingStatus, passed, flagged, search, page = 1, limit = 20, sort = 'recent' } = {}, actor = {}) {
  if (!examId && !actor?.organizationId && actor?.platformRole !== 'SUPER_ADMIN') throw ApiError.forbidden('An exam or organization scope is required');

  const where = {};
  if (examId) where.examId = examId;
  if (organizationId) where.organizationId = organizationId;
  else if (actor?.organizationId && actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;
  if (userId) where.userId = userId;
  if (status) where.status = status;
  else if (Array.isArray(statuses) && statuses.length) where.status = { in: statuses };
  if (gradingStatus) where.gradingStatus = gradingStatus;
  if (passed !== undefined) where.passed = Boolean(passed);
  if (flagged !== undefined) where.isFlagged = Boolean(flagged);
  if (search) {
    where.OR = [
      { user: { email: { contains: search, mode: 'insensitive' } } },
      { user: { displayName: { contains: search, mode: 'insensitive' } } },
      { ip: { contains: search } },
    ];
  }

  const orderBy = {
    recent: { startedAt: 'desc' },
    oldest: { startedAt: 'asc' },
    highest: { scorePercent: 'desc' },
    lowest: { scorePercent: 'asc' },
    riskiest: { riskScore: 'desc' },
    submissions: { submittedAt: 'desc' },
  }[sort] ?? { startedAt: 'desc' };

  const pageNumber = Math.max(1, Number(page) || 1);
  const take = Math.min(100, Number(limit) || 20);

  const [items, total, statusCounts] = await Promise.all([
    prisma.attempt.findMany({ where, select: ATTEMPT_LIST_SELECT, orderBy, skip: (pageNumber - 1) * take, take }),
    prisma.attempt.count({ where }),
    examId ? prisma.attempt.groupBy({ by: ['status'], where: { examId }, _count: { _all: true } }) : Promise.resolve([]),
  ]);

  return {
    items: items.map(deserialiseAttempt),
    total,
    page: pageNumber,
    limit: take,
    statusCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
  };
}

async function listMyAttempts(userId, { page = 1, limit = 20, status } = {}) {
  const where = { userId };
  if (status) where.status = status;
  const pageNumber = Math.max(1, Number(page) || 1);
  const take = Math.min(100, Number(limit) || 20);

  const [items, total] = await Promise.all([
    prisma.attempt.findMany({
      where,
      select: {
        ...ATTEMPT_LIST_SELECT,
        exam: {
          select: { id: true, title: true, slug: true, type: true, totalMarks: true, passingPercent: true, resultVisibility: true, gradesReleasedAt: true, answerReviewEnabled: true },
        },
      },
      orderBy: { startedAt: 'desc' },
      skip: (pageNumber - 1) * take,
      take,
    }),
    prisma.attempt.count({ where }),
  ]);

  return { items: items.map(deserialiseAttempt), total, page: pageNumber, limit: take };
}

/** Full staff/proctor view of a single attempt. */
async function getAttemptDetail(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      exam: {
        select: {
          id: true, title: true, slug: true, type: true, totalMarks: true, passingPercent: true, durationMinutes: true,
          settings: true, proctoringConfig: true, organizationId: true, answerReviewEnabled: true, version: true,
        },
      },
      user: { select: { id: true, displayName: true, email: true, imageUrl: true, platformRole: true } },
      registration: { select: { id: true, status: true, seatNumber: true, paidAmountCents: true } },
      proctorSession: { include: { reviewedBy: { select: { id: true, displayName: true } } } },
      recordings: { orderBy: { createdAt: 'asc' } },
      note: true,
      feedback: { orderBy: { createdAt: 'desc' } },
      gradeOverrides: { orderBy: { createdAt: 'desc' }, include: { overriddenBy: { select: { id: true, displayName: true } } } },
      gradingAssignments: { include: { grader: { select: { id: true, displayName: true, email: true } } } },
      violations: { orderBy: { occurredAt: 'asc' } },
      answers: {
        orderBy: { order: 'asc' },
        include: {
          question: { select: { id: true, type: true, prompt: true, content: true, explanation: true, marks: true, topicTags: true } },
          files: true,
          rubricScores: true,
          gradedBy: { select: { id: true, displayName: true } },
        },
      },
    },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const isStaff = actor.platformRole === 'SUPER_ADMIN'
    || Boolean(actor.organizationId && actor.organizationId === attempt.organizationId);
  if (attempt.userId !== actor.userId && !isStaff) throw ApiError.forbidden('This attempt belongs to another candidate');

  const plan = planOf(attempt);
  return {
    ...deserialiseAttempt({
      ...attempt,
      violations: attempt.violations.map((violation) => ({ ...violation, aiRiskScore: violation.aiRiskScore == null ? null : Number(violation.aiRiskScore) })),
    }),
    plan,
    progress: progressOf(plan, attempt.answers, attempt),
    timer: timer.timeSnapshot(attempt, attempt.exam),
    isStaffView: isStaff,
  };
}

/** Public "share my result" link. */
async function shareResult(attemptId, { enable = true }, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  assertOwnershipOrStaff(attempt, actor);

  if (!enable) {
    await prisma.attempt.update({ where: { id: attemptId }, data: { shareToken: null } });
    return { shared: false };
  }
  if (attempt.shareToken) return { shared: true, shareToken: attempt.shareToken, url: `${env.CLIENT_URL}/results/shared/${attempt.shareToken}` };

  const updated = await prisma.attempt.update({ where: { id: attemptId }, data: { shareToken: crypto.randomUUID() } });
  return { shared: true, shareToken: updated.shareToken, url: `${env.CLIENT_URL}/results/shared/${updated.shareToken}` };
}

async function getSharedResult(token) {
  if (!token) throw ApiError.badRequest('A share token is required');
  const attempt = await prisma.attempt.findUnique({
    where: { shareToken: token },
    include: {
      exam: { select: { id: true, title: true, totalMarks: true, passingPercent: true, type: true, organizationId: true } },
      user: { select: { displayName: true } },
      certificates: { select: { certificateNo: true, status: true, verifyToken: true, pdfUrl: true } },
    },
  });
  if (!attempt) throw ApiError.notFound('This result link is no longer valid');
  if (!['GRADED', 'RELEASED'].includes(attempt.gradingStatus)) throw ApiError.forbidden('This result has not been released yet');

  return {
    candidateName: attempt.user?.displayName ?? 'Candidate',
    examTitle: attempt.exam.title,
    submittedAt: attempt.submittedAt,
    scorePercent: Number(attempt.scorePercent ?? 0),
    finalScore: Number(attempt.finalScore ?? 0),
    totalMarks: Number(attempt.totalMarks ?? 0),
    gradeLetter: attempt.gradeLetter,
    passed: attempt.passed,
    percentile: attempt.percentile == null ? null : Number(attempt.percentile),
    certificates: attempt.certificates,
  };
}

/** Raw response dump for surveys and analytics (anonymous-safe). */
async function listAttemptResponses(examId, { limit = 500 } = {}) {
  const attempts = await prisma.attempt.findMany({
    where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } },
    select: { id: true, submittedAt: true, usedTimeSec: true, isAnonymous: true },
    orderBy: { submittedAt: 'desc' },
    take: Math.min(2000, Number(limit) || 500),
  });
  if (!attempts.length) return [];

  const answers = await prisma.answer.findMany({
    where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    select: { attemptId: true, questionId: true, response: true, order: true },
    orderBy: { order: 'asc' },
  });

  const byAttempt = new Map();
  for (const answer of answers) {
    if (!byAttempt.has(answer.attemptId)) byAttempt.set(answer.attemptId, []);
    byAttempt.get(answer.attemptId).push({ questionId: answer.questionId, response: answer.response });
  }

  return attempts.map((attempt) => ({
    attemptId: attempt.isAnonymous ? null : attempt.id,
    submittedAt: attempt.submittedAt,
    usedTimeSec: attempt.usedTimeSec,
    answers: byAttempt.get(attempt.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Live quiz (Kahoot-style real-time sessions)
// ---------------------------------------------------------------------------

/** Unambiguous 6-character join code (no O/0/I/1). */
function quizCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

async function createLiveQuiz(examId, { questionTimeLimitSec = 20, leaderboardVisible = true, teamMode = false, allowMobileJoin = true } = {}, actor = {}) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { examQuestions: { orderBy: { order: 'asc' }, select: { questionId: true } } },
  });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (actor.organizationId && exam.organizationId !== actor.organizationId && actor.platformRole !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('This exam belongs to another organization');
  }
  if (!exam.examQuestions.length) throw ApiError.badRequest('Add questions before hosting a live quiz');

  let code = quizCode();
  for (let round = 0; round < 5; round += 1) {
    const taken = await prisma.liveQuizSession.findUnique({ where: { code } });
    if (!taken) break;
    code = quizCode();
    if (round === 4) throw ApiError.conflict('Could not allocate a join code - try again');
  }

  const session = await prisma.liveQuizSession.create({
    data: {
      examId,
      hostId: actor.userId,
      organizationId: exam.organizationId,
      code,
      status: 'WAITING',
      questionTimeLimitSec: Math.min(120, Math.max(5, Number(questionTimeLimitSec) || 20)),
      leaderboardVisible: Boolean(leaderboardVisible),
      teamMode: Boolean(teamMode),
      allowMobileJoin: Boolean(allowMobileJoin),
      joinUrl: `${env.CLIENT_URL}/live-quiz/${code}`,
    },
  });

  return { ...session, questionCount: exam.examQuestions.length };
}

async function liveSessionByCode(code) {
  const session = await prisma.liveQuizSession.findUnique({
    where: { code: String(code ?? '').trim().toUpperCase() },
    include: {
      exam: { select: { id: true, title: true } },
      teams: { orderBy: { name: 'asc' } },
    },
  });
  if (!session) throw ApiError.notFound('No live quiz is waiting for that code');
  return session;
}

/** What the join screen shows before the first question opens. */
async function getLiveSession({ code = null, sessionId = null } = {}) {
  const session = code
    ? await liveSessionByCode(code)
    : await prisma.liveQuizSession.findUnique({ where: { id: sessionId }, include: { exam: { select: { id: true, title: true } }, teams: true } });
  if (!session) throw ApiError.notFound('Live quiz not found');

  const { ids } = await liveQuestionOrder(session.id);
  const leaderboard = await liveLeaderboard(session.id);
  return {
    id: session.id,
    code: session.code,
    status: session.status,
    examTitle: session.exam?.title ?? null,
    currentQuestionIndex: session.currentQuestionIndex,
    questionCount: ids.length,
    questionTimeLimitSec: session.questionTimeLimitSec,
    leaderboardVisible: session.leaderboardVisible,
    teamMode: session.teamMode,
    participantCount: session.participantCount,
    teams: session.teams.map((team) => ({ id: team.id, name: team.name, color: team.color })),
    leaderboard: session.leaderboardVisible ? leaderboard : null,
  };
}

async function joinLiveQuiz(code, { displayName = null, teamId = null } = {}, actor = {}) {
  if (!actor.userId) throw ApiError.unauthorized('Sign in to join');
  const session = await liveSessionByCode(code);
  if (session.status === 'ENDED') throw ApiError.conflict('That quiz has already finished');
  if (session.teamMode && !teamId) throw ApiError.badRequest('Pick a team to join this quiz');
  if (session.teamMode && teamId) {
    const team = await prisma.team.findFirst({ where: { sessionId: session.id, id: teamId } });
    if (!team) throw ApiError.badRequest('Unknown team');
  }

  const participant = await prisma.liveQuizParticipant.upsert({
    where: { sessionId_userId: { sessionId: session.id, userId: actor.userId } },
    update: { displayName: displayName ?? undefined, disconnectedAt: null },
    create: { sessionId: session.id, userId: actor.userId, displayName, teamId: teamId ?? null },
  });

  const participantCount = await prisma.liveQuizParticipant.count({ where: { sessionId: session.id, disconnectedAt: null } });
  await prisma.liveQuizSession.update({ where: { id: session.id }, data: { participantCount } });
  pushToRoom(`live-quiz:${session.code}`, 'live-quiz:participant-joined', { participantCount });

  return { sessionId: session.id, code: session.code, participant, status: session.status, examTitle: session.exam.title };
}

async function leaveLiveQuiz(code, actor = {}) {
  const session = await liveSessionByCode(code);
  const participant = await prisma.liveQuizParticipant.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId: actor.userId } },
  });
  if (!participant) return { left: false };

  await prisma.liveQuizParticipant.update({ where: { id: participant.id }, data: { disconnectedAt: new Date() } });
  const participantCount = await prisma.liveQuizParticipant.count({ where: { sessionId: session.id, disconnectedAt: null } });
  await prisma.liveQuizSession.update({ where: { id: session.id }, data: { participantCount } });
  return { left: true };
}

async function liveQuestionOrder(sessionId) {
  const session = await prisma.liveQuizSession.findUnique({
    where: { id: sessionId },
    include: { exam: { include: { examQuestions: { orderBy: { order: 'asc' }, select: { questionId: true, marks: true } } } } },
  });
  if (!session) throw ApiError.notFound('Live quiz not found');
  const rows = session.exam.examQuestions;
  return { session, ids: rows.map((row) => row.questionId), marks: new Map(rows.map((row) => [row.questionId, Number(row.marks ?? 1)])) };
}

function assertLiveHost(session, actor = {}) {
  if (actor.userId === session.hostId) return;
  if (actor.platformRole === 'SUPER_ADMIN') return;
  throw ApiError.forbidden('Only the host can control this live quiz');
}

/** Host pressed "next": open the following question for everyone. */
async function advanceLiveQuiz(sessionId, actor = {}) {
  const { session, ids } = await liveQuestionOrder(sessionId);
  assertLiveHost(session, actor);
  if (session.status === 'ENDED') throw ApiError.conflict('That quiz has already finished');

  const nextIndex = session.status === 'RUNNING' ? session.currentQuestionIndex + 1 : 0;
  if (nextIndex >= ids.length) return endLiveQuiz(sessionId, actor);

  const questionId = ids[nextIndex];
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: { id: true, type: true, prompt: true, content: true, imageUrls: true, estimatedTimeSec: true },
  });
  const updated = await prisma.liveQuizSession.update({
    where: { id: sessionId },
    data: { status: 'RUNNING', currentQuestionIndex: nextIndex, startedAt: session.startedAt ?? new Date() },
  });

  const payload = {
    index: nextIndex,
    total: ids.length,
    questionTimeLimitSec: session.questionTimeLimitSec,
    openedAt: new Date().toISOString(),
    question: question ? { ...question, content: stripAnswerKeys(question.content) } : null,
  };
  pushToRoom(`live-quiz:${session.code}`, 'live-quiz:question-open', payload);
  return { sessionId, code: session.code, status: updated.status, ...payload };
}

/** Kahoot scoring: a correct answer is worth more the faster it lands. */
function liveQuizPoints({ correct, responseMs, limitSec }) {
  if (!correct) return 0;
  const budget = Math.max(1, Number(limitSec) * 1000);
  const speed = 1 - Math.min(1, Math.max(0, Number(responseMs) || 0) / budget);
  return Math.round(500 + speed * 500);
}

async function submitLiveAnswer(sessionId, { questionId, response, responseMs = null } = {}, actor = {}) {
  if (!actor.userId) throw ApiError.unauthorized('Sign in to answer');
  const { session, ids, marks } = await liveQuestionOrder(sessionId);
  if (session.status !== 'RUNNING') throw ApiError.conflict('No question is currently open');
  if (questionId !== ids[session.currentQuestionIndex]) throw ApiError.badRequest('That is not the current question');

  const participant = await prisma.liveQuizParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId: actor.userId } },
    select: { id: true, score: true, answeredCount: true, correctCount: true, teamId: true },
  });
  if (!participant) throw ApiError.forbidden('Join the quiz before answering');

  const question = await prisma.question.findUnique({ where: { id: questionId }, select: { type: true, content: true } });
  if (!question) throw ApiError.notFound('Question not found');

  const grade = gradeAnswer({ type: question.type, content: question.content ?? {}, response: response ?? {}, maxMarks: marks.get(questionId) ?? 1 });
  const points = liveQuizPoints({ correct: grade.isCorrect, responseMs, limitSec: session.questionTimeLimitSec });

  const updated = await prisma.liveQuizParticipant.update({
    where: { id: participant.id },
    data: {
      score: Number(participant.score) + points,
      answeredCount: participant.answeredCount + 1,
      correctCount: participant.correctCount + (grade.isCorrect ? 1 : 0),
      lastAnswerMs: responseMs == null ? null : Math.max(0, Number(responseMs) || 0),
    },
    select: { id: true, score: true },
  });

  if (participant.teamId) {
    await prisma.team.update({ where: { id: participant.teamId }, data: { score: { increment: points } } }).catch(() => null);
  }

  await recordLiveOption(sessionId, questionId, session.currentQuestionIndex, response, grade.isCorrect);

  const payload = { sessionId, points, correct: grade.isCorrect, score: Number(updated.score) };
  pushToUser(actor.userId, 'live-quiz:answer-ack', payload);
  if (session.leaderboardVisible) {
    pushToRoom(`live-quiz:${session.code}`, 'live-quiz:leaderboard', await liveLeaderboard(sessionId));
  }
  return { points, correct: grade.isCorrect, score: Number(updated.score) };
}

/** Tally the option distribution for the post-question results slide. */
async function recordLiveOption(sessionId, questionId, questionIndex, response, correct) {
  const existing = await prisma.liveQuizQuestionResult.findFirst({ where: { sessionId, questionIndex } });
  const optionKey = String(response?.optionId ?? (Array.isArray(response?.optionIds) ? response.optionIds.join('|') : 'other'));
  const counts = { ...(existing?.optionCounts ?? {}) };
  counts[optionKey] = Number(counts[optionKey] ?? 0) + 1;

  const data = {
    optionCounts: counts,
    answerCount: (existing?.answerCount ?? 0) + 1,
    correctCount: (existing?.correctCount ?? 0) + (correct ? 1 : 0),
  };

  if (existing) return prisma.liveQuizQuestionResult.update({ where: { id: existing.id }, data });
  return prisma.liveQuizQuestionResult.create({ data: { sessionId, questionId, questionIndex, ...data } });
}

async function closeLiveQuestion(sessionId, actor = {}) {
  const { session } = await liveQuestionOrder(sessionId);
  assertLiveHost(session, actor);

  const questionIndex = session.currentQuestionIndex;
  const result = await prisma.liveQuizQuestionResult.findFirst({ where: { sessionId, questionIndex } });
  const responses = await prisma.liveQuizParticipant.findMany({ where: { sessionId, lastAnswerMs: { not: null } }, select: { lastAnswerMs: true } });
  const avgResponseMs = responses.length
    ? Math.round(responses.reduce((sum, row) => sum + Number(row.lastAnswerMs ?? 0), 0) / responses.length)
    : null;

  if (result) {
    await prisma.liveQuizQuestionResult.update({ where: { id: result.id }, data: { closedAt: new Date(), avgResponseMs } });
  }
  await prisma.liveQuizSession.update({ where: { id: sessionId }, data: { answeredCount: result?.answerCount ?? 0 } });

  const leaderboard = await liveLeaderboard(sessionId);
  pushToRoom(`live-quiz:${session.code}`, 'live-quiz:question-closed', {
    questionIndex,
    result: result ? { ...result, avgResponseMs } : null,
    leaderboard: session.leaderboardVisible ? leaderboard : null,
  });
  return { questionIndex, result, leaderboard };
}

/** `LiveQuizParticipant` has no User relation, so names are joined by hand. */
async function liveLeaderboard(sessionId) {
  const participants = await prisma.liveQuizParticipant.findMany({
    where: { sessionId },
    orderBy: [{ score: 'desc' }, { lastAnswerMs: 'asc' }],
    take: 200,
    include: { team: { select: { id: true, name: true, color: true } } },
  });

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(participants.map((participant) => participant.userId))] } },
    select: { id: true, displayName: true, imageUrl: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  return {
    individuals: participants.map((participant, index) => ({
      participantId: participant.id,
      userId: participant.userId,
      rank: index + 1,
      displayName: participant.displayName || userById.get(participant.userId)?.displayName || 'Player',
      imageUrl: userById.get(participant.userId)?.imageUrl ?? null,
      score: Number(participant.score),
      correctCount: participant.correctCount,
      answeredCount: participant.answeredCount,
      team: participant.team ? { id: participant.team.id, name: participant.team.name, color: participant.team.color } : null,
    })),
    teams: await teamStandings(sessionId),
  };
}

async function teamStandings(sessionId) {
  const teams = await prisma.team.findMany({ where: { sessionId }, orderBy: { score: 'desc' } });
  if (!teams.length) return [];
  const counts = await prisma.liveQuizParticipant.groupBy({
    by: ['teamId'],
    where: { sessionId, teamId: { in: teams.map((team) => team.id) } },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((row) => [row.teamId, row._count._all]));
  return teams.map((team, index) => ({
    id: team.id,
    name: team.name,
    color: team.color,
    rank: index + 1,
    score: Number(team.score),
    members: countById.get(team.id) ?? 0,
  }));
}

async function endLiveQuiz(sessionId, actor = {}) {
  const { session } = await liveQuestionOrder(sessionId);
  assertLiveHost(session, actor);

  const leaderboard = await liveLeaderboard(sessionId);
  const rankById = new Map(leaderboard.individuals.map((row) => [row.participantId, row.rank]));

  await prisma.$transaction([...rankById.entries()].map(([participantId, rank]) => prisma.liveQuizParticipant.update({
    where: { id: participantId },
    data: { rank },
  })));
  await prisma.$transaction(leaderboard.teams.map((team) => prisma.team.update({ where: { id: team.id }, data: { rank: team.rank } })));

  const updated = await prisma.liveQuizSession.update({
    where: { id: sessionId },
    data: { status: 'ENDED', endedAt: new Date(), resultsSavedAt: new Date() },
  });

  pushToRoom(`live-quiz:${session.code}`, 'live-quiz:ended', { leaderboard });
  return { sessionId, code: session.code, status: updated.status, leaderboard };
}

/** Host-side view: session state, question progress and the leaderboard. */
async function liveQuizState(code) {
  const state = await getLiveSession({ code });
  const results = await prisma.liveQuizQuestionResult.findMany({
    where: { sessionId: state.id },
    orderBy: { questionIndex: 'asc' },
  });
  return { ...state, questionResults: results };
}

module.exports = {
  ATTEMPT_LIST_SELECT,
  EXAM_FOR_PLAN_INCLUDE,
  advanceLiveQuiz,
  answerDisplay,
  answerKeyOf,
  answerType,
  applyAnswerWrite,
  autoSubmitExpired,
  autosave,
  beginClock,
  buildPlan,
  candidateResults,
  closeLiveQuestion,
  closeOutNotifications,
  countWords,
  createLiveQuiz,
  deriveColumns,
  deserialiseAnswer,
  deserialiseAttempt,
  endLiveQuiz,
  finaliseAttempt,
  getAttemptDetail,
  getLiveSession,
  getRuntimeState,
  getSharedResult,
  hintListFor,
  joinLiveQuiz,
  leaveLiveQuiz,
  listAttemptResponses,
  listAttempts,
  listMyAttempts,
  liveLeaderboard,
  liveQuizPoints,
  liveQuizState,
  liveSessionByCode,
  navigate,
  optionOrdersFor,
  pauseAttempt,
  planOf,
  progressOf,
  questionMapFor,
  questionReview,
  recordActivity,
  registerForExam,
  releaseStateFor,
  resumeAttempt,
  resumeClock,
  revealHint,
  runSampleTests,
  runtimeSettings,
  saveAnswer,
  shareResult,
  startAttempt,
  submitAttempt,
  submitLiveAnswer,
  syncOfflineQueue,
  terminateAttempt,
  toggleMarkForReview,
};
