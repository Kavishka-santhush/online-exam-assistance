/**
 * Uniform API envelope + the error type thrown by every service.
 *
 * Success: { success: true,  data, meta? }
 * Failure: { success: false, error: { code, message, details? }, meta? }
 *
 * Keeping both halves in one module means controllers never disagree about
 * the shape the client's `apiFetch` unwraps.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
    this.isOperational = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static validation(message = 'Validation failed', details) {
    return new ApiError(422, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have access to this resource', details) {
    return new ApiError(403, 'FORBIDDEN', message, details);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message = 'Resource conflict', details) {
    return new ApiError(409, 'CONFLICT', message, details);
  }

  static unprocessable(message = 'Unprocessable request', details) {
    return new ApiError(422, 'UNPROCESSABLE', message, details);
  }

  static tooManyRequests(message = 'Too many requests', details) {
    return new ApiError(429, 'RATE_LIMITED', message, details);
  }

  static planLimit(message = 'Your plan does not allow this', details) {
    return new ApiError(403, 'PLAN_LIMIT', message, details);
  }

  static paymentRequired(message = 'Payment required before access', details) {
    return new ApiError(402, 'PAYMENT_REQUIRED', message, details);
  }

  static locked(message = 'This resource is locked', details) {
    return new ApiError(423, 'LOCKED', message, details);
  }

  static internal(message = 'Something went wrong', details) {
    const error = new ApiError(500, 'INTERNAL_ERROR', message, details);
    error.isOperational = false;
    return error;
  }
}

function sendSuccess(res, { data = null, status = 200, message, meta } = {}) {
  return res.status(status).json({
    success: true,
    ...(message ? { message } : {}),
    data: serialise(data),
    ...(meta ? { meta } : {}),
  });
}

function sendCreated(res, data, message) {
  return sendSuccess(res, { data, status: 201, message });
}

function sendError(res, { status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong', details } = {}) {
  return res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
  });
}

function sendNoContent(res) {
  return res.status(204).send();
}

/** Prisma returns Decimal/BigInt for money and byte counts; JSON cannot encode them. */
function serialise(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(serialise);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'bigint' || (entry && entry.constructor?.name === 'Decimal')) {
        out[key] = Number(entry);
      } else if (entry instanceof Date) {
        out[key] = entry.toISOString();
      } else if (entry && typeof entry === 'object') {
        out[key] = serialise(entry);
      } else {
        out[key] = entry;
      }
    }
    return out;
  }

  return typeof value === 'bigint' ? Number(value) : value;
}

/** Parse `?page=1&limit=20` into Prisma skip/take plus the page meta block. */
function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

function paginationMeta({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNextPage: page * limit < total,
    hasPrevPage: page > 1,
  };
}

/** Wrap an async controller so rejected promises reach the error middleware. */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = {
  ApiError,
  asyncHandler,
  parsePagination,
  paginationMeta,
  sendCreated,
  sendError,
  sendNoContent,
  sendSuccess,
  serialise,
};
