/**
 * Payment service.
 *
 * Orchestrates Stripe checkout sessions, webhook processing, refunds,
 * promo/scholarship codes, bulk registrations, and subscription management.
 *
 * All monetary amounts are stored in integer cents.
 * The `Payment` row is the single source of truth; Stripe objects are
 * referenced by ID and can be re-fetched for reconciliation.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const stripeClient = require('../config/stripe');
const { notifyUser, notifyMany } = require('./notification.service');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const STAFF_ROLES = ['ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR'];

function assertStaff(actor = {}) {
  if (!actor?.userId) throw ApiError.unauthorized('Sign in first');
  const isStaff = actor.platformRole === 'SUPER_ADMIN' || STAFF_ROLES.includes(actor.role) || STAFF_ROLES.includes(actor.platformRole);
  if (!isStaff) throw ApiError.forbidden('Staff access required');
}

function assertOrgAccess(actor, organizationId) {
  if (actor.platformRole === 'SUPER_ADMIN') return;
  if (!actor.organizationId || actor.organizationId !== organizationId) throw ApiError.forbidden('Organization mismatch');
}

function generateInvoiceNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `INV-${stamp}-${random}`;
}

/** Compute the discount from a promo code row. */
function applyDiscount(promo, subtotalCents) {
  if (!promo) return { discountCents: 0, promoCodeId: null };
  let discount = 0;
  if (promo.kind === 'PERCENT') {
    discount = Math.round(subtotalCents * (Number(promo.value) / 100));
    if (promo.maxDiscountCents) discount = Math.min(discount, promo.maxDiscountCents);
  } else if (promo.kind === 'FIXED') {
    discount = Math.min(Number(promo.value), subtotalCents);
  } else if (promo.kind === 'SCHOLARSHIP') {
    discount = subtotalCents; // 100% off
  }
  return { discountCents: Math.max(0, discount), promoCodeId: promo.id };
}

/**
 * Validate a promo code against the exam, user eligibility, and usage limits.
 * Returns the promo row or throws.
 */
async function validatePromo(code, { examId, userId, amountCents }) {
  const promo = await prisma.promoCode.findUnique({ where: { code: String(code).toUpperCase().trim() } });
  if (!promo) throw ApiError.notFound('Promo code not found');
  if (!promo.isActive) throw ApiError.badRequest('This promo code is no longer active');
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) throw ApiError.badRequest('This promo code has expired');
  if (promo.maxUses && promo.usedCount >= promo.maxUses) throw ApiError.badRequest('This promo code has been fully redeemed');
  if (promo.minAmountCents && amountCents < promo.minAmountCents) throw ApiError.badRequest(`Minimum order ${promo.minAmountCents} cents required`, { minAmountCents: promo.minAmountCents });

  // Exam-specific?
  if (promo.appliesToExamIds.length && !promo.appliesToExamIds.includes(examId)) {
    throw ApiError.forbidden('This promo code does not apply to the selected exam');
  }

  // Per-user limit?
  if (promo.perUserLimit > 0 && userId) {
    const userUsed = await prisma.payment.count({ where: { userId, promoCodeId: promo.id, status: 'SUCCEEDED' } });
    if (userUsed >= promo.perUserLimit) throw ApiError.forbidden('You have already used this promo code');
  }

  return promo;
}

/**
 * Increment `usedCount` once the payment is confirmed.
 */
async function redeemPromo(promoCodeId) {
  if (!promoCodeId) return;
  await prisma.promoCode.update({ where: { id: promoCodeId }, data: { usedCount: { increment: 1 } } }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Exam-fee checkout
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Checkout session for a single exam registration fee.
 * Returns { session, paymentId } — the controller redirects the candidate to
 * `session.url`.
 */
async function createExamFeeCheckout({ examId, userId, promoCode = null, successUrl, cancelUrl }) {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, examFeeCents: true, currency: true, organizationId: true, refundPolicy: true, startsAt: true } });
  if (!exam) throw ApiError.notFound('Exam not found');
  if (!exam.examFeeCents || exam.examFeeCents <= 0) throw ApiError.badRequest('This exam is free — no payment required');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, lastName: true, displayName: true } });
  if (!user) throw ApiError.notFound('User not found');

  const registration = await prisma.examCandidate.findUnique({ where: { examId_userId: { examId, userId } } });
  if (registration && ['PAID', 'COMPLETED'].includes(registration.status)) {
    throw ApiError.conflict('You have already paid for this exam');
  }

  // Apply promo discount if provided.
  let discountCents = 0;
  let promoCodeId = null;
  if (promoCode) {
    const promo = await validatePromo(promoCode, { examId, userId, amountCents: exam.examFeeCents });
    const outcome = applyDiscount(promo, exam.examFeeCents);
    discountCents = outcome.discountCents;
    promoCodeId = outcome.promoCodeId;
  }

  const netCents = Math.max(0, exam.examFeeCents - discountCents);

  // 100% scholarship — skip Stripe, mark paid immediately.
  if (netCents === 0) {
    return grantFreeAccess({ exam, user, registration, promoCodeId, discountCents: exam.examFeeCents });
  }

  const customerId = await stripeClient.getOrCreateCustomer({ email: user.email, name: user.displayName ?? `${user.firstName} ${user.lastName}`.trim(), userId, organizationId: exam.organizationId });

  const session = await stripeClient.createCheckoutSession({
    customerId: customerId.id,
    lineItems: [{ name: `Exam fee — ${exam.title}`, unitAmountCents: netCents, currency: exam.currency }],
    successUrl: successUrl ?? `${env.CLIENT_URL}/exams/${examId}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: cancelUrl ?? `${env.CLIENT_URL}/exams/${examId}/payment-cancelled`,
    metadata: { examId, userId, organizationId: exam.organizationId, purpose: 'EXAM_FEE', promoCodeId: promoCodeId ?? '' },
    promoCodeIds: [],
  });

  const payment = await prisma.payment.create({
    data: {
      userId,
      organizationId: exam.organizationId,
      examId,
      provider: 'STRIPE',
      purpose: 'EXAM_FEE',
      status: 'PENDING',
      amountCents: netCents,
      currency: exam.currency,
      stripeCheckoutId: session.id,
      stripeCustomerId: customerId.id,
      promoCodeId,
      description: `Exam fee for "${exam.title}"`,
      metadata: { discountCents, grossCents: exam.examFeeCents },
    },
  });

  return { checkoutUrl: session.url, paymentId: payment.id, amountCents: netCents, currency: exam.currency };
}

/** 100% scholarship / free path — no Stripe session needed. */
async function grantFreeAccess({ exam, user, registration, promoCodeId, discountCents }) {
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      organizationId: exam.organizationId,
      examId: exam.id,
      provider: 'PROMO',
      purpose: 'EXAM_FEE',
      status: 'SUCCEEDED',
      amountCents: 0,
      currency: exam.currency,
      promoCodeId,
      description: `Exam fee waived via promo for "${exam.title}"`,
      paidAt: new Date(),
      metadata: { discountCents, grossCents: exam.examFeeCents },
    },
  });

  await redeemPromo(promoCodeId);
  await confirmExamPayment({ examId: exam.id, userId: user.id, paymentId: payment.id });
  return { checkoutUrl: null, paymentId: payment.id, amountCents: 0, granted: true };
}

// ---------------------------------------------------------------------------
// Certification fee checkout
// ---------------------------------------------------------------------------

async function createCertificationFeeCheckout({ attemptId, userId, successUrl, cancelUrl }) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { exam: { select: { id: true, title: true, certificationFeeCents: true, currency: true, organizationId: true } } },
  });
  if (!attempt) throw ApiError.notFound('Attempt not found');
  if (!attempt.exam.certificationFeeCents || attempt.exam.certificationFeeCents <= 0) throw ApiError.badRequest('No certification fee configured');

  const existing = await prisma.payment.findFirst({ where: { attemptId, purpose: 'CERTIFICATION_FEE', status: 'SUCCEEDED' }, select: { id: true } });
  if (existing) throw ApiError.conflict('Certification fee already paid', { paymentId: existing.id });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true } });
  const customerId = await stripeClient.getOrCreateCustomer({ email: user.email, name: user.displayName, userId, organizationId: attempt.exam.organizationId });

  const session = await stripeClient.createCheckoutSession({
    customerId: customerId.id,
    lineItems: [{ name: `Certification — ${attempt.exam.title}`, unitAmountCents: attempt.exam.certificationFeeCents }],
    successUrl: successUrl ?? `${env.CLIENT_URL}/certificates/checkout-success?payment_intent={CHECKOUT_PAYMENT_INTENT}`,
    cancelUrl: cancelUrl ?? `${env.CLIENT_URL}/exams/${attempt.examId}`,
    metadata: { attemptId, userId, organizationId: attempt.exam.organizationId, purpose: 'CERTIFICATION_FEE', examId: attempt.examId },
  });

  const payment = await prisma.payment.create({
    data: {
      userId,
      organizationId: attempt.exam.organizationId,
      examId: attempt.examId,
      attemptId,
      provider: 'STRIPE',
      purpose: 'CERTIFICATION_FEE',
      status: 'PENDING',
      amountCents: attempt.exam.certificationFeeCents,
      currency: attempt.exam.currency ?? 'usd',
      stripeCheckoutId: session.id,
      stripeCustomerId: customerId.id,
      description: `Certification fee for "${attempt.exam.title}"`,
    },
  });

  return { checkoutUrl: session.url, paymentId: payment.id, amountCents: payment.amountCents };
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

/**
 * Process Stripe webhook events. Called from the controller with the raw body
 * and signature (for verification).
 */
async function handleWebhook(rawBody, signature) {
  let event;
  try {
    event = stripeClient.constructWebhookEvent(rawBody, signature);
  } catch (error) {
    logger.error('Stripe webhook signature verification failed', { error: error.message });
    throw ApiError.badRequest('Invalid webhook signature');
  }

  const type = event.type;
  const data = event.data?.object;

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await onCheckoutCompleted(data);
      break;

    case 'checkout.session.expired':
    case 'payment_intent.payment_failed':
      await onPaymentFailed(data);
      break;

    case 'charge.refunded':
      await onChargeRefunded(data);
      break;

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await onSubscriptionUpdated(data);
      break;

    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(data);
      break;

    case 'invoice.payment_failed':
      await onInvoicePaymentFailed(data);
      break;

    default:
      logger.debug('Unhandled Stripe event', { type });
  }

  return { received: true, type };
}

async function onCheckoutCompleted(session) {
  const meta = session.metadata ?? {};
  const purpose = meta.purpose ?? 'EXAM_FEE';
  const paymentIntentId = session.payment_intent ?? session.id;

  // Find the Payment row (by checkoutId or create one if webhook arrives first).
  let payment = await prisma.payment.findFirst({
    where: { OR: [{ stripeCheckoutId: session.id }, ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : [])] },
  });

  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        userId: meta.userId ?? null,
        organizationId: meta.organizationId ?? null,
        examId: meta.examId ?? null,
        attemptId: meta.attemptId ?? null,
        provider: 'STRIPE',
        purpose,
        status: 'SUCCEEDED',
        amountCents: session.amount_total ?? 0,
        currency: session.currency ?? env.STRIPE_CURRENCY,
        stripeCheckoutId: session.id,
        stripePaymentIntentId: paymentIntentId,
        paidAt: new Date(),
        description: session.metadata?.description ?? `Stripe ${purpose}`,
      },
    });
  } else {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', paidAt: new Date(), stripePaymentIntentId: paymentIntentId, amountCents: session.amount_total ?? payment.amountCents },
    });
  }

  // Promo redemption.
  if (payment.promoCodeId) await redeemPromo(payment.promoCodeId);

  // Purpose-specific side effects.
  if (purpose === 'EXAM_FEE' && meta.examId && meta.userId) {
    await confirmExamPayment({ examId: meta.examId, userId: meta.userId, paymentId: payment.id });
  } else if (purpose === 'CERTIFICATION_FEE' && meta.attemptId) {
    await prisma.payment.update({ where: { id: payment.id }, data: { attemptId: meta.attemptId } });
    // Attempt + certificate eligibility will now pass; the grading or certificate
    // service can re-issue on the next trigger or the candidate requests it.
  } else if (purpose === 'BULK_SEATS' && meta.bulkRegistrationId) {
    await prisma.bulkRegistration.update({ where: { id: meta.bulkRegistrationId }, data: { status: 'SUCCEEDED', paymentId: payment.id } });
  } else if (purpose === 'SUBSCRIPTION') {
    // handled via subscription events below.
  }

  await generateInvoiceForPayment(payment.id);
  logger.info('Payment succeeded', { paymentId: payment.id, purpose, amountCents: session.amount_total });
}

/** Grant exam access to a candidate after payment confirmation. */
async function confirmExamPayment({ examId, userId, paymentId }) {
  const registration = await prisma.examCandidate.findUnique({ where: { examId_userId: { examId, userId } } });
  if (!registration) {
    logger.warn('confirmExamPayment: registration missing', { examId, userId, paymentId });
    return;
  }
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { amountCents: true } });
  await prisma.examCandidate.update({
    where: { id: registration.id },
    data: { status: 'PAID', paidAmountCents: (registration.paidAmountCents ?? 0) + (payment?.amountCents ?? 0), accessGrantedAt: new Date(), paymentId },
  });
  await notifyUser({
    userId,
    type: 'PAYMENT_RECEIVED',
    title: 'Payment confirmed',
    body: 'Your exam access has been granted.',
    actionUrl: `/exams/${examId}`,
    sendEmail: true,
    emailProps: { userName: '', amountCents: payment?.amountCents ?? 0, description: 'Exam fee payment received' },
  }).catch(() => null);
}

async function onPaymentFailed(data) {
  const checkoutId = data.id?.startsWith('cs_') ? data.id : null;
  const paymentIntentId = data.id?.startsWith('pi_') ? data.id : (data.payment_intent ?? null);
  const payment = await prisma.payment.findFirst({
    where: { OR: [checkoutId ? { stripeCheckoutId: checkoutId } : {}, paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}].filter(Boolean) },
  });
  if (!payment) return;

  await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failedAt: new Date(), failureMessage: data.last_payment_error?.message ?? data.failure_message ?? 'Payment failed' } });
  if (payment.userId) {
    await notifyUser({ userId: payment.userId, type: 'PAYMENT_FAILED', title: 'Payment failed', body: 'Please try again or contact support.', actionUrl: `/exams/${payment.examId}` }).catch(() => null);
  }
}

async function onChargeRefunded(charge) {
  const paymentIntentId = charge.payment_intent;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
  if (!payment) return;

  const refundAmount = charge.amount_refunded ?? 0;
  const newStatus = refundAmount >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await prisma.payment.update({ where: { id: payment.id }, data: { status: newStatus, refundedCents: refundAmount, refundedAt: new Date(), refundReason: charge.refunds?.data?.[0]?.reason ?? null } });

  // If exam fee was refunded, revoke access.
  if (payment.purpose === 'EXAM_FEE' && payment.examId && payment.userId) {
    await prisma.examCandidate.updateMany({ where: { examId: payment.examId, userId: payment.userId }, data: { status: 'PENDING', accessGrantedAt: null } });
  }
  // If cert fee refunded, mark cert PENDING.
  if (payment.purpose === 'CERTIFICATION_FEE' && payment.certificateId) {
    await prisma.certificate.update({ where: { id: payment.certificateId }, data: { status: 'PENDING' } }).catch(() => null);
  }
  logger.info('Payment refunded', { paymentId: payment.id, refundAmount, status: newStatus });
}

// ---------------------------------------------------------------------------
// Subscription events
// ---------------------------------------------------------------------------

async function onSubscriptionUpdated(sub) {
  const orgSub = await prisma.organizationSubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
  if (!orgSub) return;
  const statusMap = { active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', canceled: 'CANCELED', unpaid: 'EXPIRED', incomplete: 'INCOMPLETE', incomplete_expired: 'EXPIRED' };
  const newStatus = statusMap[sub.status] ?? 'ACTIVE';
  await prisma.organizationSubscription.update({
    where: { id: orgSub.id },
    data: {
      status: newStatus,
      currentPeriodStart: new Date(sub.current_period_start * 1000),
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      seats: sub.items?.data?.[0]?.quantity ?? orgSub.seats,
      lastBilledAt: sub.status === 'active' ? new Date() : orgSub.lastBilledAt,
    },
  });
}

async function onSubscriptionDeleted(sub) {
  const orgSub = await prisma.organizationSubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
  if (!orgSub) return;
  await prisma.organizationSubscription.update({ where: { id: orgSub.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: false } });
  logger.info('Subscription canceled', { organizationId: orgSub.organizationId });
}

async function onInvoicePaymentFailed(invoice) {
  const sub = invoice.subscription;
  if (!sub) return;
  const orgSub = await prisma.organizationSubscription.findFirst({ where: { stripeSubscriptionId: sub } });
  if (orgSub) await prisma.organizationSubscription.update({ where: { id: orgSub.id }, data: { status: 'PAST_DUE' } });
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

async function refund({ paymentId, amountCents = null, reason = null, actor = {} }) {
  assertStaff(actor);
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.organizationId) assertOrgAccess(actor, payment.organizationId);
  if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw ApiError.badRequest('Only completed payments can be refunded');

  // Refund policy gate.
  if (payment.purpose === 'EXAM_FEE' && payment.examId) {
    const exam = await prisma.exam.findUnique({ where: { id: payment.examId }, select: { refundPolicy: true, startsAt: true } });
    if (exam?.refundPolicy === 'NO_REFUND') throw ApiError.forbidden('This exam does not allow refunds');
    if (exam?.refundPolicy === 'BEFORE_WINDOW' && exam.startsAt && new Date() >= new Date(exam.startsAt)) {
      throw ApiError.badRequest('The exam window has opened — refunds are no longer available');
    }
  }

  const refundAmount = amountCents ?? payment.amountCents - (payment.refundedCents ?? 0);
  if (refundAmount <= 0) throw ApiError.badRequest('Nothing left to refund');

  let stripeRefund = null;
  if (payment.stripePaymentIntentId) {
    try {
      stripeRefund = await stripeClient.refundPayment(payment.stripePaymentIntentId, refundAmount, reason);
    } catch (error) {
      logger.error('Stripe refund failed', { paymentId, error: error.message });
      throw ApiError.internal('Stripe refund failed — check your Stripe dashboard', { reason: error.message });
    }
  }

  const newRefunded = (payment.refundedCents ?? 0) + refundAmount;
  const newStatus = newRefunded >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await prisma.payment.update({
    where: { id: paymentId },
    data: { status: newStatus, refundedCents: newRefunded, refundedAt: new Date(), refundReason: reason ?? null, stripePaymentIntentId: stripeRefund?.payment_intent ?? payment.stripePaymentIntentId },
  });

  if (payment.userId) {
    await notifyUser({ userId: payment.userId, type: 'PAYMENT_RECEIVED', title: 'Refund processed', body: `A refund of ${stripeClient.formatMoney(refundAmount)} has been issued.` }).catch(() => null);
  }

  return { paymentId, refundedCents: refundAmount, status: newStatus, stripeRefundId: stripeRefund?.id ?? null };
}

// ---------------------------------------------------------------------------
// Bulk registration
// ---------------------------------------------------------------------------

async function createBulkRegistration({ examId, seats, csvFileUrl = null, actor = {} }) {
  assertStaff(actor);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, organizationId: true, examFeeCents: true, currency: true, maxCandidates: true } });
  if (!exam) throw ApiError.notFound('Exam not found');
  assertOrgAccess(actor, exam.organizationId);
  if (seats < 1 || seats > 10_000) throw ApiError.badRequest('Seat count must be between 1 and 10000');

  const unitPrice = exam.examFeeCents ?? 0;
  const totalPrice = unitPrice * seats;

  const registration = await prisma.bulkRegistration.create({
    data: {
      organizationId: exam.organizationId,
      examId,
      seats,
      unitPriceCents: unitPrice,
      totalPriceCents: totalPrice,
      status: unitPrice > 0 ? 'PENDING' : 'SUCCEEDED',
      csvFileUrl,
      createdById: actor.userId,
    },
  });

  if (unitPrice === 0) {
    await prisma.bulkRegistration.update({ where: { id: registration.id }, data: { status: 'SUCCEEDED' } });
    return { bulkRegistration: registration, checkoutUrl: null, free: true };
  }

  // Create Stripe checkout for the total.
  const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true, displayName: true } });
  const customerId = await stripeClient.getOrCreateCustomer({ email: user.email, name: user.displayName, userId: actor.userId, organizationId: exam.organizationId });

  const session = await stripeClient.createCheckoutSession({
    customerId: customerId.id,
    lineItems: [{ name: `Bulk seats — ${exam.title} (${seats}x)`, unitAmountCents: totalPrice }],
    successUrl: `${env.CLIENT_URL}/payments/bulk-success?bulkId=${registration.id}`,
    cancelUrl: `${env.CLIENT_URL}/payments/bulk-cancelled`,
    metadata: { bulkRegistrationId: registration.id, examId, organizationId: exam.organizationId, purpose: 'BULK_SEATS', userId: actor.userId },
  });

  await prisma.payment.create({
    data: {
      userId: actor.userId,
      organizationId: exam.organizationId,
      examId,
      provider: 'STRIPE',
      purpose: 'BULK_SEATS',
      status: 'PENDING',
      amountCents: totalPrice,
      currency: exam.currency ?? 'usd',
      stripeCheckoutId: session.id,
      seatCount: seats,
      description: `Bulk registration ${seats} seats for "${exam.title}"`,
      metadata: { bulkRegistrationId: registration.id },
    },
  });

  return { bulkRegistration: registration, checkoutUrl: session.url, amountCents: totalPrice };
}

// ---------------------------------------------------------------------------
// Invoice generation
// ---------------------------------------------------------------------------

async function generateInvoiceForPayment(paymentId) {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: { select: { email: true, firstName: true, lastName: true, displayName: true } }, exam: { select: { title: true } }, organization: { select: { name: true, branding: true } }, promoCode: true },
    });
    if (!payment) return null;

    const items = [{ description: payment.description ?? `Payment ${payment.purpose}`, qty: payment.seatCount ?? 1, unitCents: Math.round(payment.amountCents / (payment.seatCount ?? 1)), totalCents: payment.amountCents }];
    const subtotal = payment.amountCents + (payment.metadata?.discountCents ?? 0);

    const invoice = await prisma.invoice.create({
      data: {
        number: generateInvoiceNumber(),
        userId: payment.userId,
        organizationId: payment.organizationId,
        examId: payment.examId,
        paymentId: payment.id,
        status: payment.status,
        items,
        subtotalCents: subtotal,
        taxCents: 0,
        discountCents: payment.metadata?.discountCents ?? 0,
        totalCents: payment.amountCents,
        currency: payment.currency,
        billingName: payment.user?.displayName ?? null,
        billingEmail: payment.user?.email ?? null,
        paidAt: payment.paidAt,
      },
    });

    // Update Payment with the invoice ID for the relation.
    await prisma.payment.update({ where: { id: paymentId }, data: { invoiceId: invoice.id } }).catch(() => null);

    // PDF rendering is async and optional (report.service may not exist yet).
    renderInvoicePdf(invoice.id).catch((e) => logger.debug('invoice pdf skipped', { invoiceId: invoice.id, error: e.message }));

    return invoice;
  } catch (error) {
    logger.warn('invoice generation failed', { paymentId, error: error.message });
    return null;
  }
}

async function renderInvoicePdf(invoiceId) {
  const report = require('./report.service');
  const rendered = await report.renderInvoicePdf({ invoiceId });
  if (rendered?.url) {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { pdfUrl: rendered.url } });
  }
}

async function getInvoice(invoiceId, actor = {}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payment: { select: { id: true, status: true, purpose: true, stripePaymentIntentId: true } }, user: { select: { email: true, displayName: true } }, organization: { select: { name: true, branding: true } } } });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (invoice.userId && actor.userId && invoice.userId !== actor.userId) assertStaff(actor);
  return invoice;
}

async function listInvoices({ userId, organizationId, examId, status, page = 1, limit = 20 } = {}, actor = {}) {
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') {
    if (actor.userId && !organizationId) where.userId = actor.userId;
    else if (organizationId) { where.organizationId = organizationId; assertStaff(actor); }
  }
  if (userId) where.userId = userId;
  if (organizationId) where.organizationId = organizationId;
  if (examId) where.examId = examId;
  if (status) where.status = status;

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit }),
    prisma.invoice.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

// ---------------------------------------------------------------------------
// Promo code CRUD
// ---------------------------------------------------------------------------

async function createPromoCode(input = {}, actor = {}) {
  assertStaff(actor);
  const organizationId = actor.platformRole === 'SUPER_ADMIN' ? input.organizationId : actor.organizationId;
  if (!organizationId) throw ApiError.badRequest('No organization');
  if (input.examId) assertOrgAccess(actor, (await prisma.exam.findUnique({ where: { id: input.examId }, select: { organizationId: true } }))?.organizationId);

  const code = String(input.code ?? crypto.randomBytes(6).toString('hex')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  const made = await prisma.promoCode.create({
    data: {
      code,
      organizationId,
      examId: input.examId ?? null,
      kind: input.kind ?? 'PERCENT',
      value: String(input.value ?? 0),
      maxDiscountCents: input.maxDiscountCents ?? null,
      minAmountCents: input.minAmountCents ?? 0,
      maxUses: input.maxUses ?? null,
      perUserLimit: input.perUserLimit ?? 1,
      appliesToExamIds: input.appliesToExamIds ?? [],
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      isActive: input.isActive !== false,
      createdById: actor.userId,
    },
  });
  return made;
}

async function listPromoCodes({ organizationId, examId, isActive, page = 1, limit = 20 } = {}, actor = {}) {
  assertStaff(actor);
  const where = { organizationId: actor.platformRole === 'SUPER_ADMIN' ? organizationId : actor.organizationId };
  if (examId) where.examId = examId;
  if (isActive !== undefined) where.isActive = isActive;
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const [items, total] = await Promise.all([
    prisma.promoCode.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit }),
    prisma.promoCode.count({ where }),
  ]);
  return { items, total, page: safePage, limit: safeLimit };
}

async function updatePromoCode(promoId, patch = {}, actor = {}) {
  assertStaff(actor);
  const promo = await prisma.promoCode.findUnique({ where: { id: promoId } });
  if (!promo) throw ApiError.notFound('Promo code not found');
  assertOrgAccess(actor, promo.organizationId);
  const data = {};
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  if (patch.maxUses !== undefined) data.maxUses = patch.maxUses;
  if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
  if (patch.value !== undefined) data.value = String(patch.value);
  return prisma.promoCode.update({ where: { id: promoId }, data });
}

async function deletePromoCode(promoId, actor = {}) {
  assertStaff(actor);
  const promo = await prisma.promoCode.findUnique({ where: { id: promoId }, include: { _count: { select: { payments: true } } } });
  if (!promo) throw ApiError.notFound('Promo code not found');
  assertOrgAccess(actor, promo.organizationId);
  if (promo._count.payments > 0) throw ApiError.conflict('This promo has been redeemed and cannot be deleted');
  await prisma.promoCode.delete({ where: { id: promoId } });
  return { deleted: true, promoId };
}

// ---------------------------------------------------------------------------
// Payment listing + revenue analytics
// ---------------------------------------------------------------------------

async function listPayments({ userId, examId, organizationId, purpose, status, from, to, page = 1, limit = 20 } = {}, actor = {}) {
  const where = {};
  if (actor.platformRole !== 'SUPER_ADMIN') where.organizationId = actor.organizationId;
  else if (organizationId) where.organizationId = organizationId;
  if (userId) where.userId = userId;
  if (examId) where.examId = examId;
  if (purpose) where.purpose = purpose;
  if (status) where.status = status;
  if (from || to) where.createdAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);

  const [items, total, aggregate] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, include: { user: { select: { id: true, email: true, displayName: true } }, exam: { select: { id: true, title: true } } } }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amountCents: true, feeCents: true, netCents: true, refundedCents: true } }),
  ]);

  return { items, total, page: safePage, limit: safeLimit, totals: aggregate._sum };
}

async function revenueDashboard({ examId, organizationId, from, to } = {}, actor = {}) {
  assertStaff(actor);
  const orgId = actor.platformRole === 'SUPER_ADMIN' ? organizationId : actor.organizationId;
  const where = { status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] }, organizationId: orgId };
  if (examId) where.examId = examId;
  if (from || to) where.paidAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };

  const [aggregate, byPurpose, byDay, transactions] = await Promise.all([
    prisma.payment.aggregate({ where, _sum: { amountCents: true, refundedCents: true, feeCents: true }, _count: { _all: true } }),
    prisma.payment.groupBy({ by: ['purpose'], where, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.payment.findMany({ where, select: { amountCents: true, createdAt: true, paidAt: true }, orderBy: { paidAt: 'asc' } }),
    prisma.payment.findMany({ where, orderBy: { paidAt: 'desc' }, take: 20, include: { user: { select: { displayName: true, email: true } }, exam: { select: { title: true } } } }),
  ]);

  const grossCents = aggregate._sum.amountCents ?? 0;
  const refundedCents = aggregate._sum.refundedCents ?? 0;
  const netCents = grossCents - refundedCents;

  return {
    grossCents,
    refundedCents,
    netCents,
    transactionCount: aggregate._count._all,
    byPurpose: byPurpose.map((row) => ({ purpose: row.purpose, totalCents: row._sum.amountCents ?? 0, count: row._count._all })),
    dailyTrend: byDay.map((row) => ({ date: row.paidAt ?? row.createdAt, amountCents: row.amountCents })),
    recentTransactions: transactions,
  };
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

async function listPlans() {
  return prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
}

async function getSubscription(organizationId) {
  return prisma.organizationSubscription.findUnique({ where: { organizationId }, include: { plan: true } });
}

async function upgradeSubscription({ organizationId, planCode, billingCycle = 'monthly', successUrl, cancelUrl, actor = {} }) {
  assertStaff(actor);
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
  if (!plan) throw ApiError.notFound('Plan not found');

  const subscription = await prisma.organizationSubscription.findUnique({ where: { organizationId }, include: { plan: true } });
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true, contactEmail: true } });

  const amountCents = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  if (amountCents <= 0) {
    // FREE plan
    await prisma.organizationSubscription.update({ where: { organizationId }, data: { planId: plan.id, status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000) } });
    return { upgraded: true, free: true };
  }

  const customerId = subscription?.stripeCustomerId
    ?? (await stripeClient.getOrCreateCustomer({ email: org.contactEmail, name: org.name, organizationId })).id;

  const session = await stripeClient.createCheckoutSession({
    customerId,
    lineItems: [{ name: `${plan.name} plan (${billingCycle})`, unitAmountCents: amountCents, recurring: true, interval: billingCycle === 'yearly' ? 'year' : 'month' }],
    successUrl: successUrl ?? `${env.CLIENT_URL}/billing/success?subscription_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: cancelUrl ?? `${env.CLIENT_URL}/billing`,
    metadata: { organizationId, planCode, billingCycle, purpose: 'SUBSCRIPTION' },
  });

  await prisma.payment.create({
    data: {
      organizationId,
      provider: 'STRIPE',
      purpose: 'SUBSCRIPTION',
      status: 'PENDING',
      amountCents,
      currency: plan.currency ?? env.STRIPE_CURRENCY,
      stripeCheckoutId: session.id,
      stripeCustomerId: typeof customerId === 'string' ? customerId : customerId.id,
      description: `${plan.name} subscription (${billingCycle})`,
      metadata: { planCode, billingCycle },
    },
  });

  return { checkoutUrl: session.url, amountCents, planCode };
}

async function cancelSubscription(organizationId, { atPeriodEnd = true } = {}, actor = {}) {
  assertStaff(actor);
  const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
  if (!sub) throw ApiError.notFound('No subscription found');
  if (sub.stripeSubscriptionId) {
    await stripeClient.cancelSubscription(sub.stripeSubscriptionId, { atPeriodEnd }).catch((e) => logger.warn('stripe cancel failed', { error: e.message }));
  }
  if (!atPeriodEnd) {
    await prisma.organizationSubscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: false } });
  } else {
    await prisma.organizationSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  }
  return { canceled: true, atPeriodEnd };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  createExamFeeCheckout,
  createCertificationFeeCheckout,
  createBulkRegistration,
  handleWebhook,
  confirmExamPayment,
  refund,
  generateInvoiceForPayment,
  getInvoice,
  listInvoices,
  createPromoCode,
  listPromoCodes,
  updatePromoCode,
  deletePromoCode,
  validatePromo,
  listPayments,
  revenueDashboard,
  listPlans,
  getSubscription,
  upgradeSubscription,
  cancelSubscription,
};
