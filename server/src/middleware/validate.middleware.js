/**
 * Zod request validation.
 *
 * Usage in a route file:
 *   router.post('/', validate({ body: createExamSchema, query: pagingSchema }), controller.create)
 *
 * Parsed values replace the originals (so `?limit=20` becomes a number) and
 * unknown keys are stripped, which keeps stray client fields from reaching
 * Prisma's `data` object.
 */

const { z, ZodError } = require('zod');
const { ApiError } = require('../utils/response.util');

/** Coerce the stringly-typed Express params/query objects before parsing. */
function preprocess(source) {
  if (!source || typeof source !== 'object') return {};
  return { ...source };
}

function validate(schemas = {}) {
  const entries = Object.entries(schemas).filter(([, schema]) => schema);

  return (req, res, next) => {
    if (!entries.length) return next();

    const issues = [];
    const parsed = {};

    for (const [location, schema] of entries) {
      const result = schema.safeParse(preprocess(req[location]));
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            in: location,
            path: issue.path.join('.') || '(root)',
            code: issue.code,
            message: issue.message,
            expected: issue.expected,
            received: issue.received,
          });
        }
      }
    }

    if (issues.length) {
      return next(ApiError.validation('Request validation failed', issues));
    }

    for (const [location, value] of Object.entries(parsed)) {
      // `req.query` / `req.params` are getters in Express 5; assign defensively.
      try {
        req[location] = value;
      } catch {
        Object.assign(req[location], value);
      }
    }
    return next();
  };
}

/** Validate an arbitrary payload outside the middleware chain (sockets, jobs). */
function parseOrThrow(schema, payload, { message = 'Validation failed' } = {}) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw ApiError.validation(
    message,
    result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      code: issue.code,
      message: issue.message,
    })),
  );
}

/** Reusable fragments shared by many schemas. */
const common = {
  id: z.string().min(1, 'is required'),
  booleanQuery: z.preprocess(
    (value) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value),
    z.boolean().optional(),
  ),
  pagination: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, 'must be a lowercase slug'),
  email: z.string().trim().toLowerCase().email('must be a valid email'),
  hexColor: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour'),
};

/** Convert a thrown ZodError into the standard envelope. */
function fromZodError(error) {
  if (!(error instanceof ZodError)) return null;
  return ApiError.validation(
    'Request validation failed',
    error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
  );
}

module.exports = { common, fromZodError, parseOrThrow, validate };
