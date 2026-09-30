/**
 * Exam + live-quiz socket handlers.
 *
 * Two realtime surfaces live here:
 *
 *   1. The taking-exam room `exam:<examId>` — a candidate joins after we have
 *      verified they own the attempt (or are staff / have valid access), and we
 *      immediately replay their runtime state so a refresh or reconnect restores
 *      the exact question, timer and saved answers without a REST bootstrap.
 *
 *   2. The Kahoot-style `live-quiz:<CODE>` room — delegated to attempt.service's
 *      join/leave so the same participant accounting and leaderboard logic
 *      backs both the socket and the REST entry points.
 *
 * Proctor-only events (violations, the watch grid, WebRTC) are in
 * proctoring.socket.js; this module only ever handles the participant side.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const attemptService = require('../services/attempt.service');
const examService = require('../services/exam.service');

/** Build the minimal actor the attempt/exam services expect. */
function actorFrom(socket) {
  const user = socket.data.user;
  return { userId: user?.id ?? null, organizationId: null, role: null, platformRole: user?.platformRole ?? null };
}

/** Does this user own the attempt, or is a staff member of its organization? */
async function canAccessAttempt(attempt, user) {
  if (!attempt || !user) return false;
  if (attempt.userId === user.id) return true;
  if (user.platformRole === 'SUPER_ADMIN') return true;
  const staff = user.memberships?.find((m) => m.organizationId === attempt.organizationId);
  return Boolean(staff && ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'].includes(staff.role));
}

async function joinExamRoom(socket, payload = {}, ack) {
  const user = socket.data.user;
  if (!user) return ack?.({ ok: false, error: 'unauthenticated' });

  try {
    const { attemptId, examId: providedExamId } = payload;

    if (attemptId) {
      const attempt = await prisma.attempt.findUnique({
        where: { id: attemptId },
        include: { exam: { select: { id: true, organizationId: true, title: true, isProctored: true, settings: true } } },
      });
      if (!attempt) return ack?.({ ok: false, error: 'attempt-not-found' });
      if (!(await canAccessAttempt(attempt, user))) return ack?.({ ok: false, error: 'forbidden' });

      const examRoom = `exam:${attempt.examId}`;
      socket.join(examRoom);
      socket.data.examRoom = examRoom;
      socket.data.attemptId = attempt.id;

      const runtime = await attemptService.getRuntimeState(attempt.id, { actor: actorFrom(socket), exam: attempt.exam });
      socket.emit('exam:state', runtime);
      return ack?.({ ok: true, joined: examRoom, runtime });
    }

    // No attempt yet — a candidate previewing / registering for an exam room.
    if (providedExamId) {
      const exam = await prisma.exam.findUnique({ where: { id: providedExamId } });
      if (!exam) return ack?.({ ok: false, error: 'exam-not-found' });
      const allowed = await examService
        .checkAccess(exam, { userId: user.id, accessCode: payload.accessCode ?? null, inviteToken: payload.inviteToken ?? null, requireWindow: false })
        .then(() => true)
        .catch(() => false);
      if (!allowed) return ack?.({ ok: false, error: 'forbidden' });

      const examRoom = `exam:${exam.id}`;
      socket.join(examRoom);
      socket.data.examRoom = examRoom;
      return ack?.({ ok: true, joined: examRoom });
    }

    return ack?.({ ok: false, error: 'examId or attemptId required' });
  } catch (error) {
    logger.debug('exam:join failed', { error: error.message });
    return ack?.({ ok: false, error: error.message });
  }
}

async function leaveExamRoom(socket, payload = {}, ack) {
  const room = payload.examId ? `exam:${payload.examId}` : socket.data.examRoom;
  if (room) socket.leave(room);
  if (socket.data.examRoom === room) socket.data.examRoom = null;
  return ack?.({ ok: true, left: room ?? null });
}

async function syncRuntime(socket, payload = {}, ack) {
  const user = socket.data.user;
  const attemptId = payload.attemptId ?? socket.data.attemptId;
  if (!user || !attemptId) return ack?.({ ok: false, error: 'unauthenticated-or-missing-attempt' });
  try {
    const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, include: { exam: true } });
    if (!(await canAccessAttempt(attempt, user))) return ack?.({ ok: false, error: 'forbidden' });
    const runtime = await attemptService.getRuntimeState(attemptId, { actor: actorFrom(socket), exam: attempt.exam });
    return ack?.({ ok: true, runtime });
  } catch (error) {
    return ack?.({ ok: false, error: error.message });
  }
}

async function joinLiveQuiz(socket, payload = {}, ack) {
  const user = socket.data.user;
  if (!user) return ack?.({ ok: false, error: 'unauthenticated' });
  const code = String(payload.code ?? '').trim();
  if (!code) return ack?.({ ok: false, error: 'code required' });
  try {
    const result = await attemptService.joinLiveQuiz(code, { displayName: payload.displayName ?? null, teamId: payload.teamId ?? null }, actorFrom(socket));
    const room = `live-quiz:${code.toUpperCase()}`;
    socket.join(room);
    socket.data.liveQuizRoom = room;
    return ack?.({ ok: true, room, session: result });
  } catch (error) {
    logger.debug('live-quiz:join failed', { error: error.message });
    return ack?.({ ok: false, error: error.message });
  }
}

async function leaveLiveQuiz(socket, payload = {}, ack) {
  const code = String(payload.code ?? '').trim();
  const user = socket.data.user;
  if (code && user) {
    await attemptService.leaveLiveQuiz(code, actorFrom(socket)).catch(() => null);
  }
  const room = code ? `live-quiz:${code.toUpperCase()}` : socket.data.liveQuizRoom;
  if (room) socket.leave(room);
  if (socket.data.liveQuizRoom === room) socket.data.liveQuizRoom = null;
  return ack?.({ ok: true, left: room ?? null });
}

function registerExamHandlers(io, socket) {
  socket.on('exam:join', (payload, ack) => joinExamRoom(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('exam:leave', (payload, ack) => leaveExamRoom(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('exam:sync', (payload, ack) => syncRuntime(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('live-quiz:join', (payload, ack) => joinLiveQuiz(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('live-quiz:leave', (payload, ack) => leaveLiveQuiz(socket, payload, typeof ack === 'function' ? ack : undefined));
}

module.exports = { registerExamHandlers };
