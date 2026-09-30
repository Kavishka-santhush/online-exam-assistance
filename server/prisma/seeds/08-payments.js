const { createRandom, daysFromNow, minutesAgo } = require('./lib/utils');

module.exports = async function seed(prisma, ctx) {
  const random = createRandom(777);
  const certEntry = ctx.exams['aws-solutions-architect'];
  const surveyEntry = ctx.exams['training-feedback-survey'];

  // --------------------------- promo + scholarship codes --------------------
  const promo = await prisma.promoCode.upsert({
    where: { code: 'LAUNCH25' },
    update: {},
    create: {
      id: 'seed-promo-launch25',
      code: 'LAUNCH25',
      organizationId: certEntry.org.id,
      examId: certEntry.exam.id,
      kind: 'PERCENT',
      value: 25,
      maxDiscountCents: 3000,
      minAmountCents: 1000,
      maxUses: 200,
      usedCount: 3,
      perUserLimit: 1,
      appliesToExamIds: [certEntry.exam.id],
      expiresAt: daysFromNow(90),
      isActive: true,
      createdById: certEntry.author.id,
    },
  });

  const scholarship = await prisma.promoCode.upsert({
    where: { code: 'SCHOLAR-100' },
    update: {},
    create: {
      id: 'seed-promo-scholarship',
      code: 'SCHOLAR-100',
      organizationId: certEntry.org.id,
      examId: certEntry.exam.id,
      kind: 'SCHOLARSHIP',
      value: 100,
      maxUses: 10,
      usedCount: 1,
      appliesToExamIds: [certEntry.exam.id],
      expiresAt: daysFromNow(180),
      isActive: true,
      createdById: ctx.superAdmin.id,
    },
  });

  ctx.promoCodes = { promo, scholarship };

  // --------------------------- exam fee payments ----------------------------
  const attempts = ctx.attemptsByExam['aws-solutions-architect'] ?? [];
  let paymentCount = 0;

  for (const [index, item] of attempts.entries()) {
    const amount = index === 0 ? 11175 : certEntry.exam.examFeeCents; // promo applied on first row
    const usedPromo = index === 0 ? promo.id : index === 3 ? scholarship.id : null;
    const status = index === attempts.length - 1 ? 'REFUNDED' : 'SUCCEEDED';

    const payment = await prisma.payment.upsert({
      where: { id: `seed-payment-exam-${item.attempt.id}` },
      update: {},
      create: {
        id: `seed-payment-exam-${item.attempt.id}`,
        userId: item.userId,
        organizationId: certEntry.org.id,
        examId: certEntry.exam.id,
        attemptId: item.attempt.id,
        provider: 'STRIPE',
        purpose: 'EXAM_FEE',
        status,
        amountCents: amount,
        currency: 'usd',
        feeCents: Math.round(amount * 0.029) + 30,
        netCents: Math.round(amount * 0.971) - 30,
        refundedCents: status === 'REFUNDED' ? amount : 0,
        stripePaymentIntentId: `pi_seed_exam_${index + 1}`,
        stripeCheckoutId: `checkout_seed_exam_${index + 1}`,
        stripeCustomerId: `cus_seed_cand_${index + 1}`,
        promoCodeId: usedPromo,
        description: `Registration - ${certEntry.exam.title}`,
        paidAt: minutesAgo(400 - index * 30),
        refundedAt: status === 'REFUNDED' ? minutesAgo(80) : null,
        refundReason: status === 'REFUNDED' ? 'Candidate withdrew before the exam window opened.' : null,
        metadata: { appliedPromoCode: usedPromo ? (index === 0 ? promo.code : scholarship.code) : null, discountCents: usedPromo ? certEntry.exam.examFeeCents - amount : 0 },
      },
    });
    paymentCount += 1;

    const invoiceNumber = `INV-SEED-EXAM-${String(index + 1).padStart(5, '0')}`;
    const invoice = await prisma.invoice.upsert({
      where: { number: invoiceNumber },
      update: {},
      create: {
        id: `seed-invoice-exam-${index + 1}`,
        number: invoiceNumber,
        userId: item.userId,
        organizationId: certEntry.org.id,
        examId: certEntry.exam.id,
        paymentId: payment.id,
        status: payment.status,
        items: [{ description: certEntry.exam.title, qty: 1, unitCents: certEntry.exam.examFeeCents, totalCents: amount }],
        subtotalCents: certEntry.exam.examFeeCents,
        discountCents: certEntry.exam.examFeeCents - amount,
        taxCents: Math.round(amount * 0.08),
        totalCents: Math.round(amount * 1.08),
        currency: 'usd',
        billingName: `Candidate ${index + 1}`,
        billingEmail: `cand.0${index + 1}@mail.example`,
        billingAddress: { country: 'US', city: 'Austin' },
        pdfUrl: `/uploads/invoices/seed-invoice-${index + 1}.pdf`,
        issuedAt: minutesAgo(400 - index * 30),
        dueAt: daysFromNow(14),
        paidAt: minutesAgo(400 - index * 30),
      },
    });

    await prisma.payment.update({ where: { id: payment.id }, data: { invoiceId: invoice.id } });
    await prisma.examCandidate.updateMany({
      where: { examId: certEntry.exam.id, userId: item.userId },
      data: { status: 'PAID', paidAmountCents: amount, paymentId: payment.id, accessGrantedAt: minutesAgo(399 - index * 30) },
    });
  }

  // --------------------------- certification fee ----------------------------
  const certificates = await prisma.certificate.findMany({ where: { status: { in: ['ISSUED', 'REVOKED'] } }, take: 6 });
  for (const [index, certificate] of certificates.entries()) {
    if (certificate.examId !== certEntry.exam.id) continue;
    await prisma.payment.upsert({
      where: { id: `seed-payment-cert-${certificate.id}` },
      update: {},
      create: {
        id: `seed-payment-cert-${certificate.id}`,
        userId: certificate.userId,
        organizationId: certificate.organizationId,
        examId: certificate.examId,
        certificateId: certificate.id,
        provider: 'STRIPE',
        purpose: 'CERTIFICATION_FEE',
        status: 'SUCCEEDED',
        amountCents: certEntry.exam.certificationFeeCents,
        currency: 'usd',
        feeCents: 75,
        netCents: certEntry.exam.certificationFeeCents - 75,
        stripePaymentIntentId: `pi_seed_cert_${index + 1}`,
        description: `Digital certificate ${certificate.certificateNo}`,
        paidAt: certificate.issuedAt,
        metadata: { index },
      },
    });
    paymentCount += 1;
  }

  // --------------------------- subscriptions ---------------------------------
  for (const [orgKey, entry] of Object.entries(ctx.orgs)) {
    const plan = entry.plan;
    if (plan.priceMonthly === 0) continue;
    const payment = await prisma.payment.upsert({
      where: { id: `seed-payment-sub-${orgKey}` },
      update: {},
      create: {
        id: `seed-payment-sub-${orgKey}`,
        organizationId: entry.org.id,
        provider: 'STRIPE',
        purpose: 'SUBSCRIPTION',
        status: 'SUCCEEDED',
        amountCents: plan.priceMonthly,
        currency: 'usd',
        feeCents: Math.round(plan.priceMonthly * 0.029) + 30,
        netCents: Math.round(plan.priceMonthly * 0.971) - 30,
        stripePaymentIntentId: `pi_seed_sub_${slugSafe(orgKey)}`,
        stripeCustomerId: entry.org.slug,
        description: `${plan.name} plan - monthly`,
        paidAt: minutesAgo(24 * 12),
        metadata: { planCode: plan.code, seats: plan.maxCandidatesPerExam },
      },
    });
    paymentCount += 1;

    await prisma.invoice.upsert({
      where: { number: `INV-SUB-${slugSafe(orgKey).toUpperCase()}` },
      update: {},
      create: {
        id: `seed-invoice-sub-${orgKey}`,
        number: `INV-SUB-${slugSafe(orgKey).toUpperCase()}`,
        organizationId: entry.org.id,
        paymentId: payment.id,
        status: 'SUCCEEDED',
        items: [{ description: `${plan.name} subscription`, qty: 1, unitCents: plan.priceMonthly, totalCents: plan.priceMonthly }],
        subtotalCents: plan.priceMonthly,
        taxCents: 0,
        totalCents: plan.priceMonthly,
        currency: 'usd',
        billingName: entry.org.name,
        billingEmail: entry.org.contactEmail,
        pdfUrl: `/uploads/invoices/sub-${orgKey}.pdf`,
        issuedAt: minutesAgo(24 * 12),
        dueAt: daysFromNow(14),
        paidAt: minutesAgo(24 * 12),
      },
    });
  }

  // --------------------------- bulk seat registration ------------------------
  const bulk = await prisma.bulkRegistration.upsert({
    where: { id: 'seed-bulk-vertex-arch' },
    update: {},
    create: {
      id: 'seed-bulk-vertex-arch',
      organizationId: ctx['vertex-cloud'].id,
      examId: certEntry.exam.id,
      seats: 25,
      unitPriceCents: 12900,
      totalPriceCents: 322500,
      status: 'SUCCEEDED',
      paymentId: `seed-payment-bulk-vertex`,
      invoiceNumber: 'INV-BULK-VERTEX-0001',
      csvFileUrl: '/uploads/imports/vertex-cohort-2026.csv',
      createdById: ctx['learning-admin@vertex.example.com'].id,
    },
  });

  await prisma.payment.upsert({
    where: { id: 'seed-payment-bulk-vertex' },
    update: {},
    create: {
      id: 'seed-payment-bulk-vertex',
      organizationId: bulk.organizationId,
      examId: bulk.examId,
      provider: 'STRIPE',
      purpose: 'BULK_SEATS',
      status: 'SUCCEEDED',
      amountCents: bulk.totalPriceCents,
      currency: 'usd',
      feeCents: Math.round(bulk.totalPriceCents * 0.029) + 30,
      netCents: bulk.totalPriceCents - 30,
      seatCount: bulk.seats,
      stripePaymentIntentId: 'pi_seed_bulk_vertex',
      description: '25 seats for the Solutions Architect certification cohort',
      paidAt: minutesAgo(24 * 40),
      metadata: { randomNote: random.int(1, 100) },
    },
  });
  paymentCount += 2;

  // Failed payment example so the revenue dashboard has a non-success row
  await prisma.payment.upsert({
    where: { id: 'seed-payment-failed-demo' },
    update: {},
    create: {
      id: 'seed-payment-failed-demo',
      userId: attempts[0]?.userId ?? ctx.superAdmin.id,
      organizationId: surveyEntry?.org.id ?? ctx['meridian-institute'].id,
      examId: surveyEntry?.exam.id ?? certEntry.exam.id,
      provider: 'STRIPE',
      purpose: 'EXAM_FEE',
      status: 'FAILED',
      amountCents: 4900,
      currency: 'usd',
      failureMessage: 'card_declined / insufficient_funds',
      failedAt: minutesAgo(90),
      description: 'Failed checkout attempt (declined card)',
    },
  });
  paymentCount += 1;

  ctx.paymentCount = paymentCount;
  console.log(`  · ${paymentCount} payments, invoices, promo codes and a bulk-seat purchase`);
};

function slugSafe(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}
