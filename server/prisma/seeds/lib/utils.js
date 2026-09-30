/**
 * Shared helpers for the Prisma seed scripts.
 *
 * Seeds are deterministic: every record is addressed through an upsert keyed on
 * a stable `seedKey` column value or a natural unique key, so re-running the
 * seeder never duplicates data.
 */

const SLUG_RE = /[^a-z0-9]+/g;

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '');
}

/** Stable pseudo random generator so seeds produce identical data every run. */
function createRandom(seed = 1337) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (list) => list[Math.floor(next() * list.length)],
    bool: (probability = 0.5) => next() < probability,
    shuffle: (list) => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

function daysFromNow(days, hour = 9, minute = 0) {
  const date = new Date(Date.now() + days * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function roundTo(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Insert-or-update helper. `where` must target a unique index; `create` is
 * merged with `data` so callers only spell out the mutable payload once.
 */
async function upsert(prisma, model, where, data, label) {
  const record = await prisma[model].upsert({
    where,
    update: data,
    create: { ...whereValues(where), ...data },
  });
  if (label) {
    console.log(`  · ${model} → ${label}`);
  }
  return record;
}

/**
 * Prisma rejects `undefined` inside `create`, and unique compound keys are
 * expressed through nested `AND` objects, so flatten only plain key values.
 */
function whereValues(where) {
  const out = {};
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined || value === null || typeof value === 'object') continue;
    out[key] = value;
  }
  return out;
}

/** Delete in FK-safe order; used before (re)seeding so runs are idempotent. */
const WIPE_ORDER = [
  'webhookEvent',
  'announcement',
  'featureFlag',
  'platformSetting',
  'auditLog',
  'aiUsageLog',
  'questionStat',
  'analyticsAggregate',
  'notificationPreference',
  'notification',
  'bulkRegistration',
  'promoCode',
  'invoice',
  'payment',
  'badge',
  'certificate',
  'certificateTemplate',
  'attemptFeedback',
  'gradeOverride',
  'gradingAssignment',
  'rubricScore',
  'gradingRubric',
  'liveQuizQuestionResult',
  'liveQuizParticipant',
  'team',
  'liveQuizSession',
  'examRecording',
  'proctorMessage',
  'violation',
  'proctorSession',
  'uploadedFile',
  'examNote',
  'answer',
  'attempt',
  'examCandidate',
  'examPool',
  'examQuestion',
  'examSection',
  'examTemplate',
  'examVersion',
  'exam',
  'examCategory',
  'questionReview',
  'questionVersion',
  'question',
  'questionBankShare',
  'questionBank',
  'questionCategory',
  'organizationSubscription',
  'subscriptionPlan',
  'organizationInvite',
  'organizationMember',
  'organizationSetting',
  'organization',
  'instructorProfile',
  'candidateProfile',
  'user',
];

async function wipe(prisma) {
  for (const model of WIPE_ORDER) {
    if (!prisma[model]) continue;
    await prisma[model].deleteMany({});
  }
}

module.exports = {
  slugify,
  createRandom,
  daysFromNow,
  hoursAgo,
  minutesAgo,
  roundTo,
  upsert,
  wipe,
  WIPE_ORDER,
};
