/**
 * Proctoring service.
 *
 * Owns the three phases of a supervised exam:
 *
 * 1. Setup    - system check, ID/selfie/environment capture, terms consent. When
 *               the exam is proctored the attempt's clock is deliberately parked
 *               (`attempt.metadata.pendingProctorSetup`) and only started here,
 *               so reading instructions never eats exam time.
 * 2. Monitoring - violation capture (with dedupe), risk scoring, realtime
 *               proctor dashboard, chat, and the staff overrides (pause, resume,
 *               extra time, terminate).
 * 3. Review   - recordings, the violation gallery and the post-exam queue a human
 *               works through, optionally enriched by the AI risk analysis.
 *
 * WebRTC media itself flows peer-to-peer; this service only stores the evidence
 * (screenshots, ID documents, MediaRecorder segments) on local disk through
 * `config/multer.js`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const timer = require('./timer.service');
const attemptService = require('./attempt.service');
const { PROCTORING_DEFAULTS } = require('./exam.service');
const { broadcastToProctors, notifyUser, pushToRoom, pushToUser } = require('./notification.service');

const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];

/** Mirrors the Prisma `ViolationType` enum - an unknown type is a client bug. */
const VIOLATION_TYPES = new Set([
  'TAB_SWITCH',
  'WINDOW_SWITCH',
  'FULLSCREEN_EXIT',
  'FACE_NOT_DETECTED',
  'MULTIPLE_FACES',
  'COPY_PASTE',
  'CUT_ATTEMPT',
  'RIGHT_CLICK',
  'KEYBOARD_SHORTCUT',
  'DEVTOOLS_OPENED',
  'SECOND_DEVICE',
  'AUDIO_DETECTED',
  'GAZE_ANOMALY',
  'NETWORK_ANOMALY',
  'MOVEMENT_DETECTED',
  'PROCTOR_FLAG',
  'AI_SUSPICION',
]);

const SEVERITIES = ['WARNING', 'MINOR', 'MAJOR', 'CRITICAL'];
const SEVERITY_RANK = { WARNING: 1, MINOR: 2, MAJOR: 3, CRITICAL: 4 };

/** Default severity per detector, overridable by the caller. */
const DEFAULT_SEVERITY = {
  TAB_SWITCH: 'MINOR',
  WINDOW_SWITCH: 'MINOR',
  FULLSCREEN_EXIT: 'MAJOR',
  FACE_NOT_DETECTED: 'MAJOR',
  MULTIPLE_FACES: 'CRITICAL',
  COPY_PASTE: 'MINOR',
  CUT_ATTEMPT: 'MINOR',
  RIGHT_CLICK: 'WARNING',
  KEYBOARD_SHORTCUT: 'WARNING',
  DEVTOOLS_OPENED: 'CRITICAL',
  SECOND_DEVICE: 'CRITICAL',
  AUDIO_DETECTED: 'MAJOR',
  GAZE_ANOMALY: 'MINOR',
  NETWORK_ANOMALY: 'MAJOR',
  MOVEMENT_DETECTED: 'WARNING',
  PROCTOR_FLAG: 'MAJOR',
  AI_SUSPICION: 'MAJOR',
};

const VIOLATION_LABELS = {
  TAB_SWITCH: 'Left the exam tab',
  WINDOW_SWITCH: 'Switched to another window',
  FULLSCREEN_EXIT: 'Exited fullscreen',
  FACE_NOT_DETECTED: 'No face in the camera frame',
  MULTIPLE_FACES: 'More than one face detected',
  COPY_PASTE: 'Copied or pasted during the exam',
  CUT_ATTEMPT: 'Attempted to cut content',
  RIGHT_CLICK: 'Right-click / context menu used',
  KEYBOARD_SHORTCUT: 'Blocked keyboard shortcut used',
  DEVTOOLS_OPENED: 'Developer tools opened',
  SECOND_DEVICE: 'Second device detected',
  AUDIO_DETECTED: 'Unexpected audio detected',
  GAZE_ANOMALY: 'Gaze away from the screen',
  NETWORK_ANOMALY: 'Suspicious network activity',
  MOVEMENT_DETECTED: 'Excessive movement detected',
  PROCTOR_FLAG: 'Flagged by a proctor',
  AI_SUSPICION: 'Flagged by the AI review',
};

/** How each severity feeds the 0-100 risk score. */
const RISK_WEIGHTS = { WARNING: 1, MINOR: 3, MAJOR: 8, CRITICAL: 15 };

/** Repeats of the same detector inside this window bump `count` instead of creating a row. */
const DEDUPE_WINDOW_MS = 15_000;

/** Base64 screenshots arrive from the client; only these may hit the disk. */
const IMAGE_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MESSAGE_KINDS = ['MESSAGE', 'WARNING', 'PAUSE', 'RESUME', 'TERMINATE', 'EXTRA_TIME', 'SYSTEM'];
const RECORDING_KINDS = ['WEBCAM', 'SCREEN', 'AUDIO_ANSWER', 'VIDEO_ANSWER'];
const RECORDING_MEDIA_KIND = {
  WEBCAM: 'WEBCAM_RECORDING',
  SCREEN: 'SCREEN_RECORDING',
  AUDIO_ANSWER: 'ANSWER_ATTACHMENT',
  VIDEO_ANSWER: 'ANSWER_ATTACHMENT',
};
const SESSION_OPEN_STATES = ['PENDING_SETUP', 'PENDING_REVIEW', 'ACTIVE'];

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Exam-level proctoring config merged over the platform defaults. */
function configFor(exam) {
  return { ...PROCTORING_DEFAULTS, ...((exam && exam.proctoringConfig) || {}) };
}

function isStaffActor(actor = {}) {
  if (actor.platformRole === 'SUPER_ADMIN') return true;
  return STAFF_ROLES.includes(actor.role) || STAFF_ROLES.includes(actor.platformRole);
}

/**
 * Staff may look at anyone inside their organization; a candidate may only look
 * at their own attempt.
 */
function assertSessionAccess(session, actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in to access the proctoring session');
  if (session.userId === actor.userId) return 'CANDIDATE';
  if (!isStaffActor(actor)) throw ApiError.forbidden('This session belongs to another candidate');
  if (actor.platformRole !== 'SUPER_ADMIN' && actor.organizationId && session.exam?.organizationId
    && session.exam.organizationId !== actor.organizationId) {
    throw ApiError.forbidden('This session belongs to another organization');
  }
  return actor.role ?? actor.platformRole ?? 'PROCTOR';
}

function assertStaff(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in to access the proctoring console');
  if (!isStaffActor(actor)) throw ApiError.forbidden('Proctoring actions require a staff role');
  return actor.role ?? actor.platformRole ?? 'PROCTOR';
}

const SESSION_READ_INCLUDE = {
  attempt: {
    select: {
      id: true,
      userId: true,
      examId: true,
      organizationId: true,
      status: true,
      gradingStatus: true,
      startedAt: true,
      expiresAt: true,
      submittedAt: true,
      pausedAt: true,
      resumedAt: true,
      usedTimeSec: true,
      remainingTimeSec: true,
      extraTimeSec: true,
      timeLimitSec: true,
      autoSubmitted: true,
      answeredCount: true,
      violationCount: true,
      riskScore: true,
      isFlagged: true,
      isTerminated: true,
      currentSectionId: true,
      currentQuestionOrder: true,
      lastActivityAt: true,
      metadata: true,
      user: { select: { id: true, displayName: true, email: true, imageUrl: true } },
    },
  },
  exam: { select: { id: true, title: true, slug: true, organizationId: true, proctoringConfig: true, settings: true, durationMinutes: true, perQuestionSec: true, questionCount: true, startsAt: true, endsAt: true } },
  reviewedBy: { select: { id: true, displayName: true } },
  _count: { select: { violations: true, recordings: true, messages: true } },
};

const VIOLATION_READ_SELECT = {
  id: true,
  attemptId: true,
  examId: true,
  userId: true,
  type: true,
  severity: true,
  occurredAt: true,
  count: true,
  description: true,
  evidenceUrls: true,
  screenshotUrl: true,
  details: true,
  isResolved: true,
  resolvedAt: true,
  resolution: true,
  aiRiskScore: true,
  aiReason: true,
  manualFlag: true,
  createdAt: true,
};

/** Load a session by attempt id, with the exam + candidate context attached. */
async function sessionFor(attemptId) {
  const session = await prisma.proctorSession.findUnique({
    where: { attemptId },
    include: SESSION_READ_INCLUDE,
  });
  if (!session) throw ApiError.notFound('No proctoring session for this attempt');
  return deserialiseSession(session);
}

async function sessionById(sessionId) {
  const session = await prisma.proctorSession.findUnique({ where: { id: sessionId }, include: SESSION_READ_INCLUDE });
  if (!session) throw ApiError.notFound('Proctoring session not found');
  return deserialiseSession(session);
}

/**
 * Persist a base64 data URL that the client captured (violation screenshot,
 * webcam snapshot) into the local uploads tree.
 */
function writeDataUrl(dataUrl, category = 'proctoring') {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl));
  if (!match) throw ApiError.badRequest('Expected a base64 data URL');
  const mimeType = match[1].toLowerCase();
  const extension = IMAGE_EXT_BY_MIME[mimeType];
  if (!extension) throw ApiError.badRequest(`Unsupported screenshot type "${mimeType}"`);

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.byteLength) throw ApiError.badRequest('Screenshot is empty');
  if (buffer.byteLength > env.maxFileBytes) {
    throw ApiError.badRequest('Screenshot exceeds the upload size limit', { maxBytes: env.maxFileBytes });
  }

  const now = new Date();
  const relativeDir = path.posix.join(category, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  const absoluteDir = path.join(env.uploadRoot, relativeDir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
  const storagePath = path.join(absoluteDir, fileName);
  fs.writeFileSync(storagePath, buffer);

  return { url: `/uploads/${relativeDir}/${fileName}`, storagePath, mimeType, sizeBytes: buffer.byteLength };
}

/**
 * Register a file that is already on disk in `UploadedFile`, so the cleanup job
 * can find orphans. Bookkeeping only - never fail a proctoring action over it.
 */
async function registerMedia(
  { url, storagePath, mimeType, sizeBytes },
  { kind, userId = null, organizationId = null, examId = null, attemptId = null, metadata = {} } = {},
) {
  if (!url) return null;
  try {
    const row = await prisma.uploadedFile.create({
      data: {
        userId,
        organizationId,
        examId,
        attemptId,
        kind,
        url,
        storagePath: storagePath ?? '',
        originalName: path.basename(storagePath ?? url),
        mimeType: mimeType ?? 'application/octet-stream',
        sizeBytes: Number(sizeBytes ?? 0),
        metadata,
      },
    });
    return row.id;
  } catch (error) {
    logger.warn('uploadedFile bookkeeping failed', { kind, url, error: error.message });
    return null;
  }
}

/** Accept either a public URL or an inline data URL for every evidence field. */
function evidenceFrom(value, category) {
  if (value === undefined || value === null || value === '') return null;
  const asString = String(value);
  if (asString.startsWith('data:')) {
    const saved = writeDataUrl(asString, category);
    return saved;
  }
  if (asString.startsWith('http://') || asString.startsWith('https://') || asString.startsWith('/uploads/')) {
    return { url: asString, storagePath: null, mimeType: null, sizeBytes: null };
  }
  throw ApiError.badRequest('Media must be a hosted URL or a base64 data URL');
}

function deserialiseSession(session) {
  if (!session) return session;
  const out = { ...session };
  if (out.faceMatchScore != null) out.faceMatchScore = Number(out.faceMatchScore);
  if (out.attempt) {
    out.attempt = { ...out.attempt };
    for (const field of ['riskScore']) {
      if (out.attempt[field] != null) out.attempt[field] = Number(out.attempt[field]);
    }
  }
  return out;
}

function deserialiseViolation(violation) {
  if (!violation) return violation;
  const out = { ...violation };
  if (out.aiRiskScore != null) out.aiRiskScore = Number(out.aiRiskScore);
  out.label = VIOLATION_LABELS[out.type] ?? out.type;
  return out;
}

/** Human summary the dashboard and the chat both use. */
function violationText(type, count) {
  const label = VIOLATION_LABELS[type] ?? 'A policy violation';
  return count > 1 ? `${label} (${count}x)` : label;
}

// ---------------------------------------------------------------------------
// Candidate setup
// ---------------------------------------------------------------------------

/**
 * What the client has to collect before the clock may start. Returned by
 * `GET /attempts/:id/proctoring/requirements` and rendered by
 * `components/proctoring/ProctorSetup.jsx`.
 */
async function setupRequirements(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  if (session.userId !== actor.userId && !isStaffActor(actor)) {
    throw ApiError.forbidden('This session belongs to another candidate');
  }

  const config = configFor(session.exam);
  const idVerification = config.idVerification ?? 'NONE';

  const checklist = [
    { key: 'camera', label: 'Working camera', required: Boolean(config.requireCamera) || Boolean(config.recordWebcam) || Boolean(config.faceDetection) || idVerification !== 'NONE' },
    { key: 'microphone', label: 'Working microphone', required: Boolean(config.requireMicrophone) || Boolean(config.audioAnalysis) },
    { key: 'screenShare', label: 'Screen sharing support', required: Boolean(config.requireScreenShare) || Boolean(config.recordScreen) },
    { key: 'idDocument', label: 'Photo identity document', required: idVerification !== 'NONE' },
    { key: 'idDocumentBack', label: 'Back of the identity document', required: idVerification === 'TWO_SIDED' },
    { key: 'selfie', label: 'Selfie for identity matching', required: idVerification !== 'NONE' || Boolean(config.faceDetection) },
    { key: 'environment', label: '360 degree environment scan', required: Boolean(config.environmentScan) },
    { key: 'terms', label: 'Accept the proctoring terms', required: true },
    { key: 'recordingConsent', label: 'Consent to be recorded', required: Boolean(config.recordWebcam) || Boolean(config.recordScreen) },
    { key: 'fullscreen', label: 'Stay in fullscreen for the whole exam', required: Boolean(config.fullscreenRequired) },
    { key: 'lockdown', label: 'Browser lockdown mode', required: Boolean(config.lockdownEnabled ?? config.lockdownBrowser) },
  ];

  return {
    attemptId,
    sessionId: session.id,
    examId: session.examId,
    examTitle: session.exam?.title ?? null,
    status: session.status,
    level: config.level,
    config,
    checklist: checklist.map((item) => ({ ...item, done: item.key === 'terms' ? session.termsAccepted : hasSetupArtifact(session, item.key) })),
    systemCheckDefaults: session.systemCheck ?? {},
    requiresProctorReview: idVerification === 'MANUAL',
    terms: {
      recordsVideo: Boolean(config.recordWebcam),
      recordsScreen: Boolean(config.recordScreen),
      aiReview: Boolean(config.aiProctorReview),
      autoTerminateAfterCritical: Number(config.autoTerminateAfterCritical ?? 0),
    },
  };
}

/** Whether a checklist artifact already exists on the session row. */
function hasSetupArtifact(session, key) {
  switch (key) {
    case 'camera':
      return Boolean(session.systemCheck?.camera);
    case 'microphone':
      return Boolean(session.systemCheck?.microphone);
    case 'screenShare':
      return Boolean(session.systemCheck?.screenShare);
    case 'idDocument':
      return Boolean(session.idDocFrontUrl);
    case 'idDocumentBack':
      return Boolean(session.idDocBackUrl);
    case 'selfie':
      return Boolean(session.selfieUrl);
    case 'environment':
      return Array.isArray(session.environmentUrls) && session.environmentUrls.length > 0;
    case 'recordingConsent':
      return Boolean(session.recordingConsent);
    case 'fullscreen':
      return Boolean(session.fullscreenRequired);
    case 'lockdown':
      return Boolean(session.lockdownEnabled);
    default:
      return false;
  }
}

/**
 * Finish the pre-exam checks and start the clock.
 *
 * Every requirement is enforced server-side: the client's `systemCheck` is only
 * a claim, so a missing camera when the exam needs one is a hard 422 rather than
 * something the candidate can walk past.
 */
async function completeProctorSetup(attemptId, payload = {}, actor = {}) {
  const session = await sessionFor(attemptId);
  if (session.userId !== actor.userId) throw ApiError.forbidden('Only the candidate can complete this setup');
  if (session.status === 'ACTIVE') return { attemptId, sessionId: session.id, status: 'ACTIVE', alreadyStarted: true };
  if (!['PENDING_SETUP', 'REJECTED'].includes(session.status)) {
    throw ApiError.conflict('This proctoring session cannot be started from its current state', { status: session.status });
  }
  if (session.attempt?.status !== 'IN_PROGRESS') {
    throw ApiError.conflict('The attempt is no longer available', { status: session.attempt?.status ?? null });
  }

  const config = configFor(session.exam);
  const idVerification = config.idVerification ?? 'NONE';
  const systemCheck = normaliseSystemCheck(payload.systemCheck ?? payload.deviceCheck ?? {});
  const browserInfo = normaliseBrowserInfo(payload.browserInfo ?? payload.browser ?? {});
  const failures = [];

  if ((config.requireCamera || config.recordWebcam || config.faceDetection || idVerification !== 'NONE') && !systemCheck.camera) {
    failures.push('A working camera is required for this exam');
  }
  if ((config.requireMicrophone || config.audioAnalysis) && !systemCheck.microphone) {
    failures.push('A working microphone is required for this exam');
  }
  if ((config.requireScreenShare || config.recordScreen) && !systemCheck.screenShare) {
    failures.push('This exam requires screen sharing support in your browser');
  }

  const idFront = idVerification !== 'NONE' ? evidenceFrom(payload.idDocFront ?? payload.idDocFrontUrl, 'proctoring') : null;
  const idBack = idVerification === 'TWO_SIDED' ? evidenceFrom(payload.idDocBack ?? payload.idDocBackUrl, 'proctoring') : null;
  const selfie = (idVerification !== 'NONE' || config.faceDetection) ? evidenceFrom(payload.selfie ?? payload.selfieUrl, 'proctoring') : null;
  const environment = config.environmentScan
    ? [payload.environment ?? payload.environmentUrls].flat().filter(Boolean)
    : [];

  if (idVerification !== 'NONE' && !idFront) failures.push('A photo of your identity document is required');
  if (idVerification === 'TWO_SIDED' && !idBack) failures.push('The back of your identity document is required');
  if ((idVerification !== 'NONE' || config.faceDetection) && !selfie) failures.push('A selfie photo is required');
  if (config.environmentScan && environment.length < 2) failures.push('Capture at least two views of your surroundings');

  if (!payload.termsAccepted) failures.push('You must accept the proctoring terms');
  if ((config.recordWebcam || config.recordScreen) && !payload.recordingConsent) {
    failures.push('This exam is recorded and requires your consent');
  }

  if (failures.length) {
    throw ApiError.validation(failures[0], { failures, requirements: failures });
  }

  const savedEnvironment = environment.map((item) => evidenceFrom(item, 'proctoring'));
  const faceMatchScore = await estimateFaceMatch({
    provided: payload.faceMatchScore,
    selfie: selfie?.url,
    idDocument: idFront?.url,
    config,
    attemptId,
    examId: session.examId,
    userId: session.userId,
  });

  const now = new Date();
  const needsHumanReview = idVerification === 'MANUAL';

  await prisma.proctorSession.update({
    where: { id: session.id },
    data: {
      status: needsHumanReview ? 'PENDING_REVIEW' : 'ACTIVE',
      systemCheck,
      browserInfo,
      idDocFrontUrl: idFront?.url ?? session.idDocFrontUrl ?? null,
      idDocBackUrl: idBack?.url ?? session.idDocBackUrl ?? null,
      selfieUrl: selfie?.url ?? session.selfieUrl ?? null,
      environmentUrls: savedEnvironment.map((item) => item.url),
      faceMatchScore: faceMatchScore == null ? undefined : String(faceMatchScore),
      termsAccepted: true,
      termsAcceptedAt: session.termsAcceptedAt ?? now,
      recordingConsent: Boolean(payload.recordingConsent),
      lockdownEnabled: payload.lockdownEnabled === undefined ? Boolean(config.lockdownBrowser ?? true) : Boolean(payload.lockdownEnabled),
      fullscreenRequired: payload.fullscreenRequired === undefined ? Boolean(config.fullscreenRequired ?? true) : Boolean(payload.fullscreenRequired),
      startedAt: needsHumanReview ? session.startedAt : now,
      reviewNote: payload.setupNote ? String(payload.setupNote).slice(0, 2000) : session.reviewNote,
    },
  });

  for (const media of [idFront, idBack, selfie, ...savedEnvironment].filter(Boolean)) {
    await registerMedia(media, {
      kind: media === selfie ? 'SELFIE' : media === idFront || media === idBack ? 'ID_DOCUMENT' : 'ENVIRONMENT_SCAN',
      userId: session.userId,
      organizationId: session.attempt?.organizationId ?? session.exam?.organizationId ?? null,
      examId: session.examId,
      attemptId,
      metadata: { proctorSessionId: session.id },
    });
  }

  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      deviceInfo: browserInfo,
      metadata: { ...(session.attempt?.metadata ?? {}), proctorSetupAt: now.toISOString(), proctorLevel: config.level },
    },
  });

  if (needsHumanReview) {
    broadcastToProctors(session.examId, 'proctor:setup-pending', {
      attemptId,
      sessionId: session.id,
      candidate: session.attempt?.user?.displayName ?? null,
      faceMatchScore,
    });
    pushToUser(session.userId, 'proctor:awaiting-approval', { attemptId, sessionId: session.id });
    await notifyUser({
      userId: session.userId,
      type: 'PROCTOR_MESSAGE',
      title: 'Waiting for proctor approval',
      body: 'A proctor is verifying your identity. Your exam timer starts as soon as they approve.',
      actionUrl: `/exam/${attemptId}`,
    }).catch(() => null);
    return { attemptId, sessionId: session.id, status: 'PENDING_REVIEW', pendingReview: true, faceMatchScore };
  }

  const clock = await attemptService.beginClock(attemptId);
  broadcastToProctors(session.examId, 'proctor:session-active', {
    attemptId,
    sessionId: session.id,
    userId: session.userId,
    candidate: session.attempt?.user?.displayName ?? null,
    at: now.toISOString(),
  });

  logger.info('proctor setup completed', { attemptId, sessionId: session.id, level: config.level });
  return {
    attemptId,
    sessionId: session.id,
    status: 'ACTIVE',
    faceMatchScore,
    clock,
    runtime: await attemptService.getRuntimeState(attemptId, { actor }),
  };
}

/**
 * When ID verification is `MANUAL` a proctor has to approve the selfie/ID pair
 * before the candidate's clock starts.
 */
async function approveProctorSetup(sessionId, { note = null, faceMatchScore = null } = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionById(sessionId);
  if (session.status !== 'PENDING_REVIEW') {
    throw ApiError.conflict('This session is not waiting for review', { status: session.status });
  }

  const now = new Date();
  await prisma.proctorSession.update({
    where: { id: sessionId },
    data: {
      status: 'ACTIVE',
      startedAt: session.startedAt ?? now,
      reviewedById: actor.userId,
      reviewedAt: now,
      reviewNote: note ? String(note).slice(0, 2000) : session.reviewNote,
      faceMatchScore: faceMatchScore == null ? undefined : String(Number(faceMatchScore)),
    },
  });

  const clock = await attemptService.beginClock(session.attemptId);
  pushToUser(session.userId, 'proctor:approved', { attemptId: session.attemptId, clock });
  await notifyUser({
    userId: session.userId,
    type: 'PROCTOR_MESSAGE',
    title: 'Identity verified',
    body: 'Your proctor has approved your setup. Good luck!',
    actionUrl: `/exam/${session.attemptId}`,
  }).catch(() => null);
  broadcastToProctors(session.examId, 'proctor:session-active', { attemptId: session.attemptId, sessionId, approved: true });

  return { sessionId, status: 'ACTIVE', clock };
}

/** Rejecting a setup ends the attempt and tells the candidate why. */
async function rejectProctorSetup(sessionId, { reason = 'Identity verification failed', reviewNote = null } = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionById(sessionId);
  const now = new Date();

  await prisma.proctorSession.update({
    where: { id: sessionId },
    data: {
      status: 'REJECTED',
      reviewedById: actor.userId,
      reviewedAt: now,
      endedAt: now,
      reviewNote: String(reviewNote ?? reason).slice(0, 2000),
    },
  });

  await prisma.attempt.update({
    where: { id: session.attemptId },
    data: {
      status: 'ABANDONED',
      isFlagged: true,
      submittedAt: now,
      metadata: { ...(session.attempt?.metadata ?? {}), proctorRejected: { reason, at: now.toISOString(), by: actor.userId } },
    },
  });

  pushToUser(session.userId, 'proctor:rejected', { attemptId: session.attemptId, reason });
  await notifyUser({
    userId: session.userId,
    type: 'VIOLATION_FLAGGED',
    title: 'Your identity check was rejected',
    body: reason,
    actionUrl: `/results/${session.attemptId}`,
  }).catch(() => null);

  return { sessionId, status: 'REJECTED', reason };
}

/** A candidate may retry the setup when the browser check failed mid-way. */
async function retryProctorSetup(attemptId, { systemCheck = {}, browserInfo = {} } = {}, actor = {}) {
  const session = await sessionFor(attemptId);
  if (session.userId !== actor.userId) throw ApiError.forbidden('This session belongs to another candidate');
  if (session.status !== 'PENDING_SETUP') throw ApiError.conflict('This session has already moved past setup', { status: session.status });

  const updated = await prisma.proctorSession.update({
    where: { id: session.id },
    data: { systemCheck: normaliseSystemCheck(systemCheck), browserInfo: normaliseBrowserInfo(browserInfo) },
  });

  return { attemptId, sessionId: session.id, status: session.status, systemCheck: updated.systemCheck };
}

function normaliseSystemCheck(input = {}) {
  const bools = ['camera', 'microphone', 'screenShare', 'webgl', 'network', 'speakers', 'bandwidth', 'supported', 'fullscreen'];
  const out = {};
  for (const key of bools) {
    if (input[key] !== undefined) out[key] = Boolean(input[key]);
  }
  if (input.browser) out.browser = String(input.browser).slice(0, 120);
  if (input.version) out.version = String(input.version).slice(0, 60);
  if (input.os) out.os = String(input.os).slice(0, 120);
  if (input.resolution) out.resolution = String(input.resolution).slice(0, 40);
  if (input.megapixels != null) out.megapixels = Number(input.megapixels) || null;
  if (input.downlinkKbps != null) out.downlinkKbps = Number(input.downlinkKbps) || null;
  out.checkedAt = new Date().toISOString();
  return out;
}

function normaliseBrowserInfo(input = {}) {
  const allowed = ['userAgent', 'browser', 'version', 'os', 'platform', 'language', 'timezone', 'screen', 'viewport', 'touchCapable', 'extensions', 'webdriver'];
  const out = {};
  for (const key of allowed) {
    if (input[key] === undefined) continue;
    out[key] = typeof input[key] === 'object' ? input[key] : String(input[key]).slice(0, 240);
  }
  return out;
}

/**
 * Ask the AI layer for an ID-vs-selfie similarity. `ai.service` is optional and
 * expensive, so a missing module or a client-provided score both fall back
 * cleanly instead of blocking the exam.
 */
async function estimateFaceMatch({ provided, selfie, idDocument, config, attemptId, examId, userId }) {
  if (provided !== undefined && provided !== null && Number.isFinite(Number(provided))) {
    return Math.max(0, Math.min(100, Number(provided)));
  }
  if (!selfie || !idDocument || config.idVerification === 'NONE') return null;
  try {
    const ai = require('./ai.service');
    const result = await ai.faceMatchScore({ selfieUrl: selfie, documentUrl: idDocument, attemptId, examId, userId });
    const score = Number(result?.score ?? result);
    return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
  } catch (error) {
    logger.debug('face match skipped', { attemptId, error: error.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/**
 * Record something the candidate's browser (or a proctor, or the AI review)
 * detected.
 *
 * Three details matter:
 * - repeats of the same detector inside `DEDUPE_WINDOW_MS` bump `count` instead
 *   of creating rows, so an alt-tab flicker cannot flood the log;
 * - the attempt's `violationCount` and `riskScore` are recomputed from the rows,
 *   never trusted from the client;
 * - configured thresholds can auto-warn and auto-terminate, because nobody is
 *   guaranteed to be watching the dashboard live.
 */
async function recordViolation(attemptId, input = {}, actor = {}) {
  const type = String(input.type ?? '').toUpperCase();
  if (!VIOLATION_TYPES.has(type)) throw ApiError.badRequest(`Unknown violation type "${input.type}"`, { allowed: [...VIOLATION_TYPES] });

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { exam: { select: { id: true, title: true, organizationId: true, proctoringConfig: true, createdById: true } } },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');

  const isCandidate = attempt.userId === actor.userId;
  if (!isCandidate && !isStaffActor(actor)) throw ApiError.forbidden('You cannot report violations for this attempt');

  const config = configFor(attempt.exam);
  if (!allowedByConfig(type, config)) {
    return { recorded: false, reason: 'Detector disabled for this exam', attemptId, type };
  }
  if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
    return { recorded: false, reason: `Attempt is ${attempt.status}`, attemptId, type };
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw ApiError.badRequest('occurredAt is not a valid date');

  const severity = normaliseSeverity(input.severity, type, config);
  const manualFlag = input.manualFlag === true || type === 'PROCTOR_FLAG';
  const details = sanitiseDetails(input.details);
  const screenshot = evidenceFrom(input.screenshot ?? input.screenshotUrl, 'proctoring');
  const evidence = [input.evidence ?? input.evidenceUrls ?? []].flat().filter(Boolean).map((item) => evidenceFrom(item, 'proctoring').url);

  const session = await prisma.proctorSession.findUnique({ where: { attemptId }, select: { id: true } });

  // Collapse bursts of the same detector into one row.
  const windowStart = new Date(occurredAt.getTime() - DEDUPE_WINDOW_MS);
  const recent = await prisma.violation.findFirst({
    where: { attemptId, type, occurredAt: { gte: windowStart } },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, count: true, severity: true, screenshotUrl: true },
  });

  let violation;
  let incremented = 0;
  if (recent) {
    incremented = 1;
    violation = await prisma.violation.update({
      where: { id: recent.id },
      data: {
        count: recent.count + 1,
        occurredAt,
        severity: rankOf(severity) > rankOf(recent.severity) ? severity : recent.severity,
        evidenceUrls: evidence.length ? { push: evidence } : undefined,
        screenshotUrl: screenshot?.url ?? recent.screenshotUrl ?? undefined,
        details: { ...details, firstSeen: recent.occurredAt?.toISOString?.() ?? null },
      },
      select: VIOLATION_READ_SELECT,
    });
  } else {
    incremented = 1;
    violation = await prisma.violation.create({
      data: {
        attemptId,
        proctorSessionId: session?.id ?? null,
        examId: attempt.examId,
        userId: attempt.userId,
        type,
        severity,
        occurredAt,
        count: 1,
        description: input.description ? String(input.description).slice(0, 2000) : violationText(type, 1),
        evidenceUrls: evidence,
        screenshotUrl: screenshot?.url ?? null,
        details,
        aiRiskScore: input.aiRiskScore == null ? undefined : String(Number(input.aiRiskScore)),
        aiReason: input.aiReason ? String(input.aiReason).slice(0, 2000) : null,
        manualFlag,
      },
      select: VIOLATION_READ_SELECT,
    });
  }

  if (screenshot) {
    await registerMedia(screenshot, {
      kind: 'VIOLATION_SCREENSHOT',
      userId: attempt.userId,
      organizationId: attempt.organizationId ?? attempt.exam.organizationId ?? null,
      examId: attempt.examId,
      attemptId,
      metadata: { violationId: violation.id, type },
    });
  }

  const counters = await tallyViolations(attemptId);
  const riskScore = riskScoreFor(counters, config);
  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      violationCount: { increment: incremented },
      riskScore: String(riskScore),
      isFlagged: attempt.isFlagged || riskScore >= thresholdFlag(config) || severity === 'CRITICAL',
    },
    select: { id: true, violationCount: true, riskScore: true, isFlagged: true },
  });

  const payload = {
    attemptId,
    violationId: violation.id,
    type,
    severity,
    count: violation.count,
    label: violationText(type, violation.count),
    occurredAt: violation.occurredAt,
    screenshotUrl: violation.screenshotUrl,
    riskScore,
    totalViolations: updated.violationCount,
    candidate: { userId: attempt.userId },
  };

  broadcastToProctors(attempt.examId, 'proctor:violation', payload);
  pushToUser(attempt.userId, 'proctor:violation', { attemptId, type, severity, count: violation.count, message: violationText(type, violation.count) });

  let warned = null;
  const alertThreshold = Number(config.violationAlertThreshold ?? 0);
  if (alertThreshold > 0 && updated.violationCount === alertThreshold) {
    warned = await sendProctorMessage(attemptId, {
      kind: 'WARNING',
      body: `You have ${updated.violationCount} recorded violations. Please stay on the exam screen.`,
      metadata: { auto: true, reason: 'ALERT_THRESHOLD' },
    }, { userId: attempt.exam.createdById, role: 'PROCTOR', organizationId: attempt.exam.organizationId });
  }

  const enforcement = await enforceLimits(attemptId, { attempt, config, counters, updated });

  logger.info('violation recorded', { attemptId, type, severity, count: violation.count, riskScore });
  return {
    recorded: true,
    attemptId,
    violation: deserialiseViolation(violation),
    riskScore,
    totalViolations: updated.violationCount,
    isFlagged: updated.isFlagged,
    warned: Boolean(warned),
    enforcement,
  };
}

/** Which detectors the exam config actually turned on. */
function allowedByConfig(type, config) {
  switch (type) {
    case 'TAB_SWITCH':
      return Boolean(config.tabSwitchDetection);
    case 'WINDOW_SWITCH':
      return Boolean(config.tabSwitchDetection) || Boolean(config.windowSwitchDetection);
    case 'FULLSCREEN_EXIT':
      return Boolean(config.fullscreenRequired);
    case 'COPY_PASTE':
    case 'CUT_ATTEMPT':
      return Boolean(config.copyPasteDetection);
    case 'RIGHT_CLICK':
      return Boolean(config.rightClickDetection);
    case 'KEYBOARD_SHORTCUT':
      return Boolean(config.keyboardShortcutDetection ?? config.copyPasteDetection);
    case 'DEVTOOLS_OPENED':
      return Boolean(config.devtoolsDetection);
    case 'FACE_NOT_DETECTED':
    case 'MULTIPLE_FACES':
    case 'MOVEMENT_DETECTED':
      return Boolean(config.faceDetection);
    case 'SECOND_DEVICE':
      return Boolean(config.objectDetection);
    case 'AUDIO_DETECTED':
      return Boolean(config.audioAnalysis);
    case 'GAZE_ANOMALY':
      return Boolean(config.gazeTracking);
    case 'NETWORK_ANOMALY':
      return Boolean(config.networkAnomalyDetection);
    case 'PROCTOR_FLAG':
    case 'AI_SUSPICION':
      return true;
    default:
      return true;
  }
}

function rankOf(severity) {
  return SEVERITY_RANK[severity] ?? 0;
}

/**
 * Severity comes from the detector's default unless the proctoring config maps
 * that detector to something stricter, or a human overrides it.
 */
function normaliseSeverity(inputSeverity, type, config) {
  const overrides = config.severityOverrides ?? {};
  const candidate = inputSeverity ?? overrides[type] ?? DEFAULT_SEVERITY[type] ?? 'MINOR';
  const normalised = String(candidate).toUpperCase();
  return SEVERITIES.includes(normalised) ? normalised : 'MINOR';
}

function sanitiseDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const json = JSON.stringify(details);
  if (json.length > 20_000) return { truncated: true, keys: Object.keys(details) };
  return details;
}

/** One pass over the log for both the score and the dashboard counters. */
async function tallyViolations(attemptId) {
  const grouped = await prisma.violation.groupBy({
    by: ['type', 'severity', 'isResolved'],
    where: { attemptId },
    _sum: { count: true },
    _count: { _all: true },
  });

  const counters = { byType: {}, bySeverity: {}, openWeight: 0, openEvents: 0, criticalOpen: 0, totalEvents: 0, totalOccurrences: 0 };
  for (const row of grouped) {
    const occurrences = Number(row._sum.count ?? 0);
    counters.totalEvents += row._count._all;
    counters.totalOccurrences += occurrences;
    counters.byType[row.type] = (counters.byType[row.type] ?? 0) + occurrences;
    counters.bySeverity[row.severity] = (counters.bySeverity[row.severity] ?? 0) + occurrences;
    if (row.isResolved) continue;
    counters.openEvents += row._count._all;
    counters.openWeight += occurrences * (RISK_WEIGHTS[row.severity] ?? 1);
    if (row.severity === 'CRITICAL') counters.criticalOpen += occurrences;
  }
  return counters;
}

/**
 * 0-100 risk score: unresolved weight, compressed so a single critical does not
 * read as 100 but a pile of majors does.
 */
function riskScoreFor(counters, config = {}) {
  const scale = Number(config.riskScoreScale ?? 2.5);
  const raw = counters.openWeight + counters.criticalOpen * 10;
  return Math.min(100, Math.round(raw * scale * 100) / 100);
}

function thresholdFlag(config) {
  return Number(config.flagRiskScore ?? 60);
}

/**
 * Configured limits: too many criticals or too many violations in total ends the
 * attempt automatically.
 */
async function enforceLimits(attemptId, { attempt, config, counters, updated }) {
  const maxCritical = Number(config.autoTerminateAfterCritical ?? 0);
  const maxTotal = Number(config.terminateAfterViolations ?? config.autoTerminateAfterViolations ?? env.VIOLATION_AUTO_TERMINATE_COUNT);

  const criticalHit = maxCritical > 0 && counters.criticalOpen >= maxCritical;
  const totalHit = maxTotal > 0 && updated.violationCount >= maxTotal;
  if (!criticalHit && !totalHit) return { terminated: false, riskScore: Number(updated.riskScore) };

  const reason = criticalHit
    ? `Automatic termination after ${counters.criticalOpen} critical violations`
    : `Automatic termination after ${updated.violationCount} recorded violations`;

  try {
    await terminateCandidateExam(attemptId, { reason, auto: true }, {
      userId: attempt.exam.createdById,
      role: 'PROCTOR',
      organizationId: attempt.organizationId ?? attempt.exam.organizationId ?? null,
    });
    return { terminated: true, reason };
  } catch (error) {
    logger.error('auto-terminate failed', { attemptId, error: error.message });
    return { terminated: false, reason, error: error.message };
  }
}

/** Manual flag from the dashboard: a violation row plus the flagged marker. */
async function flagAttempt(attemptId, { reason = 'Flagged by the proctor', note = null, severity = 'MAJOR' } = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionFor(attemptId);

  const now = new Date();
  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      isFlagged: true,
      metadata: {
        ...(session.attempt?.metadata ?? {}),
        proctorFlags: [
          ...((session.attempt?.metadata?.proctorFlags ?? [])),
          { at: now.toISOString(), by: actor.userId, reason: String(reason).slice(0, 500), note: note ? String(note).slice(0, 2000) : null },
        ],
      },
    },
  });

  const violation = await prisma.violation.create({
    data: {
      attemptId,
      proctorSessionId: session.id,
      examId: session.examId,
      userId: session.userId,
      type: 'PROCTOR_FLAG',
      severity: normaliseSeverity(severity, 'PROCTOR_FLAG', configFor(session.exam)),
      description: String(reason).slice(0, 2000),
      details: { note: note ?? null, proctorId: actor.userId },
      manualFlag: true,
    },
    select: VIOLATION_READ_SELECT,
  });

  const counters = await tallyViolations(attemptId);
  const riskScore = riskScoreFor(counters, configFor(session.exam));
  await prisma.attempt.update({ where: { id: attemptId }, data: { riskScore: String(riskScore), violationCount: { increment: 1 } } });

  broadcastToProctors(session.examId, 'proctor:flagged', { attemptId, reason, by: actor.userId, at: now.toISOString() });
  pushToUser(session.userId, 'proctor:flagged', { attemptId, message: 'Your session has been flagged for review' });

  return { attemptId, flagged: true, violation: deserialiseViolation(violation), riskScore };
}

/** Clear a violation and recompute the score, so appeals can be granted. */
async function resolveViolation(violationId, { resolution = 'Reviewed - no action required' } = {}, actor = {}) {
  assertStaff(actor);
  const violation = await prisma.violation.findUnique({ where: { id: violationId }, select: { id: true, attemptId: true, examId: true, isResolved: true } });
  if (!violation) throw ApiError.notFound('Violation not found');
  if (violation.isResolved) return { violationId, alreadyResolved: true };

  const now = new Date();
  const updated = await prisma.violation.update({
    where: { id: violationId },
    data: { isResolved: true, resolvedById: actor.userId, resolvedAt: now, resolution: String(resolution).slice(0, 4000) },
    select: { ...VIOLATION_READ_SELECT, resolvedBy: { select: { id: true, displayName: true } } },
  });

  const counters = await tallyViolations(violation.attemptId);
  const attempt = await prisma.attempt.findUnique({ where: { id: violation.attemptId }, select: { exam: { select: { proctoringConfig: true } } } });
  const riskScore = riskScoreFor(counters, configFor(attempt?.exam));
  await prisma.attempt.update({ where: { id: violation.attemptId }, data: { riskScore: String(riskScore) } });

  broadcastToProctors(violation.examId, 'proctor:violation-resolved', { violationId, attemptId: violation.attemptId, by: actor.userId });
  return { violationId, resolved: true, riskScore, violation: deserialiseViolation(updated) };
}

/** Timestamped log the candidate detail view and the review page both render. */
async function violationTimeline(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  assertSessionAccess(session, actor);

  const [violations, counters] = await Promise.all([
    prisma.violation.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' }, select: VIOLATION_READ_SELECT }),
    tallyViolations(attemptId),
  ]);

  return {
    attemptId,
    sessionId: session.id,
    total: violations.length,
    counters,
    violations: violations.map(deserialiseViolation),
  };
}

/** Cross-exam listing for the admin tables. */
async function listViolations(query = {}) {
  const { examId, attemptId, userId, type, severity, resolved, from, to, organizationId } = query;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));

  const where = {};
  if (examId) where.examId = examId;
  if (attemptId) where.attemptId = attemptId;
  if (userId) where.userId = userId;
  if (organizationId) where.attempt = { organizationId };
  if (type) where.type = String(type).toUpperCase();
  if (severity) where.severity = String(severity).toUpperCase();
  if (resolved !== undefined) where.isResolved = resolved === true || resolved === 'true';
  if (from || to) {
    where.occurredAt = {};
    if (from) where.occurredAt.gte = new Date(from);
    if (to) where.occurredAt.lte = new Date(to);
  }

  const [rows, total] = await Promise.all([
    prisma.violation.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        ...VIOLATION_READ_SELECT,
        attempt: { select: { id: true, status: true, riskScore: true, violationCount: true, user: { select: { id: true, displayName: true, email: true } } } },
        exam: { select: { id: true, title: true } },
        resolvedBy: { select: { id: true, displayName: true } },
      },
    }),
    prisma.violation.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({ ...deserialiseViolation(row), attempt: row.attempt ? { ...row.attempt, riskScore: Number(row.attempt.riskScore ?? 0) } : row.attempt })),
    total,
    page,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Live monitoring
// ---------------------------------------------------------------------------

/** Room list for the grid view: one row per candidate currently under watch. */
async function listLiveSessions(query = {}) {
  const { examId, organizationId, status, flagged, search } = query;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

  const where = {};
  if (examId) where.examId = examId;
  if (organizationId) where.exam = { organizationId };
  if (status) where.status = String(status).toUpperCase();
  else where.status = { in: SESSION_OPEN_STATES };
  if (flagged === true || flagged === 'true') where.attempt = { isFlagged: true };
  if (search) {
    where.attempt = {
      ...(where.attempt ?? {}),
      user: { OR: [{ displayName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] },
    };
  }

  const [rows, total] = await Promise.all([
    prisma.proctorSession.findMany({
      where,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: SESSION_READ_INCLUDE,
    }),
    prisma.proctorSession.count({ where }),
  ]);

  return {
    items: rows.map(sessionCard),
    total,
    page,
    limit,
  };
}

/** Compact projection the proctor grid polls / receives over the socket. */
function sessionCard(session) {
  const attempt = session.attempt ?? {};
  const plan = attempt.metadata?.questionPlan ?? [];
  const answered = Number(attempt.answeredCount ?? 0);
  const order = Number(attempt.currentQuestionOrder ?? 0);

  return {
    sessionId: session.id,
    attemptId: session.attemptId,
    examId: session.examId,
    examTitle: session.exam?.title ?? null,
    status: session.status,
    userId: session.userId,
    candidate: { id: attempt.userId ?? session.userId, name: attempt.user?.displayName ?? null, email: attempt.user?.email ?? null, imageUrl: attempt.user?.imageUrl ?? null },
    attemptStatus: attempt.status ?? null,
    startedAt: attempt.startedAt ?? null,
    expiresAt: attempt.expiresAt ?? null,
    lastActivityAt: attempt.lastActivityAt ?? null,
    answeredCount: answered,
    questionCount: plan.length || null,
    currentQuestionOrder: order || null,
    progressPercent: plan.length ? Math.round((answered / plan.length) * 100) : null,
    violationCount: Number(attempt.violationCount ?? 0),
    riskScore: Number(attempt.riskScore ?? 0),
    isFlagged: Boolean(attempt.isFlagged),
    isTerminated: Boolean(attempt.isTerminated),
    hasCameraEvidence: Boolean(session.selfieUrl),
    idDocFrontUrl: session.idDocFrontUrl,
    selfieUrl: session.selfieUrl,
    faceMatchScore: session.faceMatchScore == null ? null : Number(session.faceMatchScore),
    violations: session._count?.violations ?? 0,
    recordings: session._count?.recordings ?? 0,
    unreadMessages: session.status === 'ACTIVE' ? 0 : undefined,
    indicator: indicatorFor(session, attempt),
  };
}

/** Status chip colouring on `ProctorDashboard.jsx`. */
function indicatorFor(session, attempt = {}) {
  if (attempt.status === 'TERMINATED') return 'TERMINATED';
  if (['SUBMITTED', 'GRADED', 'AUTO_SUBMITTED'].includes(attempt.status)) return 'COMPLETED';
  if (session.status === 'PENDING_SETUP') return 'SETUP';
  if (session.status === 'PENDING_REVIEW') return 'AWAITING_APPROVAL';
  if (session.status === 'REJECTED') return 'REJECTED';
  if (attempt.isFlagged || Number(attempt.riskScore ?? 0) >= 60) return 'FLAGGED';
  if (Number(attempt.violationCount ?? 0) > 0) return 'SUSPICIOUS';
  if (attempt.status === 'PAUSED') return 'PAUSED';
  return 'ACTIVE';
}

/**
 * Everything the proctor console needs in one call: the grid, the counters and
 * the most recent alerts.
 */
async function proctorDashboard(examId, actor = {}) {
  assertStaff(actor);
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, title: true, organizationId: true, proctoringConfig: true, settings: true, startsAt: true, endsAt: true, durationMinutes: true, questionCount: true },
  });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (actor.platformRole !== 'SUPER_ADMIN' && actor.organizationId && exam.organizationId !== actor.organizationId) {
    throw ApiError.forbidden('This exam belongs to another organization');
  }

  const config = configFor(exam);
  const [sessions, attemptStats, recentViolations, bySeverity] = await Promise.all([
    prisma.proctorSession.findMany({
      where: { examId },
      orderBy: { updatedAt: 'desc' },
      include: SESSION_READ_INCLUDE,
    }),
    prisma.attempt.groupBy({
      by: ['status'],
      where: { examId },
      _count: { _all: true },
      _avg: { riskScore: true, violationCount: true, answeredCount: true, scorePercent: true },
    }),
    prisma.violation.findMany({
      where: { examId },
      orderBy: { occurredAt: 'desc' },
      take: 40,
      select: {
        ...VIOLATION_READ_SELECT,
        attempt: { select: { user: { select: { id: true, displayName: true } } } },
      },
    }),
    prisma.violation.groupBy({ by: ['severity'], where: { examId }, _sum: { count: true }, _count: { _all: true } }),
  ]);

  const cards = sessions.map(sessionCard);
  const byStatus = cards.reduce((acc, card) => {
    acc[card.indicator] = (acc[card.indicator] ?? 0) + 1;
    return acc;
  }, {});

  const planLengths = cards.map((card) => card.questionCount).filter(Boolean);
  const progresses = cards.map((card) => card.progressPercent).filter((value) => typeof value === 'number');
  const statusCounts = attemptStats.reduce((acc, row) => ({ ...acc, [row.status]: row._count._all }), {});

  const typeTally = {};
  for (const violation of recentViolations) {
    typeTally[violation.type] = (typeTally[violation.type] ?? 0) + violation.count;
  }

  return {
    exam: {
      id: exam.id,
      title: exam.title,
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      proctoring: config,
      isLive: isExamLiveNow(exam),
    },
    stats: {
      totalCandidates: cards.length,
      active: statusCounts.IN_PROGRESS ?? 0,
      paused: statusCounts.PAUSED ?? 0,
      completed: (statusCounts.SUBMITTED ?? 0) + (statusCounts.GRADED ?? 0) + (statusCounts.AUTO_SUBMITTED ?? 0),
      terminated: statusCounts.TERMINATED ?? 0,
      flagged: cards.filter((card) => card.isFlagged).length,
      suspicious: cards.filter((card) => card.indicator === 'SUSPICIOUS').length,
      awaitingApproval: byStatus.AWAITING_APPROVAL ?? 0,
      inSetup: byStatus.SETUP ?? 0,
      averageRisk: cards.length ? round2(cards.reduce((sum, card) => sum + card.riskScore, 0) / cards.length) : 0,
      averageViolations: cards.length ? round2(cards.reduce((sum, card) => sum + card.violationCount, 0) / cards.length) : 0,
      averageProgressPercent: progresses.length ? Math.round(progresses.reduce((sum, value) => sum + value, 0) / progresses.length) : 0,
      questionCount: planLengths[0] ?? null,
    },
    byStatus,
    attemptStatusCounts: statusCounts,
    violationsBySeverity: bySeverity.reduce((acc, row) => ({ ...acc, [row.severity]: Number(row._sum.count ?? 0) }), {}),
    violationsByType: Object.entries(typeTally)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({ type, count, label: violationText(type, count) })),
    sessions: cards,
    recentViolations: recentViolations.map(deserialiseViolation),
  };
}

function isExamLiveNow(exam) {
  const now = Date.now();
  if (exam.startsAt && now < new Date(exam.startsAt).getTime()) return false;
  if (exam.endsAt && now > new Date(exam.endsAt).getTime()) return false;
  return true;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/**
 * Single-candidate drill-down: full camera evidence, live violation log, current
 * question, recordings and the chat transcript.
 */
async function candidateMonitorState(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  const viewer = assertSessionAccess(session, actor);

  const [violations, recordings, messages, timeline] = await Promise.all([
    prisma.violation.findMany({ where: { attemptId }, orderBy: { occurredAt: 'desc' }, select: VIOLATION_READ_SELECT }),
    prisma.examRecording.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, url: true, mimeType: true, sizeBytes: true, chunkIndex: true, startedAt: true, endedAt: true, durationSec: true, status: true } }),
    prisma.proctorMessage.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' }, take: 200 }),
    prisma.attempt.findUnique({
      where: { id: attemptId },
      select: {
        answers: {
          select: { questionId: true, order: true, answeredAt: true, updatedAt: true, timeSpentSec: true, isMarkedForReview: true, isFlagged: true, wasSkipped: true, wordCount: true },
          orderBy: { order: 'asc' },
        },
        exam: { select: { id: true, title: true, settings: true, proctoringConfig: true, durationMinutes: true, perQuestionSec: true } },
      },
    }),
  ]);

  const plan = session.attempt?.metadata?.questionPlan ?? [];
  const order = Number(session.attempt?.currentQuestionOrder ?? 0);
  const current = plan.find((entry) => entry.order === order) ?? null;
  const config = configFor(session.exam);
  const answerRows = timeline?.answers ?? [];

  return {
    session,
    viewer,
    currentQuestion: current ? { questionId: current.questionId, sectionId: current.sectionId, order: current.order, marks: Number(current.marks ?? 0), type: current.type ?? null } : null,
    timer: timer.timeSnapshot(session.attempt, session.exam, new Date()),
    answerSummary: {
      planLength: plan.length,
      answered: answerRows.filter((row) => row.answeredAt !== null).length,
      markedForReview: answerRows.filter((row) => row.isMarkedForReview).length,
      flagged: answerRows.filter((row) => row.isFlagged).length,
      skipped: answerRows.filter((row) => row.wasSkipped).length,
      lastSavedAt: answerRows.map((row) => row.updatedAt).sort((a, b) => new Date(b) - new Date(a))[0] ?? null,
      perQuestion: viewer === 'CANDIDATE' ? undefined : answerRows,
    },
    violations: violations.map(deserialiseViolation),
    counters: {
      total: violations.length,
      open: violations.filter((row) => !row.isResolved).length,
      byType: violations.reduce((acc, row) => ({ ...acc, [row.type]: (acc[row.type] ?? 0) + row.count }), {}),
    },
    recordings: recordings.map((row) => ({ ...row, sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes) })),
    messages,
    evidence: {
      idDocFrontUrl: session.idDocFrontUrl,
      idDocBackUrl: session.idDocBackUrl,
      selfieUrl: session.selfieUrl,
      environmentUrls: session.environmentUrls,
      screenshots: violations.map((row) => row.screenshotUrl).filter(Boolean),
    },
    canControl: viewer !== 'CANDIDATE',
    proctoring: config,
  };
}

/** Lightweight heartbeat the client pings so the grid shows "still here". */
async function reportPresence(attemptId, { systemHealth = {}, inFullscreen = null, tabVisible = null, faceDetected = null } = {}, actor = {}) {
  const session = await sessionFor(attemptId);
  if (session.userId !== actor.userId) throw ApiError.forbidden('This session belongs to another candidate');
  if (session.status !== 'ACTIVE') return { attemptId, status: session.status, acknowledged: false };

  const now = new Date();
  await prisma.proctorSession.update({
    where: { id: session.id },
    data: { systemCheck: { ...(session.systemCheck ?? {}), lastHeartbeatAt: now.toISOString(), systemHealth: sanitiseDetails(systemHealth) } },
  });
  await prisma.attempt.update({ where: { id: attemptId }, data: { lastActivityAt: now } });

  broadcastToProctors(session.examId, 'proctor:presence', {
    attemptId,
    at: now.toISOString(),
    inFullscreen: inFullscreen ?? undefined,
    tabVisible: tabVisible ?? undefined,
    faceDetected: faceDetected ?? undefined,
  });

  return { attemptId, status: session.status, acknowledged: true, at: now.toISOString() };
}

/** Close a session when the exam ends or the candidate leaves. */
async function endProctorSession(attemptId, { reason = 'Exam finished' } = {}, actor = {}) {
  const session = await sessionFor(attemptId);
  assertSessionAccess(session, actor);
  if (session.status === 'ENDED') return { attemptId, status: 'ENDED', alreadyClosed: true };

  const now = new Date();
  await prisma.proctorSession.update({
    where: { id: session.id },
    data: { status: 'ENDED', endedAt: now, reviewNote: session.reviewNote ?? (reason ? String(reason).slice(0, 2000) : null) },
  });
  await prisma.examRecording.updateMany({ where: { attemptId, status: 'RECORDING' }, data: { status: 'AVAILABLE', endedAt: now } });

  broadcastToProctors(session.examId, 'proctor:session-ended', { attemptId, sessionId: session.id, reason, at: now.toISOString() });
  return { attemptId, status: 'ENDED', reason };
}

// ---------------------------------------------------------------------------
// Proctor <-> candidate chat
// ---------------------------------------------------------------------------

/**
 * Two-way text channel over the attempt. Staff messages reach the candidate as a
 * socket event on `proctor:message` plus an inbox notification for anything that
 * needs attention after the tab loses focus; candidate replies land in the
 * proctor room so whichever human is watching picks it up.
 */
async function sendProctorMessage(attemptId, { body, kind = 'MESSAGE', metadata = {} } = {}, actor = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw ApiError.badRequest('Message body is required');
  if (text.length > 4000) throw ApiError.badRequest('Message is too long (4000 characters max)');

  const normalisedKind = MESSAGE_KINDS.includes(String(kind).toUpperCase()) ? String(kind).toUpperCase() : 'MESSAGE';

  const session = await prisma.proctorSession.findUnique({
    where: { attemptId },
    include: {
      attempt: { select: { id: true, userId: true, examId: true, organizationId: true, status: true, isTerminated: true } },
      exam: { select: { id: true, organizationId: true, createdById: true, title: true } },
    },
  });
  const attempt = session?.attempt ?? await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, examId: true, organizationId: true, status: true, isTerminated: true, exam: { select: { id: true, organizationId: true, createdById: true, title: true } } },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (['SUBMITTED', 'GRADED', 'AUTO_SUBMITTED'].includes(attempt.status) && normalisedKind === 'MESSAGE') {
    throw ApiError.conflict('The exam has been submitted - the chat is closed');
  }

  const staffSender = isStaffActor(actor);
  if (!staffSender && attempt.userId !== actor.userId) throw ApiError.forbidden('You cannot message this candidate');

  const recipientId = staffSender ? attempt.userId : (session?.reviewedById ?? attempt.exam?.createdById ?? attempt.userId);
  if (!staffSender && recipientId === attempt.userId) throw ApiError.forbidden('No proctor is assigned to this attempt');

  const message = await prisma.proctorMessage.create({
    data: {
      attemptId,
      proctorSessionId: session?.id ?? null,
      examId: attempt.examId,
      fromUserId: actor.userId,
      toUserId: recipientId,
      kind: normalisedKind,
      body: text,
      metadata: sanitiseDetails(metadata),
      deliveredAt: new Date(),
    },
  });

  pushToUser(recipientId, 'proctor:message', {
    attemptId,
    messageId: message.id,
    kind: normalisedKind,
    body: text,
    fromUserId: actor.userId,
    at: message.createdAt.toISOString(),
  });
  pushToRoom(`exam:${attempt.examId}:proctors`, 'proctor:message', {
    attemptId,
    messageId: message.id,
    kind: normalisedKind,
    body: text,
    from: staffSender ? 'PROCTOR' : 'CANDIDATE',
    at: message.createdAt.toISOString(),
  });

  if (staffSender && ['WARNING', 'TERMINATE', 'EXTRA_TIME', 'PAUSE'].includes(normalisedKind)) {
    await notifyUser({
      userId: recipientId,
      type: 'PROCTOR_MESSAGE',
      title: proctorMessageTitle(normalisedKind),
      body: text,
      actionUrl: `/exam/${attemptId}`,
      priority: 3,
    }).catch((error) => logger.warn('proctor message notification failed', { attemptId, error: error.message }));
  }

  return { message, attemptId, recipientId };
}

function proctorMessageTitle(kind) {
  switch (kind) {
    case 'WARNING':
      return 'Warning from your proctor';
    case 'PAUSE':
      return 'Your exam has been paused';
    case 'RESUME':
      return 'Your exam has resumed';
    case 'TERMINATE':
      return 'Your exam has been ended';
    case 'EXTRA_TIME':
      return 'Extra time has been granted';
    default:
      return 'Message from your proctor';
  }
}

async function listProctorMessages(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  assertSessionAccess(session, actor);

  const messages = await prisma.proctorMessage.findMany({
    where: { attemptId },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true,
      attemptId: true,
      kind: true,
      body: true,
      metadata: true,
      fromUserId: true,
      toUserId: true,
      readAt: true,
      deliveredAt: true,
      createdAt: true,
      sender: { select: { id: true, displayName: true, imageUrl: true } },
    },
  });

  return { attemptId, sessionId: session.id, messages };
}

async function markMessageRead(messageId, actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  const message = await prisma.proctorMessage.findUnique({
    where: { id: messageId },
    select: { id: true, toUserId: true, readAt: true, attemptId: true, attempt: { select: { examId: true } } },
  });
  if (!message) throw ApiError.notFound('Message not found');
  if (message.toUserId !== actor.userId) throw ApiError.forbidden('This message is not addressed to you');
  if (message.readAt) return { messageId, read: true, alreadyRead: true };

  const now = new Date();
  await prisma.proctorMessage.update({ where: { id: messageId }, data: { readAt: now, deliveredAt: message.deliveredAt ?? now } });
  pushToRoom(`exam:${message.attempt.examId}:proctors`, 'proctor:message-read', { messageId, attemptId: message.attemptId });
  return { messageId, read: true };
}

/** Candidate view: mark the whole proctor conversation as read. */
async function markConversationRead(attemptId, actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  const now = new Date();
  const result = await prisma.proctorMessage.updateMany({
    where: { attemptId, toUserId: actor.userId, readAt: null },
    data: { readAt: now, deliveredAt: now },
  });
  return { attemptId, marked: result.count };
}

async function unreadMessageCount(userId) {
  if (!userId) return 0;
  return prisma.proctorMessage.count({ where: { toUserId: userId, readAt: null } });
}

/** Candidate talks back to whoever is watching. */
async function replyToProctor(attemptId, { body }, actor = {}) {
  return sendProctorMessage(attemptId, { body, kind: 'MESSAGE', metadata: { from: 'CANDIDATE' } }, actor);
}

// ---------------------------------------------------------------------------
// Staff controls
// ---------------------------------------------------------------------------

async function assertSessionExam(session, actor) {
  if (actor.platformRole !== 'SUPER_ADMIN' && actor.organizationId && session.exam?.organizationId
    && session.exam.organizationId !== actor.organizationId) {
    throw ApiError.forbidden('This session belongs to another organization');
  }
  return session;
}

/** Proctor pauses the clock; the pause never counts against exam time. */
async function pauseCandidateExam(attemptId, { reason = 'PROCTOR_PAUSE', note = null } = {}, actor = {}) {
  const role = assertStaff(actor);
  const session = await sessionFor(attemptId);
  await assertSessionExam(session, actor);

  const result = await timer.pauseAttempt(attemptId, { reason, note }, { userId: actor.userId, orgRole: role });
  const message = await sendProctorMessage(
    attemptId,
    { kind: 'PAUSE', body: note ?? 'Your exam has been paused by the proctor. Please stay on this page.', metadata: { reason } },
    actor,
  );
  broadcastToProctors(session.examId, 'proctor:attempt-paused', { attemptId, reason, by: actor.userId });

  return { attemptId, paused: true, timer: result.timer, message: message.message };
}

async function resumeCandidateExam(attemptId, { note = null } = {}, actor = {}) {
  const role = assertStaff(actor);
  const session = await sessionFor(attemptId);
  await assertSessionExam(session, actor);

  const result = await timer.resumeAttempt(attemptId, { userId: actor.userId, orgRole: role });
  const message = await sendProctorMessage(
    attemptId,
    { kind: 'RESUME', body: note ?? 'You may continue - your clock has resumed.', metadata: { pausedSec: result.pausedSec } },
    actor,
  );
  broadcastToProctors(session.examId, 'proctor:attempt-resumed', { attemptId, by: actor.userId });

  return { attemptId, resumed: true, pausedSec: result.pausedSec, timer: result.timer, message: message.message };
}

/** Minutes or seconds, whichever the console sends. */
async function grantExtraTime(attemptId, input = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionFor(attemptId);
  await assertSessionExam(session, actor);

  const seconds = Number(input.extraTimeSec ?? (Number(input.minutes ?? 0) * 60));
  if (!Number.isFinite(seconds) || seconds === 0) throw ApiError.badRequest('Provide extraTimeSec or minutes (non-zero)');
  if (Math.abs(seconds) > 6 * 60 * 60) throw ApiError.badRequest('Extra time is limited to six hours per adjustment');

  const result = await timer.grantExtraTime(attemptId, { extraTimeSec: seconds, reason: input.reason ?? null }, { userId: actor.userId, orgRole: actor.role ?? 'PROCTOR' });
  const phrase = seconds > 0
    ? `You have been given ${formatDuration(seconds)} extra time.`
    : `${formatDuration(Math.abs(seconds))} has been removed from your remaining time.`;
  const message = await sendProctorMessage(attemptId, { kind: 'EXTRA_TIME', body: input.note ?? phrase, metadata: { seconds, reason: input.reason ?? null } }, actor);

  pushToUser(session.userId, 'exam:timer-adjusted', { attemptId, timer: result.timer, extraTimeSec: Number(result.attempt.extraTimeSec) });
  await notifyUser({
    userId: session.userId,
    type: 'PROCTOR_MESSAGE',
    title: 'Time adjustment',
    body: phrase,
    actionUrl: `/exam/${attemptId}`,
  }).catch(() => null);
  broadcastToProctors(session.examId, 'proctor:extra-time', { attemptId, seconds, by: actor.userId });

  return {
    attemptId,
    extraTimeSec: Number(result.attempt.extraTimeSec),
    grantedSec: seconds,
    timer: result.timer,
    expiresAt: result.attempt.expiresAt,
    message: message.message,
  };
}

function formatDuration(seconds) {
  const absolute = Math.abs(Number(seconds) || 0);
  const minutes = Math.round(absolute / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Force-stop a candidate. Everything answered so far is graded, the session is
 * closed, and the reason is written to the attempt for the review queue.
 */
async function terminateCandidateExam(attemptId, { reason = 'Terminated by the proctor', note = null, auto = false } = {}, actor = {}) {
  const session = await prisma.proctorSession.findUnique({
    where: { attemptId },
    include: { attempt: { select: { organizationId: true, userId: true } }, exam: { select: { id: true, organizationId: true, title: true } } },
  });
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, examId: true, status: true, organizationId: true, metadata: true },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (session && actor.organizationId && actor.platformRole !== 'SUPER_ADMIN' && session.exam?.organizationId !== actor.organizationId) {
    throw ApiError.forbidden('This session belongs to another organization');
  }

  const text = String(reason ?? 'Terminated by the proctor').slice(0, 2000);
  const now = new Date();

  if (session) {
    await prisma.proctorSession.update({
      where: { id: session.id },
      data: {
        status: 'ENDED',
        endedAt: now,
        reviewNote: session.reviewNote ?? text,
        reviewedById: auto ? session.reviewedById : (actor.userId ?? session.reviewedById),
      },
    });
    await prisma.examRecording.updateMany({ where: { attemptId, status: 'RECORDING' }, data: { status: 'AVAILABLE', endedAt: now } });
  }

  const result = await attemptService.terminateAttempt(attemptId, {
    reason: text,
    terminatedBy: auto ? null : (actor.userId ?? null),
  }, { userId: actor.userId ?? null, role: actor.role ?? 'PROCTOR', organizationId: actor.organizationId ?? attempt.organizationId ?? null });

  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      isFlagged: true,
      metadata: { ...(attempt.metadata ?? {}), termination: { reason: text, note: note ?? null, auto: Boolean(auto), at: now.toISOString(), by: actor.userId ?? 'system' } },
    },
  });

  await sendProctorMessage(attemptId, { kind: 'TERMINATE', body: text, metadata: { auto: Boolean(auto) } }, {
    userId: actor.userId ?? attempt.exam?.createdById ?? attempt.userId,
    role: 'PROCTOR',
    organizationId: attempt.organizationId,
  }).catch((error) => logger.debug('termination message skipped', { attemptId, error: error.message }));

  broadcastToProctors(attempt.examId, 'proctor:attempt-terminated', {
    attemptId,
    userId: attempt.userId,
    reason: text,
    auto: Boolean(auto),
    at: now.toISOString(),
  });

  logger.warn('attempt terminated by proctoring', { attemptId, auto, actorId: actor.userId ?? null });
  return { attemptId, terminated: true, reason: text, auto: Boolean(auto), ...result };
}

/**
 * Kick a candidate out of the exam and let them start a fresh attempt later -
 * used when the setup check fails after the session opened.
 */
async function forceLogoutCandidate(attemptId, { reason = 'Please reload the exam and reconnect' } = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionFor(attemptId);
  await assertSessionExam(session, actor);

  pushToUser(session.userId, 'exam:force-logout', { attemptId, reason });
  await sendProctorMessage(attemptId, { kind: 'SYSTEM', body: String(reason).slice(0, 2000), metadata: { forceLogout: true } }, actor);

  return { attemptId, signalled: true };
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/**
 * Store one MediaRecorder segment.
 *
 * The browser records in slices (a long single blob is unreliable), so each
 * request either appends to an existing `ExamRecording` row or opens a new one.
 * Bytes land on local disk through the same multer pipeline as everything else.
 */
async function saveRecording(attemptId, input = {}, actor = {}) {
  const kind = String(input.kind ?? 'WEBCAM').toUpperCase();
  if (!RECORDING_KINDS.includes(kind)) throw ApiError.badRequest(`Unknown recording kind "${input.kind}"`, { allowed: RECORDING_KINDS });

  const session = await sessionFor(attemptId);
  if (session.userId !== actor.userId && !isStaffActor(actor)) throw ApiError.forbidden('This session belongs to another candidate');
  if (!['ACTIVE', 'ENDED'].includes(session.status)) throw ApiError.conflict('Recording is only allowed during an active session', { status: session.status });

  const config = configFor(session.exam);
  if (kind === 'WEBCAM' && !config.recordWebcam && !config.requireCamera) {
    throw ApiError.forbidden('This exam does not record webcam footage');
  }
  if (kind === 'SCREEN' && !config.recordScreen && !config.requireScreenShare) {
    throw ApiError.forbidden('This exam does not record your screen');
  }

  const media = resolveMedia(input);
  if (!media || !media.url) {
    throw ApiError.badRequest('Provide an uploaded file, a hosted URL or a base64 chunk');
  }
  const chunkIndex = Number(input.chunkIndex ?? 0);

  if (input.recordingId) {
    const existing = await prisma.examRecording.findUnique({ where: { id: input.recordingId }, select: { id: true, attemptId: true, sizeBytes: true, status: true, kind: true } });
    if (!existing) throw ApiError.notFound('Recording not found');
    if (existing.attemptId !== attemptId) throw ApiError.forbidden('That recording belongs to another attempt');
    if (existing.status !== 'RECORDING') throw ApiError.conflict('This recording is already finalised', { status: existing.status });

    const total = Number(existing.sizeBytes ?? 0) + Number(media.sizeBytes ?? 0);
    const updated = await prisma.examRecording.update({
      where: { id: existing.id },
      data: { sizeBytes: BigInt(Math.max(0, Math.round(total))), chunkIndex, status: 'RECORDING' },
    });
    return { recording: publicRecording(updated), appended: true };
  }

  const created = await prisma.examRecording.create({
    data: {
      attemptId,
      proctorSessionId: session.id,
      examId: session.examId,
      userId: session.userId,
      kind,
      url: media.url,
      storagePath: media.storagePath ?? null,
      mimeType: media.mimeType ?? null,
      sizeBytes: BigInt(Math.max(0, Math.round(Number(media.sizeBytes ?? 0)))),
      chunkIndex,
      startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
      durationSec: input.durationSec == null ? null : Number(input.durationSec),
      status: 'RECORDING',
      metadata: sanitiseDetails(input.metadata ?? {}),
    },
  });

  await registerMedia(media, {
    kind: RECORDING_MEDIA_KIND[kind] ?? 'WEBCAM_RECORDING',
    userId: session.userId,
    organizationId: session.attempt?.organizationId ?? session.exam?.organizationId ?? null,
    examId: session.examId,
    attemptId,
    metadata: { recordingId: created.id, kind, chunkIndex },
  });

  broadcastToProctors(session.examId, 'proctor:recording-started', { attemptId, recordingId: created.id, kind });
  return { recording: publicRecording(created), appended: false };
}

function resolveMedia(input) {
  if (input.file && (input.file.path || input.file.filename)) {
    const file = input.file;
    const storagePath = file.path ?? path.join(env.uploadRoot, file.filename);
    return {
      url: file.url ?? `/uploads/${path.relative(env.uploadRoot, storagePath).split(path.sep).join('/')}`,
      storagePath,
      mimeType: file.mimetype ?? 'application/octet-stream',
      sizeBytes: Number(file.size ?? 0),
    };
  }
  const evidence = evidenceFrom(input.url ?? input.data ?? input.chunk, 'recording');
  return evidence;
}

function publicRecording(recording) {
  if (!recording) return recording;
  return { ...recording, sizeBytes: recording.sizeBytes == null ? null : Number(recording.sizeBytes) };
}

/** Seal a recording so the review page can play it back. */
async function finaliseRecording(recordingId, { durationSec = null, status = 'AVAILABLE' } = {}, actor = {}) {
  const recording = await prisma.examRecording.findUnique({
    where: { id: recordingId },
    include: { attempt: { select: { userId: true, examId: true } } },
  });
  if (!recording) throw ApiError.notFound('Recording not found');
  if (recording.attempt.userId !== actor.userId && !isStaffActor(actor)) throw ApiError.forbidden('This recording belongs to another candidate');

  const allowedStatuses = ['AVAILABLE', 'UPLOADED', 'ARCHIVED', 'FAILED', 'DELETED'];
  const nextStatus = allowedStatuses.includes(String(status).toUpperCase()) ? String(status).toUpperCase() : 'AVAILABLE';
  const now = new Date();

  const updated = await prisma.examRecording.update({
    where: { id: recordingId },
    data: {
      status: nextStatus,
      endedAt: recording.endedAt ?? now,
      durationSec: durationSec == null ? recording.durationSec : Number(durationSec),
    },
  });

  if (nextStatus !== 'AVAILABLE') {
    await prisma.examRecording.updateMany({ where: { attemptId: recording.attemptId, id: { not: recordingId }, status: 'RECORDING' }, data: { status: nextStatus, endedAt: now } });
  }

  return { recording: publicRecording(updated) };
}

async function listRecordings(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  assertSessionAccess(session, actor);

  const rows = await prisma.examRecording.findMany({
    where: { attemptId },
    orderBy: [{ kind: 'asc' }, { chunkIndex: 'asc' }, { createdAt: 'asc' }],
  });

  const grouped = rows.reduce((acc, row) => {
    const bucket = acc[row.kind] ?? { kind: row.kind, items: [], totalBytes: 0, totalDurationSec: 0 };
    bucket.items.push(publicRecording(row));
    bucket.totalBytes += Number(row.sizeBytes ?? 0);
    bucket.totalDurationSec += Number(row.durationSec ?? 0);
    acc[row.kind] = bucket;
    return acc;
  }, {});

  return { attemptId, recordings: rows.map(publicRecording), grouped: Object.values(grouped) };
}

/** Violation screenshot gallery next to the recording list in the review UI. */
async function recordingGallery(attemptId, actor = {}) {
  const session = await sessionFor(attemptId);
  assertSessionAccess(session, actor);

  const [recordings, violations, uploads] = await Promise.all([
    prisma.examRecording.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' } }),
    prisma.violation.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' }, select: { id: true, type: true, severity: true, occurredAt: true, screenshotUrl: true, evidenceUrls: true, count: true } }),
    prisma.uploadedFile.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, url: true, mimeType: true, sizeBytes: true, createdAt: true, metadata: true } }),
  ]);

  const timeline = [
    ...recordings.map((row) => ({ at: row.startedAt ?? row.createdAt, type: 'RECORDING', kind: row.kind, url: row.url, durationSec: row.durationSec, status: row.status })),
    ...violations
      .filter((row) => row.screenshotUrl)
      .map((row) => ({ at: row.occurredAt, type: 'VIOLATION', violationType: row.type, severity: row.severity, url: row.screenshotUrl, violationId: row.id })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  return {
    attemptId,
    recordings: recordings.map(publicRecording),
    violations,
    files: uploads,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Post-exam review
// ---------------------------------------------------------------------------

/**
 * The queue a proctor works through after the exam: identity checks still
 * pending, flagged attempts, and anything with unresolved major violations.
 */
async function reviewQueue(query = {}) {
  const { examId, organizationId, status, riskMin } = query;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

  const where = {};
  if (examId) where.examId = examId;
  if (organizationId) where.exam = { organizationId };
  if (status) where.status = String(status).toUpperCase();

  const sessions = await prisma.proctorSession.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    include: SESSION_READ_INCLUDE,
  });

  const cards = sessions
    .map(sessionCard)
    .filter((card) => {
      const needsAttention = ['AWAITING_APPROVAL', 'FLAGGED', 'SUSPICIOUS', 'TERMINATED', 'REJECTED'].includes(card.indicator)
        || card.violationCount > 0
        || card.riskScore > 0;
      if (!needsAttention) return false;
      if (riskMin != null && card.riskScore < Number(riskMin)) return false;
      return true;
    });

  const total = await prisma.proctorSession.count({ where });
  return { items: cards, total, page, limit };
}

/**
 * Accept or reject a finished session. Rejecting can invalidate the attempt,
 * which keeps the score visible but marks it void for the analytics layer.
 */
async function reviewProctorSession(sessionId, { decision = 'APPROVED', reviewNote = null, invalidate = false, resolveViolations = true } = {}, actor = {}) {
  assertStaff(actor);
  const session = await sessionById(sessionId);
  await assertSessionExam(session, actor);

  const verdict = String(decision).toUpperCase();
  if (!['APPROVED', 'REJECTED', 'PENDING_REVIEW'].includes(verdict)) {
    throw ApiError.badRequest('decision must be APPROVED, REJECTED or PENDING_REVIEW');
  }

  const now = new Date();
  const updated = await prisma.proctorSession.update({
    where: { id: sessionId },
    data: {
      status: verdict,
      reviewedById: actor.userId,
      reviewedAt: now,
      reviewNote: reviewNote == null ? session.reviewNote : String(reviewNote).slice(0, 4000),
      endedAt: session.endedAt ?? (verdict !== 'PENDING_REVIEW' ? now : null),
    },
    include: SESSION_READ_INCLUDE,
  });

  if (verdict === 'APPROVED' && resolveViolations) {
    await prisma.violation.updateMany({
      where: { proctorSessionId: sessionId, isResolved: false, manualFlag: true },
      data: { isResolved: true, resolvedById: actor.userId, resolvedAt: now, resolution: reviewNote ? String(reviewNote).slice(0, 4000) : 'Cleared during post-exam review' },
    });
  }

  if (verdict === 'REJECTED') {
    const metadata = { ...(session.attempt?.metadata ?? {}), review: { decision: 'REJECTED', note: reviewNote ?? null, at: now.toISOString(), by: actor.userId, invalidated: Boolean(invalidate) } };
    await prisma.attempt.update({
      where: { id: session.attemptId },
      data: { isFlagged: true, metadata: invalidate ? { ...metadata, invalidated: true } : metadata },
    });
    if (invalidate) {
      await prisma.attempt.update({ where: { id: session.attemptId }, data: { passed: false } });
    }
    await notifyUser({
      userId: session.userId,
      type: 'VIOLATION_FLAGGED',
      title: invalidate ? 'Your exam result was invalidated' : 'Your exam session was rejected after review',
      body: String(reviewNote ?? 'Contact your organization for details.'),
      actionUrl: `/results/${session.attemptId}`,
    }).catch(() => null);
  } else if (verdict === 'APPROVED') {
    await prisma.attempt.update({
      where: { id: session.attemptId },
      data: { metadata: { ...(session.attempt?.metadata ?? {}), review: { decision: 'APPROVED', note: reviewNote ?? null, at: now.toISOString(), by: actor.userId } } },
    });
  }

  broadcastToProctors(session.examId, 'proctor:session-reviewed', {
    sessionId,
    attemptId: session.attemptId,
    decision: verdict,
    invalidated: Boolean(invalidate),
    by: actor.userId,
  });

  return { sessionId, decision: verdict, session: deserialiseSession(updated), invalidated: Boolean(invalidate) };
}

/** Counters for the "Review" tab badge. */
async function reviewSummary(query = {}) {
  const { examId, organizationId } = query;
  const where = {};
  if (examId) where.examId = examId;
  if (organizationId) where.exam = { organizationId };

  const [pendingSetup, pendingReview, approved, rejected, ended, unresolved] = await Promise.all([
    prisma.proctorSession.count({ where: { ...where, status: 'PENDING_SETUP' } }),
    prisma.proctorSession.count({ where: { ...where, status: 'PENDING_REVIEW' } }),
    prisma.proctorSession.count({ where: { ...where, status: 'APPROVED' } }),
    prisma.proctorSession.count({ where: { ...where, status: 'REJECTED' } }),
    prisma.proctorSession.count({ where: { ...where, status: 'ENDED' } }),
    prisma.violation.count({ where: { isResolved: false, ...(examId ? { examId } : organizationId ? { attempt: { organizationId } } : {}) } }),
  ]);

  const flaggedAttempts = await prisma.attempt.count({ where: { isFlagged: true, ...(examId ? { examId } : organizationId ? { organizationId } : {}) } });

  return {
    pendingSetup,
    pendingReview,
    approved,
    rejected,
    ended,
    unresolvedViolations: unresolved,
    flaggedAttempts,
    totalAwaitingAttention: pendingReview + flaggedAttempts,
  };
}

/**
 * Ask the model to read the violation pattern and produce a 0-100 risk score.
 * Falls back to the deterministic weighting when AI is unavailable, so the
 * review queue is never blocked by an outage.
 */
async function aiRiskAssessment(attemptId, actor = {}) {
  assertStaff(actor);
  const session = await sessionFor(attemptId);
  await assertSessionExam(session, actor);

  const [violations, counters] = await Promise.all([
    prisma.violation.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' }, select: VIOLATION_READ_SELECT }),
    tallyViolations(attemptId),
  ]);

  const config = configFor(session.exam);
  const heuristic = riskScoreFor(counters, config);

  let analysis = null;
  let source = 'HEURISTIC';
  try {
    const ai = require('./ai.service');
    analysis = await ai.cheatingRiskAnalysis({
      attemptId,
      examId: session.examId,
      userId: session.userId,
      violations: violations.map(deserialiseViolation),
      counters,
      config,
    });
    source = 'AI';
  } catch (error) {
    logger.debug('ai risk analysis unavailable', { attemptId, error: error.message });
  }

  const score = clampScore(analysis?.score ?? analysis?.riskScore ?? heuristic);
  const reason = String(analysis?.reason ?? analysis?.summary ?? describeRisk(counters, score)).slice(0, 4000);
  const recommendation = analysis?.recommendation ?? recommendationFor(score, counters, config);

  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      riskScore: String(score),
      isFlagged: score >= thresholdFlag(config),
      metadata: {
        ...(session.attempt?.metadata ?? {}),
        aiRisk: { score, reason, recommendation, source, at: new Date().toISOString(), by: actor.userId },
      },
    },
  });

  if (violations.length) {
    await prisma.violation.update({
      where: { id: violations[violations.length - 1].id },
      data: { aiRiskScore: String(score), aiReason: source === 'AI' ? reason : null },
    });
  }

  broadcastToProctors(session.examId, 'proctor:risk-updated', { attemptId, score, source, recommendation });
  return { attemptId, score, reason, recommendation, source, counters, heuristic };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(100, number)) * 100) / 100;
}

function describeRisk(counters, score) {
  if (!counters.totalEvents) return 'No violations were recorded for this attempt.';
  const top = Object.entries(counters.byType).sort(([, a], [, b]) => b - a).slice(0, 3);
  const breakdown = top.map(([type, count]) => `${violationText(type, count)}`).join(', ');
  return `Risk score ${score}/100 from ${counters.totalOccurrences} occurrence(s): ${breakdown}.${counters.criticalOpen ? ` ${counters.criticalOpen} unresolved critical event(s).` : ''}`;
}

function recommendationFor(score, counters, config = {}) {
  if (counters.criticalOpen >= 2 || score >= 85) return 'INVALIDATE';
  if (score >= thresholdFlag(config)) return 'MANUAL_REVIEW';
  if (score >= 40) return 'WATCH';
  return 'APPROVE';
}

// ---------------------------------------------------------------------------
// Read-only helpers reused by other services
// ---------------------------------------------------------------------------

/** The proctoring picture for one attempt, used by attempt/analytics views. */
async function proctoringSnapshot(attemptId) {
  const session = await prisma.proctorSession.findUnique({
    where: { attemptId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      endedAt: true,
      termsAccepted: true,
      faceMatchScore: true,
      selfieUrl: true,
      idDocFrontUrl: true,
      environmentUrls: true,
      attempt: { select: { violationCount: true, riskScore: true, isFlagged: true, status: true } },
    },
  });
  if (!session) return null;
  return {
    ...session,
    faceMatchScore: session.faceMatchScore == null ? null : Number(session.faceMatchScore),
    violationCount: session.attempt?.violationCount ?? 0,
    riskScore: Number(session.attempt?.riskScore ?? 0),
  };
}

/** Counts feeding `GET /proctoring/stats` and the organization dashboard. */
async function proctoringStats(query = {}) {
  const { examId, organizationId, from, to } = query;
  const sessionWhere = {};
  if (examId) sessionWhere.examId = examId;
  if (organizationId) sessionWhere.exam = { organizationId };
  if (from || to) {
    sessionWhere.createdAt = {};
    if (from) sessionWhere.createdAt.gte = new Date(from);
    if (to) sessionWhere.createdAt.lte = new Date(to);
  }

  const violationWhere = { ...sessionWhere };
  delete violationWhere.exam;
  if (examId) violationWhere.examId = examId;
  if (organizationId) violationWhere.attempt = { organizationId };

  const [sessions, byStatus, violations, byType] = await Promise.all([
    prisma.proctorSession.count({ where: sessionWhere }),
    prisma.proctorSession.groupBy({ by: ['status'], where: sessionWhere, _count: { _all: true } }),
    prisma.violation.count({ where: violationWhere }),
    prisma.violation.groupBy({ by: ['type'], where: violationWhere, _sum: { count: true }, orderBy: { _sum: { count: 'desc' } }, take: 12 }),
  ]);

  return {
    sessions,
    byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row.status]: row._count._all }), {}),
    violations,
    topViolations: byType.map((row) => ({ type: row.type, count: Number(row._sum.count ?? 0), label: violationText(row.type, Number(row._sum.count ?? 0)) })),
  };
}

module.exports = {
  DEFAULT_SEVERITY,
  MESSAGE_KINDS,
  RECORDING_KINDS,
  SESSION_OPEN_STATES,
  VIOLATION_LABELS,
  VIOLATION_TYPES,
  aiRiskAssessment,
  allowedByConfig,
  approveProctorSetup,
  candidateMonitorState,
  completeProctorSetup,
  configFor,
  endProctorSession,
  finaliseRecording,
  flagAttempt,
  grantExtraTime,
  listLiveSessions,
  listProctorMessages,
  listRecordings,
  listViolations,
  markConversationRead,
  markMessageRead,
  pauseCandidateExam,
  proctorDashboard,
  proctoringSnapshot,
  proctoringStats,
  recordingGallery,
  rejectProctorSetup,
  replyToProctor,
  reportPresence,
  resumeCandidateExam,
  retryProctorSetup,
  reviewProctorSession,
  reviewQueue,
  reviewSummary,
  riskScoreFor,
  saveRecording,
  sendProctorMessage,
  sessionFor,
  setupRequirements,
  terminateCandidateExam,
  tallyViolations,
  unreadMessageCount,
  violationTimeline,
};
