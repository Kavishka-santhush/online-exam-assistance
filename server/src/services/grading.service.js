/**
 * Manual grading service.
 *
 * Auto-grading lives in `scoring.service`; this module is everything a human
 * does afterwards: building the queue, assigning submissions to graders,
 * entering marks (optionally against a rubric), overriding an auto-graded
 * score, writing feedback, running the AI suggestions, and releasing grades.
 *
 * The important invariant is that a human score is never overwritten by a
 * recompute: `scoring.autoGradeAttempt()` keeps `manualScore` when it exists and
 * `GradeOverride` rows win over everything, so re-running the engine after each
 * grading action is safe.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { MANUALLY_GRADED_TYPES } = require('../constants/questionTypes');
const scoring = require('./scoring.service');
const { notifyUser, notifyMany, broadcastToExam } = require('./notification.service');

const ASSIGNABLE_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];
const PENDING_STATES = ['UNGRADED', 'IN_PROGRESS'];

const ASSIGNMENT_READ_INCLUDE = {
  exam: { select: { id: true, title: true, slug: true, organizationId: true, createdById: true } },
  attempt: {
    select: {
      id: true,
      userId: true,
      status: true,
      gradingStatus: true,
      submittedAt: true,
      usedTimeSec: true,
      finalScore: true,
      totalMarks: true,
      scorePercent: true,
      user: { select: { id: true, displayName: true, email: true, imageUrl: true } },
    },
  },
  grader: { select: { id: true, displayName: true, email: true, imageUrl: true } },
  assignedBy: { select: { id: true, displayName: true } },
};

const ANSWER_READ_INCLUDE = {
  attempt: {
    select: {
      id: true,
      examId: true,
      userId: true,
      organizationId: true,
      status: true,
      gradingStatus: true,
      submittedAt: true,
      usedTimeSec: true,
      finalScore: true,
      totalMarks: true,
      attemptNumber: true,
      isTerminated: true,
      metadata: true,
      user: { select: { id: true, displayName: true, email: true } },
      exam: { select: { id: true, title: true, organizationId: true, createdById: true, settings: true, gradeBoundaries: true, passingPercent: true, scoringConfig: true } },
    },
  },
  question: {
    select: {
      id: true,
      type: true,
      prompt: true,
      content: true,
      marks: true,
      difficulty: true,
      topicTags: true,
      rubricCriteria: true,
      explanation: true,
      codeConfig: true,
      currentVersion: true,
    },
  },
  examQuestion: { select: { id: true, marks: true, weightage: true, order: true, sectionId: true } },
  rubricScores: { include: { rubric: { select: { id: true, name: true, criteria: true, totalMarks: true } } } },
  files: { select: { id: true, url: true, kind: true, mimeType: true, originalName: true, sizeBytes: true } },
  gradedBy: { select: { id: true, displayName: true } },
};

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function isGradingStaff(actor = {}) {
  return actor.platformRole === 'SUPER_ADMIN' || ASSIGNABLE_ROLES.includes(actor.role) || ASSIGNABLE_ROLES.includes(actor.platformRole);
}

/**
 * A grader may open the submissions they were assigned; the exam author and
 * organization admins may open anything inside their organization.
 */
async function assertCanGrade(examId, actor = {}, { allowAssignment = true } = {}) {
  if (actor?.system === true) {
    const systemExam = await prisma.exam.findUnique({
      where: { id: examId },
      select: { id: true, organizationId: true, createdById: true, title: true, settings: true, resultVisibility: true },
    });
    if (!systemExam) throw ApiError.notFound('Exam not found');
    return systemExam;
  }
  if (!actor?.userId) throw ApiError.unauthorized('Sign in to grade submissions');
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, organizationId: true, createdById: true, title: true, settings: true, resultVisibility: true },
  });
  if (!exam) throw ApiError.notFound('Exam not found');

  if (actor.platformRole === 'SUPER_ADMIN') return exam;
  if (actor.organizationId && actor.organizationId === exam.organizationId && isGradingStaff(actor)) return exam;
  if (exam.createdById === actor.userId) return exam;

  if (allowAssignment) {
    const assignment = await prisma.gradingAssignment.findFirst({ where: { examId, graderId: actor.userId } });
    if (assignment) return exam;
  }
  throw ApiError.forbidden('You are not a grader for this exam');
}

function assertSameOrganization(exam, actor = {}) {
  if (actor.platformRole === 'SUPER_ADMIN') return;
  if (!actor.organizationId || exam.organizationId !== actor.organizationId) {
    throw ApiError.forbidden('This exam belongs to another organization');
  }
}

function deserialiseAnswer(answer) {
  if (!answer) return answer;
  const out = { ...answer };
  for (const field of ['maxMarks', 'autoScore', 'manualScore', 'finalScore', 'secondScore', 'aiScore']) {
    if (out[field] !== undefined && out[field] !== null) out[field] = Number(out[field]);
  }
  return out;
}

function deserialiseAssignment(assignment) {
  if (!assignment) return assignment;
  const out = { ...assignment };
  if (out.attempt) {
    out.attempt = { ...out.attempt };
    for (const field of ['finalScore', 'totalMarks', 'scorePercent']) {
      if (out.attempt[field] != null) out.attempt[field] = Number(out.attempt[field]);
    }
  }
  return out;
}

/** Compact "how much is left" summary reused by several list endpoints. */
async function pendingSummary(where) {
  const grouped = await prisma.answer.groupBy({
    by: ['gradingStatus'],
    where: { ...where, needsManualGrading: true },
    _count: { _all: true },
  });
  const counts = grouped.reduce((acc, row) => ({ ...acc, [row.gradingStatus]: row._count._all }), {});
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    total,
    ungraded: counts.UNGRADED ?? 0,
    inProgress: counts.IN_PROGRESS ?? 0,
    graded: counts.GRADED ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Queue and assignment
// ---------------------------------------------------------------------------

/**
 * Called from `attempt.service` right after a submission when some answers still
 * need a human. Creates one `GradingAssignment` per grader for the attempt,
 * round-robining over the people already working on the exam so one grader does
 * not silently receive the whole cohort.
 */
async function queueForAttempt(attemptId, { graders = null } = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { exam: { select: { id: true, organizationId: true, createdById: true, settings: true, type: true } } },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (attempt.exam.type === 'SURVEY') return { assigned: 0, reason: 'SURVEY' };

  const pending = await prisma.answer.count({ where: { attemptId, needsManualGrading: true, gradingStatus: { in: PENDING_STATES } } });
  if (!pending) return { assigned: 0, reason: 'NOTHING_PENDING' };

  const graderIds = await resolveGradersFor(attempt.exam, graders);
  if (!graderIds.length) {
    logger.warn('no grader available for manual grading', { attemptId, examId: attempt.examId });
    return { assigned: 0, reason: 'NO_GRADER', pending };
  }

  const alreadyAssigned = await prisma.gradingAssignment.findMany({
    where: { attemptId, examId: attempt.examId },
    select: { graderId: true },
  });
  const covered = new Set(alreadyAssigned.map((row) => row.graderId));

  // Balance by current open workload, then round-robin over the sorted result.
  const loads = await prisma.gradingAssignment.groupBy({
    by: ['graderId'],
    where: { examId: attempt.examId, graderId: { in: graderIds }, status: { in: PENDING_STATES } },
    _count: { _all: true },
  });
  const loadById = new Map(loads.map((row) => [row.graderId, row._count._all]));
  const ordered = [...graderIds].sort((a, b) => (loadById.get(a) ?? 0) - (loadById.get(b) ?? 0));
  const target = ordered[0] ?? graderIds[0];
  if (covered.has(target)) return { assigned: 0, reason: 'ALREADY_ASSIGNED', pending, graderId: target };

  const created = await prisma.gradingAssignment.create({
    data: {
      examId: attempt.examId,
      attemptId,
      graderId: target,
      assignedById: null,
      status: 'UNGRADED',
      dueAt: gradingDueAt(attempt.exam),
    },
  });

  await notifyUser({
    userId: target,
    type: 'EXAM_ASSIGNED',
    title: 'New submissions to grade',
    body: `${attempt.exam.title} has ${pending} answer(s) waiting for grading.`,
    data: { examId: attempt.examId, attemptId, pending },
    actionUrl: `/grading/exams/${attempt.examId}`,
  }).catch((error) => logger.warn('grader notification failed', { attemptId, error: error.message }));

  return { assigned: 1, attemptId, graderId: target, pending, assignmentId: created.id };
}

/** Explicit list wins; otherwise the exam author plus the org's staff. */
async function resolveGradersFor(exam, graders = null) {
  const explicit = Array.isArray(graders) ? graders.filter(Boolean) : graders ? [graders] : [];
  if (explicit.length) return [...new Set(explicit)];

  const members = await prisma.organizationMember.findMany({
    where: { organizationId: exam.organizationId, role: { in: ASSIGNABLE_ROLES }, status: 'ACTIVE' },
    select: { userId: true },
  });
  const ids = new Set(members.map((member) => member.userId));
  ids.add(exam.createdById);
  return [...ids].filter(Boolean);
}

function gradingDueAt(exam) {
  const hours = Number(exam.settings?.gradingDueHours ?? 0);
  if (!hours || hours <= 0) return null;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * The grading queue for one exam: every submission with outstanding answers,
 * with who owns it and how much is left.
 */
async function gradingQueue(query = {}, actor = {}) {
  const { examId, graderId, status, search, onlyMine } = query;
  if (!examId) throw ApiError.badRequest('examId is required');
  const exam = await assertCanGrade(examId, actor);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

  const attemptWhere = {
    examId,
    status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED', 'TERMINATED'] },
    gradingStatus: status ? String(status).toUpperCase() : { in: PENDING_STATES },
  };
  if (search) {
    attemptWhere.user = {
      OR: [{ displayName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }],
    };
  }
  if (onlyMine || graderId) {
    attemptWhere.gradingAssignments = { some: { graderId: onlyMine ? actor.userId : graderId } };
  }

  const [attempts, total, assignments] = await Promise.all([
    prisma.attempt.findMany({
      where: attemptWhere,
      orderBy: { submittedAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        userId: true,
        attemptNumber: true,
        status: true,
        gradingStatus: true,
        submittedAt: true,
        usedTimeSec: true,
        finalScore: true,
        totalMarks: true,
        scorePercent: true,
        answeredCount: true,
        isTerminated: true,
        user: { select: { id: true, displayName: true, email: true, imageUrl: true } },
        answers: { where: { needsManualGrading: true }, select: { id: true, questionId: true, gradingStatus: true, manualScore: true, needsManualGrading: true, maxMarks: true } },
        gradingAssignments: { select: { id: true, graderId: true, status: true, isSecondGrader: true, grader: { select: { id: true, displayName: true } } } },
      },
    }),
    prisma.attempt.count({ where: attemptWhere }),
    prisma.gradingAssignment.groupBy({ by: ['status'], where: { examId }, _count: { _all: true } }),
  ]);

  const items = attempts.map((attempt) => {
    const pendingAnswers = attempt.answers ?? [];
    const gradedAnswers = pendingAnswers.filter((row) => row.manualScore != null || row.gradingStatus === 'GRADED');
    return {
      attemptId: attempt.id,
      userId: attempt.userId,
      candidate: attempt.user,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      gradingStatus: attempt.gradingStatus,
      submittedAt: attempt.submittedAt,
      usedTimeSec: attempt.usedTimeSec,
      finalScore: attempt.finalScore == null ? null : Number(attempt.finalScore),
      totalMarks: attempt.totalMarks == null ? null : Number(attempt.totalMarks),
      scorePercent: attempt.scorePercent == null ? null : Number(attempt.scorePercent),
      pendingCount: pendingAnswers.length - gradedAnswers.length,
      manualCount: pendingAnswers.length,
      gradedCount: gradedAnswers.length,
      progressPercent: pendingAnswers.length ? Math.round((gradedAnswers.length / pendingAnswers.length) * 100) : 100,
      graders: (attempt.gradingAssignments ?? []).map((row) => ({ assignmentId: row.id, graderId: row.graderId, name: row.grader?.displayName ?? null, status: row.status, isSecondGrader: row.isSecondGrader })),
      answerIds: pendingAnswers.map((row) => row.id),
    };
  });

  return {
    exam: { id: exam.id, title: exam.title },
    items,
    total,
    page,
    limit,
    assignmentStatusCounts: assignments.reduce((acc, row) => ({ ...acc, [row.status]: row._count._all }), {}),
    summary: await pendingSummary({ attempt: { examId } }),
  };
}

/** Everything assigned to one grader, across exams. */
async function myGradingQueue(graderId, query = {}) {
  const userId = graderId ?? query.userId;
  if (!userId) throw ApiError.unauthorized('Sign in first');

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const where = { graderId: userId };
  if (query.status) where.status = String(query.status).toUpperCase();
  else where.status = { in: PENDING_STATES };
  if (query.examId) where.examId = query.examId;

  const [rows, total] = await Promise.all([
    prisma.gradingAssignment.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: ASSIGNMENT_READ_INCLUDE,
    }),
    prisma.gradingAssignment.count({ where }),
  ]);

  const withCounts = await Promise.all(rows.map(async (row) => {
    const pending = row.attemptId
      ? await prisma.answer.count({ where: { attemptId: row.attemptId, needsManualGrading: true, gradingStatus: { in: PENDING_STATES } } })
      : 0;
    return { ...deserialiseAssignment(row), pendingAnswers: pending };
  }));

  return { items: withCounts, total, page, limit };
}

/** Hand one submission (or a whole exam) to a specific grader. */
async function assignGrader(input = {}, actor = {}) {
  const { examId, attemptId, graderId, questionIds = null, isSecondGrader = false, dueAt = null, notify = true } = input;
  if (!examId || !graderId) throw ApiError.badRequest('examId and graderId are required');
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const grader = await prisma.user.findUnique({ where: { id: graderId }, select: { id: true, displayName: true, email: true } });
  if (!grader) throw ApiError.notFound('Grader not found');

  if (attemptId) {
    const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { id: true, examId: true, userId: true } });
    if (!attempt) throw ApiError.notFound('Attempt not found');
    if (attempt.examId !== examId) throw ApiError.badRequest('That attempt belongs to another exam');
  }

  const created = [];
  const skipped = [];

  if (attemptId) {
    const existing = await prisma.gradingAssignment.findUnique({
      where: { examId_graderId_attemptId: { examId, graderId, attemptId } },
      select: { id: true, status: true, isSecondGrader: true },
    });
    if (existing) {
      const updated = await prisma.gradingAssignment.update({
        where: { id: existing.id },
        data: { dueAt: dueAt ? new Date(dueAt) : undefined, isSecondGrader: Boolean(isSecondGrader), status: existing.status },
        include: ASSIGNMENT_READ_INCLUDE,
      });
      created.push(updated);
    } else {
      const row = await prisma.gradingAssignment.create({
        data: {
          examId,
          attemptId,
          graderId,
          assignedById: actor.userId,
          status: 'UNGRADED',
          isSecondGrader: Boolean(isSecondGrader),
          dueAt: dueAt ? new Date(dueAt) : gradingDueAt(exam),
        },
        include: ASSIGNMENT_READ_INCLUDE,
      });
      created.push(row);
    }
  } else {
    // Exam-wide assignment: one row per submitted attempt that still needs work.
    const attempts = await prisma.attempt.findMany({
      where: { examId, gradingStatus: { in: PENDING_STATES }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
      select: { id: true },
    });
    for (const attempt of attempts) {
      try {
        const row = await prisma.gradingAssignment.upsert({
          where: { examId_graderId_attemptId: { examId, graderId, attemptId: attempt.id } },
          create: {
            examId,
            attemptId: attempt.id,
            graderId,
            assignedById: actor.userId,
            status: 'UNGRADED',
            isSecondGrader: Boolean(isSecondGrader),
            dueAt: dueAt ? new Date(dueAt) : gradingDueAt(exam),
          },
          update: { assignedById: actor.userId, dueAt: dueAt ? new Date(dueAt) : undefined },
          include: ASSIGNMENT_READ_INCLUDE,
        });
        created.push(row);
      } catch (error) {
        skipped.push({ attemptId: attempt.id, error: error.message });
      }
    }
  }

  if (notify && created.length) {
    await notifyUser({
      userId: graderId,
      type: 'EXAM_ASSIGNED',
      title: 'Grading assignment',
      body: `You have been assigned ${created.length} submission(s) for ${exam.title}.`,
      data: { examId, count: created.length, questionIds: questionIds ?? null },
      actionUrl: `/grading/exams/${examId}`,
    }).catch(() => null);
  }

  return { assigned: created.length, skipped, assignments: created.map(deserialiseAssignment), examId, grader };
}

/** Spread an exam's outstanding submissions evenly over several graders. */
async function bulkAssign(examId, { graderIds = [], perGrader = null, dueAt = null, notify = true } = {}, actor = {}) {
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const graders = [...new Set(graderIds.filter(Boolean))];
  if (!graders.length) throw ApiError.badRequest('Provide at least one graderId');
  const users = await prisma.user.findMany({ where: { id: { in: graders } }, select: { id: true, displayName: true } });
  if (users.length !== graders.length) {
    throw ApiError.badRequest('Some grader ids do not exist', { missing: graders.filter((id) => !users.some((user) => user.id === id)) });
  }

  const attempts = await prisma.attempt.findMany({
    where: { examId, gradingStatus: { in: PENDING_STATES }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
    orderBy: { submittedAt: 'asc' },
    select: { id: true },
  });

  const cap = perGrader && Number(perGrader) > 0 ? Number(perGrader) : null;
  const distribution = graders.reduce((acc, id) => ({ ...acc, [id]: [] }), {});
  let cursor = 0;
  for (const attempt of attempts) {
    if (cap && Object.values(distribution).every((list) => list.length >= cap)) break;
    while (cap && distribution[graders[cursor % graders.length]].length >= cap) cursor += 1;
    const graderId = graders[cursor % graders.length];
    distribution[graderId].push(attempt.id);
    cursor += 1;
  }

  const operations = [];
  for (const [graderId, attemptIds] of Object.entries(distribution)) {
    for (const attemptId of attemptIds) {
      operations.push(prisma.gradingAssignment.upsert({
        where: { examId_graderId_attemptId: { examId, graderId, attemptId } },
        create: { examId, graderId, attemptId, assignedById: actor.userId, status: 'UNGRADED', dueAt: dueAt ? new Date(dueAt) : gradingDueAt(exam) },
        update: { assignedById: actor.userId, dueAt: dueAt ? new Date(dueAt) : undefined },
      }));
    }
  }
  const written = operations.length ? await prisma.$transaction(operations) : [];

  if (notify && written.length) {
    await notifyMany({
      userIds: Object.entries(distribution).filter(([, list]) => list.length).map(([graderId]) => graderId),
      type: 'EXAM_ASSIGNED',
      title: 'Grading assignment',
      body: `You have been assigned submissions for ${exam.title}.`,
      data: { examId },
      actionUrl: `/grading/exams/${examId}`,
    }).catch(() => null);
  }

  return {
    examId,
    assigned: written.length,
    distribution: Object.entries(distribution).map(([graderId, attemptIds]) => ({ graderId, count: attemptIds.length })),
  };
}

async function unassignGrader(assignmentId, actor = {}) {
  const assignment = await prisma.gradingAssignment.findUnique({
    where: { id: assignmentId },
    include: { exam: { select: { id: true, organizationId: true, createdById: true } } },
  });
  if (!assignment) throw ApiError.notFound('Assignment not found');
  await assertCanGrade(assignment.examId, actor, { allowAssignment: false });
  assertSameOrganization(assignment.exam, actor);

  if (assignment.status === 'GRADED') throw ApiError.conflict('This submission has already been graded', { status: assignment.status });
  await prisma.gradingAssignment.delete({ where: { id: assignmentId } });
  return { assignmentId, unassigned: true };
}

async function listAssignments(query = {}, actor = {}) {
  const { examId, attemptId, graderId, status } = query;
  if (!examId && !graderId) throw ApiError.badRequest('examId or graderId is required');
  if (examId) await assertCanGrade(examId, actor);

  const where = {};
  if (examId) where.examId = examId;
  if (attemptId) where.attemptId = attemptId;
  if (graderId) where.graderId = graderId;
  if (status) where.status = String(status).toUpperCase();
  if (!actor.organizationId && actor.platformRole !== 'SUPER_ADMIN') where.graderId = actor.userId;

  const rows = await prisma.gradingAssignment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: ASSIGNMENT_READ_INCLUDE,
  });
  return { items: rows.map(deserialiseAssignment), total: rows.length };
}

/** Progress board for the exam dashboard. */
async function gradingStats(examId, actor = {}) {
  const exam = await assertCanGrade(examId, actor);
  const [attempts, assignments, answers, graders] = await Promise.all([
    prisma.attempt.groupBy({ by: ['gradingStatus'], where: { examId }, _count: { _all: true } }),
    prisma.gradingAssignment.groupBy({ by: ['graderId', 'status'], where: { examId }, _count: { _all: true } }),
    prisma.answer.groupBy({
      by: ['gradingStatus'],
      where: { needsManualGrading: true, attempt: { examId } },
      _count: { _all: true },
      _sum: { manualScore: true },
    }),
    prisma.gradingAssignment.findMany({ where: { examId }, select: { graderId: true, grader: { select: { id: true, displayName: true } } }, distinct: ['graderId'] }),
  ]);

  const attemptCounts = attempts.reduce((acc, row) => ({ ...acc, [row.gradingStatus]: row._count._all }), {});
  const totalAttempts = Object.values(attemptCounts).reduce((sum, value) => sum + Number(value), 0);
  const gradedAttempts = (attemptCounts.GRADED ?? 0) + (attemptCounts.RELEASED ?? 0);

  return {
    examId,
    examTitle: exam.title,
    attempts: { total: totalAttempts, ...attemptCounts, progressPercent: totalAttempts ? Math.round((gradedAttempts / totalAttempts) * 100) : 0 },
    answers: answers.reduce((acc, row) => ({ ...acc, [row.gradingStatus]: row._count._all }), {}),
    graders: graders.map((grader) => {
      const rows = assignments.filter((row) => row.graderId === grader.graderId);
      const byStatus = rows.reduce((acc, row) => ({ ...acc, [row.status]: row._count._all }), {});
      return {
        graderId: grader.graderId,
        name: grader.grader?.displayName ?? null,
        assigned: rows.reduce((sum, row) => sum + row._count._all, 0),
        ungraded: byStatus.UNGRADED ?? 0,
        inProgress: byStatus.IN_PROGRESS ?? 0,
        completed: byStatus.GRADED ?? 0,
      };
    }),
    needsManualGrading: await prisma.answer.count({ where: { needsManualGrading: true, gradingStatus: { in: PENDING_STATES }, attempt: { examId } } }),
  };
}

// ---------------------------------------------------------------------------
// The grading interface
// ---------------------------------------------------------------------------

/**
 * Side-by-side payload: the question with its answer key on the left, the
 * candidate's answer plus rubric and previous grades on the right.
 */
async function submissionForGrading(answerId, actor = {}) {
  const answer = await prisma.answer.findUnique({ where: { id: answerId }, include: ANSWER_READ_INCLUDE });
  if (!answer) throw ApiError.notFound('Answer not found');
  const exam = await assertCanGrade(answer.attempt.examId, actor);

  const [assignment, siblings, otherGraders, overrides] = await Promise.all([
    prisma.gradingAssignment.findFirst({
      where: { examId: exam.id, attemptId: answer.attemptId, graderId: actor.userId },
      select: { id: true, status: true, isSecondGrader: true, dueAt: true },
    }),
    prisma.answer.findMany({
      where: { attemptId: answer.attemptId },
      orderBy: { order: 'asc' },
      select: {
        id: true, questionId: true, order: true, gradingStatus: true, needsManualGrading: true,
        manualScore: true, finalScore: true, maxMarks: true, isCorrect: true,
        question: { select: { id: true, type: true, prompt: true, marks: true } },
      },
    }),
    prisma.answer.findMany({
      where: { id: answerId },
      select: { manualScore: true, secondScore: true, disagreement: true, graderNote: true, secondGraderNote: true, gradedBy: { select: { id: true, displayName: true } } },
    }),
    prisma.gradeOverride.findMany({
      where: { answerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, previousScore: true, newScore: true, reason: true, createdAt: true, overriddenBy: { select: { id: true, displayName: true } } },
    }),
  ]);

  const rubric = await rubricForQuestion(exam.id, answer.questionId);
  const maxMarks = Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0);

  return {
    answer: deserialiseAnswer(answer),
    question: answer.question ? { ...answer.question, content: answer.question.content ?? {} } : null,
    attempt: {
      id: answer.attemptId,
      candidate: answer.attempt.user,
      attemptNumber: answer.attempt.attemptNumber,
      status: answer.attempt.status,
      submittedAt: answer.attempt.submittedAt,
      usedTimeSec: answer.attempt.usedTimeSec,
      runningScore: { finalScore: Number(answer.attempt.finalScore ?? 0), totalMarks: Number(answer.attempt.totalMarks ?? 0) },
    },
    exam: { id: exam.id, title: exam.title, settings: exam.settings },
    maxMarks,
    assignment,
    rubric,
    existingRubricScores: answer.rubricScores ?? [],
    otherGrades: otherGraders.map((row) => ({
      manualScore: row.manualScore == null ? null : Number(row.manualScore),
      secondScore: row.secondScore == null ? null : Number(row.secondScore),
      disagreement: row.disagreement,
      graderNote: row.graderNote,
      secondGraderNote: row.secondGraderNote,
      grader: row.gradedBy?.displayName ?? null,
    }))[0] ?? null,
    overrides: overrides.map((row) => ({ ...row, previousScore: Number(row.previousScore), newScore: Number(row.newScore) })),
    queue: siblings.map((row) => ({
      answerId: row.id,
      questionId: row.questionId,
      order: row.order,
      prompt: row.question?.prompt ?? null,
      type: row.question?.type ?? null,
      maxMarks: row.maxMarks == null ? null : Number(row.maxMarks),
      gradingStatus: row.gradingStatus,
      needsManualGrading: row.needsManualGrading,
      graded: row.manualScore != null || row.gradingStatus === 'GRADED',
      isCurrent: row.id === answerId,
    })),
    files: answer.files ?? [],
  };
}

/** The rubric that governs one question: explicit, else a default from `rubricCriteria`. */
async function rubricForQuestion(examId, questionId) {
  const stored = await prisma.gradingRubric.findFirst({
    where: { examId, OR: [{ questionId }, { questionId: null }] },
    orderBy: [{ questionId: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, description: true, criteria: true, totalMarks: true, requireSecondGrader: true, questionId: true },
  });
  if (stored) return { ...stored, totalMarks: Number(stored.totalMarks), source: 'RUBRIC' };

  const question = await prisma.question.findUnique({ where: { id: questionId }, select: { rubricCriteria: true, marks: true } });
  const criteria = Array.isArray(question?.rubricCriteria) ? question.rubricCriteria : [];
  if (!criteria.length) return null;

  return {
    id: null,
    name: 'Question rubric',
    description: null,
    criteria: criteria.map((criterion, index) => ({
      id: criterion.id ?? `criterion-${index + 1}`,
      name: criterion.name ?? criterion.label ?? `Criterion ${index + 1}`,
      maxMarks: Number(criterion.marks ?? criterion.maxMarks ?? 0),
      description: criterion.description ?? null,
    })),
    totalMarks: criteria.reduce((sum, criterion) => sum + Number(criterion.marks ?? criterion.maxMarks ?? 0), 0),
    requireSecondGrader: false,
    questionId,
    source: 'QUESTION',
  };
}

/** Full submission view for a whole attempt (essay-heavy exams, review mode). */
async function attemptSubmissions(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      exam: { select: { id: true, title: true, organizationId: true, createdById: true, settings: true } },
      user: { select: { id: true, displayName: true, email: true } },
      answers: {
        orderBy: { order: 'asc' },
        include: {
          question: { select: { id: true, type: true, prompt: true, marks: true } },
          examQuestion: { select: { marks: true, order: true, sectionId: true } },
          files: { select: { id: true, url: true, kind: true, mimeType: true, originalName: true } },
          rubricScores: true,
        },
      },
    },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  await assertCanGrade(attempt.examId, actor);

  return {
    attemptId,
    exam: attempt.exam,
    candidate: attempt.user,
    submittedAt: attempt.submittedAt,
    status: attempt.status,
    gradingStatus: attempt.gradingStatus,
    answers: attempt.answers.map((answer) => ({
      answerId: answer.id,
      questionId: answer.questionId,
      order: answer.order,
      type: answer.question?.type ?? null,
      prompt: answer.question?.prompt ?? null,
      maxMarks: Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0),
      needsManualGrading: answer.needsManualGrading,
      gradingStatus: answer.gradingStatus,
      autoScore: answer.autoScore == null ? null : Number(answer.autoScore),
      manualScore: answer.manualScore == null ? null : Number(answer.manualScore),
      finalScore: answer.finalScore == null ? null : Number(answer.finalScore),
      secondScore: answer.secondScore == null ? null : Number(answer.secondScore),
      disagreement: answer.disagreement,
      feedback: answer.feedback,
      graderNote: answer.graderNote,
      wordCount: answer.wordCount,
      timeSpentSec: answer.timeSpentSec,
      response: answer.response,
      textAnswer: answer.textAnswer,
      codeSource: answer.codeSource,
      codeLanguage: answer.codeLanguage,
      mathLatex: answer.mathLatex,
      testRunResults: answer.testRunResults,
      files: answer.files,
      rubricScores: answer.rubricScores,
    })),
  };
}

// ---------------------------------------------------------------------------
// Entering grades
// ---------------------------------------------------------------------------

/**
 * Grade one answer by hand.
 *
 * The written value depends on who is writing it: the first grader owns
 * `manualScore`, a second grader writes `secondScore` and the effective
 * `finalScore` follows the exam's `secondGraderMode` (average, or hold for
 * arbitration when the two disagree). `scoring.autoGradeAttempt()` then re-aggregates
 * the attempt, and because it always prefers a human score nothing is lost.
 */
async function gradeSubmission(input = {}, actor = {}) {
  const {
    answerId, marks = null, percentage = null, isCorrect = null, feedback = null, graderNote = null,
    rubricId = null, rubricScores = null, needsReview = false, secondGrade = false, recompute = true,
  } = input;
  if (!answerId) throw ApiError.badRequest('answerId is required');

  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    include: {
      attempt: {
        select: {
          id: true, examId: true, userId: true, organizationId: true, status: true, gradingStatus: true,
          exam: { select: { id: true, organizationId: true, createdById: true, title: true, settings: true } },
        },
      },
      question: { select: { id: true, type: true, marks: true, rubricCriteria: true } },
      examQuestion: { select: { marks: true } },
    },
  });
  if (!answer) throw ApiError.notFound('Answer not found');
  const exam = await assertCanGrade(answer.attempt.examId, actor);

  const maxMarks = Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0);
  const awarded = resolveAwardedMarks({ marks, percentage, rubricScores, maxMarks });

  const assignment = await prisma.gradingAssignment.findFirst({
    where: { examId: answer.attempt.examId, attemptId: answer.attemptId, graderId: actor.userId },
    select: { id: true, isSecondGrader: true, status: true },
  });
  const alreadyGradedByOther = answer.manualScore != null && answer.gradedById && answer.gradedById !== actor.userId;
  const asSecond = Boolean(secondGrade || assignment?.isSecondGrader || (alreadyGradedByOther && answer.manualScore != null));

  const data = {
    gradingStatus: 'GRADED',
    needsManualGrading: Boolean(needsReview),
    gradedById: actor.userId,
    gradedAt: new Date(),
    feedback: feedback == null ? answer.feedback : String(feedback).slice(0, 20_000),
    graderNote: graderNote == null ? answer.graderNote : String(graderNote).slice(0, 20_000),
    isCorrect: isCorrect == null ? awarded >= maxMarks && maxMarks > 0 : Boolean(isCorrect),
    isPartial: awarded > 0 && awarded < maxMarks,
  };

  if (asSecond) {
    data.secondScore = round2(awarded);
    data.secondGradedById = actor.userId;
    data.secondGraderNote = graderNote == null ? answer.secondGraderNote : String(graderNote).slice(0, 20_000);
  } else {
    data.manualScore = round2(awarded);
    data.finalScore = round2(awarded);
  }

  const updated = await prisma.answer.update({ where: { id: answerId }, data, include: { attempt: { select: { id: true, metadata: true } } } });

  // Disagreement handling between the two graders.
  if (asSecond && answer.manualScore != null) {
    const first = Number(answer.manualScore);
    const mode = exam.settings?.secondGraderMode ?? 'FLAG_DISAGREEMENT';
    const difference = Math.abs(first - awarded);
    const tolerance = Number(exam.settings?.secondGraderToleranceMarks ?? Math.max(0.5, maxMarks * 0.1));
    const disagreement = difference > tolerance;

    const followUp = { disagreement };
    if (mode === 'AVERAGE' && !disagreement) followUp.finalScore = round2((first + awarded) / 2);
    else if (mode === 'STRICTEST') followUp.finalScore = round2(Math.min(first, awarded));
    else followUp.finalScore = round2(first);
    if (disagreement && mode === 'FLAG_DISAGREEMENT') followUp.needsManualGrading = true;
    await prisma.answer.update({ where: { id: answerId }, data: followUp });
  }

  if (Array.isArray(rubricScores) && rubricScores.length) {
    await storeRubricScores(answerId, { rubricId, scores: rubricScores }, actor);
  }

  if (recompute) {
    await recomputeAttempt(answer.attemptId, actor);
  }

  logger.info('answer graded', { answerId, attemptId: answer.attemptId, awarded, asSecond, graderId: actor.userId });
  return {
    answerId,
    attemptId: answer.attemptId,
    awarded: round2(awarded),
    maxMarks,
    gradedAs: asSecond ? 'SECOND_GRADER' : 'FIRST_GRADER',
    answer: deserialiseAnswer(updated),
  };
}

function resolveAwardedMarks({ marks, percentage, rubricScores, maxMarks }) {
  if (marks !== null && marks !== undefined && Number.isFinite(Number(marks))) {
    return Math.max(0, Math.min(maxMarks || Number(marks), Number(marks)));
  }
  if (percentage !== null && percentage !== undefined && Number.isFinite(Number(percentage))) {
    return Math.max(0, Math.min(maxMarks, (Number(percentage) / 100) * maxMarks));
  }
  if (Array.isArray(rubricScores) && rubricScores.length) {
    const sum = rubricScores.reduce((total, row) => total + Number(row.marksAwarded ?? 0), 0);
    return Math.max(0, Math.min(maxMarks, sum));
  }
  throw ApiError.badRequest('Provide marks, percentage or rubricScores');
}

function round2(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** Keyboard-driven bulk grading: one request, many answers, one recompute. */
async function gradeMany({ items = [], recompute = true } = {}, actor = {}) {
  if (!Array.isArray(items) || !items.length) throw ApiError.badRequest('items[] is required');
  if (items.length > 200) throw ApiError.badRequest('Grade at most 200 answers per request');

  const graded = [];
  const failed = [];
  const attempts = new Set();

  for (const item of items) {
    try {
      const result = await gradeSubmission({ ...item, recompute: false }, actor);
      graded.push(result);
      attempts.add(result.attemptId);
    } catch (error) {
      failed.push({ answerId: item.answerId ?? null, error: error.message });
    }
  }

  if (recompute) {
    for (const attemptId of attempts) {
      await recomputeAttempt(attemptId, actor).catch((error) => logger.warn('recompute failed', { attemptId, error: error.message }));
    }
  }

  return { graded: graded.length, failed, attemptIds: [...attempts] };
}

/** Persist the per-criterion marks and hand the total back. */
async function storeRubricScores(answerId, { rubricId = null, scores = [] }, actor = {}) {
  if (!Array.isArray(scores) || !scores.length) throw ApiError.badRequest('scores[] is required');

  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    select: { id: true, attemptId: true, maxMarks: true, question: { select: { marks: true } }, examQuestion: { select: { marks: true } } },
  });
  if (!answer) throw ApiError.notFound('Answer not found');

  const maxMarks = Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0);
  const rows = scores.map((row) => ({
    criterionId: String(row.criterionId ?? row.id ?? ''),
    criterionName: row.criterionName ?? row.name ?? null,
    marksAwarded: round2(row.marksAwarded ?? row.marks ?? 0),
    maxMarks: round2(row.maxMarks ?? 0),
    comment: row.comment == null ? null : String(row.comment).slice(0, 4000),
    graderId: actor.userId ?? null,
  }));
  if (rows.some((row) => !row.criterionId)) throw ApiError.badRequest('Every rubric score needs a criterionId');

  const total = rows.reduce((sum, row) => sum + row.marksAwarded, 0);
  if (maxMarks > 0 && total > maxMarks + 0.001) {
    throw ApiError.validation(`Rubric marks (${total}) exceed the question's ${maxMarks} mark(s)`, { total, maxMarks });
  }

  const operations = [
    prisma.rubricScore.deleteMany({ where: { answerId, graderId: actor.userId ?? null } }),
    ...rows.map((row) => prisma.rubricScore.create({ data: { answerId, rubricId, ...row } })),
  ];
  const written = await prisma.$transaction(operations);

  return { answerId, stored: rows.length, total: round2(total), created: written };
}

async function saveRubricScores(answerId, input = {}, actor = {}) {
  const stored = await storeRubricScores(answerId, input, actor);
  const total = input.applyToScore === false ? null : stored.total;
  if (total !== null) {
    await gradeSubmission({ answerId, marks: total, rubricId: input.rubricId ?? null, recompute: true }, actor);
  }
  return { answerId, totalAwarded: stored.total, applied: total !== null };
}

/** Recompute totals, percentiles and the assignment state after a grade lands. */
async function recomputeAttempt(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, metadata: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const result = await scoring.autoGradeAttempt(attemptId, { commit: true, gradedBy: actor.userId ?? 'grader' });
  await scoring.recalculatePercentiles(attempt.examId).catch((error) => logger.warn('percentile refresh failed', { examId: attempt.examId, error: error.message }));

  const stillPending = await prisma.answer.count({ where: { attemptId, needsManualGrading: true, gradingStatus: { in: PENDING_STATES } } });
  await prisma.gradingAssignment.updateMany({
    where: { attemptId, graderId: actor.userId ?? undefined },
    data: stillPending ? { status: 'IN_PROGRESS' } : { status: 'GRADED', completedAt: new Date() },
  });

  broadcastToExam(attempt.examId, 'grading:attempt-updated', {
    attemptId,
    gradingStatus: result.gradingStatus,
    pendingManual: result.pendingManual,
    finalScore: Number(result.summary.finalScore ?? 0),
  });

  if (!stillPending) await markAttemptGraded(attemptId);
  return result;
}

/**
 * Once nothing is outstanding, stamp the attempt as fully graded so the result
 * visibility rules in `attempt.service` can take over.
 */
async function markAttemptGraded(attemptId) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, userId: true, gradingStatus: true, gradedAt: true, exam: { select: { resultVisibility: true, gradesReleasedAt: true, settings: true, title: true } } },
  });
  if (!attempt || ['GRADED', 'RELEASED', 'NOT_REQUIRED'].includes(attempt.gradingStatus)) return { graded: false };

  const now = new Date();
  const autoRelease = attempt.exam.resultVisibility === 'IMMEDIATELY' && !attempt.exam.gradesReleasedAt;
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { gradingStatus: autoRelease ? 'RELEASED' : 'GRADED', gradedAt: attempt.gradedAt ?? now, releasedAt: autoRelease ? now : attempt.releasedAt },
  });

  if (autoRelease) await issueCertificateQuietly(attemptId);

  await notifyUser({
    userId: attempt.userId,
    type: 'GRADING_COMPLETED',
    title: `Your ${attempt.exam.title} submission has been graded`,
    body: autoRelease ? 'Your result is now available.' : 'Your result will be published by your instructor.',
    actionUrl: `/results/${attemptId}`,
  }).catch(() => null);

  broadcastToExam(attempt.examId, 'grading:completed', { attemptId, released: autoRelease });
  return { graded: true, released: autoRelease };
}

/** Certificates are owned by `certificate.service`; grading must never break on them. */
async function issueCertificateQuietly(attemptId) {
  try {
    const certificateService = require('./certificate.service');
    return await certificateService.issueForAttempt({ attemptId });
  } catch (error) {
    logger.warn('certificate issuance skipped', { attemptId, error: error.message });
    return null;
  }
}

/** Instructor presses "finish grading" on one submission. */
async function finaliseGrading(attemptId, { notify = true } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, userId: true, gradingStatus: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  await assertCanGrade(attempt.examId, actor);

  const remaining = await prisma.answer.count({ where: { attemptId, needsManualGrading: true, gradingStatus: { in: PENDING_STATES } } });
  if (remaining) {
    throw ApiError.unprocessable('Some answers still need a manual grade', { remaining, answers: await listPendingAnswerIds(attemptId) });
  }

  const result = await recomputeAttempt(attemptId, actor);
  const marked = await markAttemptGraded(attemptId);

  if (notify) {
    await prisma.gradingAssignment.updateMany({ where: { attemptId }, data: { status: 'GRADED', completedAt: new Date() } });
  }

  return { attemptId, gradingStatus: result.gradingStatus, summary: result.summary, released: marked.released ?? false };
}

async function listPendingAnswerIds(attemptId) {
  const rows = await prisma.answer.findMany({
    where: { attemptId, needsManualGrading: true, gradingStatus: { in: PENDING_STATES } },
    select: { id: true, order: true },
    orderBy: { order: 'asc' },
  });
  return rows.map((row) => row.id);
}

/** Re-run the engine over a whole exam, e.g. after fixing an answer key. */
async function regradeExam(examId, { onlySubmitted = true, limit = 500 } = {}, actor = {}) {
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const where = { examId };
  if (onlySubmitted) where.status = { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] };
  const attempts = await prisma.attempt.findMany({ where, select: { id: true }, take: Math.min(Number(limit) || 500, 2000) });

  const done = [];
  const failed = [];
  for (const attempt of attempts) {
    try {
      const result = await scoring.autoGradeAttempt(attempt.id, { commit: true, gradedBy: actor.userId });
      done.push({ attemptId: attempt.id, scorePercent: Number(result.summary.scorePercent ?? 0), pendingManual: result.pendingManual });
    } catch (error) {
      failed.push({ attemptId: attempt.id, error: error.message });
    }
  }

  await scoring.recalculatePercentiles(examId).catch(() => null);
  await scoring.refreshExamAggregate(examId).catch(() => null);

  return { examId, regraded: done.length, failed, attempts: done };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Change a score after the fact. With an `answerId` the single question moves;
 * without one the whole attempt total is replaced (and `scoring.service` keeps
 * honouring that override on every later recompute).
 */
async function overrideGrade(input = {}, actor = {}) {
  const { attemptId, answerId = null, newScore, reason } = input;
  if (!attemptId || newScore === null || newScore === undefined) throw ApiError.badRequest('attemptId and newScore are required');
  if (!reason || !String(reason).trim()) throw ApiError.badRequest('An override requires a reason');

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, userId: true, finalScore: true, totalMarks: true, rawScore: true, organizationId: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  const exam = await assertCanGrade(attempt.examId, actor, { allowAssignment: false });

  const score = Number(newScore);
  if (!Number.isFinite(score) || score < 0) throw ApiError.badRequest('newScore must be a non-negative number');

  let previousScore = Number(attempt.finalScore ?? 0);
  let ceiling = Number(attempt.totalMarks ?? 0);

  if (answerId) {
    const answer = await prisma.answer.findUnique({
      where: { id: answerId },
      select: { id: true, attemptId: true, finalScore: true, manualScore: true, autoScore: true, maxMarks: true },
    });
    if (!answer) throw ApiError.notFound('Answer not found');
    if (answer.attemptId !== attemptId) throw ApiError.badRequest('That answer belongs to another attempt');
    previousScore = Number(answer.finalScore ?? answer.manualScore ?? answer.autoScore ?? 0);
    ceiling = Number(answer.maxMarks ?? ceiling);
    if (ceiling > 0 && score > ceiling) throw ApiError.badRequest(`Score cannot exceed ${ceiling} mark(s) for this question`);

    await prisma.answer.update({
      where: { id: answerId },
      data: { manualScore: round2(score), finalScore: round2(score), gradingStatus: 'GRADED', needsManualGrading: false, gradedById: actor.userId, gradedAt: new Date() },
    });
  } else if (score > ceiling) {
    throw ApiError.badRequest(`Score cannot exceed the attempt total of ${ceiling} mark(s)`);
  }

  const override = await prisma.gradeOverride.create({
    data: {
      attemptId,
      answerId: answerId ?? null,
      previousScore: round2(previousScore),
      newScore: round2(score),
      reason: String(reason).slice(0, 4000),
      overrideById: actor.userId,
    },
    include: { overriddenBy: { select: { id: true, displayName: true } } },
  });

  await recomputeAttempt(attemptId, actor).catch((error) => logger.warn('recompute after override failed', { attemptId, error: error.message }));
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { metadata: { ...(attempt.metadata ?? {}), lastOverride: { at: new Date().toISOString(), by: actor.userId, reason: String(reason).slice(0, 500) } } },
  }).catch(() => null);

  await notifyUser({
    userId: attempt.userId,
    type: 'GRADING_COMPLETED',
    title: 'Your score was updated',
    body: `An instructor adjusted the marks for ${exam.title}.`,
    actionUrl: `/results/${attemptId}`,
  }).catch(() => null);

  broadcastToExam(exam.id, 'grading:override', { attemptId, answerId, newScore: round2(score), by: actor.userId });
  return { overrideId: override.id, attemptId, answerId, previousScore: round2(previousScore), newScore: round2(score), reason: override.reason };
}

async function listOverrides(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { id: true, examId: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  await assertCanGrade(attempt.examId, actor);

  const rows = await prisma.gradeOverride.findMany({
    where: { attemptId },
    orderBy: { createdAt: 'desc' },
    include: {
      overriddenBy: { select: { id: true, displayName: true, email: true } },
      answer: { select: { id: true, questionId: true, question: { select: { prompt: true, type: true } } } },
    },
  });

  return {
    attemptId,
    items: rows.map((row) => ({
      id: row.id,
      answerId: row.answerId,
      question: row.answer?.question?.prompt ?? null,
      previousScore: Number(row.previousScore),
      newScore: Number(row.newScore),
      reason: row.reason,
      overriddenBy: row.overriddenBy,
      createdAt: row.createdAt,
    })),
  };
}

/** Who graded what, when - the audit trail behind a disputed result. */
async function gradingHistory(attemptId, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, gradedAt: true, gradingStatus: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  await assertCanGrade(attempt.examId, actor);

  const [answers, assignments, overrides, feedback] = await Promise.all([
    prisma.answer.findMany({
      where: { attemptId, OR: [{ gradedById: { not: null } }, { secondGradedById: { not: null } }] },
      orderBy: { order: 'asc' },
      select: {
        id: true, order: true, questionId: true, manualScore: true, secondScore: true, finalScore: true,
        disagreement: true, gradedAt: true, secondGradedById: true,
        gradedBy: { select: { id: true, displayName: true } },
        question: { select: { id: true, prompt: true, type: true } },
      },
    }),
    prisma.gradingAssignment.findMany({
      where: { attemptId },
      select: { id: true, status: true, isSecondGrader: true, completedAt: true, createdAt: true, grader: { select: { id: true, displayName: true } } },
    }),
    prisma.gradeOverride.findMany({ where: { attemptId }, orderBy: { createdAt: 'desc' }, select: { id: true, answerId: true, previousScore: true, newScore: true, reason: true, createdAt: true, overriddenBy: { select: { displayName: true } } } }),
    prisma.attemptFeedback.findMany({ where: { attemptId }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, content: true, createdAt: true, createdBy: { select: { id: true, displayName: true } } } }),
  ]);

  // `secondGradedById` is a plain column (no relation), so names are joined here.
  const secondGraderIds = [...new Set(answers.map((row) => row.secondGradedById).filter(Boolean))];
  const secondGraders = secondGraderIds.length
    ? await prisma.user.findMany({ where: { id: { in: secondGraderIds } }, select: { id: true, displayName: true } })
    : [];
  const secondGraderNames = new Map(secondGraders.map((user) => [user.id, user.displayName]));

  return {
    attemptId,
    gradedAt: attempt.gradedAt,
    gradingStatus: attempt.gradingStatus,
    answers: answers.map((row) => ({
      ...row,
      manualScore: row.manualScore == null ? null : Number(row.manualScore),
      secondScore: row.secondScore == null ? null : Number(row.secondScore),
      finalScore: row.finalScore == null ? null : Number(row.finalScore),
      secondGraderName: row.secondGradedById ? secondGraderNames.get(row.secondGradedById) ?? null : null,
    })),
    assignments,
    overrides: overrides.map((row) => ({ ...row, previousScore: Number(row.previousScore), newScore: Number(row.newScore) })),
    feedback,
  };
}

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

const RUBRIC_SELECT = {
  id: true,
  examId: true,
  questionId: true,
  name: true,
  description: true,
  criteria: true,
  totalMarks: true,
  requireSecondGrader: true,
  createdAt: true,
  updatedAt: true,
};

function normaliseCriteria(criteria, totalMarks) {
  const rows = Array.isArray(criteria) ? criteria : [];
  if (!rows.length) throw ApiError.badRequest('A rubric needs at least one criterion');

  let seen = new Set();
  const normalised = rows.map((criterion, index) => {
    const id = String(criterion.id ?? criterion.key ?? `criterion-${index + 1}`);
    if (seen.has(id)) throw ApiError.badRequest(`Duplicate criterion id "${id}"`);
    seen.add(id);
    return {
      id,
      name: String(criterion.name ?? criterion.label ?? `Criterion ${index + 1}`).slice(0, 200),
      description: criterion.description == null ? null : String(criterion.description).slice(0, 2000),
      maxMarks: round2(criterion.maxMarks ?? criterion.marks ?? 0),
      levels: Array.isArray(criterion.levels) ? criterion.levels.slice(0, 10) : null,
    };
  });

  const sum = normalised.reduce((total, criterion) => total + criterion.maxMarks, 0);
  if (totalMarks != null && Number(totalMarks) > 0 && Math.abs(sum - Number(totalMarks)) > 0.001) {
    throw ApiError.validation(`Criterion marks add up to ${sum}, not ${Number(totalMarks)}`, { sum, totalMarks: Number(totalMarks) });
  }
  return { criteria: normalised, totalMarks: round2(totalMarks ?? sum) };
}

async function createRubric(input = {}, actor = {}) {
  const { examId, questionId = null, name, description = null, criteria = [], totalMarks = null, requireSecondGrader = false } = input;
  if (!examId || !name) throw ApiError.badRequest('examId and name are required');

  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  if (questionId) {
    const linked = await prisma.examQuestion.findFirst({ where: { examId, questionId }, select: { id: true } });
    if (!linked) throw ApiError.badRequest('That question is not part of this exam');
  }

  const normalised = normaliseCriteria(criteria, totalMarks);
  const rubric = await prisma.gradingRubric.create({
    data: {
      examId,
      questionId,
      name: String(name).slice(0, 200),
      description: description == null ? null : String(description).slice(0, 4000),
      criteria: normalised.criteria,
      totalMarks: normalised.totalMarks,
      requireSecondGrader: Boolean(requireSecondGrader),
      createdById: actor.userId,
    },
    select: RUBRIC_SELECT,
  });

  return { rubric: { ...rubric, totalMarks: Number(rubric.totalMarks) } };
}

async function updateRubric(rubricId, input = {}, actor = {}) {
  const rubric = await prisma.gradingRubric.findUnique({ where: { id: rubricId }, select: { id: true, examId: true, totalMarks: true, criteria: true } });
  if (!rubric) throw ApiError.notFound('Rubric not found');
  const exam = await assertCanGrade(rubric.examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const data = {};
  if (input.name !== undefined) data.name = String(input.name).slice(0, 200);
  if (input.description !== undefined) data.description = input.description == null ? null : String(input.description).slice(0, 4000);
  if (input.requireSecondGrader !== undefined) data.requireSecondGrader = Boolean(input.requireSecondGrader);
  if (Array.isArray(input.criteria)) {
    const normalised = normaliseCriteria(input.criteria, input.totalMarks ?? rubric.totalMarks);
    data.criteria = normalised.criteria;
    data.totalMarks = normalised.totalMarks;
  } else if (input.totalMarks !== undefined) {
    data.totalMarks = round2(input.totalMarks);
  }
  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');

  const updated = await prisma.gradingRubric.update({ where: { id: rubricId }, data, select: RUBRIC_SELECT });
  return { rubric: { ...updated, totalMarks: Number(updated.totalMarks) } };
}

async function listRubrics(examId, actor = {}) {
  await assertCanGrade(examId, actor);
  const rows = await prisma.gradingRubric.findMany({ where: { examId }, orderBy: { createdAt: 'asc' }, select: RUBRIC_SELECT });
  return {
    examId,
    items: rows.map((row) => ({ ...row, totalMarks: Number(row.totalMarks), criteria: Array.isArray(row.criteria) ? row.criteria : [] })),
    total: rows.length,
  };
}

async function deleteRubric(rubricId, actor = {}) {
  const rubric = await prisma.gradingRubric.findUnique({ where: { id: rubricId }, select: { id: true, examId: true, _count: { select: { rubricScores: true } } } });
  if (!rubric) throw ApiError.notFound('Rubric not found');
  const exam = await assertCanGrade(rubric.examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);
  if (rubric._count.rubricScores > 0) throw ApiError.conflict('This rubric already has scores recorded', { scores: rubric._count.rubricScores });

  await prisma.gradingRubric.delete({ where: { id: rubricId } });
  return { rubricId, deleted: true };
}

// ---------------------------------------------------------------------------
// Feedback to the candidate
// ---------------------------------------------------------------------------

const FEEDBACK_KINDS = ['AI_PERSONALIZED', 'AI_RETAKE_COACH', 'INSTRUCTOR_NOTE', 'AI_EXAM_SUMMARY'];

/**
 * Written feedback on the attempt as a whole. The newest row of a kind is what
 * the result page shows, so re-generating an AI note simply adds another entry.
 */
async function addFeedback(attemptId, { content, kind = 'INSTRUCTOR_NOTE', meta = {}, notify = true } = {}, actor = {}) {
  if (!content || !String(content).trim()) throw ApiError.badRequest('content is required');
  const normalisedKind = FEEDBACK_KINDS.includes(String(kind).toUpperCase()) ? String(kind).toUpperCase() : 'INSTRUCTOR_NOTE';

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, userId: true, exam: { select: { title: true, organizationId: true, createdById: true } } },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  let authorId = actor.userId;
  if (normalisedKind.startsWith('AI_')) {
    await assertCanGrade(attempt.examId, actor, { allowAssignment: false });
  } else {
    await assertCanGrade(attempt.examId, actor);
  }
  if (!authorId) authorId = attempt.exam.createdById;

  const feedback = await prisma.attemptFeedback.create({
    data: { attemptId, kind: normalisedKind, content: String(content).slice(0, 20_000), meta: sanitiseMeta(meta), createdById: authorId },
    select: { id: true, kind: true, content: true, meta: true, createdAt: true, createdBy: { select: { id: true, displayName: true } } },
  });

  if (notify) {
    await notifyUser({
      userId: attempt.userId,
      type: 'GRADING_COMPLETED',
      title: `New feedback on ${attempt.exam.title}`,
      body: String(content).slice(0, 300),
      actionUrl: `/results/${attemptId}`,
    }).catch(() => null);
  }

  return { attemptId, feedback };
}

function sanitiseMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const json = JSON.stringify(meta);
  return json.length > 20_000 ? { truncated: true } : meta;
}

async function listFeedback(attemptId, { kind = null } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { id: true, examId: true, userId: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (attempt.userId !== actor.userId) await assertCanGrade(attempt.examId, actor);

  const where = { attemptId };
  if (kind) where.kind = String(kind).toUpperCase();

  const rows = await prisma.attemptFeedback.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, content: true, meta: true, createdAt: true, createdBy: { select: { id: true, displayName: true, imageUrl: true } } },
  });
  return { attemptId, items: rows, total: rows.length };
}

async function deleteFeedback(feedbackId, actor = {}) {
  const feedback = await prisma.attemptFeedback.findUnique({ where: { id: feedbackId }, select: { id: true, attempt: { select: { id: true, examId: true } } } });
  if (!feedback) throw ApiError.notFound('Feedback not found');
  await assertCanGrade(feedback.attempt.examId, actor, { allowAssignment: false });
  await prisma.attemptFeedback.delete({ where: { id: feedbackId } });
  return { feedbackId, deleted: true };
}

// ---------------------------------------------------------------------------
// AI assistance (suggestions only - a human always confirms)
// ---------------------------------------------------------------------------

/** AI essay score: written to `aiScore`/`aiFeedback`, never into `finalScore`. */
async function aiGradeEssay(answerId, actor = {}) {
  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    include: {
      attempt: { select: { id: true, examId: true } },
      question: { select: { id: true, type: true, prompt: true, content: true, marks: true, rubricCriteria: true } },
      examQuestion: { select: { marks: true } },
    },
  });
  if (!answer) throw ApiError.notFound('Answer not found');
  const exam = await assertCanGrade(answer.attempt.examId, actor);

  const maxMarks = Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0);
  const rubric = await rubricForQuestion(exam.id, answer.questionId);

  let suggestion;
  try {
    const ai = require('./ai.service');
    suggestion = await ai.gradeEssay({
      question: answer.question,
      response: answer.response ?? {},
      textAnswer: answer.textAnswer,
      rubric,
      maxMarks,
      wordCount: answer.wordCount,
    });
  } catch (error) {
    logger.warn('ai essay grading unavailable', { answerId, error: error.message });
    throw ApiError.internal('AI essay grading is not available right now', { reason: error.message });
  }

  const score = clampMarks(suggestion?.score ?? suggestion?.marks ?? 0, maxMarks);
  const feedback = String(suggestion?.feedback ?? suggestion?.comment ?? '').slice(0, 20_000);

  await prisma.answer.update({
    where: { id: answerId },
    data: {
      aiScore: round2(score),
      aiFeedback: feedback || null,
      aiRubricScores: sanitiseMeta(suggestion?.criteria ?? suggestion?.rubricScores ?? {}),
    },
  });

  return {
    answerId,
    suggestedScore: round2(score),
    maxMarks,
    feedback,
    criteria: suggestion?.criteria ?? suggestion?.rubricScores ?? [],
    applied: false,
    model: suggestion?.model ?? null,
  };
}

/** AI code review for a programming answer. */
async function aiCodeReview(answerId, actor = {}) {
  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    include: {
      attempt: { select: { id: true, examId: true } },
      question: { select: { id: true, type: true, prompt: true, content: true, marks: true, codeConfig: true } },
      examQuestion: { select: { marks: true } },
    },
  });
  if (!answer) throw ApiError.notFound('Answer not found');
  await assertCanGrade(answer.attempt.examId, actor);

  const maxMarks = Number(answer.maxMarks ?? answer.examQuestion?.marks ?? answer.question?.marks ?? 0);
  let review;
  try {
    const ai = require('./ai.service');
    review = await ai.reviewCode({
      question: answer.question,
      code: answer.codeSource ?? answer.response?.code ?? '',
      language: answer.codeLanguage ?? answer.response?.language ?? answer.question?.codeConfig?.language ?? 'javascript',
      runResults: answer.testRunResults ?? answer.response?.runResults ?? null,
      maxMarks,
    });
  } catch (error) {
    logger.warn('ai code review unavailable', { answerId, error: error.message });
    throw ApiError.internal('AI code review is not available right now', { reason: error.message });
  }

  const score = clampMarks(review?.score ?? review?.marks ?? 0, maxMarks);
  await prisma.answer.update({
    where: { id: answerId },
    data: { aiScore: round2(score), aiFeedback: String(review?.feedback ?? review?.summary ?? '').slice(0, 20_000) || null, aiRubricScores: sanitiseMeta(review?.criteria ?? {}) },
  });

  return { answerId, suggestedScore: round2(score), maxMarks, review, applied: false };
}

function clampMarks(value, maxMarks) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(maxMarks || number, number);
}

/**
 * Personalised coach note for a finished attempt, generated on demand from the
 * score breakdown and stored as `AI_PERSONALIZED` feedback.
 */
async function generatePersonalisedFeedback(attemptId, { kind = 'AI_PERSONALIZED', notify = true } = {}, actor = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, examId: true, userId: true, finalScore: true, totalMarks: true, scorePercent: true, passed: true, gradeLetter: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  await assertCanGrade(attempt.examId, actor, { allowAssignment: false });

  const breakdown = await scoring.scoreBreakdown(attemptId, { includeResponses: false });
  let content;
  try {
    const ai = require('./ai.service');
    const generated = kind === 'AI_RETAKE_COACH'
      ? await ai.retakeRecommendation({ attempt: breakdown, breakdown })
      : await ai.personalizedFeedback({ attempt: breakdown, breakdown });
    content = String(generated?.content ?? generated?.text ?? generated ?? '').slice(0, 20_000);
  } catch (error) {
    logger.warn('ai feedback unavailable', { attemptId, error: error.message });
    content = fallbackFeedbackText(breakdown);
  }
  if (!content.trim()) throw ApiError.internal('The model returned no feedback');

  return addFeedback(attemptId, { content, kind: kind === 'AI_RETAKE_COACH' ? 'AI_RETAKE_COACH' : 'AI_PERSONALIZED', meta: { generated: true, scorePercent: Number(attempt.scorePercent ?? 0) }, notify }, { userId: actor.userId ?? null, ...actor });
}

function fallbackFeedbackText(breakdown) {
  const percent = Number(breakdown?.overall?.scorePercent ?? 0);
  const weak = (breakdown?.byTopic ?? []).filter((row) => Number(row.scorePercent ?? 0) < 50).map((row) => row.topic ?? row.tag).filter(Boolean);
  const strong = (breakdown?.byTopic ?? []).filter((row) => Number(row.scorePercent ?? 0) >= 80).map((row) => row.topic ?? row.tag).filter(Boolean);
  const lines = [`You scored ${percent}% on this assessment.`];
  if (strong.length) lines.push(`You did well on: ${strong.slice(0, 5).join(', ')}.`);
  if (weak.length) lines.push(`Worth revising: ${weak.slice(0, 5).join(', ')}.`);
  if (!strong.length && !weak.length) lines.push('Review the questions you skipped or answered partially before your next attempt.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Grade release
// ---------------------------------------------------------------------------

/**
 * Publish every graded attempt at once. Results become visible to candidates,
 * certificates are issued where configured, and the candidates are notified.
 */
async function releaseGrades(examId, { notify = true, resultsVisibleAt = null, certificate = true } = {}, actor = {}) {
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const now = new Date();
  const releaseAt = resultsVisibleAt ? new Date(resultsVisibleAt) : now;
  const isNow = releaseAt <= now;

  await prisma.exam.update({
    where: { id: examId },
    data: {
      gradesReleasedAt: releaseAt,
      resultsVisibleAt: releaseAt,
      resultVisibility: isNow && exam.resultVisibility === 'NEVER' ? 'IMMEDIATELY' : exam.resultVisibility,
    },
  });

  const pendingRelease = isNow ? { gradingStatus: 'GRADED' } : { gradingStatus: 'GRADED', releasedAt: null };
  const graded = await prisma.attempt.findMany({
    where: { examId, ...pendingRelease },
    select: { id: true, userId: true, finalScore: true, scorePercent: true, passed: true, gradeLetter: true },
  });

  if (isNow && graded.length) {
    await prisma.attempt.updateMany({ where: { id: { in: graded.map((row) => row.id) } }, data: { gradingStatus: 'RELEASED', releasedAt: now } });
    if (certificate) {
      for (const attempt of graded) {
        if (attempt.passed !== true) continue;
        await issueCertificateQuietly(attempt.id);
      }
    }
    if (notify) {
      await notifyMany({
        userIds: graded.map((row) => row.userId),
        type: 'RESULTS_RELEASED',
        title: `Your ${exam.title} result is out`,
        body: 'Sign in to see your score, grade and feedback.',
        actionUrl: '/my-results',
      }).catch(() => null);
    }
  }

  await scoring.refreshExamAggregate(examId).catch(() => null);
  broadcastToExam(examId, 'grading:released', { examId, released: isNow ? graded.length : 0, at: releaseAt.toISOString() });

  logger.info('grades released', { examId, actorId: actor.userId, attempts: graded.length, scheduled: !isNow });
  return {
    examId,
    releasedAt: releaseAt,
    isReleased: isNow,
    attemptsReleased: isNow ? graded.length : 0,
    scheduled: !isNow,
    notified: isNow && notify ? graded.length : 0,
  };
}

/** Take results back down (e.g. a grading error was found after release). */
async function holdGrades(examId, { reason = null } = {}, actor = {}) {
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  await prisma.exam.update({ where: { id: examId }, data: { resultVisibility: 'NEVER', gradesReleasedAt: null } });
  const held = await prisma.attempt.updateMany({
    where: { examId, gradingStatus: 'RELEASED' },
    data: { gradingStatus: 'GRADED', releasedAt: null },
  });

  broadcastToExam(examId, 'grading:held', { examId, reason: reason ?? null });
  return { examId, held: held.count, reason: reason ?? null };
}

/** Push a scheduled release date forward or backward. */
async function scheduleGradeRelease(examId, { resultsVisibleAt, notifyOnRelease = true } = {}, actor = {}) {
  if (!resultsVisibleAt) throw ApiError.badRequest('resultsVisibleAt is required');
  const when = new Date(resultsVisibleAt);
  if (Number.isNaN(when.getTime())) throw ApiError.badRequest('resultsVisibleAt is not a valid date');

  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  await prisma.exam.update({ where: { id: examId }, data: { resultVisibility: 'ON_DATE', resultsVisibleAt: when, gradesReleasedAt: when } });
  await prisma.exam.update({ where: { id: examId }, data: { settings: { ...(exam.settings ?? {}), notifyOnRelease: Boolean(notifyOnRelease) } } });

  return { examId, resultsVisibleAt: when, upcoming: when > new Date() };
}

/**
 * Called by `examScheduler.job.js`: release anything whose date has arrived and
 * finish grading for exams where every candidate has submitted.
 */
async function processScheduledReleases() {
  const due = await prisma.exam.findMany({
    where: { resultVisibility: 'ON_DATE', gradesReleasedAt: { lte: new Date() } },
    select: { id: true, gradesReleasedAt: true, settings: true },
    take: 200,
  });

  const released = [];
  for (const exam of due) {
    try {
      const result = await releaseGrades(exam.id, { resultsVisibleAt: null, notify: exam.settings?.notifyOnRelease !== false }, { userId: null, system: true });
      released.push({ examId: exam.id, attempts: result.attemptsReleased });
    } catch (error) {
      logger.error('scheduled grade release failed', { examId: exam.id, error: error.message });
    }
  }
  return { checked: due.length, released: released.length, details: released };
}

/** Instructor's "everyone is done, wrap the exam up" action. */
async function completeGradingForExam(examId, { release = false } = {}, actor = {}) {
  const exam = await assertCanGrade(examId, actor, { allowAssignment: false });
  assertSameOrganization(exam, actor);

  const outstanding = await prisma.answer.count({ where: { needsManualGrading: true, gradingStatus: { in: PENDING_STATES }, attempt: { examId } } });
  if (outstanding) throw ApiError.unprocessable('Grading is not finished yet', { outstandingAnswers: outstanding });

  const attempts = await prisma.attempt.findMany({ where: { examId, gradingStatus: { in: PENDING_STATES } }, select: { id: true } });
  for (const attempt of attempts) await markAttemptGraded(attempt.id).catch(() => null);

  await scoring.recalculatePercentiles(examId).catch(() => null);
  await scoring.refreshExamAggregate(examId).catch(() => null);

  const result = release ? await releaseGrades(examId, {}, actor) : null;
  return { examId, gradedAttempts: attempts.length, outstanding, released: result?.attemptsReleased ?? 0 };
}

// ---------------------------------------------------------------------------
// Reader helpers for the other dashboards
// ---------------------------------------------------------------------------

/** Types that can never be auto-graded - used by the builder's warnings. */
function manuallyGradedTypes() {
  return [...MANUALLY_GRADED_TYPES];
}

/** How much manual work a draft exam will create before it is published. */
async function gradingForecast(examId) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, organizationId: true, settings: true } });
  if (!exam) throw ApiError.notFound('Exam not found');

  const links = await prisma.examQuestion.findMany({
    where: { examId },
    select: { questionId: true, marks: true, question: { select: { id: true, type: true } } },
  });
  const manual = links.filter((link) => MANUALLY_GRADED_TYPES.includes(link.question?.type));

  return {
    examId,
    questions: links.length,
    manualGradedQuestions: manual.length,
    manualMarks: round2(manual.reduce((sum, link) => sum + Number(link.marks ?? 0), 0)),
    requiresSecondGrader: Boolean(exam.settings?.requireSecondGrader),
    estimatedMinutes: Math.ceil((manual.length * Number(exam.settings?.secondsPerManualGrade ?? 180)) / 60),
  };
}

module.exports = {
  ASSIGNABLE_ROLES,
  FEEDBACK_KINDS,
  PENDING_STATES,
  addFeedback,
  aiCodeReview,
  aiGradeEssay,
  assertCanGrade,
  attemptSubmissions,
  bulkAssign,
  completeGradingForExam,
  createRubric,
  deleteFeedback,
  deleteRubric,
  deserialiseAnswer,
  finaliseGrading,
  generatePersonalisedFeedback,
  gradeMany,
  gradeSubmission,
  gradingForecast,
  gradingHistory,
  gradingQueue,
  gradingStats,
  holdGrades,
  issueCertificateQuietly,
  listAssignments,
  listFeedback,
  listOverrides,
  listPendingAnswerIds,
  listRubrics,
  manuallyGradedTypes,
  markAttemptGraded,
  myGradingQueue,
  overrideGrade,
  processScheduledReleases,
  queueForAttempt,
  recomputeAttempt,
  regradeExam,
  releaseGrades,
  rubricForQuestion,
  saveRubricScores,
  scheduleGradeRelease,
  submissionForGrading,
  unassignGrader,
  updateRubric,
};
