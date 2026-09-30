import axios from 'axios';
import { endpoints } from './endpoints';

/**
 * Single axios instance for the whole SPA.
 *
 * Responsibilities:
 *   - prefix `/api` (in dev the Vite proxy forwards to the Express server; in
 *     prod `VITE_API_URL` is used) so the code base never hard-codes hosts;
 *   - attach the Clerk session JWT as a Bearer token on every request via an
 *     injected `getToken` provider (kept out of this module to avoid an import
 *     cycle with the Clerk provider);
 *   - send the active organization id in the `X-Organization-Id` header, which
 *     the server's `resolveOrganization` middleware reads;
 *   - unwrap the server envelope `{ success, data, meta }` so callers get the
 *     payload directly and can still reach `meta` for pagination;
 *   - normalise error responses into a thrown `ApiError` carrying the server's
 *     `code` / `details` for the UI to branch on.
 */

export class ApiError extends Error {
  constructor(message, { code = 'ERROR', status = 0, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export const api = axios.create({
  baseURL,
  withCredentials: false,
  headers: { 'Content-Type': 'application/json' },
  timeout: 45_000,
});

// ---- pluggable auth token provider ----------------------------------------
let tokenProvider = async () => null;
let activeOrganization = null;

/** The Clerk bootstrap calls this once with `getToken` from the Clerk session. */
export function configureApiClient({ getToken } = {}) {
  if (typeof getToken === 'function') tokenProvider = getToken;
}

/** Auth slice sets this whenever the user switches organization context. */
export function setActiveOrganization(organizationId) {
  activeOrganization = organizationId ?? null;
  try {
    if (organizationId) localStorage.setItem('activeOrganizationId', organizationId);
    else localStorage.removeItem('activeOrganizationId');
  } catch {
    /* storage disabled — header still works from memory for the session */
  }
}

export function getActiveOrganization() {
  if (activeOrganization) return activeOrganization;
  try {
    return localStorage.getItem('activeOrganizationId') ?? null;
  } catch {
    return null;
  }
}

api.interceptors.request.use(
  async (config) => {
    try {
      const token = await tokenProvider();
      if (token) config.headers.Authorization = `Bearer ${token}`;
    } catch {
      /* no session — let anonymous requests (public catalog, verify) through */
    }
    const organizationId = getActiveOrganization();
    if (organizationId) config.headers['X-Organization-Id'] = organizationId;
    return config;
  },
  (error) => Promise.reject(error),
);

api.interceptors.response.use(
  (response) => {
    const body = response.data;
    // Envelope shape: { success, data, meta? }. Anything else passes through.
    if (body && typeof body === 'object' && 'success' in body) {
      if (body.success === false) {
        const err = body.error ?? {};
        throw new ApiError(err.message || 'Request failed', {
          code: err.code || 'ERROR',
          status: response.status,
          details: err.details ?? null,
        });
      }
      response.data = body.data;
      response.meta = body.meta ?? null;
      response.message = body.message ?? null;
    }
    return response;
  },
  (error) => {
    const status = error.response?.status ?? 0;
    const payload = error.response?.data ?? {};
    const serverError = payload.error ?? {};
    const normalized = new ApiError(serverError.message || error.message || 'Network error', {
      code: serverError.code || (status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'NETWORK_ERROR'),
      status,
      details: serverError.details ?? null,
    });
    return Promise.reject(normalized);
  },
);

/** Thin verb helpers that return the unwrapped `data` (and `meta` when needed). */
export const request = {
  get: (url, config) => api.get(url, config).then((res) => res.data),
  post: (url, data, config) => api.post(url, data, config).then((res) => res.data),
  put: (url, data, config) => api.put(url, data, config).then((res) => res.data),
  patch: (url, data, config) => api.patch(url, data, config).then((res) => res.data),
  delete: (url, config) => api.delete(url, config).then((res) => res.data),
  /** When you need the pagination block: returns { data, meta }. */
  paged: (url, config) => api.get(url, config).then((res) => ({ data: res.data, meta: res.meta })),
  /** Multipart upload — axios sets the boundary; we only swap the content type. */
  upload: (url, formData, config) =>
    api.post(url, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120_000, ...config }).then((res) => res.data),
};

// Re-exported so slices/hooks/pages have one binding surface (`@/lib/apiClient`)
// for both the transport and the URL catalogue. `endpoints.js` is pure URL
// builders and does not import this module, so this adds no import cycle.
export { endpoints };

export default api;
