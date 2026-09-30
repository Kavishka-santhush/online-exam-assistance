/**
 * Payment routes — mounted at `/api/payments`.
 *
 * The Stripe webhook is public but signature-verified and needs a raw body.
 * Checkout + promo validation are candidate actions; refunds, the payment /
 * revenue listings, invoice generation, promo CRUD and subscription changes are
 * staff-only.
 */

const express = require('express');
const controller = require('../controllers/payment.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireStaff } = require('../middleware/role.middleware');
const { webhookLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

const staff = [authenticate, resolveOrganization, requireStaff()];

// ---- Stripe webhook (raw body, signature verified in the service) ----
router.post('/webhook', express.raw({ type: 'application/json' }), webhookLimiter, controller.webhook);

// ---- public / candidate ----
router.get('/plans', controller.listPlans);
router.post('/checkout/exam/:examId', authenticate, controller.examCheckout);
router.post('/checkout/certification/:attemptId', authenticate, controller.certificationCheckout);
router.post('/confirm', authenticate, controller.confirm);
router.post('/promo-codes/validate', authenticate, controller.validatePromo);

// ---- candidate invoices ----
router.get('/invoices', authenticate, controller.listInvoices);
router.get('/invoices/:id', authenticate, controller.getInvoice);

// ---- staff: payments + revenue ----
router.get('/payments', ...staff, controller.listPayments);
router.get('/revenue', ...staff, controller.revenue);
router.post('/refunds', ...staff, controller.refund);
router.post('/bulk-registration', ...staff, controller.bulkRegistration);
router.post('/invoices/:paymentId/generate', ...staff, controller.generateInvoice);

// ---- staff: promo codes ----
router.get('/promo-codes', ...staff, controller.listPromos);
router.post('/promo-codes', ...staff, controller.createPromo);
router.patch('/promo-codes/:promoId', ...staff, controller.updatePromo);
router.delete('/promo-codes/:promoId', ...staff, controller.deletePromo);

// ---- staff: subscriptions ----
router.get('/subscriptions/:organizationId', ...staff, controller.getSubscription);
router.post('/subscriptions/upgrade', ...staff, controller.upgrade);
router.post('/subscriptions/cancel', ...staff, controller.cancel);

module.exports = router;
