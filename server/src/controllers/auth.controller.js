/**
 * Auth / identity controller.
 *
 * Clerk owns sign-in, sign-up and OAuth, so this controller never handles
 * credentials. It exposes the "who am I" surface (profile + memberships +
 * feature flags), the editable candidate / instructor profiles, invite
 * acceptance and the Clerk webhook that keeps the local `User` table in sync.
 */

const auth = require('../services/auth.service');
const { ApiError, asyncHandler, sendSuccess } = require('../utils/response.util');

/** Derive the lightweight `actor` object the services expect. */
function actor(req) {
  return {
    userId: req.userId,
    email: req.user?.email ?? null,
    displayName: req.user?.displayName ?? null,
    organizationId: req.organizationId ?? null,
    role: req.orgRole ?? null,
    platformRole: req.platformRole ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/** GET /api/auth/me — the authenticated identity bundle. */
const me = asyncHandler(async (req, res) => {
  const user = auth.publicUser(req.user);
  const organizations = (req.user.memberships ?? []).map((membership) => ({
    ...auth.summariseOrganization(membership.organization),
    membershipId: membership.id,
    role: membership.role,
    status: membership.status,
    permissions: membership.permissions ?? [],
  }));

  return sendSuccess(res, {
    data: {
      user,
      organizations,
      flags: auth.resolveFeatureFlags(req.user),
      candidateProfile: req.user.candidateProfile ?? null,
      instructorProfile: req.user.instructorProfile ?? null,
      currentOrganizationId: req.organizationId ?? null,
    },
  });
});

/** PATCH /api/auth/profile — update the mutable profile columns. */
const updateProfile = asyncHandler(async (req, res) => {
  const updated = await auth.updateProfile(req.userId, req.body ?? {});
  return sendSuccess(res, { data: auth.publicUser(updated), message: 'Profile updated' });
});

/** GET /api/auth/profile/candidate */
const getCandidateProfile = asyncHandler(async (req, res) => {
  const profile = await auth.getCandidateProfile(req.userId);
  return sendSuccess(res, { data: profile ?? {} });
});

/** PUT /api/auth/profile/candidate */
const saveCandidateProfile = asyncHandler(async (req, res) => {
  const profile = await auth.saveCandidateProfile(req.userId, req.body ?? {});
  return sendSuccess(res, { data: profile, message: 'Candidate profile saved' });
});

/** PUT /api/auth/profile/instructor */
const saveInstructorProfile = asyncHandler(async (req, res) => {
  const profile = await auth.saveInstructorProfile(req.userId, req.body ?? {});
  return sendSuccess(res, { data: profile, message: 'Instructor profile saved' });
});

/** POST /api/auth/invites/accept — redeem an organization invite token. */
const acceptInvite = asyncHandler(async (req, res) => {
  const token = req.body?.token ?? req.query.token;
  if (!token) throw ApiError.badRequest('Invite token is required');
  const result = await auth.acceptInvite({ token, userId: req.userId });
  return sendSuccess(res, { data: result, message: 'Invite accepted' });
});

/** POST /api/auth/account/deactivate — soft close the current account. */
const deactivateAccount = asyncHandler(async (req, res) => {
  const result = await auth.deactivateAccount(req.userId, { reason: req.body?.reason ?? null });
  return sendSuccess(res, { data: result, message: 'Account deactivated' });
});

/** POST /api/auth/account/reactivate */
const reactivateAccount = asyncHandler(async (req, res) => {
  const result = await auth.reactivateAccount(req.userId);
  return sendSuccess(res, { data: auth.publicUser(result), message: 'Account reactivated' });
});

/**
 * POST /api/auth/webhook/clerk — Clerk calls this on user lifecycle events.
 * `clerkWebhook(secret)` middleware verifies the signature and normalises the
 * body before it reaches here.
 */
const clerkWebhook = asyncHandler(async (req, res) => {
  const event = req.body ?? {};
  const result = await auth.handleClerkWebhook({ event, payload: event.data ?? event });
  return sendSuccess(res, { data: { received: true, ignored: Boolean(result?.ignored) } });
});

/** GET /api/auth/flags — feature flags only (cheap probe for the client). */
const flags = asyncHandler(async (req, res) => {
  return sendSuccess(res, { data: auth.resolveFeatureFlags(req.user ?? {}) });
});

module.exports = {
  acceptInvite,
  actor,
  clerkWebhook,
  deactivateAccount,
  flags,
  getCandidateProfile,
  me,
  reactivateAccount,
  saveCandidateProfile,
  saveInstructorProfile,
  updateProfile,
};
