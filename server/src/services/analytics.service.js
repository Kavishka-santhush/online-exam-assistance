/**
 * Analytics service.
 *
 * Computed-on-read analytics for the instructor dashboard. Heavy aggregates
 * (question stats, analytics buckets) are written by `scoring.service` as
 * side-effects of grading; this service assembles the views the UI needs.
 *
 * All amounts/percentages are in the 0-100 range.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];
const BIN_SIZE = 10; // percentage bins for the histogram

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertStaff(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  const isStaff = actor.platformRole === 'SUPER_ADMIN' || STAFF_ROLES.includes(actor.role) || STAFF_ROLES.includes(actor.platformRole);
  if (!isStaff) throw ApiError.forbidden('Staff access required');
}

async function assertExamAccess(examId, actor) {
  assertStaff(actor);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, organizationId: true, title: true, totalMarks: true, passingPercent: true, durationMinutes: true, questionCount: true, totalAttempts: true, totalRegistrations: true, averageScore: true, passRate: true, type: true } });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (actor.platformRole !== 'SUPER_ADMIN' && exam.organizationId !== actor.organizationId) throw ApiError.forbidden('Access denied');
  return exam;
}

// ---------------------------------------------------------------------------
// Exam overview
// ---------------------------------------------------------------------------

async function examOverview(examId, actor = {}) {
  const exam = await assertExamAccess(examId, actor);

  const [totalAttempts, submitted, inProgress, terminated, graded, passed, avgScore, avgTimeSec, totalRegistrations] = await Promise.all([
    prisma.attempt.count({ where: { examId } }),
    prisma.attempt.count({ where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } } }),
    prisma.attempt.count({ where: { examId, status: { in: ['IN_PROGRESS', 'PAUSED'] } } }),
    prisma.attempt.count({ where: { examId, isTerminated: true } }),
    prisma.attempt.count({ where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } } }),
    prisma.attempt.count({ where: { examId, passed: true } }),
    prisma.attempt.aggregate({ where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } }, _avg: { scorePercent: true } }),
    prisma.attempt.aggregate({ where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } }, _avg: { usedTimeSec: true } }),
    prisma.examCandidate.count({ where: { examId } }),
  ]);

  return {
    exam: { id: exam.id, title: exam.title, type: exam.type, totalMarks: Number(exam.totalMarks), passingPercent: Number(exam.passingPercent), durationMinutes: exam.durationMinutes, questionCount: exam.questionCount },
    totalAttempts,
    totalRegistrations,
    submitted,
    inProgress,
    terminated,
    graded,
    completionRate: totalAttempts > 0 ? round1((submitted / totalAttempts) * 100) : 0,
    averageScore: round1(avgScore._avg.scorePercent ?? 0),
    passRate: graded > 0 ? round1((passed / graded) * 100) : 0,
    averageTimeSec: Math.round(avgTimeSec._avg.usedTimeSec ?? 0),
    passedCount: passed,
  };
}

// ---------------------------------------------------------------------------
// Score distribution histogram
// ---------------------------------------------------------------------------

async function scoreDistribution(examId, actor = {}) {
  await assertExamAccess(examId, actor);
  const attempts = await prisma.attempt.findMany({ where: { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } }, select: { scorePercent: true, passed: true } });

  const bins = Array.from({ length: 10 }, (_, i) => ({ range: `${i * BIN_SIZE}-${(i + 1) * BIN_SIZE - 1}%`, count: 0, passedCount: 0 }));
  for (const row of attempts) {
    const pct = Number(row.scorePercent ?? 0);
    const idx = Math.min(Math.floor(pct / BIN_SIZE), 9);
    bins[idx].count += 1;
    if (row.passed) bins[idx].passedCount += 1;
  }

  const scores = attempts.map((row) => Number(row.scorePercent));
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    bins,
    total: attempts.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    median: sorted.length ? (sorted.length % 2 === 1 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0,
    mean: scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    stdDev: scores.length ? round1(stdDev(scores)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Time analysis
// ---------------------------------------------------------------------------

async function timeAnalysis(examId, actor = {}) {
  const exam = await assertExamAccess(examId, actor);
  const [attemptTimes, answerTimes] = await Promise.all([
    prisma.attempt.findMany({ where: { examId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } }, select: { usedTimeSec: true, timeLimitSec: true, autoSubmitted: true } }),
    prisma.answer.findMany({ where: { attempt: { examId }, timeSpentSec: { not: null } }, select: { questionId: true, timeSpentSec: true, order: true } }),
  ]);

  const avgAttemptSec = attemptTimes.length ? Math.round(attemptTimes.reduce((s, r) => s + (r.usedTimeSec ?? 0), 0) / attemptTimes.length) : 0;
  const autoSubmittedCount = attemptTimes.filter((r) => r.autoSubmitted).length;

  // Per-question avg.
  const perQuestionMap = {};
  for (const row of answerTimes) {
    if (!perQuestionMap[row.questionId]) perQuestionMap[row.questionId] = { total: 0, count: 0 };
    perQuestionMap[row.questionId].total += row.timeSpentSec ?? 0;
    perQuestionMap[row.questionId].count += 1;
  }
  const perQuestion = Object.entries(perQuestionMap).map(([questionId, data]) => ({ questionId, avgTimeSec: Math.round(data.total / data.count), sampleSize: data.count }));

  return {
    averageTimeSec: avgAttemptSec,
    timeLimitSec: exam.durationMinutes * 60,
    utilizationPercent: exam.durationMinutes > 0 ? round1((avgAttemptSec / (exam.durationMinutes * 60)) * 100) : 0,
    autoSubmittedCount,
    totalSubmissions: attemptTimes.length,
    perQuestion: perQuestion.sort((a, b) => b.avgTimeSec - a.avgTimeSec),
  };
}

// ---------------------------------------------------------------------------
// Question analytics (per-question stats)
// ---------------------------------------------------------------------------

async function questionAnalytics(examId, { page = 1, limit = 50 } = {}, actor = {}) {
  await assertExamAccess(examId, actor);

  const examQuestions = await prisma.examQuestion.findMany({
    where: { examId },
    orderBy: { order: 'asc' },
    include: { question: { select: { id: true, prompt: true, type: true, marks: true, content: true } } },
  });

  const stats = await prisma.questionStat.findMany({ where: { examId } });
  const statsMap = Object.fromEntries(stats.map((s) => [s.questionId, s]));

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const paged = examQuestions.slice((safePage - 1) * safeLimit, safePage * safeLimit);

  const items = paged.map((eq) => {
    const q = eq.question;
    const stat = statsMap[q.id];
    return {
      questionId: q.id,
      prompt: (q.prompt ?? '').slice(0, 200),
      type: q.type,
      marks: Number(q.marks ?? eq.marks ?? 0),
      order: eq.order,
      attempts: stat?.attempts ?? 0,
      correctCount: stat?.correctCount ?? 0,
      incorrectCount: stat?.incorrectCount ?? 0,
      skippedCount: stat?.skippedCount ?? 0,
      difficultyIndex: stat ? Number(stat.difficultyIndex) : null,
      discriminationIndex: stat ? Number(stat.discriminationIndex) : null,
      avgScorePercent: stat ? Number(stat.avgScorePercent) : null,
      avgTimeSec: stat ? Number(stat.avgTimeSec) : null,
      optionDistribution: stat?.optionDistribution ?? null,
      skipRate: stat && stat.attempts > 0 ? round1((stat.skippedCount / stat.attempts) * 100) : null,
    };
  });

  return { items, total: examQuestions.length, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// Topic performance heatmap
// ---------------------------------------------------------------------------

async function topicPerformance(examId, actor = {}) {
  await assertExamAccess(examId, actor);

  const answers = await prisma.answer.findMany({
    where: { attempt: { examId }, finalScore: { not: null } },
    select: { questionId: true, finalScore: true, maxMarks: true, question: { select: { topicTags: true } } },
  });

  const topicMap = {};
  for (const a of answers) {
    const topics = a.question?.topicTags ?? [];
    const scorePercent = a.maxMarks > 0 ? (Number(a.finalScore) / Number(a.maxMarks)) * 100 : 0;
    for (const topic of topics) {
      if (!topicMap[topic]) topicMap[topic] = { total: 0, count: 0 };
      topicMap[topic].total += scorePercent;
      topicMap[topic].count += 1;
    }
  }

  const items = Object.entries(topicMap).map(([topic, data]) => ({ topic, avgScorePercent: round1(data.total / data.count), sampleSize: data.count }));
  items.sort((a, b) => a.avgScorePercent - b.avgScorePercent);
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// Candidate comparison (ranking table)
// ---------------------------------------------------------------------------

async function candidateComparison(examId, { page = 1, limit = 50, search } = {}, actor = {}) {
  await assertExamAccess(examId, actor);

  const where = { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] } };
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [attempts, total] = await Promise.all([
    prisma.attempt.findMany({
      where,
      orderBy: [{ scorePercent: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: { id: true, userId: true, scorePercent: true, finalScore: true, totalMarks: true, gradeLetter: true, passed: true, percentile: true, usedTimeSec: true, submittedAt: true, attemptNumber: true, user: { select: { id: true, displayName: true, email: true } } },
    }),
    prisma.attempt.count({ where }),
  ]);

  let items = attempts.map((row, idx) => ({
    rank: (safePage - 1) * safeLimit + idx + 1,
    attemptId: row.id,
    userId: row.userId,
    candidate: row.user?.displayName ?? row.user?.email ?? 'Unknown',
    scorePercent: Number(row.scorePercent),
    finalScore: Number(row.finalScore),
    totalMarks: Number(row.totalMarks),
    gradeLetter: row.gradeLetter,
    passed: row.passed,
    percentile: row.percentile ? Number(row.percentile) : null,
    timeSec: row.usedTimeSec,
    submittedAt: row.submittedAt,
    attemptNumber: row.attemptNumber,
  }));

  if (search) {
    const lc = String(search).toLowerCase();
    items = items.filter((row) => row.candidate.toLowerCase().includes(lc));
  }

  return { items: search ? items : items, total, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// Violation analytics
// ---------------------------------------------------------------------------

async function violationAnalytics(examId, actor = {}) {
  await assertExamAccess(examId, actor);

  const [totalViolations, byType, bySeverity, flaggedAttempts, topOffenders] = await Promise.all([
    prisma.violation.count({ where: { examId } }),
    prisma.violation.groupBy({ by: ['type'], where: { examId }, _count: { _all: true } }),
    prisma.violation.groupBy({ by: ['severity'], where: { examId }, _count: { _all: true } }),
    prisma.attempt.count({ where: { examId, isFlagged: true } }),
    prisma.attempt.findMany({ where: { examId, violationCount: { gt: 0 } }, orderBy: { violationCount: 'desc' }, take: 10, select: { id: true, userId: true, violationCount: true, riskScore: true, user: { select: { displayName: true, email: true } } } }),
  ]);

  return {
    totalViolations,
    byType: byType
      .map((row) => ({ type: row.type, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    bySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row._count._all])),
    flaggedAttempts,
    topOffenders: topOffenders.map((row) => ({ attemptId: row.id, userId: row.userId, candidate: row.user?.displayName ?? 'Unknown', violationCount: row.violationCount, riskScore: Number(row.riskScore) })),
  };
}

// ---------------------------------------------------------------------------
// Attempt trend over time
// ---------------------------------------------------------------------------

async function attemptTrend(examId, { granularity = 'day' } = {}, actor = {}) {
  await assertExamAccess(examId, actor);

  const attempts = await prisma.attempt.findMany({
    where: { examId },
    select: { submittedAt: true, startedAt: true, scorePercent: true, passed: true },
    orderBy: { startedAt: 'asc' },
  });

  const bucketMap = {};
  for (const row of attempts) {
    const date = row.submittedAt ?? row.startedAt;
    if (!date) continue;
    const key = bucketKey(date, granularity);
    if (!bucketMap[key]) bucketMap[key] = { attempts: 0, passed: 0, scoreSum: 0 };
    bucketMap[key].attempts += 1;
    if (row.passed) bucketMap[key].passed += 1;
    bucketMap[key].scoreSum += Number(row.scorePercent ?? 0);
  }

  const items = Object.entries(bucketMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, data]) => ({
    date,
    attempts: data.attempts,
    passed: data.passed,
    avgScore: data.attempts > 0 ? round1(data.scoreSum / data.attempts) : 0,
  }));

  return { items, granularity, totalAttempts: attempts.length };
}

function bucketKey(date, granularity) {
  const d = new Date(date);
  if (granularity === 'hour') return d.toISOString().slice(0, 13);
  if (granularity === 'week') { const w = getISOWeek(d); return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`; }
  if (granularity === 'month') return d.toISOString().slice(0, 7);
  return d.toISOString().slice(0, 10); // day
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86_400_000 + 1) / 7);
}

// ---------------------------------------------------------------------------
// Candidate personal analytics (historical performance across all exams)
// ---------------------------------------------------------------------------

async function candidateHistory(userId, { examId, limit = 50 } = {}) {
  const where = { userId, gradingStatus: { in: ['GRADED', 'RELEASED'] } };
  if (examId) where.examId = examId;

  const attempts = await prisma.attempt.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
    select: { id: true, examId: true, scorePercent: true, finalScore: true, totalMarks: true, gradeLetter: true, passed: true, usedTimeSec: true, submittedAt: true, attemptNumber: true, exam: { select: { title: true, type: true, passingPercent: true } } },
  });

  return {
    items: attempts.map((row) => ({
      attemptId: row.id, examId: row.examId, examTitle: row.exam?.title ?? '', examType: row.exam?.type,
      scorePercent: Number(row.scorePercent), finalScore: Number(row.finalScore), totalMarks: Number(row.totalMarks),
      gradeLetter: row.gradeLetter, passed: row.passed, timeSec: row.usedTimeSec,
      submittedAt: row.submittedAt, attemptNumber: row.attemptNumber,
    })),
    total: attempts.length,
  };
}

// ---------------------------------------------------------------------------
// Organization-level analytics
// ---------------------------------------------------------------------------

async function organizationAnalytics(organizationId, actor = {}) {
  if (actor.platformRole !== 'SUPER_ADMIN' && actor.organizationId !== organizationId) assertStaff(actor);

  const [examCount, activeExams, attemptCount, gradedCount, passedCount, certCount, paymentAgg, violationCount] = await Promise.all([
    prisma.exam.count({ where: { organizationId } }),
    prisma.exam.count({ where: { organizationId, status: { in: ['PUBLISHED', 'ACTIVE', 'CLOSED'] } } }),
    prisma.attempt.count({ where: { exam: { organizationId } } }),
    prisma.attempt.count({ where: { exam: { organizationId }, gradingStatus: { in: ['GRADED', 'RELEASED'] } } }),
    prisma.attempt.count({ where: { exam: { organizationId }, passed: true } }),
    prisma.certificate.count({ where: { organizationId, status: 'ISSUED' } }),
    prisma.payment.aggregate({ where: { organizationId, status: 'SUCCEEDED' }, _sum: { amountCents: true, netCents: true } }),
    prisma.violation.count({ where: { attempt: { exam: { organizationId } } } }),
  ]);

  return {
    totalExams: examCount,
    activeExams,
    totalAttempts: attemptCount,
    gradedAttempts: gradedCount,
    overallPassRate: gradedCount > 0 ? round1((passedCount / gradedCount) * 100) : 0,
    certificatesIssued: certCount,
    revenueCents: paymentAgg._sum.amountCents ?? 0,
    netRevenueCents: paymentAgg._sum.netCents ?? 0,
    totalViolations: violationCount,
  };
}

// ---------------------------------------------------------------------------
// AI-powered quality analysis + pass-rate prediction
// ---------------------------------------------------------------------------

async function aiQualityAnalysis(examId, actor = {}) {
  const exam = await assertExamAccess(examId, actor);
  const stats = await prisma.questionStat.findMany({
    where: { examId },
    include: { question: { select: { id: true, prompt: true, type: true, marks: true } } },
  });

  const questionStats = stats.map((s) => ({
    questionId: s.questionId,
    prompt: (s.question?.prompt ?? '').slice(0, 120),
    type: s.question?.type,
    difficultyIndex: Number(s.difficultyIndex),
    discriminationIndex: Number(s.discriminationIndex),
    avgScorePercent: Number(s.avgScorePercent),
    skipRate: s.attempts > 0 ? (s.skippedCount / s.attempts) * 100 : 0,
    attempts: s.attempts,
  }));

  try {
    const ai = require('./ai.service');
    const analysis = await ai.calibrateDifficulty({ examId, questionStats, organizationId: exam.organizationId ?? actor.organizationId, userId: actor.userId });
    return { source: 'AI', ...analysis };
  } catch (error) {
    logger.debug('AI quality analysis unavailable, returning raw stats', { examId, error: error.message });
    // Fallback: flag questions with bad indices heuristically.
    const flagged = questionStats.filter((q) => q.discriminationIndex < 0.2 || q.difficultyIndex < 0.15 || q.difficultyIndex > 0.95);
    return { source: 'HEURISTIC', flagged, totalQuestions: questionStats.length };
  }
}

async function aiPassRatePrediction(examId, { cohort } = {}, actor = {}) {
  const exam = await assertExamAccess(examId, actor);
  const historicalData = {
    overallPassRate: Number(exam.passRate),
    averagePercent: Number(exam.averageScore),
    questionCount: exam.questionCount,
    durationMinutes: exam.durationMinutes,
  };

  try {
    const ai = require('./ai.service');
    const prediction = await ai.predictPassRate({ examId, cohort: cohort ?? {}, historicalData, organizationId: actor.organizationId, userId: actor.userId });
    return { source: 'AI', ...prediction };
  } catch (error) {
    logger.debug('AI pass rate prediction unavailable', { examId, error: error.message });
    return { source: 'HISTORICAL', predictedPassRate: historicalData.overallPassRate, confidence: 60 };
  }
}

// ---------------------------------------------------------------------------
// AI summary report (narrative text)
// ---------------------------------------------------------------------------

async function generateExamSummaryReport(examId, actor = {}) {
  const exam = await assertExamAccess(examId, actor);
  const [overview, distribution, topics] = await Promise.all([
    examOverview(examId, actor),
    scoreDistribution(examId, actor),
    topicPerformance(examId, actor),
  ]);

  const statistics = { overview, distribution, topicPerformance: topics.items.slice(0, 10) };
  try {
    const ai = require('./ai.service');
    const report = await ai.generateSummaryReport({ examId, statistics, organizationId: actor.organizationId, userId: actor.userId });
    return report;
  } catch (error) {
    logger.debug('AI summary report unavailable', { examId, error: error.message });
    throw ApiError.internal('AI summary report is not available right now');
  }
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

async function exportExamAnalytics(examId, { format = 'pdf' } = {}, actor = {}) {
  await assertExamAccess(examId, actor);
  const [overview, distribution, questionStats, topics] = await Promise.all([
    examOverview(examId, actor),
    scoreDistribution(examId, actor),
    questionAnalytics(examId, { limit: 200 }, actor),
    topicPerformance(examId, actor),
  ]);
  const statistics = { ...overview, distribution, questionStats: questionStats.items, topicPerformance: topics.items };

  if (format === 'csv') {
    const report = require('./report.service');
    return report.exportAnalyticsCsv({ examId });
  }
  const report = require('./report.service');
  return report.renderAnalyticsPdf({ examId, statistics });
}

async function exportExamResults(examId, actor = {}) {
  await assertExamAccess(examId, actor);
  const report = require('./report.service');
  return report.exportResultsCsv({ examId });
}

// ---------------------------------------------------------------------------
// Persist analytics bucket (called by scoring.service after grading)
// ---------------------------------------------------------------------------

async function saveAggregate({ scope, organizationId, examId, userId, metric, dimension, value, bucket }) {
  return prisma.analyticsAggregate.create({
    data: { scope, organizationId: organizationId ?? null, examId: examId ?? null, userId: userId ?? null, metric, dimension: dimension ?? {}, value, bucket: bucket ? new Date(bucket) : null },
  });
}

async function getAggregates({ scope, examId, organizationId, userId, metric, bucketFrom, bucketTo, limit = 100 }) {
  const where = { scope };
  if (examId) where.examId = examId;
  if (organizationId) where.organizationId = organizationId;
  if (userId) where.userId = userId;
  if (metric) where.metric = metric;
  if (bucketFrom || bucketTo) where.bucket = { ...(bucketFrom ? { gte: new Date(bucketFrom) } : {}), ...(bucketTo ? { lte: new Date(bucketTo) } : {}) };
  return prisma.analyticsAggregate.findMany({ where, orderBy: { bucket: 'desc' }, take: Math.min(Number(limit) || 100, 500) });
}

// ---------------------------------------------------------------------------
// Survey-specific analytics
// ---------------------------------------------------------------------------

async function surveyResults(examId, actor = {}) {
  const exam = await assertExamAccess(examId, actor);
  if (exam.type !== 'SURVEY') throw ApiError.badRequest('This is not a survey exam');

  const questions = await prisma.examQuestion.findMany({ where: { examId }, orderBy: { order: 'asc' }, include: { question: { select: { id: true, prompt: true, type: true, content: true } } } });
  const answers = await prisma.answer.findMany({ where: { attempt: { examId } }, select: { questionId: true, response: true, textAnswer: true, selectedOptions: true, ratingValue: true, matchedPairs: true, matrixResponses: true } });

  const results = questions.map((eq) => {
    const q = eq.question;
    const qAnswers = answers.filter((a) => a.questionId === q.id);
    const total = qAnswers.length;

    // Count per option / value.
    const distribution = {};
    for (const a of qAnswers) {
      const options = a.selectedOptions ?? [];
      const single = options[0] ?? a.ratingValue ?? a.textAnswer ?? 'no_response';
      const key = String(single);
      distribution[key] = (distribution[key] ?? 0) + 1;
    }

    const options = (q.content?.options ?? []).map((opt) => ({
      id: opt.id,
      text: opt.text,
      count: distribution[opt.id] ?? 0,
      percent: total > 0 ? round1(((distribution[opt.id] ?? 0) / total) * 100) : 0,
    }));

    return { questionId: q.id, prompt: q.prompt, type: q.type, totalResponses: total, options, rawDistribution: distribution };
  });

  return { examId, totalResponses: answers.length, results };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  examOverview,
  scoreDistribution,
  timeAnalysis,
  questionAnalytics,
  topicPerformance,
  candidateComparison,
  violationAnalytics,
  attemptTrend,
  candidateHistory,
  organizationAnalytics,
  aiQualityAnalysis,
  aiPassRatePrediction,
  generateExamSummaryReport,
  exportExamAnalytics,
  exportExamResults,
  saveAggregate,
  getAggregates,
  surveyResults,
};
