/**
 * Certificate service.
 *
 * A certificate is a signed record, not a PDF: the row carries a unique
 * `certificateNo` (printed), an unguessable `verifyToken` (encoded in the QR),
 * and an HMAC over the canonical fields so any copy can be checked against the
 * database. The PDF is derived from those three and is regenerated on demand,
 * which is why revocation is instant even for a file someone downloaded months
 * ago.
 *
 * Rendering happens in `report.service` (Puppeteer) and is loaded lazily so a
 * missing browser binary never costs a candidate their certificate row.
 */

const fs = require('node:fs');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { queueMail } = require('../config/mailer');
const { ApiError } = require('../utils/response.util');
const certificateUtil = require('../utils/certificate.util');
const { notifyUser, pushToUser } = require('./notification.service');

const DEFAULT_VALIDITY_YEARS = 3;
const MAX_REISSUE_ATTEMPTS = 5;
const PUBLIC_VERIFY_SELECT = {
  id: true,
  certificateNo: true,
  verifyToken: true,
  candidateName: true,
  examTitle: true,
  scorePercent: true,
  gradeLetter: true,
  issuedAt: true,
  expiresAt: true,
  status: true,
  pdfUrl: true,
  qrDataUrl: true,
  signatureHash: true,
  digitalSignature: true,
  validityYears: true,
  revokeReason: true,
  revokedAt: true,
  organizationId: true,
  examId: true,
  userId: true,
  metadata: true,
  organization: { select: { id: true, name: true, slug: true, branding: true, website: true } },
  exam: { select: { id: true, title: true, type: true, totalMarks: true, passingPercent: true, startsAt: true, endsAt: true } },
};

const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];

/** Relations every read path needs; `metadata` carries the org logo for emails. */
const CERTIFICATE_RELATIONS = {
  organization: { select: { id: true, name: true, slug: true, website: true, branding: true, settings: true } },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCertificateStaff(actor = {}) {
  return actor.platformRole === 'SUPER_ADMIN' || STAFF_ROLES.includes(actor.role) || STAFF_ROLES.includes(actor.platformRole);
}

function assertStaff(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  if (!isCertificateStaff(actor)) throw ApiError.forbidden('Only organization staff can manage certificates');
}

function assertOrganization(actor, organizationId) {
  if (actor.platformRole === 'SUPER_ADMIN') return;
  if (!actor.organizationId || actor.organizationId !== organizationId) throw ApiError.forbidden('This certificate belongs to another organization');
}

function deserialiseCertificate(certificate) {
  if (!certificate) return certificate;
  const out = { ...certificate };
  if (out.scorePercent != null) out.scorePercent = Number(out.scorePercent);
  if (out.template && out.template.config) out.template = { ...out.template, config: out.template.config };
  return out;
}

/** Sequence number that keeps `EXAM-2026-000124` looking sequential per org. */
async function nextSequence(organizationId) {
  const count = await prisma.certificate.count({ where: { organizationId } });
  return count + 1;
}

function prefixFor(exam) {
  const raw = String(exam.organization?.slug ?? exam.slug ?? 'EXAM')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return raw || 'EXAM';
}

/**
 * Reserve a certificate number. `certificateNo` and `verifyToken` are both
 * unique, so a collision (a re-issued certificate, a cloned org) retries rather
 * than surfacing a 500 to the caller.
 */
async function mintIdentifiers(organizationId, prefix) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_REISSUE_ATTEMPTS; attempt += 1) {
    const sequence = (await nextSequence(organizationId)) + attempt;
    const candidate = {
      certificateNo: certificateUtil.generateCertificateNo(prefix, sequence),
      verifyToken: certificateUtil.generateVerifyToken(),
    };
    const clash = await prisma.certificate.findFirst({
      where: { OR: [{ certificateNo: candidate.certificateNo }, { verifyToken: candidate.verifyToken }] },
      select: { id: true },
    });
    if (!clash) return candidate;
    lastError = `Collision on ${candidate.certificateNo}`;
  }
  throw ApiError.conflict('Could not allocate a unique certificate number, please retry', { lastError });
}

function expiryFor(issuedAt, validityYears) {
  const years = Number(validityYears) > 0 ? Number(validityYears) : DEFAULT_VALIDITY_YEARS;
  const date = new Date(issuedAt);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}

/** The fields the HMAC covers - identical at issue time and verify time. */
function canonicalFromRow(row) {
  return certificateUtil.rowToCanonical(row);
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Called from `attempt.service` once a result is released. Safe to call twice:
 * an existing row for the attempt is returned untouched.
 *
 * Returns `null` (never throws) when the attempt is not certificate-eligible,
 * because a failed certificate must not roll back a graded exam.
 */
async function issueForAttempt({ attemptId, templateId = null, issuedById = null, generatePdf = true, force = false, notify = true } = {}) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      user: { select: { id: true, displayName: true, email: true, firstName: true, lastName: true } },
      organization: { select: { id: true, name: true, slug: true, branding: true, website: true } },
      exam: {
        select: {
          id: true, title: true, slug: true, type: true, organizationId: true, createdById: true,
          settings: true, certificationFeeCents: true, passingPercent: true, totalMarks: true,
          certificateTemplate: true,
        },
      },
    },
  });
  if (!attempt) {
    logger.warn('certificate issue skipped - attempt missing', { attemptId });
    return null;
  }

  const existing = await prisma.certificate.findFirst({ where: { attemptId }, select: { id: true, status: true, certificateNo: true } });
  if (existing && !force) return existing;

  const eligibility = await certificateEligibility(attempt);
  if (!eligibility.eligible && !force) {
    logger.info('certificate not eligible', { attemptId, reasons: eligibility.reasons });
    return null;
  }
  if (!eligibility.eligible && force && !eligibility.overridable) {
    throw ApiError.unprocessable('This attempt cannot receive a certificate', { reasons: eligibility.reasons });
  }

  const settings = attempt.exam.settings ?? {};
  const template = await resolveTemplate({ examId: attempt.examId, organizationId: attempt.exam.organizationId, templateId });
  const validityYears = Number(template?.config?.validityYears ?? settings.certificateValidityYears ?? DEFAULT_VALIDITY_YEARS);
  const issuedAt = new Date();
  const scorePercent = Number(attempt.scorePercent ?? 0);
  const candidateName = displayCandidateName(attempt.user);
  const needsManualVerification = settings.certificateManualVerification === true && !issuedById;

  const { certificateNo, verifyToken } = await mintIdentifiers(attempt.exam.organizationId, prefixFor(attempt.exam));
  const qr = await certificateUtil.generateQrDataUrl(verifyToken);
  const basePayload = {
    certificateNo,
    attemptId,
    candidateName,
    examTitle: attempt.exam.title,
    scorePercent,
    issuedAt,
  };
  const signature = certificateUtil.signCertificate(basePayload);

  const created = await prisma.certificate.create({
    data: {
      certificateNo,
      verifyToken,
      attemptId,
      examId: attempt.examId,
      userId: attempt.userId,
      organizationId: attempt.exam.organizationId,
      templateId: template?.id ?? null,
      candidateName: basePayload.candidateName,
      examTitle: basePayload.examTitle,
      scorePercent: scorePercent.toFixed(2),
      gradeLetter: attempt.gradeLetter ?? null,
      issuedAt,
      expiresAt: expiryFor(issuedAt, validityYears),
      status: needsManualVerification ? 'PENDING' : 'ISSUED',
      qrDataUrl: qr.dataUrl,
      signatureHash: signature.signatureHash,
      digitalSignature: signature.digitalSignature,
      validityYears,
      issuedById: issuedById ?? (needsManualVerification ? null : attempt.exam.createdById),
      metadata: {
        verificationUrl: qr.url,
        algorithm: signature.digitalSignature.algorithm,
        keyId: signature.digitalSignature.keyId,
        autoIssued: issuedById == null,
        pendingVerification: needsManualVerification,
        feeCents: Number(attempt.exam.certificationFeeCents ?? 0),
      },
    },
    select: { ...PUBLIC_VERIFY_SELECT, template: { select: { id: true, name: true, config: true, backgroundImageUrl: true } } },
  });

  await attachBadge(created);

  if (generatePdf && !needsManualVerification) {
    await generatePdfFor(created.id).catch((error) => logger.warn('certificate pdf failed', { certificateId: created.id, error: error.message }));
  }

  if (notify && !needsManualVerification) {
    await notifyUser({
      userId: attempt.userId,
      type: 'CERTIFICATE_ISSUED',
      title: 'Your certificate is ready',
      body: `${attempt.exam.title} - certificate ${certificateNo}.`,
      actionUrl: `/certificates/${created.id}`,
      sendEmail: true,
      emailProps: {
        candidateName: created.candidateName,
        examTitle: created.examTitle,
        certificateNo,
        issuedOn: issuedAt,
        verificationUrl: qr.url,
        scorePercent,
      },
    }).catch((error) => logger.warn('certificate notification failed', { attemptId, error: error.message }));
  }

  if (needsManualVerification) {
    await notifyUser({
      userId: attempt.exam.createdById,
      type: 'CERTIFICATE_ISSUED',
      title: 'Certificate awaiting verification',
      body: `${created.candidateName} passed ${attempt.exam.title}; confirm to issue certificate ${certificateNo}.`,
      actionUrl: `/certificates?examId=${attempt.examId}`,
    }).catch(() => null);
  }

  pushToUser(attempt.userId, 'certificate:issued', { certificateId: created.id, certificateNo, examId: attempt.examId });
  logger.info('certificate issued', { certificateId: created.id, attemptId, certificateNo, status: created.status });

  return deserialiseCertificate(created);
}

/** Why a certificate is or is not warranted, with the reason list attached. */
async function certificateEligibility(attempt) {
  const settings = attempt.exam?.settings ?? {};
  const reasons = [];

  if (settings.issueCertificate === false) reasons.push('CERTIFICATES_DISABLED');
  if (attempt.exam?.type === 'SURVEY') reasons.push('SURVEY_HAS_NO_CERTIFICATE');
  if (!['GRADED', 'RELEASED'].includes(attempt.gradingStatus)) reasons.push('NOT_GRADED');
  if (['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) reasons.push('NOT_SUBMITTED');
  if (attempt.isTerminated) reasons.push('ATTEMPT_TERMINATED');

  const passBasis = settings.certificateOnCompletion === true ? true : attempt.passed === true;
  if (!passBasis) reasons.push('DID_NOT_PASS');

  // A paid certificate only exists once the money has actually arrived.
  const fee = Number(attempt.exam?.certificationFeeCents ?? 0);
  if (fee > 0 && settings.certificatePaid !== false) {
    const paid = await prisma.payment.findFirst({
      where: {
        attemptId: attempt.id,
        purpose: 'CERTIFICATION_FEE',
        status: 'SUCCEEDED',
      },
      select: { id: true },
    });
    if (!paid) reasons.push('CERTIFICATION_FEE_UNPAID');
  }

  return {
    eligible: reasons.length === 0,
    // Everything except an unfinished attempt can be waived by a staff override.
    overridable: reasons.every((reason) => reason !== 'NOT_SUBMITTED' && reason !== 'NOT_GRADED'),
    reasons,
    requiresPayment: reasons.includes('CERTIFICATION_FEE_UNPAID'),
  };
}

function displayCandidateName(user = {}) {
  if (!user) return 'Candidate';
  if (user.displayName) return user.displayName;
  const joined = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return joined || 'Candidate';
}

/** Certificate template: exam-specific, else the organization default. */
async function resolveTemplate({ examId, organizationId, templateId = null }) {
  if (templateId) {
    const explicit = await prisma.certificateTemplate.findUnique({ where: { id: templateId } });
    if (explicit) return explicit;
  }
  const forExam = await prisma.certificateTemplate.findUnique({ where: { examId } });
  if (forExam) return forExam;
  return prisma.certificateTemplate.findFirst({
    where: { organizationId, OR: [{ examId: null }, { examId: { not: null } }] },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

/** Open Badges assertion companion row. */
async function attachBadge(certificate) {
  try {
    const badge = await prisma.badge.upsert({
      where: { certificateId: certificate.id },
      create: {
        certificateId: certificate.id,
        name: `Certificate - ${certificate.examTitle}`,
        description: `Awarded for completing ${certificate.examTitle} with ${Number(certificate.scorePercent).toFixed(0)}%`,
        imageUrl: certificate.pdfUrl ?? null,
        criteria: { examId: certificate.examId, scorePercent: Number(certificate.scorePercent ?? 0), gradeLetter: certificate.gradeLetter ?? null },
        contextJson: certificateUtil.buildBadgeAssertion(certificate, { id: certificate.id, name: certificate.examTitle }),
        providerUrl: certificate.organization?.website ?? env.CLIENT_URL,
        recipientEmail: null,
      },
      update: { name: `Certificate - ${certificate.examTitle}` },
    });
    return badge;
  } catch (error) {
    logger.warn('badge creation failed', { certificateId: certificate.id, error: error.message });
    return null;
  }
}

/**
 * Ask `report.service` (Puppeteer) for the PDF and keep it on local disk.
 * Also exposed on its own so a download can lazily render a missing file.
 */
async function generatePdfFor(certificateId) {
  try {
    const report = require('./report.service');
    const rendered = await report.renderCertificatePdf({ certificateId });
    if (!rendered?.url) return null;

    const saved = await prisma.certificate.update({
      where: { id: certificateId },
      data: { pdfUrl: rendered.url, metadata: { ...((await prisma.certificate.findUnique({ where: { id: certificateId }, select: { metadata: true } }))?.metadata ?? {}), pdf: { storagePath: rendered.storagePath ?? null, sizeBytes: rendered.sizeBytes ?? null, generatedAt: new Date().toISOString() } } },
      select: { id: true, pdfUrl: true, certificateNo: true },
    });

    await prisma.uploadedFile.create({
      data: {
        certificateId,
        organizationId: (await prisma.certificate.findUnique({ where: { id: certificateId }, select: { organizationId: true } }))?.organizationId ?? null,
        kind: 'CERTIFICATE_PDF',
        url: rendered.url,
        storagePath: rendered.storagePath ?? '',
        originalName: `${saved.certificateNo}.pdf`,
        mimeType: rendered.mimeType ?? 'application/pdf',
        sizeBytes: Number(rendered.sizeBytes ?? 0),
        metadata: { certificateId },
      },
    }).catch((error) => logger.debug('certificate pdf bookkeeping failed', { certificateId, error: error.message }));

    return saved;
  } catch (error) {
    logger.warn('certificate rendering unavailable', { certificateId, error: error.message });
    return null;
  }
}

/** Staff approve the `PENDING` certificates after eyeballing identity/results. */
async function verifyAndIssue(certificateId, { approve = true, note = null, notify = true } = {}, actor = {}) {
  assertStaff(actor);
  const certificate = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { attempt: { select: { id: true, metadata: true, userId: true } }, exam: { select: { id: true, title: true, settings: true, createdById: true } } },
  });
  if (!certificate) throw ApiError.notFound('Certificate not found');
  assertOrganization(actor, certificate.organizationId);
  if (certificate.status !== 'PENDING') throw ApiError.conflict('This certificate is not awaiting verification', { status: certificate.status });

  if (!approve) {
    await prisma.certificate.update({
      where: { id: certificateId },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId, revokeReason: String(note ?? 'Verification declined') },
    });
    pushToUser(certificate.userId, 'certificate:declined', { certificateId, note });
    return { certificateId, status: 'REVOKED', approved: false };
  }

  const updated = await prisma.certificate.update({
    where: { id: certificateId },
    data: { status: 'ISSUED', issuedAt: new Date(), issuedById: actor.userId },
    select: { ...PUBLIC_VERIFY_SELECT },
  });

  await prisma.attempt.update({
    where: { id: certificate.attemptId },
    data: { metadata: { ...(certificate.attempt.metadata ?? {}), certificateVerified: { at: new Date().toISOString(), by: actor.userId, note: note ?? null } } },
  }).catch(() => null);

  await generatePdfFor(certificateId);

  if (notify) {
    await notifyUser({
      userId: certificate.userId,
      type: 'CERTIFICATE_ISSUED',
      title: 'Your certificate is ready',
      body: `${certificate.examTitle} - certificate ${certificate.certificateNo}.`,
      actionUrl: `/certificates/${certificateId}`,
      sendEmail: true,
      emailProps: {
        candidateName: certificate.candidateName,
        examTitle: certificate.examTitle,
        certificateNo: certificate.certificateNo,
        issuedOn: updated.issuedAt,
        verificationUrl: certificate.metadata?.verificationUrl ?? null,
        scorePercent: Number(certificate.scorePercent),
      },
    }).catch(() => null);
  }

  pushToUser(certificate.userId, 'certificate:issued', { certificateId, certificateNo: certificate.certificateNo });
  return { certificateId, status: 'ISSUED', approved: true, certificate: deserialiseCertificate(updated) };
}

/** Issue certificates for every passing attempt of an exam in one go. */
async function issueBulk(examId, { onlyPassed = true, templateId = null, notify = true, generatePdf = true, limit = 1000 } = {}, actor = {}) {
  assertStaff(actor);
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { organization: { select: { id: true, name: true, slug: true, branding: true, website: true } } },
  });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertOrganization(actor, exam.organizationId);

  const where = { examId, gradingStatus: { in: ['GRADED', 'RELEASED'] }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'GRADED'] } };
  if (onlyPassed) where.passed = true;
  const attempts = await prisma.attempt.findMany({ where, select: { id: true, userId: true }, take: Math.min(Number(limit) || 1000, 5000) });

  const issued = [];
  const skipped = [];
  const failed = [];

  for (const attempt of attempts) {
    try {
      const result = await issueForAttempt({ attemptId: attempt.id, templateId, issuedById: actor.userId, notify, generatePdf });
      if (!result) skipped.push({ attemptId: attempt.id, reason: 'NOT_ELIGIBLE' });
      else if (result.certificateNo) issued.push({ attemptId: attempt.id, certificateId: result.id ?? result.certificateId, certificateNo: result.certificateNo });
      else skipped.push({ attemptId: attempt.id, reason: 'ALREADY_ISSUED', certificateId: result.id });
    } catch (error) {
      failed.push({ attemptId: attempt.id, error: error.message });
    }
  }

  logger.info('bulk certificate issuance', { examId, issued: issued.length, skipped: skipped.length, failed: failed.length });
  return { examId, issued: issued.length, skipped: skipped.length, failed: failed.length, details: { issued, skipped, failed } };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const OWNER_OR_STAFF = 'You cannot see this certificate';

function canSeeCertificate(row, actor = {}) {
  if (!row) return false;
  if (actor.userId && row.userId === actor.userId) return true;
  if (!actor.userId) return false;
  return isCertificateStaff(actor) && (actor.platformRole === 'SUPER_ADMIN' || actor.organizationId === row.organizationId);
}

async function getCertificate(certificateId, actor = {}) {
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: {
      template: { select: { id: true, name: true, config: true, backgroundImageUrl: true } },
      attempt: { select: { id: true, finalScore: true, totalMarks: true, scorePercent: true, passed: true, percentile: true, submittedAt: true, gradedAt: true, releasedAt: true, attemptNumber: true, isTerminated: true } },
      user: { select: { id: true, email: true, displayName: true, firstName: true, lastName: true } },
      issuedBy: { select: { id: true, displayName: true, email: true } },
      revokedBy: { select: { id: true, displayName: true, email: true } },
      badge: { select: { id: true, name: true, description: true, imageUrl: true, criteria: true } },
      ...CERTIFICATE_RELATIONS,
    },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  if (!canSeeCertificate(row, actor)) throw ApiError.forbidden(OWNER_OR_STAFF);
  return deserialiseCertificate(row);
}

/** Candidate-facing wallet. */
async function myCertificates({ userId, status, organizationId, search, page = 1, limit = 20 } = {}) {
  const where = { userId };
  if (status) where.status = status;
  if (organizationId) where.organizationId = organizationId;
  if (search) {
    where.OR = [
      { certificateNo: { contains: String(search), mode: 'insensitive' } },
      { examTitle: { contains: String(search), mode: 'insensitive' } },
    ];
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const [items, total] = await Promise.all([
    prisma.certificate.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: {
        id: true,
        certificateNo: true,
        candidateName: true,
        examTitle: true,
        scorePercent: true,
        gradeLetter: true,
        issuedAt: true,
        expiresAt: true,
        status: true,
        pdfUrl: true,
        qrDataUrl: true,
        linkedInUrl: true,
        verifyToken: true,
        organization: { select: { id: true, name: true, slug: true, branding: true } },
        exam: { select: { id: true, title: true, type: true } },
      },
    }),
    prisma.certificate.count({ where }),
  ]);

  return {
    items: items.map((row) => {
      const out = deserialiseCertificate(row);
      out.verificationUrl = certificateUtil.verificationUrl(row.verifyToken);
      delete out.verifyToken;
      return out;
    }),
    total,
    page: safePage,
    limit: safeLimit,
  };
}

/** Staff-facing list with the filters the admin table needs. */
async function listCertificates({ examId, organizationId, userId, status, templateId, from, to, search, page = 1, limit = 20, sort = 'issuedAt' } = {}, actor = {}) {
  assertStaff(actor);
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') {
    if (!actor.organizationId) throw ApiError.forbidden(OWNER_OR_STAFF);
    where.organizationId = actor.organizationId;
  } else if (organizationId) {
    where.organizationId = organizationId;
  }
  if (examId) where.examId = examId;
  if (userId) where.userId = userId;
  if (templateId) where.templateId = templateId;
  if (status) where.status = Array.isArray(status) ? { in: status } : status;
  if (from || to) where.issuedAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  if (search) {
    where.OR = [
      { certificateNo: { contains: String(search), mode: 'insensitive' } },
      { candidateName: { contains: String(search), mode: 'insensitive' } },
      { examTitle: { contains: String(search), mode: 'insensitive' } },
    ];
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const sortField = ['issuedAt', 'createdAt', 'certificateNo', 'scorePercent', 'downloadCount', 'verifyCount'].includes(sort) ? sort : 'issuedAt';

  const [items, total, byStatus] = await Promise.all([
    prisma.certificate.findMany({
      where,
      orderBy: [{ [sortField]: 'desc' }, { createdAt: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: {
        id: true,
        certificateNo: true,
        candidateName: true,
        examTitle: true,
        scorePercent: true,
        gradeLetter: true,
        issuedAt: true,
        expiresAt: true,
        status: true,
        pdfUrl: true,
        downloadCount: true,
        verifyCount: true,
        emailSentAt: true,
        revokeReason: true,
        revokedAt: true,
        linkedInUrl: true,
        verifyToken: true,
        examId: true,
        userId: true,
        organization: { select: { id: true, name: true, slug: true } },
        exam: { select: { id: true, title: true, type: true } },
        user: { select: { id: true, email: true, displayName: true } },
        template: { select: { id: true, name: true } },
      },
    }),
    prisma.certificate.count({ where }),
    prisma.certificate.groupBy({ by: ['status'], where, _count: { _all: true } }),
  ]);

  return {
    items: items.map((row) => {
      const out = deserialiseCertificate(row);
      out.verificationUrl = certificateUtil.verificationUrl(row.verifyToken);
      delete out.verifyToken;
      return out;
    }),
    total,
    page: safePage,
    limit: safeLimit,
    statusBreakdown: Object.fromEntries(byStatus.map((group) => [group.status, group._count._all])),
  };
}

/**
 * Download the PDF. A missing render (browser binary was absent at issue time)
 * is generated on demand rather than answered with a 404.
 */
async function downloadCertificate(certificateId, actor = {}) {
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: { id: true, status: true, pdfUrl: true, certificateNo: true, userId: true, organizationId: true, metadata: true, examTitle: true, candidateName: true },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  if (!canSeeCertificate(row, actor)) throw ApiError.forbidden(OWNER_OR_STAFF);
  if (row.status === 'REVOKED') throw ApiError.unprocessable('This certificate has been revoked', { certificateNo: row.certificateNo });

  let storagePath = row.metadata?.pdf?.storagePath ?? null;
  if (!row.pdfUrl || !storagePath || !fs.existsSync(storagePath)) {
    const rendered = await generatePdfFor(certificateId);
    if (rendered?.pdfUrl) {
      row.pdfUrl = rendered.pdfUrl;
      const fresh = await prisma.certificate.findUnique({ where: { id: certificateId }, select: { metadata: true, pdfUrl: true } });
      storagePath = fresh?.metadata?.pdf?.storagePath ?? null;
      row.pdfUrl = fresh?.pdfUrl ?? row.pdfUrl;
    }
  }
  if (!row.pdfUrl) throw ApiError.notFound('The certificate PDF is not available yet, please retry in a moment');

  await prisma.certificate.update({ where: { id: certificateId }, data: { downloadCount: { increment: 1 } } }).catch(() => null);

  return {
    certificateId,
    certificateNo: row.certificateNo,
    fileName: `${row.certificateNo}.pdf`,
    url: row.pdfUrl,
    downloadUrl: storagePath && fs.existsSync(storagePath) ? `${env.API_BASE_URL.replace(/\/$/, '')}${row.pdfUrl}` : row.pdfUrl,
    sizeBytes: row.metadata?.pdf?.sizeBytes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

/**
 * What the public page may show. The token itself is never echoed back - the
 * visitor already has it in the URL and re-emitting it invites scraping.
 */
function publicVerifyPayload(row, extra = {}) {
  const branding = row.organization?.branding ?? {};
  return {
    certificateNo: row.certificateNo,
    candidateName: row.candidateName,
    examTitle: row.examTitle,
    scorePercent: Number(row.scorePercent ?? 0),
    gradeLetter: row.gradeLetter ?? null,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt ?? null,
    status: row.status,
    valid: extra.valid ?? row.status === 'ISSUED',
    reason: extra.reason ?? null,
    message: extra.message ?? null,
    organization: { name: row.organization?.name ?? null, logoUrl: branding.logoUrl ?? null, website: row.organization?.website ?? null },
    exam: row.exam ? { id: row.exam.id, title: row.exam.title, type: row.exam.type } : undefined,
    verificationUrl: certificateUtil.verificationUrl(row.verifyToken),
    qrDataUrl: row.qrDataUrl ?? null,
    badgeUrl: `${env.API_BASE_URL.replace(/\/$/, '')}/badges/${row.certificateNo}`,
    signature: { algorithm: row.digitalSignature?.algorithm ?? 'HMAC-SHA256', keyId: row.digitalSignature?.keyId ?? 'primary', hash: row.signatureHash ?? null },
    revokedAt: row.status === 'REVOKED' ? row.revokedAt ?? null : undefined,
    revokeReason: row.status === 'REVOKED' ? row.revokeReason ?? null : undefined,
  };
}

async function countVerification(certificateId) {
  await prisma.certificate.update({ where: { id: certificateId }, data: { verifyCount: { increment: 1 } } }).catch(() => null);
}

/** The QR code lands here: `/verify/:token`. */
async function verifyByToken(token) {
  const row = await prisma.certificate.findUnique({
    where: { verifyToken: String(token ?? '') },
    include: CERTIFICATE_RELATIONS,
  });
  if (!row) {
    return { found: false, valid: false, reason: 'NOT_FOUND', message: 'No certificate matches this code. Check the URL or contact the issuing organisation.' };
  }

  const check = certificateUtil.verifyCertificateSignature(row, row.signatureHash);
  const outcome = check.valid
    ? { valid: true, reason: null, message: 'This certificate is authentic and currently valid.' }
    : {
        valid: false,
        reason: check.reason,
        message:
          check.reason === 'REVOKED'
            ? 'This certificate has been revoked by the issuing organisation.'
            : check.reason === 'EXPIRED'
              ? 'This certificate has passed its validity period.'
              : check.reason === 'MISSING_SIGNATURE'
                ? 'This certificate carries no verifiable signature.'
                : 'The certificate signature does not match our records; treat it as unverifiable.',
      };

  await countVerification(row.id);
  return { found: true, ...publicVerifyPayload(row, outcome) };
}

/**
 * Manual lookup by the printed certificate number. Because the number is
 * sequential-looking and therefore guessable, the holder's surname is required
 * as a second factor before anything is disclosed.
 */
async function verifyByNumber({ certificateNo, lastName = null } = {}) {
  const row = await prisma.certificate.findFirst({
    where: { certificateNo: { equals: String(certificateNo ?? '').trim(), mode: 'insensitive' } },
    include: CERTIFICATE_RELATIONS,
  });
  if (!row) return { found: false, valid: false, reason: 'NOT_FOUND', message: 'No certificate matches that number.' };

  const surname = String(row.candidateName ?? '').trim().split(/\s+/).pop() ?? '';
  if (!lastName || surname.toLowerCase() !== String(lastName).trim().toLowerCase()) {
    return { found: true, valid: false, reason: 'IDENTITY_MISMATCH', message: 'The certificate number and surname do not match. Please check both and try again.' };
  }

  const check = certificateUtil.verifyCertificateSignature(row, row.signatureHash);
  const valid = check.reason === 'REVOKED' || check.reason === 'EXPIRED' ? false : check.valid;
  await countVerification(row.id);
  return {
    found: true,
    ...publicVerifyPayload(row, {
      valid,
      reason: valid ? null : check.reason,
      message: valid ? 'This certificate is authentic and currently valid.' : `This certificate cannot be validated (${check.reason}).`,
    }),
  };
}

/**
 * Cryptographic check of a PDF the caller already holds: recompute the HMAC of
 * the fields printed on the document and compare with the embedded signature.
 */
async function verifySignature({ certificateNo, signatureHash = null, data = {} } = {}) {
  const row = await prisma.certificate.findFirst({
    where: { certificateNo: { equals: String(certificateNo ?? '').trim(), mode: 'insensitive' } },
    select: { id: true, certificateNo: true, attemptId: true, candidateName: true, examTitle: true, scorePercent: true, issuedAt: true, expiresAt: true, status: true, signatureHash: true, revokedAt: true },
  });
  if (!row) return { found: false, valid: false, reason: 'NOT_FOUND' };

  const presented = signatureHash ?? row.signatureHash;
  const source = { ...row, ...(data.candidateName ? { candidateName: data.candidateName } : {}), ...(data.examTitle ? { examTitle: data.examTitle } : {}), ...(data.scorePercent != null ? { scorePercent: Number(data.scorePercent) } : {}), ...(data.issuedAt ? { issuedAt: new Date(data.issuedAt) } : {}) };
  const check = certificateUtil.verifyCertificateSignature(source, presented);
  return {
    found: true,
    valid: check.valid,
    reason: check.reason ?? null,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: revoke / restore / reissue
// ---------------------------------------------------------------------------

/**
 * Revocation is instant and authoritative: the verification path checks status
 * before it checks the signature, so a downloaded PDF stops verifying the
 * moment this runs.
 */
async function revokeCertificate(certificateId, { reason = null } = {}, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: { id: true, status: true, organizationId: true, userId: true, certificateNo: true, examTitle: true, revokeReason: true, revokedAt: true },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  assertOrganization(actor, row.organizationId);
  if (row.status === 'REVOKED') {
    return { certificateId, status: 'REVOKED', alreadyRevoked: true, revokedAt: row.revokedAt, reason: row.revokeReason };
  }

  const note = String(reason ?? 'Revoked by administrator').slice(0, 2000);
  const updated = await prisma.certificate.update({
    where: { id: certificateId },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId ?? null, revokeReason: note },
    select: { ...PUBLIC_VERIFY_SELECT },
  });

  await prisma.badge
    .updateMany({ where: { certificateId }, data: { contextJson: { ...certificateUtil.buildBadgeAssertion(updated, { name: `Certificate - ${row.examTitle}` }), revoked: true, revokedAt: new Date().toISOString() } } })
    .catch(() => null);

  await notifyUser({
    userId: row.userId,
    type: 'ANNOUNCEMENT',
    title: 'A certificate has been revoked',
    channels: ['IN_APP'],
    body: `Certificate ${row.certificateNo} (${row.examTitle}) has been revoked. Reason: ${note}`,
    actionUrl: `/certificates/${certificateId}`,
  }).catch(() => null);

  pushToUser(row.userId, 'certificate:revoked', { certificateId, certificateNo: row.certificateNo, reason: note });
  logger.info('certificate revoked', { certificateId, certificateNo: row.certificateNo, by: actor.userId });
  return { certificateId, status: 'REVOKED', revokedAt: updated.revokedAt, reason: note };
}

/** Only a signature that still validates may come back, so a tampered row stays down. */
async function restoreCertificate(certificateId, { reason = 'Restored by administrator' } = {}, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificate.findUnique({ where: { id: certificateId }, select: { id: true, status: true, organizationId: true, userId: true, certificateNo: true, signatureHash: true } });
  if (!row) throw ApiError.notFound('Certificate not found');
  assertOrganization(actor, row.organizationId);
  if (row.status !== 'REVOKED') throw ApiError.conflict('This certificate is not revoked', { status: row.status });

  const full = await prisma.certificate.findUnique({ where: { id: certificateId }, select: { ...PUBLIC_VERIFY_SELECT } });
  const check = certificateUtil.verifyCertificateSignature(full, row.signatureHash);
  if (!check.valid && check.reason !== 'REVOKED') {
    throw ApiError.unprocessable('Cannot restore this certificate - its signature no longer matches our records', { reason: check.reason });
  }

  const updated = await prisma.certificate.update({
    where: { id: certificateId },
    data: { status: 'ISSUED', revokedAt: null, revokedById: null, revokeReason: null, metadata: { ...(full.metadata ?? {}), restoredAt: new Date().toISOString(), restoredBy: actor.userId ?? null, restoreReason: String(reason).slice(0, 500) } },
    select: { ...PUBLIC_VERIFY_SELECT },
  });

  await notifyUser({
    userId: row.userId,
    type: 'CERTIFICATE_ISSUED',
    title: 'Your certificate is valid again',
    body: `Certificate ${row.certificateNo} has been reinstated.`,
    actionUrl: `/certificates/${certificateId}`,
  }).catch(() => null);

  pushToUser(row.userId, 'certificate:restored', { certificateId, certificateNo: row.certificateNo });
  return { certificateId, status: 'ISSUED', certificate: deserialiseCertificate(updated) };
}

/**
 * Correct a name or template: revoke the standing row and mint a fresh one so
 * both versions stay auditable, rather than editing a signed document in place.
 */
async function reissueCertificate(certificateId, { candidateName = null, templateId = null, reason = 'Reissued with corrections', notify = true } = {}, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { attempt: { select: { id: true, scorePercent: true, gradeLetter: true, userId: true, examId: true, gradingStatus: true, passed: true, status: true, isTerminated: true, metadata: true } }, exam: { select: { id: true, title: true, settings: true, organizationId: true } }, ...CERTIFICATE_RELATIONS },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  assertOrganization(actor, row.organizationId);

  const updated = await prisma.certificate.update({
    where: { id: certificateId },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.userId ?? null, revokeReason: `SUPERSEDED: ${String(reason).slice(0, 500)}` },
  });
  void updated.id;

  const replacement = await issueForAttempt({
    attemptId: row.attemptId,
    templateId: templateId ?? row.templateId,
    issuedById: actor.userId ?? null,
    force: true,
    notify: false,
  });
  if (!replacement) throw ApiError.unprocessable('The replacement certificate could not be created');

  if (candidateName) {
    await prisma.certificate.update({ where: { id: replacement.id }, data: { candidateName: String(candidateName).slice(0, 160) } });
    replacement.candidateName = String(candidateName).slice(0, 160);
  }

  if (notify) {
    await notifyUser({
      userId: row.userId,
      type: 'CERTIFICATE_ISSUED',
      title: 'Your certificate was reissued',
      body: `Certificate ${replacement.certificateNo} replaces the previous copy.`,
      actionUrl: `/certificates/${replacement.id}`,
    }).catch(() => null);
  }

  pushToUser(row.userId, 'certificate:reissued', { certificateId: replacement.id, certificateNo: replacement.certificateNo, superseded: row.certificateNo });
  logger.info('certificate reissued', { from: row.certificateNo, to: replacement.certificateNo, by: actor.userId });
  return { previousCertificateNo: row.certificateNo, certificate: replacement };
}

/** Sweep `ISSUED` rows past their expiry so dashboards and verifiers agree. */
async function checkCertificateExpiries() {
  const now = new Date();
  const expiring = await prisma.certificate.findMany({
    where: { status: 'ISSUED', expiresAt: { not: null, lte: now } },
    select: { id: true, certificateNo: true, userId: true, examTitle: true },
    take: 1000,
  });
  if (!expiring.length) return { expired: 0, notified: 0 };

  await prisma.certificate.updateMany({ where: { id: { in: expiring.map((row) => row.id) } }, data: { status: 'EXPIRED' } });
  return { expired: expiring.length, ids: expiring.map((row) => row.id), notified: 0 };
}

/** Heads-up before expiry; the sweep above does the actual state change. */
async function notifyExpiringCertificates(withinDays = 30) {
  const now = Date.now();
  const horizon = new Date(now + withinDays * 24 * 60 * 60 * 1000);
  const soon = await prisma.certificate.findMany({
    where: { status: 'ISSUED', expiresAt: { not: null, gt: new Date(now), lte: horizon } },
    select: { id: true, certificateNo: true, userId: true, examTitle: true, expiresAt: true, metadata: true },
    take: 500,
  });

  let notified = 0;
  for (const row of soon) {
    if (row.metadata?.expiryNotified) continue;
    await notifyUser({
      userId: row.userId,
      type: 'ANNOUNCEMENT',
      title: 'A certificate is about to expire',
      channels: ['IN_APP'],
      body: `${row.examTitle} (${row.certificateNo}) expires on ${new Date(row.expiresAt).toDateString()}.`,
      actionUrl: `/certificates/${row.id}`,
    })
      .then(() => {
        notified += 1;
        return prisma.certificate.update({ where: { id: row.id }, data: { metadata: { ...(row.metadata ?? {}), expiryNotified: new Date().toISOString() } } });
      })
      .catch(() => null);
  }
  return { checked: soon.length, notified };
}

// ---------------------------------------------------------------------------
// Sharing: badge, LinkedIn, email
// ---------------------------------------------------------------------------

/** Open Badges 3.0 JSON-LD document, served with `application/json`. */
async function badgeAssertion(certificateNo) {
  const row = await prisma.certificate.findUnique({
    where: { certificateNo: String(certificateNo ?? '').trim() },
    include: { badge: true, organization: { select: { id: true, name: true, website: true, branding: true } }, ...CERTIFICATE_RELATIONS },
  });
  if (!row) throw ApiError.notFound('No badge with that identifier');

  const assertion = row.badge?.contextJson ?? certificateUtil.buildBadgeAssertion(row, row.badge ?? { name: `Certificate - ${row.examTitle}` });
  return {
    ...assertion,
    verification: {
      ...(assertion.verification ?? {}),
      verifiedProperty: { type: 'id', id: certificateUtil.verificationUrl(row.verifyToken) },
    },
    revoked: row.status === 'REVOKED',
    evidence: `${env.API_BASE_URL.replace(/\/$/, '')}/certificates/${row.id}`,
  };
}

/** One-click "add to LinkedIn profile", pre-filled and stored on the row. */
async function linkedInShare(certificateId, actor = {}) {
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: { id: true, status: true, certificateNo: true, candidateName: true, examTitle: true, issuedAt: true, expiresAt: true, userId: true, linkedInUrl: true, organization: { select: { name: true, website: true, branding: true, metadata: true } } },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  if (!actor.userId || row.userId !== actor.userId) throw ApiError.forbidden('Only the owner can share this certificate');
  if (row.status !== 'ISSUED') throw ApiError.unprocessable('Only a valid certificate can be shared', { status: row.status });

  const issued = new Date(row.issuedAt);
  const expires = row.expiresAt ? new Date(row.expiresAt) : null;
  const orgName = row.organization?.name ?? 'Assessment organization';
  const orgSettings = row.organization?.settings ?? {};
  const orgUrl = row.organization?.branding?.linkedinUrl ?? orgSettings.linkedinUrl ?? row.organization?.website ?? null;

  const params = new URLSearchParams();
  params.set('name', row.examTitle);
  params.set('issuingOrganization', orgName);
  if (orgUrl) params.set('issuingOrganizationLink', orgUrl);
  params.set('issueMonth', String(issued.getUTCMonth() + 1));
  params.set('issueYear', String(issued.getUTCFullYear()));
  if (expires) {
    params.set('expirationMonth', String(expires.getUTCMonth() + 1));
    params.set('expirationYear', String(expires.getUTCFullYear()));
  }
  params.set('orgName', orgName);
  params.set('displayName', `Certificate - ${row.certificateNo}`);
  params.set('certId', row.certificateNo);
  params.set('url', certificateUtil.verificationUrl(row.verifyToken));

  const linkedInUrl = `https://www.linkedin.com/profile/add?${params.toString()}`;
  if (row.linkedInUrl !== linkedInUrl) {
    await prisma.certificate.update({ where: { id: certificateId }, data: { linkedInUrl } }).catch(() => null);
  }
  return { certificateId, linkedInUrl, verificationUrl: certificateUtil.verificationUrl((await prisma.certificate.findUnique({ where: { id: certificateId }, select: { verifyToken: true } })).verifyToken) };
}

/**
 * Nodemailer delivery with the PDF attached. Falls back to a link-only message
 * when the render is missing, so a broken browser binary never blocks delivery.
 */
async function emailCertificate(certificateId, actor = {}, { to = null, force = false, message = null } = {}) {
  const row = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { user: { select: { id: true, email: true, displayName: true, firstName: true, lastName: true } }, attempt: { select: { id: true, scorePercent: true, gradeLetter: true, passed: true, submittedAt: true, attemptNumber: true } }, ...CERTIFICATE_RELATIONS },
  });
  if (!row) throw ApiError.notFound('Certificate not found');
  if (!canSeeCertificate(row, actor)) throw ApiError.forbidden(OWNER_OR_STAFF);
  if (row.status === 'REVOKED') throw ApiError.unprocessable('A revoked certificate cannot be emailed');

  const recipient = to ?? row.user?.email;
  if (!recipient) throw ApiError.badRequest('There is no email address on file for this candidate');

  let storagePath = row.metadata?.pdf?.storagePath ?? null;
  if (!storagePath || !fs.existsSync(storagePath)) {
    await generatePdfFor(certificateId);
    const fresh = await prisma.certificate.findUnique({ where: { id: certificateId }, select: { metadata: true, pdfUrl: true } });
    storagePath = fresh?.metadata?.pdf?.storagePath ?? null;
    row.pdfUrl = fresh?.pdfUrl ?? row.pdfUrl;
  }

  const verifyUrl = certificateUtil.verificationUrl(row.verifyToken);
  const absolutePdfUrl = row.pdfUrl ? `${env.API_BASE_URL.replace(/\/$/, '')}${row.pdfUrl}` : null;
  const attachments = storagePath && fs.existsSync(storagePath)
    ? [{ filename: `${row.certificateNo}.pdf`, path: storagePath, contentType: 'application/pdf' }]
    : [];

  queueMail({
    to: recipient,
    subject: `Your certificate - ${row.examTitle} (${row.certificateNo})`,
    template: 'CertificateIssued',
    props: {
      userName: displayCandidateName(row.user),
      candidateName: row.candidateName,
      examTitle: row.examTitle,
      certificateNo: row.certificateNo,
      scorePercent: Number(row.scorePercent ?? 0).toFixed(1),
      issuedAt: row.issuedAt,
      verifyUrl,
      pdfUrl: absolutePdfUrl,
      organizationName: row.organization?.name ?? null,
      organizationLogoUrl: row.organization?.branding?.logoUrl ?? null,
      note: message ?? undefined,
    },
    attachments,
  });

  await prisma.certificate.update({
    where: { id: certificateId },
    data: { emailSentAt: force || row.emailSentAt == null ? new Date() : row.emailSentAt, metadata: { ...(row.metadata ?? {}), emailedTo: recipient, emailAttachments: attachments.length } },
  }).catch(() => null);

  logger.info('certificate emailed', { certificateId, recipient, attached: attachments.length > 0 });
  return { certificateId, delivered: true, recipient, attached: attachments.length > 0, pdfUrl: absolutePdfUrl, verificationUrl: verifyUrl };
}

/** Bulk email for a whole exam, used from the results page. */
async function emailCertificatesForExam(examId, actor = {}, { onlyIssued = true, limit = 200 } = {}) {
  assertStaff(actor);
  const where = { examId };
  if (actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;
  if (onlyIssued) where.status = 'ISSUED';

  const rows = await prisma.certificate.findMany({ where, select: { id: true }, take: Math.min(Number(limit) || 200, 1000) });
  const results = [];
  for (const row of rows) {
    try {
      const outcome = await emailCertificate(row.id, actor);
      results.push({ certificateId: row.id, ok: true, recipient: outcome.recipient });
    } catch (error) {
      results.push({ certificateId: row.id, ok: false, error: error.message });
    }
  }
  return { examId, sent: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length, details: results };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TOKEN_FIELDS = ['heading', 'subheading', 'bodyText', 'congratulations', 'footerNote', 'signatoryName', 'signatoryTitle', 'signatory2Name', 'signatory2Title'];

function normaliseTemplateConfig(config = {}) {
  const out = {
    size: ['A4_PORTRAIT', 'A4_LANDSCAPE', 'LETTER_PORTRAIT', 'LETTER_LANDSCAPE', 'A3_LANDSCAPE'].includes(config.size) ? config.size : 'A4_LANDSCAPE',
    theme: config.theme ?? 'classic',
    colors: {
      primary: config.colors?.primary ?? '#0f766e',
      accent: config.colors?.accent ?? '#b45309',
      text: config.colors?.text ?? '#0f172a',
      background: config.colors?.background ?? '#ffffff',
      border: config.colors?.border ?? '#0f766e',
    },
    border: {
      style: config.border?.style ?? 'double',
      width: Number(config.border?.width ?? 8),
      color: config.border?.color ?? config.colors?.primary ?? '#0f766e',
    },
    layout: {
      logoPosition: config.layout?.logoPosition ?? 'top-center',
      sealPosition: config.layout?.sealPosition ?? 'bottom-right',
      qrPosition: config.layout?.qrPosition ?? 'bottom-left',
      showScore: config.layout?.showScore !== false,
      showGrade: config.layout?.showGrade !== false,
      showValidity: config.layout?.showValidity !== false,
      showQR: config.layout?.showQR !== false,
      showSignature: config.layout?.showSignature !== false,
    },
    validityYears: Number(config.validityYears ?? DEFAULT_VALIDITY_YEARS),
    fonts: { heading: config.fonts?.heading ?? 'Georgia, serif', body: config.fonts?.body ?? 'Helvetica, Arial, sans-serif' },
  };

  for (const field of TOKEN_FIELDS) {
    if (typeof config[field] === 'string') out[field] = config[field];
  }
  out.heading = out.heading ?? 'Certificate of Achievement';
  out.subheading = out.subheading ?? 'This is to certify that';
  out.bodyText = out.bodyText ?? 'has successfully completed {examTitle}';
  out.congratulations = out.congratulations ?? 'Congratulations on this accomplishment.';
  out.footerNote = out.footerNote ?? 'Verify this certificate at {verificationUrl}';
  out.custom = config.custom ?? {};
  return out;
}

/** Sample values so a preview shows real text instead of bare tokens. */
function previewData(overrides = {}) {
  const now = new Date();
  return {
    candidateName: 'Jordan Alvarez',
    examTitle: 'Advanced Data Structures',
    scorePercent: '87.5',
    gradeLetter: 'A',
    certificateNo: 'EXAM-2026-000123',
    issuedAt: now,
    issuedAtText: now.toDateString(),
    validUntil: new Date(now.getTime() + 3 * 365 * 24 * 60 * 60 * 1000),
    organizationName: 'Academy of Technology',
    verificationUrl: certificateUtil.verificationUrl('sample-token'),
    ...overrides,
  };
}

async function assertTemplateExam(template, examId, organizationId) {
  if (!examId) return null;
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, organizationId: true } });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (exam.organizationId !== organizationId) throw ApiError.forbidden('That exam belongs to another organization');
  void template;
  return exam;
}

async function createTemplate(input = {}, actor = {}) {
  assertStaff(actor);
  const organizationId = actor.platformRole === 'SUPER_ADMIN' ? input.organizationId : actor.organizationId;
  if (!organizationId) throw ApiError.badRequest('No organization on this account');
  const exam = await assertTemplateExam(null, input.examId ?? null, organizationId);

  if (input.examId) {
    const existing = await prisma.certificateTemplate.findUnique({ where: { examId: input.examId } });
    if (existing) throw ApiError.conflict('This exam already has a certificate template - update it instead', { templateId: existing.id });
  }

  const config = normaliseTemplateConfig(input.config ?? {});
  if (exam) config.examTitle = config.examTitle ?? exam.title;

  const made = await prisma.certificateTemplate.create({
    data: {
      organizationId,
      examId: input.examId ?? null,
      name: String(input.name ?? `${exam ? exam.title : 'Default'} certificate`).slice(0, 140),
      description: input.description ? String(input.description).slice(0, 2000) : null,
      config,
      backgroundImageUrl: input.backgroundImageUrl ?? null,
      isDefault: input.isDefault === true && !input.examId,
    },
  });
  if (made.isDefault) await clearOtherDefaults(made.id, made.organizationId);
  return made;
}

async function updateTemplate(templateId, patch = {}, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificateTemplate.findUnique({ where: { id: templateId } });
  if (!row) throw ApiError.notFound('Template not found');
  assertOrganization(actor, row.organizationId);

  const data = {};
  if (patch.name != null) data.name = String(patch.name).slice(0, 140);
  if (patch.description != null) data.description = String(patch.description).slice(0, 2000);
  if (patch.backgroundImageUrl !== undefined) data.backgroundImageUrl = patch.backgroundImageUrl ?? null;
  if (patch.config) data.config = normaliseTemplateConfig({ ...row.config, ...patch.config });
  if (patch.isDefault !== undefined) data.isDefault = patch.isDefault === true && !row.examId;

  const updated = await prisma.certificateTemplate.update({ where: { id: templateId }, data });
  if (updated.isDefault) await clearOtherDefaults(updated.id, updated.organizationId);
  return updated;
}

async function listTemplates({ examId, organizationId, includeShared = false } = {}, actor = {}) {
  assertStaff(actor);
  const scope = actor.platformRole === 'SUPER_ADMIN' ? organizationId : actor.organizationId;
  if (!scope) throw ApiError.forbidden('No organization on this account');

  const where = includeShared ? { OR: [{ organizationId: scope }, ...(organizationId && organizationId !== scope ? [{ organizationId }] : [])] } : { organizationId: scope };
  if (examId) where.OR = [{ examId }, ...(includeShared ? [{ organizationId: scope, examId: null }] : [])];

  const items = await prisma.certificateTemplate.findMany({
    where,
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    include: { exam: { select: { id: true, title: true } }, _count: { select: { certificates: true } } },
  });
  return { items, total: items.length };
}

async function deleteTemplate(templateId, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificateTemplate.findUnique({ where: { id: templateId }, include: { _count: { select: { certificates: true } } } });
  if (!row) throw ApiError.notFound('Template not found');
  assertOrganization(actor, row.organizationId);
  if (row._count.certificates > 0) {
    throw ApiError.conflict('This template has already issued certificates and cannot be deleted', { certificates: row._count.certificates });
  }
  await prisma.certificateTemplate.delete({ where: { id: templateId } });
  return { deleted: true, templateId };
}

async function setDefaultTemplate(templateId, actor = {}) {
  assertStaff(actor);
  const row = await prisma.certificateTemplate.findUnique({ where: { id: templateId } });
  if (!row) throw ApiError.notFound('Template not found');
  assertOrganization(actor, row.organizationId);
  if (row.examId) throw ApiError.badRequest('Exam-bound templates cannot become the organization default');

  await prisma.certificateTemplate.updateMany({ where: { organizationId: row.organizationId, examId: null, NOT: { id: templateId } }, data: { isDefault: false } });
  return prisma.certificateTemplate.update({ where: { id: templateId }, data: { isDefault: true } });
}

async function clearOtherDefaults(templateId, organizationId) {
  await prisma.certificateTemplate.updateMany({
    where: { organizationId, examId: null, NOT: { id: templateId } },
    data: { isDefault: false },
  }).catch(() => null);
}

/**
 * Rendered strings for the client-side preview (the client owns the canvas;
 * Puppeteer uses the same config for the PDF, so both stay in agreement).
 */
async function templatePreview(templateId, data = {}) {
  const row = await prisma.certificateTemplate.findUnique({
    where: { id: templateId },
    include: { exam: { select: { id: true, title: true } }, organization: { select: { id: true, name: true, branding: true, website: true } } },
  });
  if (!row) throw ApiError.notFound('Template not found');

  const values = previewData({
    ...(data.candidateName ? { candidateName: data.candidateName } : {}),
    examTitle: data.examTitle ?? row.exam?.title ?? row.config?.examTitle ?? 'Advanced Data Structures',
    organizationName: row.organization?.name ?? 'Academy of Technology',
  });

  const rendered = {};
  for (const field of TOKEN_FIELDS) {
    if (typeof row.config?.[field] === 'string') rendered[field] = certificateUtil.renderTemplateTokens(row.config[field], values);
  }

  return {
    templateId: row.id,
    name: row.name,
    config: row.config,
    backgroundImageUrl: row.backgroundImageUrl,
    organization: { name: row.organization?.name ?? null, branding: row.organization?.branding ?? {}, website: row.organization?.website ?? null },
    values,
    rendered,
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

async function certificateStats({ examId, organizationId, from, to } = {}, actor = {}) {
  assertStaff(actor);
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;
  else if (organizationId) where.organizationId = organizationId;
  if (examId) where.examId = examId;
  if (from || to) where.issuedAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  const [total, byStatus, downloads, verifications, recent, pending] = await Promise.all([
    prisma.certificate.count({ where }),
    prisma.certificate.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.certificate.aggregate({ where, _sum: { downloadCount: true } }),
    prisma.certificate.aggregate({ where, _sum: { verifyCount: true } }),
    prisma.certificate.findMany({ where, orderBy: { issuedAt: 'desc' }, take: 10, select: { id: true, certificateNo: true, candidateName: true, examTitle: true, issuedAt: true, status: true } }),
    prisma.certificate.findMany({ where: { ...where, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 100, select: { id: true, certificateNo: true, candidateName: true, examTitle: true } }),
  ]);

  const breakdown = Object.fromEntries(byStatus.map((group) => [group.status, group._count._all]));
  const expiryHorizon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const expiringSoon = await prisma.certificate.count({ where: { ...where, status: 'ISSUED', expiresAt: { not: null, lte: expiryHorizon } } });

  return {
    total,
    issued: breakdown.ISSUED ?? 0,
    pending: breakdown.PENDING ?? 0,
    revoked: breakdown.REVOKED ?? 0,
    expired: breakdown.EXPIRED ?? 0,
    downloads: downloads._sum.downloadCount ?? 0,
    verifications: verifications._sum.verifyCount ?? 0,
    expiringWithinDays: 90,
    expiringSoon,
    byStatus: breakdown,
    recent,
    awaitingVerification: pending,
  };
}

/** Verification-page traffic, for the "is this being checked?" widget. */
async function verificationStats({ certificateId = null, examId = null, organizationId, limit = 20 } = {}, actor = {}) {
  assertStaff(actor);
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;
  else if (organizationId) where.organizationId = organizationId;
  if (certificateId) where.id = certificateId;
  if (examId) where.examId = examId;

  const rows = await prisma.certificate.findMany({
    where,
    orderBy: [{ verifyCount: 'desc' }, { issuedAt: 'desc' }],
    take: Math.min(Number(limit) || 20, 100),
    select: { id: true, certificateNo: true, candidateName: true, examTitle: true, verifyCount: true, downloadCount: true, status: true, issuedAt: true },
  });
  const totals = rows.reduce((acc, row) => ({ verifies: acc.verifies + row.verifyCount, downloads: acc.downloads + row.downloadCount }), { verifies: 0, downloads: 0 });
  return { items: rows, totalVerifies: totals.verifies, totalDownloads: totals.downloads };
}

module.exports = {
  attachBadge,
  badgeAssertion,
  canSeeCertificate,
  certificateEligibility,
  certificateStats,
  checkCertificateExpiries,
  clearOtherDefaults,
  createTemplate,
  deleteTemplate,
  deserialiseCertificate,
  displayCandidateName,
  downloadCertificate,
  emailCertificate,
  emailCertificatesForExam,
  expiryFor,
  generatePdfFor,
  getCertificate,
  issueBulk,
  issueForAttempt,
  linkedInShare,
  listCertificates,
  listTemplates,
  mintIdentifiers,
  myCertificates,
  nextSequence,
  normaliseTemplateConfig,
  notifyExpiringCertificates,
  prefixFor,
  publicVerifyPayload,
  reissueCertificate,
  resolveTemplate,
  restoreCertificate,
  revokeCertificate,
  setDefaultTemplate,
  templatePreview,
  updateTemplate,
  verificationStats,
  verifyAndIssue,
  verifyByNumber,
  verifyByToken,
  verifySignature,
  canonicalFromRow,
};
