/**
 * Socket.io gateway.
 *
 * A single Socket.io server shares the HTTP port with the REST API. It owns
 * three cross-cutting concerns and then hands the per-feature event wiring off
 * to the sibling `*.socket` modules:
 *
 *   1. authentication — the client passes a Clerk session JWT in
 *      `socket.handshake.auth.token` (or `?token=`); we verify it, resolve the
 *      local `User`, and stash a compact identity on `socket.data`.
 *   2. room membership — every authenticated socket joins its personal room
 *      (`user:<id>`) and one room per organization membership (`org:<id>`), so
 *      services can target a person or a whole tenant without tracking socket
 *      ids.
 *   3. the outbound helpers `emitToUser` / `emitToRoom` that
 *      notification.service lazy-requires to fan events out after a DB write.
 *
 * Room naming convention (shared with the services, keep in sync):
 *   user:<userId>                 personal inbox + direct exam notices
 *   org:<organizationId>          tenant-wide broadcasts / announcements
 *   exam:<examId>                 everyone participating in an exam
 *   exam:<examId>:proctors        the proctor watch grid for an exam
 *   live-quiz:<CODE>              a Kahoot-style live session
 */

const { Server } = require('socket.io');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { clerkClient, requireLocalUser } = require('../config/clerk');

const { registerExamHandlers } = require('./exam.socket');
const { registerProctoringHandlers } = require('./proctoring.socket');
const { registerNotificationHandlers } = require('./notification.socket');

/** The live Socket.io server, kept module-level so services can emit into it. */
let io = null;

function roomsFor(user) {
  const rooms = [`user:${user.id}`];
  for (const membership of user.memberships ?? []) {
    if (membership.organizationId) rooms.push(`org:${membership.organizationId}`);
  }
  return rooms;
}

/** Pull the bearer token from the handshake (auth object first, query second). */
function tokenFromHandshake(socket) {
  const auth = socket.handshake.auth ?? {};
  if (auth.token) return auth.token;
  const header = auth.Authorization || auth.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const query = socket.handshake.query ?? {};
  if (typeof query.token === 'string' && query.token) return query.token;
  return null;
}

async function authenticateSocket(socket, next) {
  try {
    const token = tokenFromHandshake(socket);
    if (!token) {
      // Anonymous sockets are allowed but stay in no privileged room; feature
      // handlers reject actions that need identity. Public live-quiz spectators
      // and the health ping use this path.
      socket.data.user = null;
      return next();
    }
    const payload = await clerkClient.tokens.verifyToken(token);
    const user = await requireLocalUser(payload.sub);
    socket.data.user = {
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      displayName: user.displayName,
      platformRole: user.platformRole,
      memberships: (user.memberships ?? []).map((m) => ({ organizationId: m.organizationId, role: m.role })),
    };
    return next();
  } catch (error) {
    logger.debug('socket authentication failed', { error: error.message });
    // Still connect: handlers that require a user will deny the action. This
    // avoids tearing down the transport for e.g. an expired token mid-quiz.
    socket.data.user = null;
    return next();
  }
}

function initSocket(server) {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || env.corsOrigins.includes(origin) || env.corsOrigins.includes('*')) return callback(null, true);
        return callback(new Error('CORS origin not allowed'));
      },
      credentials: true,
    },
    pingInterval: 25_000,
    pingTimeout: 60_000,
    maxHttpBufferSize: 1e6,
    transports: ['websocket', 'polling'],
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const user = socket.data.user;
    if (user) {
      for (const room of roomsFor(user)) socket.join(room);
      socket.emit('socket:connected', { userId: user.id, rooms: roomsFor(user) });
    } else {
      socket.emit('socket:connected', { userId: null, anonymous: true });
    }

    // Feature modules attach their own listeners to this socket.
    registerNotificationHandlers(io, socket);
    registerExamHandlers(io, socket);
    registerProctoringHandlers(io, socket);

    socket.on('error', (error) => logger.debug('socket error', { id: socket.id, error: error.message }));
    socket.on('disconnect', (reason) => logger.debug('socket disconnected', { id: socket.id, reason }));
  });

  logger.info('socket.io gateway ready');
  return io;
}

/** Emit to a single person's personal room. No-op before init or if offline. */
function emitToUser(userId, event, payload) {
  if (!io || !userId) return false;
  io.to(`user:${userId}`).emit(event, payload);
  return true;
}

/** Emit to an arbitrary named room (exam / org / live-quiz / proctor grid). */
function emitToRoom(room, event, payload) {
  if (!io || !room) return false;
  io.to(room).emit(event, payload);
  return true;
}

/** Relay to everyone in a room except the sender (presence-style updates). */
function emitToRoomExcept(socketId, room, event, payload) {
  if (!io || !room) return false;
  socketId ? io.to(room).except(socketId).emit(event, payload) : io.to(room).emit(event, payload);
  return true;
}

function getIo() {
  return io;
}

async function closeSocket() {
  if (!io) return;
  await new Promise((resolve) => io.close(() => resolve()));
  io = null;
}

module.exports = {
  authenticateSocket,
  closeSocket,
  emitToRoom,
  emitToRoomExcept,
  emitToUser,
  getIo,
  initSocket,
};
