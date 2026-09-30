/**
 * Stripe client + the small amount of money maths the platform needs.
 *
 * Everything monetary is stored in integer cents. Subscription prices live in
 * the `SubscriptionPlan` rows (see `prisma/seeds/01-platform.js`), so invoices
 * and the pricing page always read the same source.
 */

const Stripe = require('stripe');
const env = require('./env');
const logger = require('../utils/logger.util');

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia', typescript: false })
  : null;

const PLATFORM_FEE_PERCENT = 2.9;
const PLATFORM_FEE_FIXED_CENTS = 30;

function requireStripe() {
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY is not set - payments are unavailable');
  }
  return stripe;
}

/** Stripe takes ~2.9% + 30c; derive the fee and what the org actually nets. */
function splitPayment(amountCents) {
  const amount = Math.round(Number(amountCents) || 0);
  const feeCents = Math.round(amount * (PLATFORM_FEE_PERCENT / 100)) + PLATFORM_FEE_FIXED_CENTS;
  return { amountCents: amount, feeCents: Math.min(feeCents, amount), netCents: Math.max(0, amount - Math.min(feeCents, amount)) };
}

function formatMoney(amountCents, currency = env.STRIPE_CURRENCY) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(
    (Number(amountCents) || 0) / 100,
  );
}

async function getOrCreateCustomer({ email, name, userId, organizationId, metadata = {} }) {
  const client = requireStripe();
  const existing = await client.customers.list({ email, limit: 1 });
  if (existing.data.length) return existing.data[0];

  return client.customers.create({
    email,
    name: name ?? undefined,
    metadata: { userId: userId ?? '', organizationId: organizationId ?? '', ...metadata },
  });
}

/**
 * Hosted Checkout session for a one-off charge (exam fee, certificate fee or a
 * bulk seat pack). `unit_amount` is in cents.
 */
async function createCheckoutSession({
  customerId,
  lineItems,
  successUrl,
  cancelUrl,
  metadata = {},
  currency = env.STRIPE_CURRENCY,
  promoCodeIds = [],
  trialEnd = null,
}) {
  const client = requireStripe();
  const isSubscription = lineItems.some((item) => item.recurring);
  return client.checkout.sessions.create({
    mode: isSubscription ? 'subscription' : 'payment',
    customer: customerId ?? undefined,
    customer_email: customerId ? undefined : metadata.email,
    line_items: lineItems.map((item) => ({
      quantity: item.quantity ?? 1,
      price_data: {
        currency,
        product_data: { name: item.name, description: item.description, images: item.images },
        unit_amount: item.unitAmountCents,
        ...(item.recurring ? { recurring: { interval: item.interval ?? 'month' } } : {}),
      },
    })),
    allow_promotion_codes: promoCodeIds.length === 0,
    discounts: promoCodeIds.length ? promoCodeIds.map((promotionId) => ({ promotion_code: promotionId })) : undefined,
    subscription_data: trialEnd ? { trial_end: Math.floor(new Date(trialEnd).getTime() / 1000) } : undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    // `payment_intent_data` is rejected in subscription mode.
    ...(isSubscription ? {} : { payment_intent_data: { metadata, description: lineItems.map((item) => item.name).join(' + ') } }),
  });
}

async function refundPayment(paymentIntentId, amountCents, reason) {
  const client = requireStripe();
  const params = { payment_intent: paymentIntentId };
  if (amountCents) params.amount = Math.round(Number(amountCents));
  if (reason) params.refund_application_fee = true;
  return client.refunds.create(params);
}

async function createSubscription({ customerId, priceId, metadata = {}, trialDays = 14 }) {
  const client = requireStripe();
  return client.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    metadata,
    trial_period_days: trialDays || undefined,
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  });
}

async function cancelSubscription(subscriptionId, { atPeriodEnd = true } = {}) {
  const client = requireStripe();
  if (atPeriodEnd) return client.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  return client.subscriptions.cancel(subscriptionId);
}

/** Verify the `stripe-signature` header against the raw request body. */
function constructWebhookEvent(rawBody, signature, secret = env.STRIPE_WEBHOOK_SECRET) {
  const client = requireStripe();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return client.webhooks.constructEvent(rawBody, signature, secret);
}

function verifyStripeMode() {
  if (!stripe) {
    logger.warn('Stripe is not configured - checkout endpoints will fail');
    return false;
  }
  return true;
}

module.exports = {
  PLATFORM_FEE_FIXED_CENTS,
  PLATFORM_FEE_PERCENT,
  cancelSubscription,
  constructWebhookEvent,
  createCheckoutSession,
  createSubscription,
  formatMoney,
  getOrCreateCustomer,
  refundPayment,
  requireStripe,
  splitPayment,
  stripe,
  verifyStripeMode,
};
