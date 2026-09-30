/**
 * Server-authoritative exam clock.
 *
 * The browser is never trusted with time: every response carries the remaining
 * seconds computed from the database columns (`startedAt`, `timeLimitSec`,
 * `extraTimeSec`, `pausedAt`), and the auto-submit sweep uses the same math.
 * The client clock is only used to detect tampering.
 *
 * Attempt timing model
 * --------------------
 *   limitSec   = exam.durationMinutes * 60  (+ accessibility time)
 *   deadline   = startedAt + limitSec + extraTimeSec + pausedDuration
 *   expiresAt  = min(deadline, exam.endsAt)      <- stored on the row
 *   usedSec    = now - startedAt - pausedDuration
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');

/** A candidate may not report a clock that runs slower than the server's. */
const MAX_CLIENT_DRIFT_SEC = 5;
const WARN_AT_REMAINING_SEC = Number(process.env.EXAM_TIME_WARNING_SEC || 300);

const SECOND = 1000;

function secondsBetween(from, to = new Date()) {
  const start = from instanceof Date ? from : new Date(from);
  return Math.max(0, Math.round((to.getTime() - start.getTime()) / SECOND));
}

/**
 * Total time the candidate is allowed, in seconds: the exam duration plus any
 * per-candidate accessibility time already granted (`extraTimeSec`).
 */
function computeLimitSec(attempt, exam) {
  if (attempt.timeLimitSec) return Number(attempt.timeLimitSec);
  if (exam?.perQuestionSec && exam?.questionCount) {
    return Number(exam.perQuestionSec) * Number(exam.questionCount);
  }
  return Number(exam?.durationMinutes ?? 0) * 60;
}

/** Accumulated paused time, including a pause that has not been resumed yet. */
function computePausedSec(attempt, now = new Date()) {
  let paused = Number(attempt.metadata?.pausedTotalSec ?? 0);
  if (attempt.pausedAt) {
    paused += secondsBetween(attempt.pausedAt, attempt.resumedAt ?? now);
  }
  return paused;
}

/**
 * The absolute deadline: personal allowance first, then the exam window close,
 * whichever comes sooner.
 */
function computeDeadline(attempt, exam, now = new Date()) {
  const startedAt = new Date(attempt.startedAt);
  const limitSec = computeLimitSec(attempt, exam);
  if (!limitSec) {
    // Open-ended practice/survey: only the exam window applies.
    return exam?.endsAt ? new Date(exam.endsAt) : null;
  }

  let deadline = new Date(startedAt.getTime() + (limitSec + Number(attempt.extraTimeSec ?? 0) + computePausedSec(attempt, now)) * SECOND);

  if (exam?.endsAt) {
    const windowClosesAt = new Date(exam.endsAt);
    if (windowClosesAt < deadline) deadline = windowClosesAt;
  }
  return deadline;
}

/** Snapshot handed to the client on start, autosave ack and timer sync. */
function timeSnapshot(attempt, exam, now = new Date()) {
  const deadline = attempt.expiresAt ? new Date(attempt.expiresAt) : computeDeadline(attempt, exam, now);
  const pausedSec = computePausedSec(attempt, now);
  const limitSec = computeLimitSec(attempt, exam);
  const isPaused = attempt.status === 'PAUSED' || Boolean(attempt.pausedAt && !attempt.resumedAt);
  const remainingSec = deadline ? Math.max(0, secondsBetween(now, deadline)) : null;
  // Active time excludes every pause: while paused the clock stops at `pausedAt`.
  const referenceTime = isPaused && attempt.pausedAt ? attempt.pausedAt : now;
  const priorPausedSec = Number(attempt.metadata?.pausedTotalSec ?? 0);
  const usedSec = Math.max(0, secondsBetween(attempt.startedAt, referenceTime) - priorPausedSec);

  return {
    startedAt: attempt.startedAt,
    expiresAt: deadline,
    limitSec,
    extraTimeSec: Number(attempt.extraTimeSec ?? 0),
    pausedSec,
    isPaused,
    usedSec,
    remainingSec,
    serverTime: now.toISOString(),
    warning: remainingSec != null && remainingSec <= WARN_AT_REMAINING_SEC && remainingSec > 0,
    critical: remainingSec != null && remainingSec <= 60 && remainingSec > 0,
    expired: remainingSec === 0,
    autoSubmitted: Boolean(attempt.autoSubmitted),
  };
}

/** Persist the derived clock columns right after an attempt starts. */
async function startClock(attemptId, { accessibilityExtraSec = 0 } = {}) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const now = new Date();
  const startedAt = attempt.status === 'IN_PROGRESS' && attempt.startedAt ? attempt.startedAt : now;
  const extraTimeSec = Number(attempt.extraTimeSec ?? 0) + Number(accessibilityExtraSec ?? 0);
  const projected = { ...attempt, startedAt, extraTimeSec };
  const deadline = computeDeadline(projected, attempt.exam, now);

  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      status: 'IN_PROGRESS',
      startedAt,
      timeLimitSec: computeLimitSec(projected, attempt.exam),
      extraTimeSec,
      expiresAt: deadline,
      remainingTimeSec: deadline ? secondsBetween(now, deadline) : null,
      resumedAt: null,
      pausedAt: null,
      lastActivityAt: now,
    },
  });

  return { attempt: updated, timer: timeSnapshot(updated, attempt.exam, now) };
}

/**
 * Periodic sync from the client. Returns the authoritative remaining time and
 * flags a client clock that is running slow (a classic "freeze the timer"
 * tamper attempt).
 */
async function syncTimer(attempt, { clientRemainingSec = null, clientElapsedSec = null } = {}) {
  const now = new Date();
  const exam = attempt.exam ?? await prisma.exam.findUnique({ where: { id: attempt.examId } });
  const snapshot = timeSnapshot(attempt, exam, now);

  const reported = clientRemainingSec != null ? Number(clientRemainingSec) : snapshot.limitSec - Number(clientElapsedSec ?? 0);
  const driftSec = Number.isFinite(reported) ? reported - snapshot.remainingSec : 0;
  const suspiciousDrift = driftSec > MAX_CLIENT_DRIFT_SEC;

  const data = {
    usedTimeSec: snapshot.usedSec,
    remainingTimeSec: snapshot.remainingSec,
    lastActivityAt: now,
  };

  if (suspiciousDrift) {
    data.metadata = {
      ...(attempt.metadata ?? {}),
      timerDrift: {
        detectedAt: now.toISOString(),
        clientRemainingSec: reported,
        serverRemainingSec: snapshot.remainingSec,
        driftSec: Math.round(driftSec),
      },
    };
    logger.warn('candidate timer drift detected', {
      attemptId: attempt.id,
      userId: attempt.userId,
      driftSec: Math.round(driftSec),
    });
  }

  await prisma.attempt.update({ where: { id: attempt.id }, data }).catch((error) => {
    logger.debug('timer sync write skipped', { attemptId: attempt.id, error: error.message });
  });

  return { ...snapshot, driftSec: Math.round(driftSec), suspiciousDrift };
}

/** Proctor-initiated or self-initiated pause (only allowed if the exam permits). */
async function pauseAttempt(attemptId, { reason = 'CANDIDATE_REQUEST', note = null } = {}, actor = null) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (attempt.status !== 'IN_PROGRESS') throw ApiError.locked(`Cannot pause an attempt that is ${attempt.status.toLowerCase()}`);

  const allowed = attempt.exam.settings?.allowCandidatePause === true || ['ORG_ADMIN', 'PROCTOR'].includes(actor?.orgRole);
  if (!allowed) throw ApiError.forbidden('This exam does not allow pausing');

  const now = new Date();
  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: { status: 'PAUSED', pausedAt: now, remainingTimeSec: timeSnapshot(attempt, attempt.exam, now).remainingSec },
  });

  logger.info('attempt paused', { attemptId, actorId: actor?.userId ?? null, reason });
  return { attempt: updated, timer: timeSnapshot(updated, attempt.exam, now), reason, note };
}

/** Resuming shifts the deadline by however long the pause lasted. */
async function resumeAttempt(attemptId, actor = null) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (attempt.status !== 'PAUSED') throw ApiError.locked('This attempt is not paused');

  const now = new Date();
  const pausedSec = computePausedSec({ ...attempt, resumedAt: now }, now);
  const metadata = { ...(attempt.metadata ?? {}), pausedTotalSec: pausedSec };
  const deadline = computeDeadline({ ...attempt, metadata, pausedAt: null, resumedAt: now }, attempt.exam, now);

  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: { status: 'IN_PROGRESS', resumedAt: now, expiresAt: deadline, metadata, remainingTimeSec: secondsBetween(now, deadline ?? now) },
  });

  logger.info('attempt resumed', { attemptId, actorId: actor?.userId ?? null, pausedSec });
  return { attempt: updated, timer: timeSnapshot(updated, attempt.exam, now), pausedSec };
}

/** Proctor grants additional time; the candidate keeps working on the new clock. */
async function grantExtraTime(attemptId, { extraTimeSec, reason }, actor = null) {
  const seconds = Number(extraTimeSec);
  if (!Number.isFinite(seconds) || seconds === 0) throw ApiError.badRequest('extraTimeSec must be a non-zero number of seconds');

  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (['SUBMITTED', 'GRADED', 'AUTO_SUBMITTED', 'TERMINATED'].includes(attempt.status)) {
    throw ApiError.locked('The attempt is already finished');
  }

  const now = new Date();
  const extra = Number(attempt.extraTimeSec ?? 0) + seconds;
  const deadline = computeDeadline({ ...attempt, extraTimeSec: extra }, attempt.exam, now);

  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      extraTimeSec: extra,
      expiresAt: deadline,
      remainingTimeSec: deadline ? secondsBetween(now, deadline) : null,
      metadata: {
        ...(attempt.metadata ?? {}),
        timeAdjustments: [
          ...((attempt.metadata?.timeAdjustments ?? [])),
          { grantedAt: now.toISOString(), seconds, reason: reason ?? null, grantedById: actor?.userId ?? null },
        ],
      },
    },
  });

  logger.info('extra time granted', { attemptId, seconds, actorId: actor?.userId ?? null });
  return { attempt: updated, timer: timeSnapshot(updated, attempt.exam, now) };
}

/** Used by autosave/submit paths to reject late writes. */
function isExpired(attempt, exam = null, now = new Date()) {
  const deadline = attempt.expiresAt ?? (exam ? computeDeadline(attempt, exam, now) : null);
  if (!deadline) return false;
  return new Date(deadline).getTime() <= now.getTime();
}

/** Remaining seconds, or null for untimed practice exams. */
function remainingSeconds(attempt, exam = null, now = new Date()) {
  const deadline = attempt.expiresAt ?? (exam ? computeDeadline(attempt, exam, now) : null);
  if (!deadline) return null;
  return Math.max(0, secondsBetween(now, deadline));
}

/**
 * Attempts whose clock ran out. The auto-submit job submits them through
 * attempt.service (this module deliberately does not depend on it).
 */
async function findExpiredAttempts({ graceSec = 0, limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - graceSec * SECOND);
  return prisma.attempt.findMany({
    where: {
      status: { in: ['IN_PROGRESS', 'PAUSED'] },
      expiresAt: { not: null, lte: cutoff },
    },
    include: { exam: { select: { id: true, title: true, endsAt: true, settings: true } } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });
}

/** Countdown milestones that deserve a nudge (15/5/1 minutes left). */
function warningThresholds(exam) {
  const configured = exam?.settings?.timerWarningsSec;
  if (Array.isArray(configured) && configured.length) {
    return configured.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
  }
  return [900, 300, 60];
}

/** Which warnings have already passed for a given remaining time. */
function dueWarnings(previousRemainingSec, remainingSec, exam) {
  if (previousRemainingSec == null || remainingSec == null) return [];
  return warningThresholds(exam).filter(
    (threshold) => remainingSec <= threshold && previousRemainingSec > threshold,
  );
}

/** Per-question timing for `perQuestionSec` exams (Kahoot-style). */
function questionDeadline(attempt, exam, questionOrder) {
  if (!exam?.perQuestionSec || !attempt?.startedAt) return null;
  const perQuestion = Number(exam.perQuestionSec);
  const startedAt = new Date(attempt.startedAt).getTime();
  const offsetSec = (Number(questionOrder ?? 1) - 1) * perQuestion;
  return {
    perQuestionSec: perQuestion,
    opensAt: new Date(startedAt + offsetSec * SECOND),
    closesAt: new Date(startedAt + (offsetSec + perQuestion) * SECOND),
  };
}

module.exports = {
  MAX_CLIENT_DRIFT_SEC,
  WARN_AT_REMAINING_SEC,
  computeDeadline,
  computeLimitSec,
  computePausedSec,
  dueWarnings,
  findExpiredAttempts,
  grantExtraTime,
  isExpired,
  pauseAttempt,
  questionDeadline,
  remainingSeconds,
  resumeAttempt,
  secondsBetween,
  startClock,
  syncTimer,
  timeSnapshot,
  warningThresholds,
};
