/**
 * Scoring service: turns stored `Answer` rows into an attempt score.
 *
 * The pure rules live in `utils/scoring.util.js`; this module adds the database
 * side - loading the gradeable set, running coding answers through the sandbox,
 * persisting per-answer marks, and writing the aggregate onto the attempt.
 *
 * Manual-grading is *not* done here: answers that need a human are marked
 * `needsManualGrading` and the attempt is left in `IN_PROGRESS` until
 * grading.service finishes them.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const {
  aggregateScore, gradeAnswer, gradeLetter, percentile, round,
} = require('../utils/scoring.util');
const { runCode, scoreFromRun } = require('../utils/codeRunner.util');
const { MANUALLY_GRADED_TYPES } = require('../constants/questionTypes');

/**
 * Everything needed to score one attempt, in a single query.
 * `include` is reused by grading.service and report.service.
 */
const GRADEABLE_INCLUDE = {
  exam: {
    include: {
      sections: { orderBy: { order: 'asc' } },
      organization: { select: { id: true, name: true, slug: true, settings: true } },
    },
  },
  answers: {
    include: {
      question: {
        select: {
          id: true, type: true, prompt: true, content: true, marks: true, negativePercent: true,
          difficulty: true, topicTags: true, rubricCriteria: true, status: true, codeConfig: true, explanation: true,
        },
      },
      examQuestion: { select: { id: true, marks: true, negativePercent: true, weightage: true, order: true, sectionId: true } },
      rubricScores: true,
      files: { select: { id: true, url: true, kind: true, mimeType: true } },
    },
    orderBy: { order: 'asc' },
  },
  gradeOverrides: { orderBy: { createdAt: 'desc' } },
};

/** Auto-grade (and optionally persist) every answer on an attempt. */
async function autoGradeAttempt(attemptId, { commit = true, gradedBy = null, runCoding = true } = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: GRADEABLE_INCLUDE });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const exam = attempt.exam;
  const negativeMarkingEnabled = Boolean(exam.negativeMarking);
  const entries = [];
  const updates = [];

  for (const answer of attempt.answers) {
    const question = answer.question;
    if (!question) continue;

    const maxMarks = Number(answer.examQuestion?.marks ?? question.marks ?? 0);
    const negativePercent = negativeMarkingEnabled
      ? Number(answer.examQuestion?.negativePercent ?? question.negativePercent ?? exam.scoringConfig?.negativeMarkingPercent ?? 0)
      : 0;

    let grading = gradeAnswer({
      type: question.type,
      content: question.content ?? {},
      response: answer.response ?? {},
      maxMarks,
      negativePercent,
    });

    // CODING needs the sandbox, which is asynchronous, so it is graded here and
    // the result is handed back to the pure aggregator via `entry.grading`.
    if (question.type === 'CODING' && runCoding) {
      grading = await gradeCodingAnswer({ answer, question, maxMarks, negativePercent, fallback: grading });
    }

    // A human already scored this answer: keep their number, never overwrite.
    const manuallyGraded = answer.manualScore != null;
    const finalScore = manuallyGraded ? Number(answer.manualScore) : round(grading.score, 2);
    const needsManual = grading.needsManualGrading && !manuallyGraded;

    entries.push({
      answerId: answer.id,
      questionId: question.id,
      question,
      examQuestion: answer.examQuestion,
      sectionId: answer.sectionId ?? answer.examQuestion?.sectionId ?? null,
      response: answer.response,
      grading: { ...grading, awarded: manuallyGraded ? Number(answer.manualScore) : grading.awarded, deducted: manuallyGraded ? 0 : grading.deducted, needsManualGrading: needsManual },
    });

    if (commit) {
      updates.push(prisma.answer.update({
        where: { id: answer.id },
        data: {
          maxMarks,
          autoScore: round(grading.score, 2),
          finalScore: manuallyGraded ? null : round(grading.score, 2),
          isCorrect: grading.isCorrect,
          isPartial: grading.isPartial,
          needsManualGrading: needsManual,
          gradingStatus: needsManual ? 'UNGRADED' : 'NOT_REQUIRED',
          ...(grading.detail?.runResults !== undefined ? { testRunResults: grading.detail.runResults } : {}),
        },
      }));
    }
  }

  const summary = aggregateScore(entries, exam);

  // Grade overrides always win over the computed total.
  const attemptOverride = attempt.gradeOverrides.find((override) => override.answerId === null);
  if (attemptOverride) {
    summary.finalScore = Number(attemptOverride.newScore);
    summary.totalMarks = summary.totalMarks || Number(attempt.totalMarks) || 1;
    summary.scorePercent = round((summary.finalScore / summary.totalMarks) * 100, 2);
    summary.passed = summary.scorePercent >= Number(exam.passingPercent ?? 0);
    summary.gradeLetter = gradeLetter(summary.scorePercent, exam.gradeBoundaries);
    summary.overridden = true;
  }

  const pendingManual = summary.pendingManualCount;
  const gradingStatus = pendingManual > 0 ? 'IN_PROGRESS' : 'GRADED';

  if (commit) {
    updates.push(prisma.attempt.update({
      where: { id: attemptId },
      data: {
        rawScore: summary.rawScore,
        negativeDeducted: summary.negativeDeducted,
        partialAwarded: summary.partialAwarded,
        totalMarks: summary.totalMarks,
        finalScore: summary.finalScore,
        scorePercent: summary.scorePercent,
        passed: summary.passed,
        gradeLetter: summary.gradeLetter,
        gradingStatus,
        gradedAt: pendingManual ? null : new Date(),
        answeredCount: summary.answerSummary.correct + summary.answerSummary.partial + summary.answerSummary.incorrect,
        ...(attempt.isAdaptive ? adaptiveWrite(attempt, entries) : {}),
      },
    }));

    await prisma.$transaction(updates);
    await persistSectionProgress(attemptId, summary.sections);
    await refreshExamAggregate(exam.id).catch((error) => logger.warn('exam aggregate refresh failed', { examId: exam.id, error: error.message }));
    if (gradedBy) {
      logger.info('attempt auto-graded', { attemptId, gradedBy, scorePercent: summary.scorePercent, pendingManual });
    }
  }

  return { attemptId, examId: exam.id, summary, pendingManual, gradingStatus, committed: commit };
}

/** Execute a candidate's program and convert the run into a score. */
async function gradeCodingAnswer({ answer, question, maxMarks, negativePercent, fallback }) {
  const config = question.codeConfig ?? question.content?.codeConfig ?? {};
  const visibleTests = Array.isArray(config.testCases) ? config.testCases : [];
  const hiddenTests = Array.isArray(config.hiddenTestCases) ? config.hiddenTestCases : [];
  const code = answer.codeSource ?? answer.response?.code ?? '';

  if (!String(code).trim()) {
    return { ...fallback, awarded: 0, deducted: 0, score: 0, needsManualGrading: false, detail: { reason: 'no code submitted' } };
  }

  try {
    const run = await runCode({
      language: answer.codeLanguage ?? config.language ?? 'javascript',
      code,
      testCases: [...visibleTests, ...hiddenTests],
      entryFunction: config.entryFunction ?? 'solution',
      timeLimitMs: config.timeLimitMs ?? config.timeoutMs,
      memoryLimitMb: config.memoryLimitMb,
    });

    if (run.status === 'UNSUPPORTED') {
      // No runtime installed for that language: keep it auto-graded = false so
      // the manual queue picks it up instead of silently awarding zero.
      return {
        ratio: 0,
        awarded: 0,
        deducted: 0,
        score: 0,
        isCorrect: false,
        isPartial: false,
        needsManualGrading: true,
        detail: { reason: `runtime for ${run.language ?? config.language} is unavailable`, runResults: summariseRun(run) },
      };
    }

    const scoringRule = config.scoringRule ?? 'PASSED_TEST_PERCENT';
    const ratio = scoreFromRun(run, scoringRule, 0) ?? 0;
    const awarded = round(Math.min(1, Math.max(0, ratio)) * maxMarks, 2);
    const deducted = ratio === 0 && negativePercent > 0 ? round((negativePercent / 100) * maxMarks, 2) : 0;

    return {
      ratio,
      awarded,
      deducted,
      score: round(awarded - deducted, 2),
      isCorrect: ratio >= 0.999,
      isPartial: ratio > 0 && ratio < 0.999,
      needsManualGrading: false,
      detail: {
        passedTests: run.passedCount,
        totalTests: run.totalCount,
        status: run.status,
        runResults: summariseRun(run),
      },
    };
  } catch (error) {
    logger.warn('coding grading failed - routed to manual review', { answerId: answer.id, error: error.message });
    return {
      ratio: 0,
      awarded: 0,
      deducted: 0,
      score: 0,
      isCorrect: false,
      isPartial: false,
      needsManualGrading: true,
      detail: { reason: 'the code runner could not evaluate this submission', error: error.message },
    };
  }
}

function summariseRun(run) {
  const total = run.totalCount ?? run.results?.length ?? 0;
  const passed = run.passedCount ?? 0;
  return {
    status: run.status,
    passed,
    failed: Math.max(0, total - passed),
    total,
    compileOutput: run.compileOutput ?? null,
    reason: run.reason ?? null,
    logs: Array.isArray(run.logs) ? run.logs.slice(0, 20) : [],
    cases: (run.results ?? []).slice(0, 40).map((result) => ({
      testId: result.testId ?? null,
      passed: Boolean(result.passed),
      isSample: Boolean(result.isSample),
      expected: result.expected ?? null,
      actual: result.actual ?? null,
      message: result.error ?? null,
      timedOut: Boolean(result.timedOut),
      durationMs: result.durationMs ?? null,
    })),
  };
}

async function persistSectionProgress(attemptId, sections) {
  const progress = {};
  for (const section of sections) {
    if (!section.sectionId) continue;
    progress[section.sectionId] = {
      awarded: section.awarded,
      obtainable: section.obtainable,
      finalScore: section.finalScore,
      scorePercent: section.scorePercent,
      questions: section.questions,
    };
  }
  await prisma.attempt.update({ where: { id: attemptId }, data: { sectionProgress: progress } });
}

/** Update the denormalised pass rate / average score on the exam row. */
async function refreshExamAggregate(examId) {
  const graded = await prisma.attempt.findMany({
    where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } },
    select: { scorePercent: true, passed: true },
  });
  if (!graded.length) return null;

  const average = graded.reduce((sum, row) => sum + Number(row.scorePercent), 0) / graded.length;
  const passedCount = graded.filter((row) => row.passed).length;

  return prisma.exam.update({
    where: { id: examId },
    data: {
      averageScore: round(average, 2),
      passRate: round((passedCount / graded.length) * 100, 2),
      totalAttempts: await prisma.attempt.count({ where: { examId } }),
    },
  });
}

/**
 * Percentile needs the whole cohort, so it is recomputed for every graded
 * attempt whenever a new score lands (cheap for the cohorts this platform
 * targets; the query is indexed on [examId, gradingStatus]).
 */
async function recalculatePercentiles(examId) {
  const attempts = await prisma.attempt.findMany({
    where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } },
    select: { id: true, scorePercent: true },
    orderBy: { submittedAt: 'asc' },
  });
  if (!attempts.length) return { updated: 0 };

  const distribution = attempts.map((row) => Number(row.scorePercent));
  const writes = attempts.map((row) => prisma.attempt.update({
    where: { id: row.id },
    data: { percentile: percentile(Number(row.scorePercent), distribution) },
  }));
  await prisma.$transaction(writes);
  return { updated: writes.length };
}

/**
 * A score preview used by the question editor and the "test grading" button:
 * no database access at all.
 */
async function previewGrade({ type, content = {}, response = {}, maxMarks = 1, negativePercent = 0 }) {
  if (!type) throw ApiError.badRequest('Question type is required');
  const grading = gradeAnswer({ type, content, response, maxMarks, negativePercent });
  return {
    ...grading,
    maxMarks: Number(maxMarks),
    awarded: grading.awarded,
    deducted: grading.deducted,
    percentage: round((grading.awarded / (Number(maxMarks) || 1)) * 100, 2),
    requiresManualGrading: MANUALLY_GRADED_TYPES.includes(type),
  };
}

/**
 * Adaptive ability estimate: expected-a-posteriori over a -3..3 grid using the
 * 2-parameter logistic model. Deterministic, no iteration count surprises.
 */
function estimateAbility(entries, { priorMean = 0, priorSd = 1, gridStep = 0.25 } = {}) {
  if (!entries.length) return { ability: round(priorMean, 3), stdErr: round(priorSd, 3) };

  const items = entries.map((entry) => ({
    difficulty: Number(entry.difficulty ?? 0),
    discrimination: Number(entry.discrimination ?? 1),
    score: Number(entry.score ?? 0),
  }));

  let numerator = 0;
  let denominator = 0;
  let secondMoment = 0;
  let maxWeight = -Infinity;
  const grid = [];

  for (let theta = -3; theta <= 3 + 1e-9; theta += gridStep) {
    let logLikelihood = 0;
    for (const item of items) {
      const probability = clampNumber(1 / (1 + Math.exp(-item.discrimination * (theta - item.difficulty))), 1e-6, 1 - 1e-6);
      logLikelihood += item.score > 0.5 ? Math.log(probability) : Math.log(1 - probability);
    }
    const priorLog = -((theta - priorMean) ** 2) / (2 * priorSd ** 2);
    const weight = logLikelihood + priorLog;
    grid.push({ theta, weight });
    if (weight > maxWeight) maxWeight = weight;
  }

  for (const cell of grid) {
    const scaled = Math.exp(cell.weight - maxWeight);
    numerator += cell.theta * scaled;
    secondMoment += cell.theta ** 2 * scaled;
    denominator += scaled;
  }

  const mean = numerator / (denominator || 1);
  const variance = Math.max(0, secondMoment / (denominator || 1) - mean ** 2);
  return { ability: round(mean, 3), stdErr: round(Math.sqrt(variance), 3) };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Map a difficulty label onto the IRT theta scale used by `estimateAbility`. */
const DIFFICULTY_THETA = { EASY: -1.5, MEDIUM: 0, HARD: 1.2, EXPERT: 2.2 };

/**
 * Choose the next item for an adaptive route: maximise information at the
 * current ability estimate, excluding items already answered.
 */
function selectAdaptiveItem({ pool = [], answeredIds = [], ability = 0, target = null }) {
  const seen = new Set(answeredIds);
  const candidates = pool.filter((item) => item?.id && !seen.has(item.id));
  if (!candidates.length) return null;

  const want = target ?? clampNumber(ability, -3, 3);
  let best = null;
  let bestScore = -Infinity;

  for (const item of candidates) {
    const difficulty = item.irtDifficulty ?? DIFFICULTY_THETA[item.difficulty] ?? 0;
    const discrimination = item.irtDiscrimination ?? defaultDiscrimination(item);
    const probability = irtP(want, { difficulty, discrimination });
    const information = discrimination ** 2 * probability * (1 - probability);
    // Tie-break towards items that have been field-tested less.
    const score = information - Math.min(0.4, (item.timesAnswered ?? 0) / 1000);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function defaultDiscrimination(item) {
  const stat = Number(item.discriminationIndex);
  if (Number.isFinite(stat) && stat > 0.1) return clampNumber(stat * 2, 0.5, 2.5);
  return 1;
}

function irtP(ability, { difficulty, discrimination }) {
  return 1 / (1 + Math.exp(-discrimination * (ability - difficulty)));
}

/** Write the IRT state back onto the attempt row after each answer. */
function adaptiveWrite(attempt, entries) {
  const items = entries.map((entry) => ({
    difficulty: entry.question?.irtDifficulty ?? DIFFICULTY_THETA[entry.question?.difficulty] ?? 0,
    discrimination: entry.question?.irtDiscrimination ?? 1,
    score: entry.grading?.isCorrect ? 1 : entry.grading?.isPartial ? Number(entry.grading?.ratio ?? 0) : 0,
  }));
  const { ability, stdErr } = estimateAbility(items, {
    priorMean: Number(attempt.adaptiveState?.ability ?? 0),
    priorSd: Number(attempt.adaptiveState?.stdErr ?? 1) || 1,
  });
  return {
    abilityScore: round(ability, 3),
    abilityStdErr: round(stdErr, 3),
    adaptiveState: {
      ...(attempt.adaptiveState ?? {}),
      ability: round(ability, 3),
      stdErr: round(stdErr, 3),
      itemsAnswered: items.length,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Full per-question breakdown for the results / review screen. */
async function scoreBreakdown(attemptId, { includeResponses = true } = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: GRADEABLE_INCLUDE });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const questions = [];
  for (const answer of attempt.answers) {
    const maxMarks = Number(answer.examQuestion?.marks ?? answer.question?.marks ?? 0);
    const breakdown = {
      answerId: answer.id,
      questionId: answer.questionId,
      order: answer.order,
      type: answer.question?.type,
      prompt: answer.question?.prompt ?? answer.question?.content?.prompt ?? null,
      sectionId: answer.sectionId ?? answer.examQuestion?.sectionId ?? null,
      maxMarks,
      autoScore: answer.autoScore == null ? null : Number(answer.autoScore),
      manualScore: answer.manualScore == null ? null : Number(answer.manualScore),
      aiScore: answer.aiScore == null ? null : Number(answer.aiScore),
      finalScore: answer.finalScore == null ? null : Number(answer.finalScore),
      isCorrect: answer.isCorrect,
      isPartial: answer.isPartial,
      needsManualGrading: answer.needsManualGrading,
      gradingStatus: answer.gradingStatus,
      graderNote: answer.graderNote,
      aiFeedback: answer.aiFeedback,
      feedback: answer.feedback,
      timeSpentSec: answer.timeSpentSec,
      wasSkipped: answer.wasSkipped,
      rubricScores: answer.rubricScores.map((score) => ({
        criterionId: score.criterionId,
        criterionName: score.criterionName,
        marksAwarded: Number(score.marksAwarded),
        maxMarks: Number(score.maxMarks),
        comment: score.comment,
      })),
      correctAnswer: answer.question?.content?.correctOptionId
        ?? answer.question?.content?.correctOptionIds
        ?? answer.question?.solution
        ?? null,
      options: (answer.question?.content?.options ?? []).map((option) => ({
        id: option.id,
        text: option.text ?? option.label ?? null,
        correct: Boolean(option.correct) || (Array.isArray(answer.question?.content?.correctOptionIds) && answer.question.content.correctOptionIds.includes(option.id)),
      })),
      explanation: includeResponses ? answer.question?.explanation ?? null : null,
    };
    if (includeResponses) {
      breakdown.response = answer.response;
      breakdown.codeSource = answer.codeSource;
      breakdown.testRunResults = answer.testRunResults;
    }
    questions.push(breakdown);
  }

  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    status: attempt.status,
    gradingStatus: attempt.gradingStatus,
    released: Boolean(attempt.releasedAt),
    score: {
      rawScore: Number(attempt.rawScore),
      negativeDeducted: Number(attempt.negativeDeducted),
      partialAwarded: Number(attempt.partialAwarded),
      finalScore: Number(attempt.finalScore),
      totalMarks: Number(attempt.totalMarks),
      scorePercent: Number(attempt.scorePercent),
      percentile: attempt.percentile == null ? null : Number(attempt.percentile),
      gradeLetter: attempt.gradeLetter,
      passed: attempt.passed,
      abilityScore: attempt.abilityScore == null ? null : Number(attempt.abilityScore),
    },
    sections: attempt.exam.sections.map((section) => ({
      id: section.id,
      name: section.name,
      order: section.order,
      progress: attempt.sectionProgress?.[section.id] ?? null,
    })),
    questions,
    submittedAt: attempt.submittedAt,
    gradedAt: attempt.gradedAt,
  };
}

/** How many attempts are still waiting for a human. */
async function pendingGradingCount(examId) {
  const [answers, attempts] = await Promise.all([
    prisma.answer.count({
      where: { needsManualGrading: true, gradingStatus: { in: ['UNGRADED', 'IN_PROGRESS'] }, attempt: { examId } },
    }),
    prisma.attempt.count({ where: { examId, gradingStatus: { in: ['UNGRADED', 'IN_PROGRESS'] } } }),
  ]);
  return { answers, attempts };
}

module.exports = {
  DIFFICULTY_THETA,
  GRADEABLE_INCLUDE,
  adaptiveWrite,
  autoGradeAttempt,
  estimateAbility,
  gradeCodingAnswer,
  pendingGradingCount,
  persistSectionProgress,
  previewGrade,
  recalculatePercentiles,
  refreshExamAggregate,
  scoreBreakdown,
  selectAdaptiveItem,
  summariseRun,
};
