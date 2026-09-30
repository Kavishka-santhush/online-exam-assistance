/**
 * Shared controller helpers.
 *
 * Every controller builds the same two things: the lightweight `actor` object
 * the services consume (identity + organization scope derived from the auth
 * middleware) and a uniform paginated response. Centralising them keeps the
 * individual controllers thin and consistent.
 */

const { paginationMeta, sendSuccess } = require('../utils/response.util');

/** Build the `actor` context services read for authorization + attribution. */
function actor(req) {
  return {
    userId: req.userId ?? null,
    email: req.user?.email ?? null,
    displayName: req.user?.displayName ?? null,
    organizationId: req.organizationId ?? null,
    role: req.orgRole ?? null,
    platformRole: req.platformRole ?? null,
    membership: req.membership ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * Normalise a service result into the API envelope. If the service returned the
 * house `{ items, total, page, limit }` shape, the array becomes `data` and the
 * rest becomes `meta`; anything else is passed straight through as `data`.
 */
function paged(res, result, { message, status = 200 } = {}) {
  if (result && Array.isArray(result.items) && typeof result.total === 'number') {
    return sendSuccess(res, {
      data: result.items,
      meta: paginationMeta({
        page: result.page,
        limit: result.limit,
        total: result.total,
      }),
      message,
      status,
    });
  }
  return sendSuccess(res, { data: result, message, status });
}

/** Merge validated query filters with pagination parsed from `?page&limit`. */
function listQuery(req, extra = {}) {
  const query = {
    ...(req.query ?? {}),
    ...extra,
  };
  if (query.page !== undefined) query.page = Number(query.page);
  if (query.limit !== undefined) query.limit = Number(query.limit);
  return query;
}

module.exports = { actor, listQuery, paged };
