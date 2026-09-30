/**
 * Certificate identity + signing helpers.
 *
 * Every certificate carries three identifiers:
 *   certificateNo  human readable, unique, printed on the PDF  (EXAM-2026-000123)
 *   verifyToken    unguessable slug used in the public /verify/:token URL
 *   signatureHash  HMAC-SHA256 over the canonical payload, so a PDF can be
 *                  re-checked against the database without trusting its text
 */

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const env = require('../config/env');

const CANONICAL_FIELDS = ['certificateNo', 'attemptId', 'candidateName', 'examTitle', 'scorePercent', 'issuedAt'];

function hmac(payload, secret = env.CERTIFICATE_SECRET) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Sequential-looking but unpredictable certificate number. */
function generateCertificateNo(prefix = 'EXAM', sequence = null) {
  const year = new Date().getFullYear();
  const tail = sequence !== null
    ? String(sequence).padStart(6, '0')
    : crypto.randomBytes(4).readUInt32BE(0).toString().padStart(6, '0').slice(-6);
  return `${prefix}-${year}-${tail}`;
}

function generateVerifyToken() {
  return `${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(6).toString('base64url')}`;
}

/** Canonical string that both issuing and verification recomputes. */
function canonicalPayload(data = {}) {
  return CANONICAL_FIELDS.map((field) => {
    const value = data[field];
    if (value instanceof Date) return `${field}=${value.toISOString()}`;
    if (typeof value === 'number') return `${field}=${Number.isInteger(value) ? value : value.toFixed(2)}`;
    return `${field}=${value ?? ''}`;
  }).join('|');
}

function signCertificate(data, secret = env.CERTIFICATE_SECRET) {
  const hash = hmac(canonicalPayload(data), secret);
  return {
    signatureHash: hash,
    digitalSignature: {
      algorithm: 'HMAC-SHA256',
      keyId: secret === env.CERTIFICATE_SECRET ? 'primary' : 'custom',
      hash,
      signedAt: new Date().toISOString(),
      payload: canonicalPayload(data),
    },
  };
}

/**
 * Timing-safe verification. The caller supplies the row read from the
 * database plus the hash embedded in the PDF/metadata.
 */
function verifyCertificateSignature(row, presentedHash, secret = env.CERTIFICATE_SECRET) {
  if (!row || !presentedHash) return { valid: false, reason: 'MISSING_SIGNATURE' };
  if (row.status === 'REVOKED') return { valid: false, reason: 'REVOKED', revokedAt: row.revokedAt ?? null };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: 'EXPIRED', expiresAt: row.expiresAt };
  }
  const expected = hmac(canonicalPayload(rowToCanonical(row)), secret);
  const matches = safeEqual(expected, String(presentedHash));
  return matches
    ? { valid: true, reason: null }
    : { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

function rowToCanonical(row) {
  return {
    certificateNo: row.certificateNo,
    attemptId: row.attemptId,
    candidateName: row.candidateName,
    examTitle: row.examTitle,
    scorePercent: Number(row.scorePercent),
    issuedAt: row.issuedAt,
  };
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** URL the QR code encodes; the public verification page reads the token. */
function verificationUrl(verifyToken, baseUrl = env.CLIENT_URL) {
  return `${baseUrl.replace(/\/$/, '')}/verify/${verifyToken}`;
}

async function generateQrDataUrl(verifyToken, baseUrl = env.CLIENT_URL) {
  const url = verificationUrl(verifyToken, baseUrl);
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
  return { url, dataUrl };
}

/** Open Badges 3.0 assertion document published at /badges/:certificateNo. */
function buildBadgeAssertion(certificate, badge, baseUrl = env.API_BASE_URL) {
  return {
    '@context': 'https://w3id.org/openbadges/v3',
    type: 'Assertion',
    id: `${baseUrl.replace(/\/$/, '')}/badges/${certificate.certificateNo}`,
    name: badge?.name ?? certificate.examTitle,
    description: badge?.description ?? `Awarded for passing ${certificate.examTitle}`,
    image: badge?.imageUrl ?? null,
    issuedOn: new Date(certificate.issuedAt ?? Date.now()).toISOString(),
    expiresAt: certificate.expiresAt ? new Date(certificate.expiresAt).toISOString() : undefined,
    verification: {
      type: 'hosted',
      verifiedProperty: { type: 'id', id: verificationUrl(certificate.verifyToken, env.CLIENT_URL) },
    },
    recipient: {
      type: 'email',
      hashed: false,
      identity: certificate.recipientEmail ?? certificate.candidateEmail ?? null,
      name: certificate.candidateName,
    },
    achievement: {
      id: `${baseUrl.replace(/\/$/, '')}/achievements/${certificate.examId}`,
      type: 'achievement',
      name: certificate.examTitle,
      description: certificate.examTitle,
      criteria: {
        type: 'criteria',
        narrative: `Scored ${certificate.scorePercent}% (grade ${certificate.gradeLetter ?? 'n/a'}) in a proctored assessment`,
      },
    },
    signature: certificate.signatureHash,
  };
}

/**
 * Fill a template's placeholders. Supported tokens:
 *   {candidateName} {examTitle} {scorePercent} {gradeLetter} {issuedAt}
 *   {certificateNo} {verificationUrl} {organizationName} {validUntil}
 */
function renderTemplateTokens(text, data = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return '';
    if (value instanceof Date) return value.toDateString();
    return String(value);
  });
}

module.exports = {
  CANONICAL_FIELDS,
  buildBadgeAssertion,
  canonicalPayload,
  generateCertificateNo,
  generateQrDataUrl,
  generateVerifyToken,
  hmac,
  renderTemplateTokens,
  rowToCanonical,
  signCertificate,
  verificationUrl,
  verifyCertificateSignature,
};
