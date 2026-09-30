/**
 * Auth / identity routes.
 *
 * Mounted at `/api/auth`. The Clerk webhook is the only public endpoint (it is
 * authenticated by signature, not by session); everything else requires a
 * signed-in Clerk JWT resolved by `authenticate`.
 */

const express = require('express');
const { clerkMiddleware, clerkWebhook } = require('@clerk/express');
const { z } = require('zod');
const env = require('../config/env');
const controller = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  bio: z.string().max(2000).optional(),
  timezone: z.string().max(80).optional(),
  language: z.string().length(2, 5).optional(),
  avatarUrl: z.string().url().optional(),
  phone: z.string().max(30).optional(),
}).passthrough();

const acceptInviteSchema = z.object({ token: z.string().min(1) });

router.use(clerkMiddleware());

// Clerk -> local user sync. Raw body + signature verification.
router.post(
  '/webhook/clerk',
  express.raw({ type: 'application/json' }),
  authLimiter,
  clerkWebhook(env.CLERK_WEBHOOK_SECRET),
  controller.clerkWebhook,
);

// Everything below needs a session.
router.use(authenticate);

router.get('/me', controller.me);
router.get('/flags', controller.flags);
router.patch('/profile', validate({ body: updateProfileSchema }), controller.updateProfile);

router.get('/profile/candidate', controller.getCandidateProfile);
router.put('/profile/candidate', controller.saveCandidateProfile);
router.put('/profile/instructor', controller.saveInstructorProfile);

router.post('/invites/accept', validate({ body: acceptInviteSchema }), controller.acceptInvite);
router.post('/account/deactivate', controller.deactivateAccount);
router.post('/account/reactivate', controller.reactivateAccount);

module.exports = router;
