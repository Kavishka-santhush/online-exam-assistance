/**
 * Organization controller: profile, membership, invites, settings, departments.
 */

const org = require('../services/organization.service');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** GET /api/organizations/mine */
const listMine = asyncHandler(async (req, res) => {
  const result = await org.listMyOrganizations(req.userId);
  return sendSuccess(res, { data: result });
});

/** GET /api/organizations — super admins list every org, users list their own. */
const list = asyncHandler(async (req, res) => {
  if (req.platformRole === 'SUPER_ADMIN') {
    return paged(res, await org.listOrganizations(listQuery(req)));
  }
  return sendSuccess(res, { data: await org.listMyOrganizations(req.userId) });
});

/** POST /api/organizations */
const create = asyncHandler(async (req, res) => {
  const result = await org.createOrganization({ payload: req.body ?? {}, actor: actor(req) });
  return sendCreated(res, result, 'Organization created');
});

/** GET /api/organizations/lookup?identifier=slug-or-domain */
const lookup = asyncHandler(async (req, res) => {
  const identifier = req.query.identifier ?? req.query.slug;
  if (!identifier) throw ApiError.badRequest('identifier is required');
  const result = await org.findBySlugOrDomain(String(identifier));
  if (!result) throw ApiError.notFound('No organization matches that address');
  return sendSuccess(res, { data: result });
});

/** GET /api/organizations/:id */
const getOne = asyncHandler(async (req, res) => {
  const result = await org.getOrganization(req.params.id, req.userId);
  return sendSuccess(res, { data: result });
});

/** PATCH /api/organizations/:id */
const update = asyncHandler(async (req, res) => {
  const result = await org.updateOrganization(req.params.id, req.body ?? {});
  return sendSuccess(res, { data: result, message: 'Organization updated' });
});

/** GET /api/organizations/:id/settings */
const getSettings = asyncHandler(async (req, res) => {
  const organization = await org.getOrganization(req.params.id, req.userId);
  return sendSuccess(res, { data: organization?.settings ?? organization?.settingRows ?? {} });
});

/** PUT /api/organizations/:id/settings */
const saveSettings = asyncHandler(async (req, res) => {
  const result = await org.upsertSettings(req.params.id, req.body ?? {}, req.userId);
  return sendSuccess(res, { data: result, message: 'Settings saved' });
});

/** GET /api/organizations/:id/members */
const listMembers = asyncHandler(async (req, res) => {
  const result = await org.listMembers(listQuery(req, { organizationId: req.params.id }));
  return paged(res, result);
});

/** GET /api/organizations/:id/members/:userId */
const getMember = asyncHandler(async (req, res) => {
  const result = await org.getMember(req.params.id, req.params.userId);
  return sendSuccess(res, { data: result });
});

/** PATCH /api/organizations/:id/members/:userId */
const updateMember = asyncHandler(async (req, res) => {
  const result = await org.updateMember({
    organizationId: req.params.id,
    userId: req.params.userId,
    ...req.body,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Member updated' });
});

/** DELETE /api/organizations/:id/members/:userId */
const removeMember = asyncHandler(async (req, res) => {
  const result = await org.removeMember({
    organizationId: req.params.id,
    userId: req.params.userId,
    reason: req.body?.reason ?? req.query.reason ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Member removed' });
});

/** POST /api/organizations/:id/members/invite */
const invite = asyncHandler(async (req, res) => {
  const result = await org.inviteMembers({
    organizationId: req.params.id,
    invites: req.body?.invites ?? [],
    message: req.body?.message ?? null,
  }, actor(req));
  return sendCreated(res, result, 'Invitations sent');
});

/** GET /api/organizations/:id/invites */
const listInvites = asyncHandler(async (req, res) => {
  const result = await org.listInvites(listQuery(req, { organizationId: req.params.id }));
  return paged(res, result);
});

/** POST /api/organizations/:id/invites/:inviteId/resend */
const resendInvite = asyncHandler(async (req, res) => {
  const result = await org.resendInvite({ organizationId: req.params.id, inviteId: req.params.inviteId });
  return sendSuccess(res, { data: result, message: 'Invitation resent' });
});

/** DELETE /api/organizations/:id/invites/:inviteId */
const revokeInvite = asyncHandler(async (req, res) => {
  const result = await org.revokeInvite({ organizationId: req.params.id, inviteId: req.params.inviteId });
  return sendSuccess(res, { data: result, message: 'Invitation revoked' });
});

/** GET /api/organizations/:id/departments */
const listDepartments = asyncHandler(async (req, res) => {
  const result = await org.listDepartments(req.params.id);
  return sendSuccess(res, { data: result });
});

/** GET /api/organizations/:id/subscription */
const getSubscription = asyncHandler(async (req, res) => {
  const result = await org.getSubscription(req.params.id);
  return sendSuccess(res, { data: result });
});

/** POST /api/organizations/:id/suspend */
const suspend = asyncHandler(async (req, res) => {
  const result = await org.suspendOrganization(req.params.id, {
    suspended: req.body?.suspended !== false,
    reason: req.body?.reason ?? null,
  }, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization suspension updated' });
});

/** DELETE /api/organizations/:id */
const destroy = asyncHandler(async (req, res) => {
  const result = await org.deleteOrganization(req.params.id, actor(req));
  return sendSuccess(res, { data: result, message: 'Organization deleted' });
});

module.exports = {
  create,
  destroy,
  getMember,
  getOne,
  getSettings,
  getSubscription,
  invite,
  list,
  listDepartments,
  listInvites,
  listMembers,
  listMine,
  lookup,
  removeMember,
  resendInvite,
  revokeInvite,
  saveSettings,
  suspend,
  update,
  updateMember,
};
