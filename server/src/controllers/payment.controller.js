/**
 * Payment controller — Stripe checkout for exam / certification fees, the
 * webhook receiver, refunds, invoices, promo codes and subscriptions.
 */

const payment = require('../services/payment.service');
const env = require('../config/env');
const { ApiError, asyncHandler, sendCreated, sendSuccess } = require('../utils/response.util');
const { actor, listQuery, paged } = require('./controller.util');

/** Build return URLs for a Stripe hosted checkout. */
function returnUrls(body = {}, fallback) {
  return {
    successUrl: body.successUrl ?? `${env.CLIENT_URL}/${fallback}?checkout=success`,
    cancelUrl: body.cancelUrl ?? `${env.CLIENT_URL}/${fallback}?checkout=cancelled`,
  };
}

/** POST /api/payments/checkout/exam/:examId */
const examCheckout = asyncHandler(async (req, res) => {
  const urls = returnUrls(req.body, `exams/${req.params.examId}`);
  const result = await payment.createExamFeeCheckout({
    examId: req.params.examId,
    userId: req.userId,
    promoCode: req.body?.promoCode ?? null,
    ...urls,
  });
  return sendCreated(res, result);
});

/** POST /api/payments/checkout/certification/:attemptId */
const certificationCheckout = asyncHandler(async (req, res) => {
  const urls = returnUrls(req.body, `attempts/${req.params.attemptId}/results`);
  const result = await payment.createCertificationFeeCheckout({
    attemptId: req.params.attemptId,
    userId: req.userId,
    ...urls,
  });
  return sendCreated(res, result);
});

/**
 * POST /api/payments/webhook — Stripe pushes events here. The route uses a raw
 * body parser so `handleWebhook` can verify the `stripe-signature` header.
 */
const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) throw ApiError.badRequest('Missing stripe-signature header');
  const result = await payment.handleWebhook(req.body, signature);
  return sendSuccess(res, { data: result });
});

/** POST /api/payments/confirm — belt-and-suspenders access grant after return. */
const confirm = asyncHandler(async (req, res) => {
  const result = await payment.confirmExamPayment({
    examId: req.body?.examId,
    userId: req.userId,
    paymentId: req.body?.paymentId ?? null,
  });
  return sendSuccess(res, { data: result });
});

/** POST /api/payments/bulk-registration */
const bulkRegistration = asyncHandler(async (req, res) => {
  const result = await payment.createBulkRegistration({
    examId: req.body?.examId,
    seats: req.body?.seats,
    csvFileUrl: req.body?.csvFileUrl ?? null,
    actor: actor(req),
  });
  return sendCreated(res, result, 'Bulk registration processed');
});

/** POST /api/payments/refunds */
const refund = asyncHandler(async (req, res) => {
  const result = await payment.refund({
    paymentId: req.body?.paymentId,
    amountCents: req.body?.amountCents ?? null,
    reason: req.body?.reason ?? null,
    actor: actor(req),
  });
  return sendSuccess(res, { data: result, message: 'Refund submitted' });
});

/** GET /api/payments/payments */
const listPayments = asyncHandler(async (req, res) => {
  const result = await payment.listPayments(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return paged(res, result);
});

/** GET /api/payments/revenue */
const revenue = asyncHandler(async (req, res) => {
  const result = await payment.revenueDashboard(listQuery(req, { organizationId: req.organizationId }), actor(req));
  return sendSuccess(res, { data: result });
});

// ---- invoices ----
/** POST /api/payments/invoices/:paymentId/generate */
const generateInvoice = asyncHandler(async (req, res) => {
  const result = await payment.generateInvoiceForPayment(req.params.paymentId);
  return sendCreated(res, result, 'Invoice generated');
});

/** GET /api/payments/invoices */
const listInvoices = asyncHandler(async (req, res) => {
  const result = await payment.listInvoices(listQuery(req, { organizationId: req.organizationId, userId: req.userId }), actor(req));
  return paged(res, result);
});

/** GET /api/payments/invoices/:id */
const getInvoice = asyncHandler(async (req, res) => {
  const result = await payment.getInvoice(req.params.id, actor(req));
  return sendSuccess(res, { data: result });
});

// ---- promo codes ----
/** POST /api/payments/promo-codes */
const createPromo = asyncHandler(async (req, res) => {
  const result = await payment.createPromoCode(req.body ?? {}, actor(req));
  return sendCreated(res, result, 'Promo code created');
});

/** GET /api/payments/promo-codes */
const listPromos = asyncHandler(async (req, res) => {
  const result = await payment.listPromoCodes(listQuery(req, { examId: req.query.examId ?? null }), actor(req));
  return paged(res, result);
});

/** PATCH /api/payments/promo-codes/:promoId */
const updatePromo = asyncHandler(async (req, res) => {
  const result = await payment.updatePromoCode(req.params.promoId, req.body ?? {}, actor(req));
  return sendSuccess(res, { data: result, message: 'Promo code updated' });
});

/** DELETE /api/payments/promo-codes/:promoId */
const deletePromo = asyncHandler(async (req, res) => {
  const result = await payment.deletePromoCode(req.params.promoId, actor(req));
  return sendSuccess(res, { data: result, message: 'Promo code deleted' });
});

/** POST /api/payments/promo-codes/validate */
const validatePromo = asyncHandler(async (req, res) => {
  const result = await payment.validatePromo(req.body?.code, {
    examId: req.body?.examId ?? null,
    userId: req.userId,
    amountCents: req.body?.amountCents ?? null,
  });
  return sendSuccess(res, { data: result });
});

// ---- subscriptions ----
/** GET /api/payments/plans */
const listPlans = asyncHandler(async (req, res) => {
  const result = await payment.listPlans();
  return sendSuccess(res, { data: result });
});

/** GET /api/payments/subscriptions/:organizationId */
const getSubscription = asyncHandler(async (req, res) => {
  const result = await payment.getSubscription(req.params.organizationId);
  return sendSuccess(res, { data: result });
});

/** POST /api/payments/subscriptions/upgrade */
const upgrade = asyncHandler(async (req, res) => {
  const urls = returnUrls(req.body, 'billing/plans');
  const result = await payment.upgradeSubscription({
    organizationId: req.organizationId,
    planCode: req.body?.planCode,
    billingCycle: req.body?.billingCycle ?? 'monthly',
    actor: actor(req),
    ...urls,
  });
  return sendCreated(res, result);
});

/** POST /api/payments/subscriptions/cancel */
const cancel = asyncHandler(async (req, res) => {
  const result = await payment.cancelSubscription(req.organizationId, { atPeriodEnd: req.body?.atPeriodEnd !== false }, actor(req));
  return sendSuccess(res, { data: result, message: 'Subscription cancellation scheduled' });
});

module.exports = {
  bulkRegistration,
  cancel,
  certificationCheckout,
  confirm,
  createPromo,
  deletePromo,
  examCheckout,
  generateInvoice,
  getInvoice,
  getSubscription,
  listInvoices,
  listPayments,
  listPlans,
  listPromos,
  refund,
  revenue,
  updatePromo,
  upgrade,
  validatePromo,
  webhook,
};
