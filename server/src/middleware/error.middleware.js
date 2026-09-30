/**
 * Terminal error handling.
 *
 * Every failure in the stack ends up here and is converted into the single
 * envelope the client unwraps:
 *
 *   { success: false, error: { code, message, details? } }
 *
 * Translation table, in priority order:
 *   ApiError          -> its own status/code (thrown by services + middleware)
 *   ZodError          -> 422 VALIDATION_ERROR (schema thrown outside a route)
 *   PrismaClientKnownRequestError
 *                     -> P2002 409, P2003 400, P2025 404, P2024/P2028 503,
 *                        P2000 value too long -> 422
 *   Clerk/JWT         -> 401 / 403
 *   MulterError       -> 413 LIMIT_FILE_SIZE, otherwise 400
 *   Stripe errors     -> 402 / 400 with the merchant message
 *   body-parser       -> 400 INVALID_JSON
 *   unknown           -> 500, message hidden in production
 */

const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError, sendError } = require('../utils/response.util');
const { fromZodError } = require('./validate.middleware');

/** 404 for anything that fell through the route table. */
function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

/**
 * Express recognises the 4-argument signature; do not "simplify" it to three
 * parameters or the handler will be treated as normal middleware.
 */
function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  let apiError = normalise(error, req);

  if (res.headersSent) {
    // A stream / download already started; all we can do is end it.
    return res.end();
  }

  const log = logger.child({
    code: apiError.code,
    status: apiError.status,
    method: req.method,
    path: req.originalUrl,
    userId: req.userId ?? null,
    organizationId: req.organizationId ?? null,
    requestId: req.id,
  });

  if (apiError.status >= 500) {
    log.error(apiError.message, { stack: apiError.stack, details: apiError.details });
  } else if (apiError.status === 401 || apiError.status === 403) {
    log.warn(apiError.message, { details: apiError.details });
  } else {
    log.info(apiError.message, { details: apiError.details });
  }

  // Never leak internals for errors we did not explicitly raise.
  if (!apiError.isOperational && env.isProduction && apiError.status >= 500) {
    apiError = ApiError.internal('An unexpected error occurred');
  }

  return sendError(res, {
    status: apiError.status,
    code: apiError.code,
    message: apiError.message,
    details: debugDetails(apiError, req),
  });
}

/** Attach the stack to the payload outside production to speed up triage. */
function debugDetails(apiError, req) {
  if (env.isProduction) return apiError.details ?? null;
  return {
    ...(apiError.details ?? {}),
    stack: apiError.stack ? String(apiError.stack).split('\n').slice(0, 8).join('\n') : undefined,
    requestId: req.id,
  };
}

/** Convert literally any thrown value into an ApiError-shaped object. */
function normalise(error, req) {
  if (error instanceof ApiError) return error;
  if (!error) return ApiError.internal('Unknown error');

  const zod = fromZodError(error);
  if (zod) return zod;

  if (error.name === 'PrismaClientKnownRequestError' || error.code?.startsWith?.('P')) {
    return fromPrisma(error);
  }
  if (error.name === 'PrismaClientValidationError') {
    return ApiError.unprocessable('The query was rejected by the database layer', env.isProduction ? undefined : { reason: error.message });
  }
  if (error.name === 'PrismaClientInitializationError' || error.name === 'PrismaClientRustPanicError') {
    return new ApiError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable right now', null);
  }

  if (error.name === 'MulterError') return fromMulter(error);
  if (error.type === 'entity.parse.failed' || error instanceof SyntaxError && 'body' in error) {
    return ApiError.badRequest('Request body is not valid JSON');
  }
  if (error.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit');
  }

  if (error.name === 'StripeCardError' || error.type === 'StripeCardError') {
    return ApiError.paymentRequired(error.message ?? 'The card was declined', error.code ? { stripeCode: error.code } : undefined);
  }
  if (error.raw?.constructor?.name === 'StripeError' || error.name?.startsWith?.('Stripe')) {
    return ApiError.badRequest(error.message ?? 'Stripe rejected the request');
  }

  if (error.name === 'TokenExpiredError') return ApiError.unauthorized('Your session expired - sign in again');
  if (error.name === 'JsonWebTokenError' || error.name === 'ClerkJwksCacheHighValidationErrorCountError') {
    return ApiError.unauthorized('The session token is not valid');
  }
  if (error.metKeys || error.clerkError || error.status === 401 && error.message?.toLowerCase?.().includes('token')) {
    return ApiError.unauthorized('Sign in to continue');
  }
  if (error.status === 403 && error.message) {
    return ApiError.forbidden(error.message);
  }

  // Bare `throw new Error()` from a third-party library: keep the message when
  // it is clearly user-facing (low-cardinality), otherwise mask it.
  if (error instanceof Error) {
    const mapped = fromErrorMessage(error.message);
    if (mapped) return mapped;
    const status = Number(error.status ?? error.statusCode) || 500;
    const wrapped = ApiError.internal(error.message || 'Something went wrong');
    wrapped.status = status;
    wrapped.stack = error.stack ?? wrapped.stack;
    return wrapped;
  }

  return ApiError.internal(typeof error === 'string' ? error : 'Something went wrong');
}

/** Prisma's `code` is the useful signal; `meta` carries the field names. */
function fromPrisma(error) {
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(', ') : target;

  switch (error.code) {
    case 'P2000':
      return ApiError.unprocessable(`A value is too long for ${fields ?? 'a column'}`, { fields });
    case 'P2002':
      return ApiError.conflict(`A record with this ${fields ?? 'value'} already exists`, { fields, unique: true });
    case 'P2003':
      return ApiError.badRequest(`Related record for ${fields ?? 'a field'} does not exist`, { fields, foreignKey: true });
    case 'P2004':
      return ApiError.unprocessable('The database rejected this change because a constraint failed');
    case 'P2011':
      return ApiError.unprocessable(`${fields ?? 'A field'} must not be null`, { fields, notNull: true });
    case 'P2012':
      return ApiError.internal(`Missing required value for ${fields ?? 'a field'}`);
    case 'P2014':
      return ApiError.unprocessable('This change would break a required relation');
    case 'P2016':
      return ApiError.notFound('The record was removed by another operation');
    case 'P2025':
      return ApiError.notFound(fields ? `${fields} not found` : 'The record you tried to change no longer exists');
    case 'P2024':
      return new ApiError(503, 'DATABASE_TIMEOUT', 'The database is busy - please retry');
    case 'P2028':
      return new ApiError(503, 'DATABASE_TRANSACTION_ERROR', 'The transaction failed - please retry');
    default:
      return ApiError.internal(`Database error ${error.code ?? ''}`.trim(), { code: error.code });
  }
}

function fromMulter(error) {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return new ApiError(413, 'FILE_TOO_LARGE', `The file exceeds the ${env.MAX_FILE_SIZE_MB} MB upload limit`, {
      maxBytes: env.maxFileBytes,
    });
  }
  const messages = {
    LIMIT_FILE_COUNT: 'Too many files in one request',
    LIMIT_UNEXPECTED_FILE: 'Unexpected form field name for this upload',
    LIMIT_PART_SIZE: 'The upload chunk was too large',
    LIMIT_FIELD_VALUE: 'A form field value was too long',
    LIMIT_FILE_INCLUDE: 'That file name is not permitted',
    INCOMPLETE: 'The upload was interrupted - send it again',
    FILE_FILTER: 'That file type is not allowed',
  };
  return ApiError.badRequest(messages[error.code] ?? `Upload failed (${error.code})`);
}

/** A handful of driver-level strings worth turning into proper 4xx codes. */
function fromErrorMessage(message = '') {
  const text = String(message).toLowerCase();
  if (text.includes('unique constraint') || text.includes('duplicate key')) {
    return ApiError.conflict('A record with these values already exists');
  }
  if (text.includes('foreign key constraint')) {
    return ApiError.badRequest('A related record is missing');
  }
  if (text.includes('connection terminated') || text.includes('too many connections')) {
    return new ApiError(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
  }
  if (text.includes('could not connect to smtp') || text.includes('mail send failed')) {
    return ApiError.internal('The mail provider is unavailable');
  }
  return null;
}

/**
 * Minimal body for logging a failure raised inside a socket handler or cron
 * job, where there is no `res` to write to.
 */
function describeError(error) {
  const apiError = normalise(error);
  return {
    code: apiError.code,
    status: apiError.status,
    message: apiError.message,
    stack: apiError.stack,
  };
}

module.exports = {
  describeError,
  errorHandler,
  normalise,
  notFoundHandler,
};
