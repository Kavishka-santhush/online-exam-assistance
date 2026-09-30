/**
 * Organization routes — mounted at `/api/organizations`.
 *
 * `scopedToParam` copies the `:id` route segment into `req.organizationId` so
 * the role middleware (`requireStaff` / `requireOrgAdmin`) can resolve the
 * caller's membership against that organization.
 */

const express = require('express');
const { z } = require('zod');
const controller = require('../controllers/organization.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireOrgAdmin, requireStaff, requireSuperAdmin } = require('../middleware/role.middleware');
const { validate } = require('../middleware/validate.middleware');

const router = express.Router();

function scopedToParam(req, res, next) {
  req.organizationId = req.params.id;
  return next();
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/).optional(),
  description: z.string().max(2000).optional(),
  website: z.string().url().optional(),
  contactEmail: z.string().email().optional(),
  type: z.enum(['UNIVERSITY', 'COMPANY', 'TRAINING_INSTITUTE', 'CERTIFICATION_BODY', 'SCHOOL', 'OTHER']).optional(),
}).passthrough();

const inviteSchema = z.object({
  invites: z.array(z.object({
    email: z.string().email(),
    role: z.enum(['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE']).default('CANDIDATE'),
    department: z.string().max(120).optional(),
  })).min(1),
  message: z.string().max(1000).optional(),
});

const updateMemberSchema = z.object({
  role: z.enum(['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE']).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INVITED', 'REMOVED']).optional(),
  permissions: z.array(z.string()).optional(),
  department: z.string().max(120).nullable().optional(),
}).passthrough();

router.use(authenticate);

router.get('/mine', controller.listMine);
router.get('/lookup', controller.lookup);
router.get('/', controller.list);
router.post('/', validate({ body: createSchema }), controller.create);

router.get('/:id', controller.getOne);
router.patch('/:id', scopedToParam, requireOrgAdmin(), controller.update);
router.delete('/:id', requireSuperAdmin(), controller.destroy);
router.post('/:id/suspend', requireSuperAdmin(), controller.suspend);

router.get('/:id/settings', scopedToParam, requireStaff(), controller.getSettings);
router.put('/:id/settings', scopedToParam, requireOrgAdmin(), controller.saveSettings);

router.get('/:id/members', scopedToParam, requireStaff(), controller.listMembers);
router.get('/:id/members/:userId', scopedToParam, requireStaff(), controller.getMember);
router.patch('/:id/members/:userId', scopedToParam, requireOrgAdmin(), validate({ body: updateMemberSchema }), controller.updateMember);
router.delete('/:id/members/:userId', scopedToParam, requireOrgAdmin(), controller.removeMember);

router.post('/:id/members/invite', scopedToParam, requireOrgAdmin(), validate({ body: inviteSchema }), controller.invite);
router.get('/:id/invites', scopedToParam, requireOrgAdmin(), controller.listInvites);
router.post('/:id/invites/:inviteId/resend', scopedToParam, requireOrgAdmin(), controller.resendInvite);
router.delete('/:id/invites/:inviteId', scopedToParam, requireOrgAdmin(), controller.revokeInvite);

router.get('/:id/departments', scopedToParam, requireStaff(), controller.listDepartments);
router.get('/:id/subscription', scopedToParam, requireOrgAdmin(), controller.getSubscription);

module.exports = router;
