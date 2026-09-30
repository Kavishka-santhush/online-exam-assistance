/**
 * Local-disk upload handling (no cloud storage).
 *
 * Files land in `<UPLOAD_DIR>/<category>/<yyyy>/<mm>/<random><ext>` and are
 * served statically by `app.js` at `/uploads/...`. Every upload also creates an
 * `UploadedFile` row (done by the service, not here) so orphaned files can be
 * swept by `cleanup.job.js`.
 *
 * `category` decides the allowed mime types and size ceiling:
 *   avatar | document | media | question | certificate | proctoring | recording | import
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const env = require('./env');
const { ApiError } = require('../utils/response.util');

const IMAGE_TYPES = env.ALLOWED_IMAGE_TYPES.length
  ? env.ALLOWED_IMAGE_TYPES
  : ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const DOCUMENT_TYPES = env.ALLOWED_DOCUMENT_TYPES.length
  ? env.ALLOWED_DOCUMENT_TYPES
  : ['application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const MEDIA_TYPES = env.ALLOWED_MEDIA_TYPES.length
  ? env.ALLOWED_MEDIA_TYPES
  : ['audio/webm', 'audio/mpeg', 'video/webm', 'video/mp4'];

const SPREADSHEET_TYPES = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const CATEGORY_RULES = {
  avatar: { mimeTypes: IMAGE_TYPES, maxFiles: 1, maxSizeMb: 5 },
  question: { mimeTypes: [...IMAGE_TYPES, 'image/svg+xml', ...MEDIA_TYPES], maxFiles: 6, maxSizeMb: 25 },
  document: { mimeTypes: [...DOCUMENT_TYPES, 'application/zip'], maxFiles: 5, maxSizeMb: env.MAX_FILE_SIZE_MB },
  media: { mimeTypes: [...MEDIA_TYPES, ...IMAGE_TYPES], maxFiles: 3, maxSizeMb: env.MAX_FILE_SIZE_MB },
  answer: { mimeTypes: [...DOCUMENT_TYPES, ...MEDIA_TYPES, ...IMAGE_TYPES, 'application/zip'], maxFiles: 5, maxSizeMb: env.MAX_FILE_SIZE_MB },
  certificate: { mimeTypes: [...IMAGE_TYPES, 'application/pdf', 'image/svg+xml'], maxFiles: 4, maxSizeMb: 15 },
  branding: { mimeTypes: [...IMAGE_TYPES, 'image/svg+xml'], maxFiles: 3, maxSizeMb: 8 },
  proctoring: { mimeTypes: [...IMAGE_TYPES, 'image/jpeg'], maxFiles: 12, maxSizeMb: 20 },
  recording: { mimeTypes: [...MEDIA_TYPES, 'application/octet-stream', 'video/x-webm'], maxFiles: 20, maxSizeMb: env.MAX_FILE_SIZE_MB },
  import: { mimeTypes: [...SPREADSHEET_TYPES, 'text/tab-separated-values'], maxFiles: 1, maxSizeMb: 20 },
  export: { mimeTypes: [...DOCUMENT_TYPES, 'application/pdf'], maxFiles: 1, maxSizeMb: 50 },
};

const EXTENSION_ALLOW_LIST = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.pdf', '.txt', '.md', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.zip',
  '.mp3', '.wav', '.m4a', '.weba', '.mp4', '.mov', '.mkv',
]);

function categoryRules(category) {
  return CATEGORY_RULES[category] ?? CATEGORY_RULES.document;
}

/** `<uploadRoot>/<category>/<yyyy>/<mm>` - created lazily on first use. */
function resolveTargetDir(category) {
  const now = new Date();
  const relative = path.posix.join(category, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  const absolute = path.join(env.uploadRoot, relative);
  fs.mkdirSync(absolute, { recursive: true });
  return { absolute, relative: relative.split(path.sep).join('/') };
}

/** Never trust the client filename: keep only a sanitised stem for debugging. */
function safeStem(originalName = '') {
  const base = path.basename(String(originalName)).toLowerCase().replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 48) || 'file';
}

function safeExtension(originalName = '') {
  const extension = path.extname(String(originalName)).toLowerCase();
  return EXTENSION_ALLOW_LIST.has(extension) ? extension : '';
}

const storage = multer.diskStorage({
  destination(req, file, callback) {
    try {
      const category = req.uploadCategory ?? 'document';
      const { absolute } = resolveTargetDir(category);
      callback(null, absolute);
    } catch (error) {
      callback(error);
    }
  },
  filename(req, file, callback) {
    const extension = safeExtension(file.originalname) || guessExtension(file.mimetype);
    callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safeStem(file.originalname)}${extension}`);
  },
});

function guessExtension(mimeType = '') {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/csv': '.csv',
    'text/plain': '.txt',
    'audio/webm': '.weba',
    'video/webm': '.webm',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'application/zip': '.zip',
  };
  return map[mimeType] ?? '';
}

/** Public URL stored on `UploadedFile.url` and embedded in answers. */
function publicUrlFor(file) {
  const relativeFromRoot = path.relative(env.uploadRoot, file.path).split(path.sep).join('/');
  return `/uploads/${relativeFromRoot}`;
}

function ensureUploadRoot() {
  fs.mkdirSync(env.uploadRoot, { recursive: true });
  for (const category of Object.keys(CATEGORY_RULES)) {
    fs.mkdirSync(path.join(env.uploadRoot, category), { recursive: true });
  }
}

function buildUploader(category, { maxFiles, maxSizeMb } = {}) {
  const rules = categoryRules(category);
  const allowed = new Set(rules.mimeTypes);
  const fileSize = Math.min((maxSizeMb ?? rules.maxSizeMb) * 1024 * 1024, env.maxFileBytes);

  return multer({
    storage,
    limits: { fileSize, files: maxFiles ?? rules.maxFiles, fields: 40 },
    fileFilter(req, file, callback) {
      req.uploadCategory = category;
      if (!allowed.has(file.mimetype)) {
        callback(ApiError.badRequest(`Unsupported file type "${file.mimetype}" for ${category} uploads`, { allowed: [...allowed] }));
        return;
      }
      callback(null, true);
    },
  });
}

/** Cache the builder per category so each call does not re-allocate multer. */
const uploaderCache = new Map();
function uploader(category, options) {
  const key = `${category}:${options?.maxFiles ?? ''}:${options?.maxSizeMb ?? ''}`;
  if (!uploaderCache.has(key)) uploaderCache.set(key, buildUploader(category, options));
  return uploaderCache.get(key);
}

/**
 * Multer surfaces limit problems as `MulterError`; translate them into the
 * envelope the client understands.
 */
function handleUploadError(error, req, res, next) {
  if (!error) return next();
  if (error.name === 'MulterError') {
    const messages = {
      LIMIT_FILE_SIZE: `File exceeds the ${Math.round(env.maxFileBytes / 1024 / 1024)}MB upload limit`,
      LIMIT_FILE_COUNT: 'Too many files in one request',
      LIMIT_UNEXPECTED_FILE: 'Unexpected form field name for this upload',
      LIMIT_FIELD_VALUE: 'A form field exceeded the length limit',
    };
    return res.status(400).json({
      success: false,
      error: { code: 'UPLOAD_REJECTED', message: messages[error.code] ?? error.message, details: { multerCode: error.code } },
    });
  }
  return next(error);
}

/** Stream an upload straight to `UploadedFile` with the shared shape. */
function toUploadedFileRecord(file, { userId, organizationId, examId = null, attemptId = null, answerId = null, questionId = null, certificateId = null, category, context = {} }) {
  return {
    userId,
    organizationId,
    examId,
    attemptId,
    answerId,
    questionId,
    certificateId,
    kind: categoryToMediaKind(category),
    originalName: file.originalname,
    storagePath: file.path,
    url: publicUrlFor(file),
    mimeType: file.mimetype,
    sizeBytes: Number(file.size),
    checksum: crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),
    metadata: context,
  };
}

function categoryToMediaKind(category) {
  switch (category) {
    case 'avatar':
      return 'AVATAR';
    case 'question':
      return 'QUESTION_IMAGE';
    case 'answer':
      return 'ANSWER_ATTACHMENT';
    case 'proctoring':
      return 'VIOLATION_SCREENSHOT';
    case 'recording':
      return 'WEBCAM_RECORDING';
    case 'certificate':
      return 'CERTIFICATE_PDF';
    case 'branding':
      return 'ORG_LOGO';
    case 'import':
      return 'IMPORT_FILE';
    case 'export':
      return 'EXPORT_FILE';
    default:
      return 'ANSWER_ATTACHMENT';
  }
}

module.exports = {
  CATEGORY_RULES,
  DOCUMENT_TYPES,
  IMAGE_TYPES,
  MEDIA_TYPES,
  SPREADSHEET_TYPES,
  categoryRules,
  ensureUploadRoot,
  handleUploadError,
  publicUrlFor,
  toUploadedFileRecord,
  upload,
  uploader,
};

/** Convenience presets used directly by routes. */
function upload(category) {
  const instance = uploader(category);
  return {
    single: (field) => [instance.single(field), handleUploadError],
    array: (field, maxFiles) => [instance.array(field, maxFiles), handleUploadError],
    fields: (fields) => [instance.fields(fields), handleUploadError],
    none: () => [instance.none(), handleUploadError],
  };
}
