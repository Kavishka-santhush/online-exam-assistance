/**
 * Exam service: the assessment lifecycle.
 *
 * Draft -> Scheduled -> Published -> Active -> Closed -> Archived
 *
 * Structure is sections + explicit questions + random pools. Totals
 * (`questionCount`, `totalMarks`) are denormalised onto the `Exam` row and
 * recomputed by `recomputeTotals()` whenever the structure changes.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { AUTO_GRADED_TYPES } = require('../constants/questionTypes');
const { notifyExamCandidates, notifyUser } = require('./notification.service');

const LIST_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  type: true,
  status: true,
  language: true,
  thumbnailUrl: true,
  totalMarks: true,
  passingPercent: true,
  durationMinutes: true,
  questionCount: true,
  startsAt: true,
  endsAt: true,
  resultsVisibleAt: true,
  resultVisibility: true,
  isProctored: true,
  isAdaptive: true,
  isAutoGraded: true,
  accessControl: true,
  examFeeCents: true,
  currency: true,
  maxCandidates: true,
  attemptLimit: true,
  totalAttempts: true,
  totalRegistrations: true,
  averageScore: true,
  passRate: true,
  publishedAt: true,
  closedAt: true,
  createdAt: true,
  version: true,
  organizationId: true,
  createdById: true,
  createdBy: { select: { id: true, displayName: true, imageUrl: true } },
  category: { select: { id: true, name: true, slug: true, color: true } },
  _count: { select: { registrations: true, attempts: true, sections: true, examQuestions: true } },
};

const DETAIL_INCLUDE = {
  createdBy: { select: { id: true, displayName: true, email: true, imageUrl: true } },
  category: true,
  organization: { select: { id: true, name: true, slug: true, branding: true, defaultExamSettings: true } },
  sections: {
    orderBy: { order: 'asc' },
    include: {
      pools: { include: { bank: { select: { id: true, name: true } }, questions: { select: { id: true, type: true, marks: true, difficulty: true } } } },
    },
  },
  examQuestions: {
    orderBy: { order: 'asc' },
    include: {
      question: {
        select: {
          id: true, type: true, prompt: true, marks: true, difficulty: true, status: true,
          topicTags: true, estimatedTimeSec: true, content: true,
        },
      },
    },
  },
  certificateTemplate: { select: { id: true, name: true, config: true } },
  rubrics: { select: { id: true, name: true, questionId: true, totalMarks: true, requireSecondGrader: true } },
  _count: { select: { registrations: true, attempts: true, certificates: true, payments: true } },
};

/** Section settings the runtime reads; merged over organization defaults. */
const EXAM_SETTING_DEFAULTS = {
  allowNavigation: true,
  allowReviewBeforeSubmit: true,
  showQuestionNumber: true,
  showProgress: true,
  showTimer: true,
  allowCandidatePause: false,
  autoSaveIntervalSec: 30,
  submitConfirmation: true,
  oneQuestionPerPage: false,
  blockCopyPaste: true,
  blockRightClick: true,
  disableDevTools: true,
  requireFullscreen: false,
  warnOnTabSwitch: true,
  terminateAfterViolations: 0,
  allowCalculator: false,
  allowScratchpad: false,
  allowAttachments: false,
  showResultsImmediately: true,
  showCorrectAnswers: false,
  showExplanation: true,
  perQuestionTimeWarnings: true,
};

const PROCTORING_DEFAULTS = {
  level: 'STANDARD',
  requireCamera: false,
  requireMicrophone: false,
  requireScreenShare: false,
  recordWebcam: false,
  recordScreen: false,
  idVerification: 'NONE',
  environmentScan: false,
  faceDetection: true,
  objectDetection: false,
  gazeTracking: false,
  audioAnalysis: false,
  tabSwitchDetection: true,
  copyPasteDetection: true,
  rightClickDetection: true,
  devtoolsDetection: true,
  networkAnomalyDetection: false,
  lockdownBrowser: false,
  autoTerminateAfterCritical: 5,
  violationAlertThreshold: 3,
  aiProctorReview: false,
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function listExams(query = {}) {
  const { organizationId, createdById, status, statuses, type, categoryId, search, mine, available, userId, page = 1, limit = 20, sort = 'newest' } = query;
  const where = {};
  if (organizationId) where.organizationId = organizationId;
  if (createdById) where.createdById = createdById;
  if (status) where.status = status;
  else if (Array.isArray(statuses) && statuses.length) where.status = { in: statuses };
  if (type) where.type = type;
  if (categoryId) where.categoryId = categoryId;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { instructions: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (mine && userId) where.createdById = userId;

  if (available && userId) {
    // "Exams for me": published, open now, and the candidate is registered or
    // the exam is public.
    where.status = { in: ['PUBLISHED', 'ACTIVE'] };
    where.OR = [
      { accessControl: 'PUBLIC' },
      { registrations: { some: { userId, status: { not: 'WITHDRAWN' } } } },
    ];
    const now = new Date();
    where.AND = [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }];
  }

  const orderBy = {
    newest: { createdAt: 'desc' },
    oldest: { createdAt: 'asc' },
    soonest: { startsAt: 'asc' },
    titleAsc: { title: 'asc' },
    mostAttempts: { totalAttempts: 'desc' },
    bestRated: { passRate: 'desc' },
  }[sort] ?? { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.exam.findMany({ where, select: LIST_SELECT, orderBy, skip: (page - 1) * limit, take: limit }),
    prisma.exam.count({ where }),
  ]);
  return { items: items.map(deserialiseExam), total, page, limit };
}

/** Public catalog: everything marked PUBLIC that is live right now. */
async function listCatalog({ search, type, tag, page = 1, limit = 20 } = {}) {
  const where = {
    status: { in: ['PUBLISHED', 'ACTIVE'] },
    accessControl: 'PUBLIC',
    OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
  };
  if (search) {
    where.OR = [{ title: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
  }
  if (type) where.type = type;

  const [items, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      select: {
        ...LIST_SELECT,
        organization: { select: { id: true, name: true, slug: true, logoUrl: true } },
      },
      orderBy: { publishedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.exam.count({ where }),
  ]);
  return { items: items.map(deserialiseExam), total, page, limit };
}

async function getExam(examId, { actor = null, includeAnswers = false } = {}) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: DETAIL_INCLUDE,
  });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (actor?.organizationId && exam.organizationId !== actor.organizationId && exam.accessControl !== 'PUBLIC' && actor.platformRole !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('This exam belongs to another organization');
  }

  const [sectionsWithCounts, eligibility] = await Promise.all([
    sectionSummaries(examId),
    actor?.userId ? evaluateEligibility(examId, actor.userId, { exam }) : null,
  ]);

  const detail = {
    ...exam,
    settings: { ...EXAM_SETTING_DEFAULTS, ...(exam.organization?.defaultExamSettings ?? {}), ...(exam.settings ?? {}) },
    proctoringConfig: { ...PROCTORING_DEFAULTS, ...(exam.proctoringConfig ?? {}) },
    sections: exam.sections.map((section) => ({
      ...section,
      summary: sectionsWithCounts.get(section.id) ?? null,
      pools: section.pools.map((pool) => ({
        ...pool,
        availableQuestions: pool.questions?.length ?? 0,
      })),
    })),
    eligibility,
    candidateCount: exam._count?.registrations ?? 0,
  };
  if (!includeAnswers) {
    detail.examQuestions = detail.examQuestions.map((row) => ({
      ...row,
      question: { ...row.question, content: stripAnswerKeys(row.question?.content) },
    }));
  }
  return deserialiseExam(detail);
}

/** Remove correct answers / solutions so a preview response cannot leak them. */
function stripAnswerKeys(content = {}) {
  if (!content || typeof content !== 'object') return content;
  const { correctOptionId, correctOptionIds, acceptedAnswers, answers, solution, modelAnswer, rubric, ...rest } = content;
  if (Array.isArray(rest.options)) {
    rest.options = rest.options.map((option) => ({ id: option.id, text: option.text ?? option.label ?? '' }));
  }
  return rest;
}

async function sectionSummaries(examId) {
  const rows = await prisma.examQuestion.groupBy({
    by: ['sectionId'],
    where: { examId },
    _count: { _all: true },
    _sum: { marks: true },
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.sectionId ?? 'unassigned', {
      questions: row._count._all,
      marks: Number(row._sum.marks ?? 0),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

async function createExam(payload, actor) {
  const organizationId = payload.organizationId ?? actor.organizationId;
  if (!organizationId) throw ApiError.badRequest('An organization is required');

  const slug = await uniqueExamSlug(organizationId, payload.slug || payload.title);
  const settings = { ...EXAM_SETTING_DEFAULTS, ...(payload.settings ?? {}) };
  const proctoringConfig = { ...PROCTORING_DEFAULTS, ...(payload.proctoringConfig ?? {}) };

  const exam = await prisma.exam.create({
    data: {
      organizationId,
      createdById: actor.userId,
      categoryId: payload.categoryId ?? null,
      title: payload.title,
      slug,
      description: payload.description ?? null,
      instructions: payload.instructions ?? null,
      thumbnailUrl: payload.thumbnailUrl ?? null,
      type: payload.type ?? 'TEST',
      status: 'DRAFT',
      language: payload.language ?? 'en',
      languages: payload.languages ?? [payload.language ?? 'en'],
      accessControl: payload.accessControl ?? 'ORGANIZATION',
      examFeeCents: Number(payload.examFeeCents ?? 0),
      certificationFeeCents: Number(payload.certificationFeeCents ?? 0),
      refundPolicy: payload.refundPolicy ?? 'NO_REFUND',
      passingPercent: payload.passingPercent ?? 50,
      durationMinutes: payload.durationMinutes ?? 60,
      perQuestionSec: payload.perQuestionSec ?? null,
      attemptLimit: payload.attemptLimit ?? 1,
      startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
      endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
      resultsVisibleAt: payload.resultsVisibleAt ? new Date(payload.resultsVisibleAt) : null,
      resultVisibility: payload.resultVisibility ?? 'IMMEDIATELY',
      gradeBoundaries: payload.gradeBoundaries ?? { A: 90, B: 80, C: 70, D: 60, F: 0 },
      settings,
      proctoringConfig,
      adaptiveConfig: { maxItems: 30, startTheta: 0, stepTheta: 0.5, terminateAtStdErr: 0.3, ...(payload.adaptiveConfig ?? {}) },
      scoringConfig: { negativeMarkingPercent: 25, partialMarkingMode: 'PROPORTIONAL', ...(payload.scoringConfig ?? {}) },
      accessibilityConfig: payload.accessibilityConfig ?? {},
      isProctored: payload.isProctored ?? false,
      isAdaptive: payload.isAdaptive ?? false,
      isAutoGraded: payload.isAutoGraded ?? true,
      answerReviewEnabled: payload.answerReviewEnabled ?? true,
      shuffleQuestions: Boolean(payload.shuffleQuestions),
      shuffleOptions: Boolean(payload.shuffleOptions),
      negativeMarking: Boolean(payload.negativeMarking),
      partialMarking: Boolean(payload.partialMarking),
      calculatorAllowed: Boolean(payload.calculatorAllowed),
      scratchpadAllowed: Boolean(payload.scratchpadAllowed),
      attachmentAllowed: Boolean(payload.attachmentAllowed),
      requireCamera: proctoringConfig.requireCamera,
      requireScreenShare: proctoringConfig.requireScreenShare,
      recordWebcam: proctoringConfig.recordWebcam,
      recordScreen: proctoringConfig.recordScreen,
      maxCandidates: payload.maxCandidates ?? 1000,
    },
    include: DETAIL_INCLUDE,
  });

  if (Array.isArray(payload.sections) && payload.sections.length) {
    await createSections(exam.id, payload.sections, actor);
  }
  if (Array.isArray(payload.questionIds) && payload.questionIds.length) {
    await addQuestions(exam.id, { questionIds: payload.questionIds }, actor);
  }

  logger.info('exam created', { examId: exam.id, actorId: actor.userId, type: exam.type });
  return deserialiseExam(exam);
}

async function uniqueExamSlug(organizationId, base) {
  const cleaned = normaliseSlug(base) || `exam-${Date.now().toString(36)}`;
  let candidate = cleaned;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await prisma.exam.findFirst({ where: { organizationId, slug: candidate } });
    if (!existing) return candidate;
    candidate = `${cleaned}-${attempt}`;
  }
}

function normaliseSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
}

/** Only DRAFT/SCHEDULED exams may be edited structurally. */
async function assertEditable(exam) {
  if (!['DRAFT', 'SCHEDULED'].includes(exam.status)) {
    throw ApiError.locked(`A ${exam.status.toLowerCase()} exam cannot be edited - clone it or unpublish first`);
  }
}

async function updateExam(examId, payload, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);

  const editable = ['DRAFT', 'SCHEDULED'].includes(exam.status);
  const data = {};

  const structuralFields = [
    'title', 'description', 'instructions', 'thumbnailUrl', 'type', 'language', 'languages',
    'accessControl', 'passingPercent', 'durationMinutes', 'perQuestionSec', 'attemptLimit',
    'maxCandidates', 'examFeeCents', 'certificationFeeCents', 'refundPolicy', 'resultVisibility',
    'isProctored', 'isAutoGraded', 'answerReviewEnabled', 'shuffleQuestions', 'shuffleOptions',
    'negativeMarking', 'partialMarking', 'calculatorAllowed', 'scratchpadAllowed', 'attachmentAllowed',
    'categoryId', 'gradeBoundaries',
  ];
  for (const field of structuralFields) {
    if (payload[field] === undefined) continue;
    if (!editable && !['description', 'instructions', 'thumbnailUrl', 'categoryId'].includes(field)) {
      throw ApiError.locked(`"${field}" cannot be changed while the exam is ${exam.status.toLowerCase()}`);
    }
    data[field] = payload[field];
  }

  if (payload.slug && payload.slug !== exam.slug) {
    data.slug = await uniqueExamSlug(exam.organizationId, payload.slug);
  }
  for (const field of ['startsAt', 'endsAt', 'resultsVisibleAt']) {
    if (payload[field] !== undefined) data[field] = payload[field] ? new Date(payload[field]) : null;
  }
  if (payload.settings) data.settings = { ...EXAM_SETTING_DEFAULTS, ...(exam.settings ?? {}), ...payload.settings };
  if (payload.proctoringConfig) {
    data.proctoringConfig = { ...PROCTORING_DEFAULTS, ...(exam.proctoringConfig ?? {}), ...payload.proctoringConfig };
    data.isProctored = (data.proctoringConfig.level ?? 'STANDARD') !== 'NONE';
  }
  if (payload.adaptiveConfig) data.adaptiveConfig = { ...(exam.adaptiveConfig ?? {}), ...payload.adaptiveConfig };
  if (payload.scoringConfig) data.scoringConfig = { ...(exam.scoringConfig ?? {}), ...payload.scoringConfig };
  if (payload.accessibilityConfig) data.accessibilityConfig = payload.accessibilityConfig;
  if (payload.isAdaptive !== undefined) data.isAdaptive = Boolean(payload.isAdaptive);

  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');
  if (data.startsAt && data.endsAt && data.endsAt < data.startsAt) {
    throw ApiError.badRequest('endsAt must be after startsAt');
  }

  const updated = await prisma.exam.update({ where: { id: examId }, data, include: DETAIL_INCLUDE });
  return deserialiseExam(updated);
}

// ---------------------------------------------------------------------------
// Sections, questions and pools
// ---------------------------------------------------------------------------

async function createSections(examId, sections = [], actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);
  await assertEditable(exam);

  const startOrder = await prisma.examSection.count({ where: { examId } });
  const created = [];
  for (const [index, section] of sections.entries()) {
    const row = await prisma.examSection.create({
      data: {
        examId,
        name: section.name ?? `Section ${startOrder + index + 1}`,
        instructions: section.instructions ?? null,
        order: section.order ?? startOrder + index,
        durationMinutes: section.durationMinutes ?? null,
        canNavigateBack: section.canNavigateBack !== false,
        isLocked: Boolean(section.isLocked),
        randomFromPool: Boolean(section.randomFromPool),
        pickCount: section.pickCount ?? null,
        settings: section.settings ?? {},
      },
    });
    created.push(row);

    if (Array.isArray(section.questionIds) && section.questionIds.length) {
      await addQuestions(examId, { questionIds: section.questionIds, sectionId: row.id }, actor);
    }
    if (section.pool) await setSectionPool(row.id, section.pool, actor);
  }

  await recomputeTotals(examId);
  return prisma.examSection.findMany({ where: { examId }, orderBy: { order: 'asc' } });
}

async function updateSection(sectionId, payload, actor) {
  const section = await prisma.examSection.findUnique({ where: { id: sectionId }, include: { exam: true } });
  if (!section) throw ApiError.notFound('Section not found');
  await assertEditable(section.exam);
  assertSameOrganization(section.exam, actor);

  const data = {};
  for (const field of ['name', 'instructions', 'order', 'durationMinutes', 'canNavigateBack', 'isLocked', 'randomFromPool', 'pickCount', 'settings']) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }
  const updated = await prisma.examSection.update({ where: { id: sectionId }, data });
  if (payload.questionIds) {
    await setSectionQuestions(sectionId, { questionIds: payload.questionIds }, actor);
  }
  await recomputeTotals(section.examId);
  return updated;
}

async function deleteSection(sectionId, actor) {
  const section = await prisma.examSection.findUnique({ where: { id: sectionId }, include: { exam: true } });
  if (!section) throw ApiError.notFound('Section not found');
  await assertEditable(section.exam);
  assertSameOrganization(section.exam, actor);

  await prisma.$transaction([
    prisma.examQuestion.updateMany({ where: { sectionId }, data: { sectionId: null } }),
    prisma.examSection.delete({ where: { id: sectionId } }),
  ]);
  await recomputeTotals(section.examId);
  return { deleted: true, sectionId };
}

async function reorderSections(examId, { sectionIds = [] }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  await assertEditable(exam);
  assertSameOrganization(exam, actor);

  await prisma.$transaction(sectionIds.map((id, index) => prisma.examSection.update({ where: { id }, data: { order: index } })));
  return prisma.examSection.findMany({ where: { examId }, orderBy: { order: 'asc' } });
}

/**
 * Attach bank questions to an exam. `marks` per link overrides the question
 * default so the same item can be worth 1 mark in a quiz and 5 in a mock exam.
 */
async function addQuestions(examId, { questionIds = [], sectionId = null, marksByQuestion = {}, startOrder = null }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  await assertEditable(exam);
  assertSameOrganization(exam, actor);
  if (!questionIds.length) throw ApiError.badRequest('Select at least one question');
  if (questionIds.length > 500) throw ApiError.badRequest('Add at most 500 questions at a time');

  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds }, organizationId: exam.organizationId },
    select: { id: true, marks: true, status: true, type: true, bankId: true },
  });
  if (questions.length !== questionIds.length) {
    throw ApiError.badRequest('Some questions were not found in this organization');
  }
  const unusable = questions.filter((question) => ['DRAFT', 'REJECTED', 'ARCHIVED'].includes(question.status));
  if (unusable.length && exam.status !== 'DRAFT') {
    throw ApiError.unprocessable('Only approved questions can be used in a published exam', { questionIds: unusable.map((question) => question.id) });
  }

  // `@@unique([examId, questionId])` means a re-add is an update, not a dupe.
  const existingRows = await prisma.examQuestion.findMany({
    where: { examId, questionId: { in: questionIds } },
    select: { id: true, questionId: true },
  });
  const existingIds = new Map(existingRows.map((row) => [row.questionId, row.id]));
  const totalLinked = await prisma.examQuestion.count({ where: { examId } });

  let order = startOrder ?? totalLinked;
  const operations = [];
  const added = new Set();

  for (const question of questions) {
    if (added.has(question.id)) continue;
    added.add(question.id);
    order += 1;
    const marks = marksByQuestion[question.id] ?? question.marks;
    const linkedId = existingIds.get(question.id);

    if (linkedId) {
      operations.push(prisma.examQuestion.update({
        where: { id: linkedId },
        data: { sectionId: sectionId ?? undefined, order, marks },
      }));
    } else {
      operations.push(prisma.examQuestion.create({
        data: {
          examId,
          questionId: question.id,
          sectionId: sectionId ?? null,
          order,
          marks,
          negativePercent: exam.negativeMarking ? undefined : null,
        },
      }));
    }
  }

  await prisma.$transaction(operations);

  await recomputeTotals(examId);
  return { added: added.size, examId, sectionId };
}

async function removeQuestion(examId, { examQuestionId = null, questionId = null }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  await assertEditable(exam);
  assertSameOrganization(exam, actor);

  const where = examQuestionId ? { id: examQuestionId } : { examId_questionId: { examId, questionId: String(questionId) } };
  await prisma.examQuestion.delete({ where });
  await recomputeTotals(examId);
  return { removed: true };
}

async function setSectionQuestions(sectionId, { questionIds = [] }, actor) {
  const section = await prisma.examSection.findUnique({ where: { id: sectionId }, include: { exam: true } });
  if (!section) throw ApiError.notFound('Section not found');
  await assertEditable(section.exam);
  assertSameOrganization(section.exam, actor);

  await prisma.examQuestion.updateMany({ where: { sectionId }, data: { sectionId: null } });

  // Pre-fetch the default marks: the transaction array is built synchronously,
  // so no `await` may appear inside the map callback.
  const marksRows = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, marks: true },
  });
  const marksById = new Map(marksRows.map((row) => [row.id, row.marks]));

  await prisma.$transaction(questionIds.map((questionId, index) => prisma.examQuestion.upsert({
    where: { examId_questionId: { examId: section.examId, questionId } },
    update: { sectionId, order: index },
    create: {
      examId: section.examId,
      questionId,
      sectionId,
      order: index,
      marks: marksById.get(questionId) ?? 1,
    },
  })));

  await recomputeTotals(section.examId);
  return { sectionId, questions: questionIds.length };
}

async function reorderQuestions(examId, { order = [] }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  await assertEditable(exam);
  assertSameOrganization(exam, actor);

  await prisma.$transaction(order.map((entry, index) => prisma.examQuestion.update({
    where: { id: entry.examQuestionId ?? entry.id },
    data: {
      order: entry.order ?? index,
      ...(entry.sectionId !== undefined ? { sectionId: entry.sectionId } : {}),
      ...(entry.marks !== undefined ? { marks: entry.marks } : {}),
      ...(entry.isRequired !== undefined ? { isRequired: entry.isRequired } : {}),
    },
  })));
  await recomputeTotals(examId);
  return { reordered: order.length };
}

/** Randomised section: store the filter + the eligible question set. */
async function setSectionPool(sectionId, { bankId, filters = {}, pickCount = 5, questionIds = [] }, actor) {
  const section = await prisma.examSection.findUnique({ where: { id: sectionId }, include: { exam: true } });
  if (!section) throw ApiError.notFound('Section not found');
  await assertEditable(section.exam);
  assertSameOrganization(section.exam, actor);

  let eligible = questionIds;
  if (!eligible.length && bankId) {
    eligible = (await prisma.question.findMany({
      where: {
        bankId,
        organizationId: section.exam.organizationId,
        status: 'APPROVED',
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.difficulty ? { difficulty: filters.difficulty } : {}),
        ...(Array.isArray(filters.tags) && filters.tags.length ? { topicTags: { hasSome: filters.tags } } : {}),
      },
      select: { id: true },
      take: 500,
    })).map((row) => row.id);
  }
  if (!eligible.length) throw ApiError.badRequest('The pool has no matching questions');

  const existing = await prisma.examPool.findFirst({ where: { sectionId } });
  const data = {
    bankId: bankId ?? null,
    filters: { ...filters, questionIds: eligible },
    pickCount: Math.min(Number(pickCount) || 5, eligible.length),
  };

  const pool = existing
    ? await prisma.examPool.update({ where: { id: existing.id }, data })
    : await prisma.examPool.create({ data: { sectionId, ...data } });

  if (existing && existing.id !== pool.id) throw ApiError.conflict('Pool replacement failed');

  await prisma.examPool.update({
    where: { id: pool.id },
    data: { questions: { set: eligible.map((id) => ({ id })) } },
  });

  await prisma.examSection.update({ where: { id: sectionId }, data: { randomFromPool: true, pickCount: data.pickCount, poolSize: eligible.length } });
  return { poolId: pool.id, poolSize: eligible.length, pickCount: data.pickCount };
}

/**
 * Pick this attempt's random questions. Called once when the attempt starts and
 * frozen into `attempt.adaptiveState`/metadata so a refresh cannot re-roll.
 */
function drawFromPool(pool, { seed = null } = {}) {
  const ids = Array.isArray(pool?.filters?.questionIds) ? pool.filters.questionIds : [];
  if (!ids.length) return [];
  const count = Math.min(pool.pickCount ?? ids.length, ids.length);
  const random = seededRandom(seed ?? crypto.randomBytes(4).readUInt32BE(0));
  const copy = [...ids];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy.slice(0, count);
}

/** Deterministic PRNG (mulberry32) so a re-draw with the same seed matches. */
function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Recompute `questionCount` + `totalMarks` (and the per-section marks) from the
 * current structure. Safe to call at any time.
 */
async function recomputeTotals(examId) {
  const links = await prisma.examQuestion.findMany({
    where: { examId },
    select: { sectionId: true, marks: true },
  });
  const totalMarks = links.reduce((sum, link) => sum + Number(link.marks ?? 0), 0);

  const bySection = new Map();
  for (const link of links) {
    const key = link.sectionId ?? 'unassigned';
    bySection.set(key, (bySection.get(key) ?? 0) + Number(link.marks ?? 0));
  }

  const sections = await prisma.examSection.findMany({ where: { examId }, select: { id: true, pools: { select: { pickCount: true, filters: true } } } });
  await prisma.$transaction(sections.map((section) => {
    const pool = section.pools[0];
    const poolQuestions = Math.min(pool?.pickCount ?? 0, Array.isArray(pool?.filters?.questionIds) ? pool.filters.questionIds.length : 0);
    const direct = links.filter((link) => link.sectionId === section.id).length;
    return prisma.examSection.update({
      where: { id: section.id },
      data: {
        sectionMarks: Number((bySection.get(section.id) ?? 0).toFixed(2)),
        questionCount: direct || poolQuestions,
      },
    });
  }));

  const updated = await prisma.exam.update({
    where: { id: examId },
    data: {
      totalMarks: Number(totalMarks.toFixed(2)),
      questionCount: links.length + sections.reduce((sum, section) => sum + (section.pools[0]?.pickCount ?? 0), 0),
    },
    select: { id: true, totalMarks: true, questionCount: true },
  });

  // An exam whose only auto-gradable items are manual types cannot auto-grade.
  const autoGradable = await prisma.examQuestion.count({
    where: { examId, question: { type: { in: AUTO_GRADED_TYPES } } },
  });
  if (autoGradable === 0 && links.length > 0) {
    await prisma.exam.update({ where: { id: examId }, data: { isAutoGraded: false } });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Publish: validate the structure, freeze a version snapshot, mint the invite
 * token, and tell everyone who is registered.
 */
async function publishExam(examId, { notify = true, publishedAtMessage = null } = {}, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: DETAIL_INCLUDE });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);
  if (['PUBLISHED', 'ACTIVE'].includes(exam.status)) return deserialiseExam(exam);
  if (exam.status === 'ARCHIVED') throw ApiError.conflict('An archived exam cannot be published');

  const problems = validateForPublish(exam);
  if (problems.length) throw ApiError.unprocessable('This exam is not ready to publish', { problems });

  const version = exam.version + 1;
  const inviteToken = exam.inviteToken ?? crypto.randomBytes(12).toString('hex');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.exam.update({
      where: { id: examId },
      data: {
        status: exam.startsAt && exam.startsAt > new Date() ? 'SCHEDULED' : 'PUBLISHED',
        publishedAt: exam.publishedAt ?? new Date(),
        version,
        inviteToken,
      },
      include: DETAIL_INCLUDE,
    });
    await tx.examVersion.create({
      data: {
        examId,
        version,
        createdById: actor.userId,
        publishedAt: new Date(),
        snapshot: snapshotOf(exam),
        changeNote: publishedAtMessage ?? null,
      },
    });
    return result;
  });

  if (notify && exam.accessControl !== 'PUBLIC') {
    const registrations = await prisma.examCandidate.findMany({ where: { examId, status: { not: 'WITHDRAWN' } }, select: { userId: true } });
    await notifyExamCandidates(examId, {
      type: 'EXAM_ASSIGNED',
      title: `“${exam.title}” is now available`,
      body: exam.startsAt ? `Opens ${new Date(exam.startsAt).toLocaleString()}` : 'Start it whenever you are ready.',
      actionUrl: `/exams/${exam.slug}`,
      emailProps: {
        examTitle: exam.title,
        startsAt: exam.startsAt,
        endsAt: exam.endsAt,
        durationMinutes: exam.durationMinutes,
        totalMarks: Number(exam.totalMarks),
        instructions: exam.instructions,
        link: `${env.CLIENT_URL}/exams/${exam.slug}`,
      },
    }).catch((error) => logger.warn('publish notifications failed', { examId, error: error.message }));
    logger.info('exam published with notifications', { examId, recipients: registrations.length });
  }

  logger.info('exam published', { examId, version, actorId: actor.userId });
  return deserialiseExam(updated);
}

function validateForPublish(exam) {
  const problems = [];
  const questionCount = (exam.examQuestions ?? []).length;
  const poolBacked = (exam.sections ?? []).some((section) => section.randomFromPool || (section.pools ?? []).length > 0);
  if (!questionCount && !poolBacked) problems.push('add at least one question or a random pool');
  if (!exam.durationMinutes && !exam.perQuestionSec) problems.push('set a duration');
  if (exam.startsAt && exam.endsAt && new Date(exam.endsAt) <= new Date(exam.startsAt)) problems.push('the exam ends before it starts');
  if (exam.resultVisibility === 'ON_DATE' && !exam.resultsVisibleAt) problems.push('results visibility is "on a date" but no date is set');
  if (exam.accessControl === 'SPECIFIC_CANDIDATES' && (exam._count?.registrations ?? 0) === 0) problems.push('no candidates are assigned yet');
  if (exam.isProctored && exam.proctoringConfig?.level === 'NONE') problems.push('proctoring is switched off while the exam is marked as proctored');
  if (!exam.title || !exam.title.trim()) problems.push('the exam needs a title');
  return problems;
}

/** Compact structure stored in `ExamVersion.snapshot`. */
function snapshotOf(exam) {
  return {
    title: exam.title,
    description: exam.description,
    instructions: exam.instructions,
    type: exam.type,
    durationMinutes: exam.durationMinutes,
    perQuestionSec: exam.perQuestionSec,
    passingPercent: Number(exam.passingPercent),
    totalMarks: Number(exam.totalMarks),
    settings: exam.settings,
    proctoringConfig: exam.proctoringConfig,
    adaptiveConfig: exam.adaptiveConfig,
    scoringConfig: exam.scoringConfig,
    gradeBoundaries: exam.gradeBoundaries,
    attemptLimit: exam.attemptLimit,
    accessControl: exam.accessControl,
    examFeeCents: exam.examFeeCents,
    sections: (exam.sections ?? []).map((section) => ({
      id: section.id,
      name: section.name,
      order: section.order,
      durationMinutes: section.durationMinutes,
      randomFromPool: section.randomFromPool,
      pickCount: section.pickCount,
      settings: section.settings,
    })),
    questions: (exam.examQuestions ?? []).map((link) => ({
      questionId: link.questionId,
      sectionId: link.sectionId,
      order: link.order,
      marks: Number(link.marks),
      isRequired: link.isRequired,
    })),
  };
}

async function changeStatus(examId, { status, reason = null }, actor) {
  const allowedTransitions = {
    DRAFT: ['SCHEDULED', 'PUBLISHED', 'ARCHIVED'],
    SCHEDULED: ['PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED', 'DRAFT'],
    PUBLISHED: ['ACTIVE', 'CLOSED', 'ARCHIVED', 'SCHEDULED'],
    ACTIVE: ['CLOSED', 'ARCHIVED'],
    CLOSED: ['ARCHIVED', 'PUBLISHED'],
    ARCHIVED: ['CLOSED'],
  };

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);

  if (!allowedTransitions[exam.status]?.includes(status)) {
    throw ApiError.conflict(`Cannot move an exam from ${exam.status} to ${status}`);
  }

  const data = { status };
  if (status === 'CLOSED') data.closedAt = new Date();
  if (status === 'ARCHIVED') data.archivedAt = new Date();
  if (status === 'PUBLISHED' && !exam.publishedAt) data.publishedAt = new Date();

  const updated = await prisma.exam.update({ where: { id: examId }, data, include: DETAIL_INCLUDE });

  if (status === 'CLOSED') {
    await prisma.attempt.updateMany({
      where: { examId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
      data: { status: 'AUTO_SUBMITTED', submittedAt: new Date(), autoSubmitted: true },
    });
  }

  logger.info('exam status changed', { examId, from: exam.status, to: status, reason, actorId: actor.userId });
  return deserialiseExam(updated);
}

/** Roll back to a stored snapshot (used after a bad edit). */
async function restoreVersion({ examId, version }, actor) {
  const snapshot = await prisma.examVersion.findUnique({ where: { examId_version: { examId, version: Number(version) } } });
  if (!snapshot) throw ApiError.notFound(`Version ${version} does not exist`);

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);
  await assertEditable(exam);

  const payload = snapshot.snapshot ?? {};
  const data = {
    title: payload.title,
    description: payload.description,
    instructions: payload.instructions,
    durationMinutes: payload.durationMinutes,
    passingPercent: payload.passingPercent,
    settings: payload.settings,
    proctoringConfig: payload.proctoringConfig,
    adaptiveConfig: payload.adaptiveConfig,
    scoringConfig: payload.scoringConfig,
    gradeBoundaries: payload.gradeBoundaries,
    version: exam.version + 1,
  };

  const updated = await prisma.exam.update({ where: { id: examId }, data });
  await prisma.$transaction((payload.questions ?? []).map((link) => prisma.examQuestion.upsert({
    where: { examId_questionId: { examId, questionId: link.questionId } },
    update: { order: link.order, marks: link.marks, sectionId: link.sectionId, isRequired: link.isRequired },
    create: { examId, questionId: link.questionId, order: link.order, marks: link.marks, sectionId: link.sectionId, isRequired: link.isRequired },
  })));
  await recomputeTotals(examId);

  logger.info('exam version restored', { examId, version, actorId: actor.userId });
  return getExam(examId, { actor });
}

async function listVersions(examId) {
  return prisma.examVersion.findMany({
    where: { examId },
    include: { createdBy: { select: { id: true, displayName: true } } },
    orderBy: { version: 'desc' },
    take: 50,
  });
}

/** Reuse an exam: structure yes/no, questions shared always (bank items). */
async function cloneExam(examId, { title, startsAt = null, endsAt = null, includeQuestions = true, resetSchedule = true }, actor) {
  const source = await prisma.exam.findUnique({ where: { id: examId }, include: DETAIL_INCLUDE });
  if (!source) throw ApiError.notFound('Exam not found');
  assertSameOrganization(source, actor);

  const slug = await uniqueExamSlug(source.organizationId, title || `${source.slug}-copy`);

  const created = await prisma.exam.create({
    data: {
      organizationId: source.organizationId,
      createdById: actor.userId,
      categoryId: source.categoryId,
      title: title ?? `${source.title} (copy)`,
      slug,
      description: source.description,
      instructions: source.instructions,
      thumbnailUrl: source.thumbnailUrl,
      type: source.type,
      status: 'DRAFT',
      language: source.language,
      languages: source.languages,
      accessControl: source.accessControl,
      examFeeCents: source.examFeeCents,
      certificationFeeCents: source.certificationFeeCents,
      refundPolicy: source.refundPolicy,
      passingPercent: source.passingPercent,
      durationMinutes: source.durationMinutes,
      perQuestionSec: source.perQuestionSec,
      attemptLimit: source.attemptLimit,
      startsAt: resetSchedule && !startsAt ? null : new Date(startsAt),
      endsAt: resetSchedule && !endsAt ? null : endsAt ? new Date(endsAt) : null,
      resultVisibility: source.resultVisibility,
      gradeBoundaries: source.gradeBoundaries,
      settings: source.settings,
      proctoringConfig: source.proctoringConfig,
      adaptiveConfig: source.adaptiveConfig,
      scoringConfig: source.scoringConfig,
      accessibilityConfig: source.accessibilityConfig,
      isProctored: source.isProctored,
      isAdaptive: source.isAdaptive,
      isAutoGraded: source.isAutoGraded,
      answerReviewEnabled: source.answerReviewEnabled,
      shuffleQuestions: source.shuffleQuestions,
      shuffleOptions: source.shuffleOptions,
      negativeMarking: source.negativeMarking,
      partialMarking: source.partialMarking,
      calculatorAllowed: source.calculatorAllowed,
      scratchpadAllowed: source.scratchpadAllowed,
      attachmentAllowed: source.attachmentAllowed,
      maxCandidates: source.maxCandidates,
      clonedFromId: source.id,
    },
  });

  if (includeQuestions) {
    const sectionMap = new Map();
    for (const section of source.sections ?? []) {
      const copy = await prisma.examSection.create({
        data: {
          examId: created.id,
          name: section.name,
          instructions: section.instructions,
          order: section.order,
          durationMinutes: section.durationMinutes,
          canNavigateBack: section.canNavigateBack,
          randomFromPool: section.randomFromPool,
          pickCount: section.pickCount,
          settings: section.settings,
        },
      });
      sectionMap.set(section.id, copy.id);
    }

    for (const link of source.examQuestions ?? []) {
      await prisma.examQuestion.create({
        data: {
          examId: created.id,
          questionId: link.questionId,
          sectionId: link.sectionId ? sectionMap.get(link.sectionId) ?? null : null,
          order: link.order,
          marks: link.marks,
          isRequired: link.isRequired,
          negativePercent: link.negativePercent ?? undefined,
        },
      });
    }

    for (const section of source.sections ?? []) {
      for (const pool of section.pools ?? []) {
        const newSectionId = sectionMap.get(section.id);
        if (!newSectionId) continue;
        const createdPool = await prisma.examPool.create({
          data: { sectionId: newSectionId, bankId: pool.bankId, filters: pool.filters, pickCount: pool.pickCount },
        });
        const questionIds = Array.isArray(pool.filters?.questionIds) ? pool.filters.questionIds : [];
        if (questionIds.length) {
          await prisma.examPool.update({ where: { id: createdPool.id }, data: { questions: { connect: questionIds.map((id) => ({ id })) } } });
        }
      }
    }
  }

  await recomputeTotals(created.id);
  logger.info('exam cloned', { sourceExamId: examId, newExamId: created.id, actorId: actor.userId });
  return getExam(created.id, { actor });
}

// ---------------------------------------------------------------------------
// Candidates / registration
// ---------------------------------------------------------------------------

/**
 * Assign candidates (creates PENDING registrations) or register an existing
 * roster. `emails` are matched against `User.email`; unknown addresses get an
 * invite-token registration they can claim later.
 */
async function assignCandidates(examId, { emails = [], userIds = [], role = 'CANDIDATE', notify = true, message = null }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { organization: true } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);

  if (emails.length + userIds.length > 2000) throw ApiError.badRequest('Assign at most 2000 candidates at a time');

  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } })
    : [];
  const byEmail = emails.length
    ? await prisma.user.findMany({ where: { email: { in: emails.map((email) => String(email).toLowerCase()) } }, select: { id: true, email: true, displayName: true } })
    : [];

  const resolved = [...new Map([...users, ...byEmail].map((user) => [user.id, user])).values()];
  const assigned = [];
  const unmatched = [];

  for (const user of resolved) {
    const registration = await prisma.examCandidate.upsert({
      where: { examId_userId: { examId, userId: user.id } },
      update: { status: exam.examFeeCents > 0 ? 'PENDING' : 'REGISTERED', assignedById: actor.userId },
      create: {
        examId,
        userId: user.id,
        status: exam.examFeeCents > 0 ? 'PENDING' : 'REGISTERED',
        assignedById: actor.userId,
        seatNumber: nextSeatNumber(exam.maxCandidates, assigned.length),
      },
    });
    assigned.push({ userId: user.id, email: user.email, registrationId: registration.id });
  }

  const matchedEmails = new Set(resolved.map((user) => user.email.toLowerCase()));
  for (const email of emails) {
    if (!matchedEmails.has(String(email).toLowerCase())) unmatched.push(String(email));
  }

  await prisma.exam.update({ where: { id: examId }, data: { totalRegistrations: await prisma.examCandidate.count({ where: { examId } }) } });

  if (notify && assigned.length) {
    await notifyCandidates(exam, assigned, message, actor).catch((error) => logger.warn('assignment notification failed', { examId, error: error.message }));
  }

  return { assigned: assigned.length, unassigned: unmatched.length, unmatched, assignedIds: assigned };
}

function nextSeatNumber(maxCandidates, offset) {
  const next = offset + 1;
  return maxCandidates && next > maxCandidates ? null : next;
}

async function notifyCandidates(exam, assigned, message, actor) {
  return notifyExamCandidates(exam.id, {
    type: 'EXAM_ASSIGNED',
    title: `“${exam.title}” has been assigned to you`,
    body: message ?? (exam.startsAt ? `Opens ${new Date(exam.startsAt).toLocaleString()}` : 'Available now.'),
    actionUrl: `/exams/${exam.slug}`,
    emailProps: {
      examTitle: exam.title,
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      durationMinutes: exam.durationMinutes,
      totalMarks: Number(exam.totalMarks),
      instructions: exam.instructions,
      organizationName: exam.organization?.name,
      link: `${env.CLIENT_URL}/exams/${exam.slug}`,
    },
  }).then((rows) => {
    logger.debug('assignment notifications queued', { examId: exam.id, count: rows.length, actorId: actor?.userId });
    return rows;
  });
}

async function removeCandidate(examId, { userId = null, registrationId = null }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);

  const registration = registrationId
    ? await prisma.examCandidate.findUnique({ where: { id: registrationId } })
    : await prisma.examCandidate.findUnique({ where: { examId_userId: { examId, userId } } });
  if (!registration || registration.examId !== examId) throw ApiError.notFound('That candidate is not registered');

  const attempts = await prisma.attempt.count({ where: { registrationId: registration.id } });
  if (attempts > 0) {
    // Keep the attempt history: withdraw instead of deleting.
    return prisma.examCandidate.update({
      where: { id: registration.id },
      data: { status: 'WITHDRAWN', withdrawalReason: 'removed by instructor' },
    });
  }

  await prisma.examCandidate.delete({ where: { id: registration.id } });
  await prisma.exam.update({ where: { id: examId }, data: { totalRegistrations: await prisma.examCandidate.count({ where: { examId } }) } });
  return { removed: true, registrationId: registration.id };
}

async function listCandidates({ examId, status, search, page = 1, limit = 25 }) {
  const where = { examId };
  if (status) where.status = status;
  if (search) {
    where.user = {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  const [items, total] = await Promise.all([
    prisma.examCandidate.findMany({
      where,
      include: {
        user: { select: { id: true, email: true, displayName: true, firstName: true, lastName: true, imageUrl: true } },
        attempts: { select: { id: true, status: true, scorePercent: true, submittedAt: true, finalScore: true } },
      },
      orderBy: { registeredAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.examCandidate.count({ where }),
  ]);

  return {
    items: items.map((row) => ({
      ...row,
      attempts: row.attempts.map((attempt) => ({ ...attempt, scorePercent: Number(attempt.scorePercent) })),
      bestScore: row.attempts.length ? Math.max(...row.attempts.map((attempt) => Number(attempt.scorePercent ?? 0))) : null,
    })),
    total,
    page,
    limit,
  };
}

/** Self-enrolment (public / ORGANIZATION access exams). */
async function registerSelf(examId, userId, { accessCode = null, inviteToken = null } = {}) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');

  const gate = await checkAccess(exam, { userId, accessCode, inviteToken });
  if (!gate.allowed) throw ApiError.forbidden(gate.reason, gate);

  if (exam.maxCandidates && exam.totalRegistrations >= exam.maxCandidates) {
    throw ApiError.conflict('This exam is full');
  }

  const existing = await prisma.examCandidate.findUnique({ where: { examId_userId: { examId, userId } } });
  if (existing && existing.status !== 'WITHDRAWN') {
    return { registration: existing, already: true, requiresPayment: exam.examFeeCents > 0 && existing.status !== 'PAID' };
  }

  const registration = existing
    ? await prisma.examCandidate.update({
      where: { id: existing.id },
      data: { status: exam.examFeeCents > 0 ? 'PENDING' : 'REGISTERED', withdrawalReason: null },
    })
    : await prisma.examCandidate.create({
      data: {
        examId,
        userId,
        status: exam.examFeeCents > 0 ? 'PENDING' : 'REGISTERED',
        seatNumber: (exam.totalRegistrations ?? 0) + 1,
      },
    });

  await prisma.exam.update({ where: { id: examId }, data: { totalRegistrations: { increment: existing ? 0 : 1 } } });

  if (exam.examFeeCents > 0) {
    throw ApiError.paymentRequired(`A fee of ${formatFee(exam.examFeeCents, exam.currency)} is required`, {
      examId,
      amountCents: exam.examFeeCents,
      currency: exam.currency,
      registrationId: registration.id,
    });
  }

  return { registration, already: false, requiresPayment: false };
}

function formatFee(cents, currency = 'usd') {
  const amount = Number(cents ?? 0) / 100;
  return `${String(currency).toUpperCase()} ${amount.toFixed(2)}`;
}

/**
 * Can this user take the exam? Centralised so the start endpoint, the catalog
 * and the socket handshake all agree.
 */
async function checkAccess(exam, { userId, accessCode = null, inviteToken = null, requireWindow = true } = {}) {
  const now = new Date();
  const staff = userId
    ? await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: exam.organizationId, userId } } })
    : null;
  const isAuthor = staff && ['ORG_ADMIN', 'INSTRUCTOR'].includes(staff.role);
  const isSuperAdmin = userId ? (await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } }))?.platformRole === 'SUPER_ADMIN' : false;

  if (requireWindow) {
    if (exam.startsAt && now < exam.startsAt) return { allowed: false, reason: 'This exam has not opened yet', opensAt: exam.startsAt, code: 'NOT_OPEN' };
    if (exam.endsAt && now > exam.endsAt) return { allowed: false, reason: 'The exam window has closed', closedAt: exam.endsAt, code: 'CLOSED' };
    if (!['PUBLISHED', 'ACTIVE'].includes(exam.status) && !isAuthor && !isSuperAdmin) {
      return { allowed: false, reason: 'This exam is not published', code: 'NOT_PUBLISHED' };
    }
  }

  if (isAuthor || isSuperAdmin) return { allowed: true, role: 'STAFF' };

  switch (exam.accessControl) {
    case 'PUBLIC':
      return { allowed: true, role: 'CANDIDATE' };
    case 'ACCESS_CODE': {
      if (!accessCode || accessCode !== exam.accessCode) return { allowed: false, reason: 'The access code is incorrect', code: 'ACCESS_CODE' };
      return { allowed: true, role: 'CANDIDATE' };
    }
    case 'INVITE_LINK': {
      if (!inviteToken || inviteToken !== exam.inviteToken) return { allowed: false, reason: 'A valid invite link is required', code: 'INVITE_REQUIRED' };
      return { allowed: true, role: 'CANDIDATE' };
    }
    case 'ORGANIZATION': {
      if (!staff) return { allowed: false, reason: 'Only members of this organization can take the exam', code: 'NOT_MEMBER' };
      return { allowed: true, role: staff.role };
    }
    case 'SPECIFIC_CANDIDATES': {
      const registration = userId
        ? await prisma.examCandidate.findUnique({ where: { examId_userId: { examId: exam.id, userId } } })
        : null;
      if (!registration || registration.status === 'WITHDRAWN') {
        return { allowed: false, reason: 'You are not on the candidate list for this exam', code: 'NOT_REGISTERED' };
      }
      if (exam.examFeeCents > 0 && registration.status !== 'PAID' && registration.paidAmountCents < exam.examFeeCents) {
        return { allowed: false, reason: 'The exam fee has not been paid', code: 'PAYMENT_REQUIRED', registrationId: registration.id };
      }
      return { allowed: true, role: 'CANDIDATE', registration };
    }
    default:
      return { allowed: false, reason: 'Access to this exam is restricted', code: 'RESTRICTED' };
  }
}

/** Full pre-flight answer for the exam intro screen. */
async function evaluateEligibility(examId, userId, { exam = null } = {}) {
  const record = exam ?? await prisma.exam.findUnique({ where: { id: examId } });
  if (!record) return { allowed: false, reason: 'Exam not found', code: 'NOT_FOUND' };

  const [attempts, registration, proctorSession] = await Promise.all([
    prisma.attempt.findMany({ where: { examId, userId }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, attemptNumber: true, finalScore: true, scorePercent: true, submittedAt: true } }),
    prisma.examCandidate.findUnique({ where: { examId_userId: { examId, userId } } }),
    prisma.proctorSession.findFirst({ where: { attempt: { examId, userId } }, select: { id: true, status: true, attemptId: true } }),
  ]);

  const access = await checkAccess(record, { userId });
  const active = attempts.find((attempt) => ['IN_PROGRESS', 'PAUSED'].includes(attempt.status));
  const attemptsLeft = record.attemptLimit ? Math.max(0, record.attemptLimit - attempts.length) : null;

  return {
    ...access,
    registration: registration ? { status: registration.status, seatNumber: registration.seatNumber } : null,
    attemptsUsed: attempts.length,
    attemptsLeft,
    canStart: access.allowed && !active && (attemptsLeft === null || attemptsLeft > 0),
    activeAttempt: active ?? null,
    previousAttempts: attempts.map((attempt) => ({ ...attempt, scorePercent: attempt.scorePercent == null ? null : Number(attempt.scorePercent) })),
    proctorSession: proctorSession ?? null,
    requiresPayment: record.examFeeCents > 0 && registration?.status !== 'PAID',
  };
}

/** Rotate the access/invite tokens for an exam. */
async function regenerateAccessTokens(examId, { accessCode = null, invite = false }, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);

  const data = {};
  if (accessCode) data.accessCode = String(accessCode);
  else if (exam.accessControl === 'ACCESS_CODE' && !exam.accessCode) data.accessCode = readableCode();
  if (invite) data.inviteToken = crypto.randomBytes(12).toString('hex');

  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to regenerate');
  const updated = await prisma.exam.update({ where: { id: examId }, data, select: { id: true, accessCode: true, inviteToken: true } });
  return { ...updated, inviteUrl: updated.inviteToken ? `${env.CLIENT_URL}/exams/join/${updated.inviteToken}` : null };
}

function readableCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let index = 0; index < 6; index += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

/** Public lookup used by /exams/join/:token and the access-code screen. */
async function findByToken({ inviteToken = null, accessCode = null, previewToken = null }) {
  const where = [];
  if (inviteToken) where.push({ inviteToken });
  if (accessCode) where.push({ accessCode });
  if (previewToken) where.push({ previewToken });
  if (!where.length) return null;

  const exam = await prisma.exam.findFirst({
    where: { OR: where },
    select: { ...LIST_SELECT, instructions: true, accessibilityConfig: true, settings: true, proctoringConfig: true, inviteToken: true },
  });
  return exam ? deserialiseExam(exam) : null;
}

// ---------------------------------------------------------------------------
// Author dashboards
// ---------------------------------------------------------------------------

/** Everything the exam overview page shows, in one call. */
async function examDashboard(examId, { actor = null } = {}) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, title: true, slug: true, status: true, totalMarks: true, passingPercent: true, durationMinutes: true, questionCount: true, startsAt: true, endsAt: true, resultVisibility: true, resultsVisibleAt: true, organizationId: true, isProctored: true },
  });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (actor?.organizationId) assertSameOrganization(exam, actor);

  const [attempts, registrations, pendingGrading, violations, scoreGroups, completion, payments] = await Promise.all([
    prisma.attempt.groupBy({ by: ['status'], where: { examId }, _count: { _all: true } }),
    prisma.examCandidate.count({ where: { examId, status: { not: 'WITHDRAWN' } } }),
    prisma.answer.count({ where: { needsManualGrading: true, gradingStatus: { in: ['UNGRADED', 'IN_PROGRESS'] }, attempt: { examId } } }),
    prisma.violation.groupBy({ by: ['type'], where: { examId }, _count: { _all: true } }),
    prisma.attempt.aggregate({ where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } }, _avg: { scorePercent: true }, _min: { scorePercent: true }, _max: { scorePercent: true } }),
    prisma.attempt.groupBy({ by: ['passed'], where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { examId, status: 'SUCCEEDED' }, _sum: { amountCents: true } }),
  ]);

  const submitted = attempts.filter((row) => ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'].includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
  const inProgress = attempts.filter((row) => ['IN_PROGRESS', 'PAUSED'].includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
  const graded = completion.reduce((sum, row) => sum + row._count._all, 0);
  const passedCount = completion.find((row) => row.passed === true)?._count._all ?? 0;

  return {
    exam: deserialiseExam(exam),
    registrations,
    attempts: { total: attempts.reduce((sum, row) => sum + row._count._all, 0), submitted, inProgress, graded },
    completionPercent: registrations ? Math.round((submitted / registrations) * 1000) / 10 : 0,
    scores: {
      average: scoreGroups._avg.scorePercent == null ? null : round2(scoreGroups._avg.scorePercent),
      min: scoreGroups._min.scorePercent == null ? null : round2(scoreGroups._min.scorePercent),
      max: scoreGroups._max.scorePercent == null ? null : round2(scoreGroups._max.scorePercent),
    },
    passRate: graded ? Math.round((passedCount / graded) * 1000) / 10 : null,
    pendingManualGrading: pendingGrading,
    violations: violations.map((row) => ({ type: row.type, count: row._count._all })),
    revenueCents: payments._sum.amountCents ?? 0,
  };
}

function round2(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** My exams for the candidate dashboard. */
async function myExams(userId, { status = 'available', page = 1, limit = 20 } = {}) {
  const now = new Date();
  const base = {
    AND: [
      { OR: [{ accessControl: 'PUBLIC' }, { registrations: { some: { userId } } }] },
    ],
  };

  let where = { ...base, status: { in: ['PUBLISHED', 'ACTIVE'] } };
  if (status === 'upcoming') where = { ...base, status: { in: ['PUBLISHED', 'SCHEDULED'] }, startsAt: { gt: now } };
  if (status === 'completed') {
    where = { attempts: { some: { userId } }, ...base };
    delete where.status;
    where.OR = [{ status: 'CLOSED' }, { status: 'ARCHIVED' }, { attempts: { some: { userId, status: { in: ['SUBMITTED', 'GRADED', 'AUTO_SUBMITTED'] } } } }];
  }
  if (status === 'in-progress') where = { ...base, attempts: { some: { userId, status: { in: ['IN_PROGRESS', 'PAUSED'] } } } };

  const [items, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      select: {
        ...LIST_SELECT,
        registrations: { where: { userId }, select: { status: true, seatNumber: true } },
        attempts: { where: { userId }, select: { id: true, status: true, scorePercent: true, startedAt: true, submittedAt: true }, orderBy: { startedAt: 'desc' }, take: 5 },
      },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.exam.count({ where }),
  ]);

  return {
    items: items.map((exam) => deserialiseExam({
      ...exam,
      myRegistration: exam.registrations?.[0] ?? null,
      myAttempts: exam.attempts ?? [],
      registrations: undefined,
      attempts: undefined,
    })),
    total,
    page,
    limit,
  };
}

/** Instructor home page: totals plus what needs attention. */
async function authorOverview(organizationId, userId) {
  const [owned, published, drafts, awaitingGrading, liveNow, upcoming] = await Promise.all([
    prisma.exam.count({ where: { organizationId, createdById: userId } }),
    prisma.exam.count({ where: { organizationId, status: { in: ['PUBLISHED', 'ACTIVE'] } } }),
    prisma.exam.count({ where: { organizationId, status: 'DRAFT' } }),
    prisma.answer.count({ where: { needsManualGrading: true, gradingStatus: 'UNGRADED', attempt: { exam: { organizationId } } } }),
    prisma.exam.findMany({
      where: { organizationId, status: { in: ['PUBLISHED', 'ACTIVE'] }, startsAt: { lte: new Date() }, OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] },
      select: { id: true, title: true, endsAt: true, totalAttempts: true, maxCandidates: true },
      take: 10,
    }),
    prisma.exam.findMany({
      where: { organizationId, status: { in: ['SCHEDULED', 'PUBLISHED'] }, startsAt: { gt: new Date() } },
      select: { id: true, title: true, startsAt: true, totalRegistrations: true },
      orderBy: { startsAt: 'asc' },
      take: 10,
    }),
  ]);

  return {
    totals: { owned, published, drafts, awaitingGrading },
    liveNow,
    upcoming,
  };
}

/** Delete a DRAFT exam; anything published must be archived. */
async function deleteExam(examId, actor) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, include: { _count: { select: { attempts: true, registrations: true } } } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertSameOrganization(exam, actor);
  if (exam._count.attempts > 0 || exam.status !== 'DRAFT') {
    throw ApiError.conflict('Only an untouched draft can be deleted - archive it instead', { attempts: exam._count.attempts, status: exam.status });
  }
  await prisma.exam.delete({ where: { id: examId } });
  logger.warn('exam deleted', { examId, actorId: actor.userId });
  return { deleted: true, examId };
}

function assertSameOrganization(exam, actor) {
  if (!actor?.organizationId || actor.platformRole === 'SUPER_ADMIN') return;
  if (exam.organizationId !== actor.organizationId) throw ApiError.forbidden('This exam belongs to another organization');
}

/** Decimal columns become numbers on the way out. */
function deserialiseExam(exam) {
  if (!exam) return exam;
  const out = { ...exam };
  for (const field of ['totalMarks', 'passingPercent', 'averageScore', 'passRate']) {
    if (out[field] !== undefined && out[field] !== null) out[field] = Number(out[field]);
  }
  if (Array.isArray(out.examQuestions)) {
    out.examQuestions = out.examQuestions.map((link) => ({ ...link, marks: Number(link.marks ?? 0), weightage: link.weightage == null ? null : Number(link.weightage) }));
  }
  if (Array.isArray(out.sections)) {
    out.sections = out.sections.map((section) => ({ ...section, sectionMarks: section.sectionMarks == null ? null : Number(section.sectionMarks) }));
  }
  return out;
}

module.exports = {
  DETAIL_INCLUDE,
  EXAM_SETTING_DEFAULTS,
  LIST_SELECT,
  PROCTORING_DEFAULTS,
  addQuestions,
  assignCandidates,
  authorOverview,
  checkAccess,
  cloneExam,
  createExam,
  createSections,
  deleteExam,
  deleteSection,
  drawFromPool,
  evaluateEligibility,
  examDashboard,
  findByToken,
  getExam,
  listCatalog,
  listExams,
  listVersions,
  listCandidates,
  myExams,
  publishExam,
  recomputeTotals,
  regenerateAccessTokens,
  removeCandidate,
  removeQuestion,
  reorderQuestions,
  reorderSections,
  restoreVersion,
  seededRandom,
  setSectionPool,
  setSectionQuestions,
  snapshotOf,
  stripAnswerKeys,
  updateExam,
  updateSection,
  validateForPublish,
};
