import { io } from 'socket.io-client';

/**
 * Socket.io client singleton.
 *
 * One managed connection for the whole app (personal inbox, exam rooms, the
 * proctor watch grid, live-quiz sessions and WebRTC signalling all share it).
 * We keep the instance in module scope so any component or slice can reach it
 * without prop-drilling, and we funnel the Clerk token through the `auth`
 * handshake field the server's `authenticateSocket` reads.
 *
 * The server runs on the same origin as the API; in dev the Vite proxy relays
 * `/socket.io` (with ws upgrade) to :5000, so `VITE_SOCKET_URL` is optional.
 */

const url = import.meta.env.VITE_SOCKET_URL || undefined; // undefined → same origin

let socket = null;
let tokenProvider = async () => null;

export function configureSocket({ getToken } = {}) {
  if (typeof getToken === 'function') tokenProvider = getToken;
}

export function connectSocket() {
  if (socket?.connected || socket?.active) return socket;

  socket = io(url, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    reconnectionAttempts: Infinity,
    auth: { token: null },
  });

  // Re-attach the freshest Clerk token on every (re)connection attempt.
  socket.on('connect', async () => {
    try {
      const token = await tokenProvider();
      if (token) {
        socket.auth = { token };
        socket.disconnect();
        socket.connect();
      }
    } catch {
      /* stay connected anonymously */
    }
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/**
 * Ack-aware request. The server's inbound handlers (`exam:join`, `exam:sync`,
 * `proctor:watch`, `proctor:monitor`, `live-quiz:join`, …) all answer through a
 * socket.io acknowledgement callback, so we wrap that in a promise for hooks
 * that need the returned snapshot/runtime. Resolves with the ack payload, or
 * `{ ok:false, error }` when there is no live socket or the server never acks.
 */
export function socketRequest(event, payload = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ ok: false, error: 'socket-not-connected' });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'ack-timeout' });
    }, timeoutMs);
    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response ?? { ok: true });
    });
  });
}

/** Convenience wrappers around the server's room join/leave contracts. */
export const joinExamRoom = (payload) => socketRequest('exam:join', payload);
export const leaveExamRoom = (payload) => socketRequest('exam:leave', payload);
export const watchProctorExam = (payload) => socketRequest('proctor:watch', payload);
export const unwatchProctorExam = (payload) => socketRequest('proctor:unwatch', payload);
export const monitorCandidate = (payload) => socketRequest('proctor:monitor', payload);
export const joinLiveQuiz = (payload) => socketRequest('live-quiz:join', payload);
export const leaveLiveQuiz = (payload) => socketRequest('live-quiz:leave', payload);

export function emitSocket(event, payload, ack) {
  if (!socket) return;
  if (typeof ack === 'function') socket.emit(event, payload, ack);
  else socket.emit(event, payload);
}

/** Subscribe a handler and return its unsubscribe function (for useEffect). */
export function onSocket(event, handler) {
  if (!socket) return () => {};
  socket.on(event, handler);
  return () => socket.off(event, handler);
}

export function socketConnected() {
  return Boolean(socket?.connected);
}
