/**
 * Prisma seeder entry point (`prisma db seed`).
 *
 * Order matters because later steps resolve records created by earlier ones.
 * Shared lookups are passed through a `ctx` object so no step re-queries by
 * magic constants.
 *
 * Run with:  npm run prisma:seed
 * Optional:  SEED_WIPE=true npm run prisma:seed   (delete demo data first)
 *
 * NOTE: this file is provided for execution by a human operator. The code
 * generation task does not run any command.
 */

const { PrismaClient } = require('@prisma/client');
const { wipe } = require('./lib/utils');

const steps = [
  ['01-platform', require('./01-platform')],
  ['02-organizations', require('./02-organizations')],
  ['03-question-bank', require('./03-question-bank')],
  ['04-exams', require('./04-exams')],
  ['05-attempts', require('./05-attempts')],
  ['06-proctoring', require('./06-proctoring')],
  ['07-grading-certificates', require('./07-grading-certificates')],
  ['08-payments', require('./08-payments')],
  ['09-live-quiz', require('./09-live-quiz')],
  ['10-analytics-notifications', require('./10-analytics-notifications')],
];

/** @param {PrismaClient} prisma */
async function seed(prisma) {
  const ctx = {};

  if (process.env.SEED_WIPE === 'true') {
    console.log('· wiping existing rows (FK-safe order)');
    await wipe(prisma);
  }

  for (const [name, run] of steps) {
    console.log(`\n▶ ${name}`);
    await run(prisma, ctx);
  }

  console.log('\n✔ seed complete');
  console.table({
    users: ctx.userCount ?? 0,
    organizations: ctx.organizationCount ?? 0,
    questions: ctx.questionCount ?? 0,
    exams: ctx.examCount ?? 0,
    attempts: ctx.attemptCount ?? 0,
    certificates: ctx.certificateCount ?? 0,
    payments: ctx.paymentCount ?? 0,
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
  } catch (error) {
    console.error('✖ seed failed', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}

module.exports = { seed, steps };
