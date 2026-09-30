/**
 * Proctoring socket handlers.
 *
 * The live proctor watch grid and the WebRTC signalling plane:
 *
 *   1. `proctor:watch` verifies the caller is staff (ORG_ADMIN / INSTRUCTOR /
 *      PROCTOR, or a platform SUPER_ADMIN) on the exam's organization, joins the
 *      `exam:<examId>:proctors` room the services already broadcast violations,
 *      presence and message events into, and replays a fresh dashboard snapshot.
 *
 *   2. WebRTC signalling (`webrtc:signal`) relays offer / answer / ICE between a
 *      candidate socket and a proctor socket. The server never touches media —
 *      it only forwards SDP/candidate blobs to the target's personal room, which
 *      is why we route by `toUserId` (room `user:<id>`) or an explicit room name.
 *
 * Authorization is delegated to `proctoring.service` (assertStaff inside
 * proctorDashboard / candidateMonitorState) as the authoritative check; the
 * membership test here is a cheap pre-filter so we never hand another tenant's
 * dashboard to the wrong proctor.
 */

const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const proctoring = require('../services/proctoring.service');

const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];

function actorFrom(socket, organizationId) {
  const user = socket.data.user;
  const membership = user?.memberships?.find((m) => m.organizationId === organizationId);
  return {
    userId: user?.id ?? null,
    organizationId: organizationId ?? null,
    role: membership?.role ?? null,
    platformRole: user?.platformRole ?? null,
  };
}

function isStaffOn(user, organizationId) {
  if (!user) return false;
  if (user.platformRole === 'SUPER_ADMIN') return true;
  const membership = user.memberships?.find((m) => m.organizationId === organizationId);
  return Boolean(membership && STAFF_ROLES.includes(membership.role));
}

async function watchExam(socket, payload = {}, ack) {
  const user = socket.data.user;
  if (!user) return ack?.({ ok: false, error: 'unauthenticated' });
  const examId = payload.examId;
  if (!examId) return ack?.({ ok: false, error: 'examId required' });

  try {
    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, organizationId: true } });
    if (!exam) return ack?.({ ok: false, error: 'exam-not-found' });
    if (!isStaffOn(user, exam.organizationId)) return ack?.({ ok: false, error: 'forbidden' });

    const room = `exam:${examId}:proctors`;
    socket.join(room);
    socket.data.proctorRoom = room;

    const snapshot = await proctoring.proctorDashboard(examId, actorFrom(socket, exam.organizationId));
    return ack?.({ ok: true, room, snapshot });
  } catch (error) {
    logger.debug('proctor:watch failed', { error: error.message });
    return ack?.({ ok: false, error: error.message });
  }
}

async function unwatchExam(socket, payload = {}, ack) {
  const room = payload.examId ? `exam:${payload.examId}:proctors` : socket.data.proctorRoom;
  if (room) socket.leave(room);
  if (socket.data.proctorRoom === room) socket.data.proctorRoom = null;
  return ack?.({ ok: true, left: room ?? null });
}

async function monitorCandidate(socket, payload = {}, ack) {
  const user = socket.data.user;
  const attemptId = payload.attemptId;
  if (!user || !attemptId) return ack?.({ ok: false, error: 'unauthenticated-or-missing-attempt' });
  try {
    const session = await prisma.proctorSession.findUnique({
      where: { attemptId },
      select: { exam: { select: { organizationId: true } } },
    });
    if (!session) return ack?.({ ok: false, error: 'session-not-found' });
    if (!isStaffOn(user, session.exam.organizationId)) return ack?.({ ok: false, error: 'forbidden' });

    const state = await proctoring.candidateMonitorState(attemptId, actorFrom(socket, session.exam.organizationId));
    socket.join(`attempt:${attemptId}`);
    socket.data.monitoredAttemptId = attemptId;
    return ack?.({ ok: true, state });
  } catch (error) {
    logger.debug('proctor:monitor failed', { error: error.message });
    return ack?.({ ok: false, error: error.message });
  }
}

/**
 * Relay a WebRTC signalling envelope. The sender must be an authenticated
 * participant; we forward only to the explicitly named target (a user id) or a
 * room the sender is already a member of, so no one can spam an arbitrary room.
 */
async function relaySignal(io, socket, payload = {}, ack) {
  const sender = socket.data.user;
  const { to, toRoom, data } = payload;
  if (!sender) return ack?.({ ok: false, error: 'unauthenticated' });
  if (!data || typeof data !== 'object') return ack?.({ ok: false, error: 'invalid signal payload' });

  const envelope = { from: sender.id, fromDisplayName: sender.displayName ?? null, data };

  if (to) {
    io.to(`user:${to}`).emit('webrtc:signal', envelope);
    return ack?.({ ok: true, deliveredTo: `user:${to}` });
  }

  if (toRoom && socket.rooms.has(toRoom)) {
    io.to(toRoom).except(socket.id).emit('webrtc:signal', envelope);
    return ack?.({ ok: true, deliveredTo: toRoom });
  }

  return ack?.({ ok: false, error: 'no valid target' });
}

function registerProctoringHandlers(io, socket) {
  socket.on('proctor:watch', (payload, ack) => watchExam(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('proctor:unwatch', (payload, ack) => unwatchExam(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('proctor:monitor', (payload, ack) => monitorCandidate(socket, payload, typeof ack === 'function' ? ack : undefined));
  socket.on('webrtc:signal', (payload, ack) => relaySignal(io, socket, payload, typeof ack === 'function' ? ack : undefined));
}

module.exports = { registerProctoringHandlers };
