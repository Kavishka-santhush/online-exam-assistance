const { slugify } = require('./lib/utils');
const { questionFixtures } = require('./data/questions');

const BANKS = [
  {
    key: 'cs-core',
    orgKey: 'northgate-university',
    ownerEmail: 'i.hartley@northgate.example.edu',
    name: 'Computer Science Core',
    description: 'Reusable items for networking, databases, devops and architecture papers.',
    categoryPath: ['Computer Science', 'Core Modules'],
    tags: ['cs', 'core'],
    questionKeys: [
      'q-mcq-capitals', 'q-mcma-protocols', 'q-tf-sql-drop', 'q-short-entropy', 'q-fill-blank-tcp',
      'q-matching-aws', 'q-ordering-pipeline', 'q-dropdown-verbs', 'q-coding-two-sum', 'q-essay-cloud-native',
    ],
  },
  {
    key: 'math-applied',
    orgKey: 'northgate-university',
    ownerEmail: 's.oyelaran@northgate.example.edu',
    name: 'Applied Mathematics',
    description: 'Algebra, calculus and physics items including math and drawing answer types.',
    categoryPath: ['Mathematics', 'Algebra'],
    tags: ['math', 'physics'],
    questionKeys: ['q-math-quadratic', 'q-drawing-freebody', 'q-hotspot-diagram', 'q-file-upload-essay'],
  },
  {
    key: 'clinical-imaging',
    orgKey: 'northgate-university',
    ownerEmail: 'i.hartley@northgate.example.edu',
    name: 'Clinical Imaging Bank',
    description: 'Image-heavy items shared with the medical faculty.',
    categoryPath: ['Medicine', 'Radiology'],
    tags: ['clinical'],
    questionKeys: ['q-mcq-img-symptom'],
    sharedWith: ['s.oyelaran@northgate.example.edu'],
  },
  {
    key: 'cloud-architecture',
    orgKey: 'vertex-cloud',
    ownerEmail: 'arch.trainer@vertex.example.com',
    name: 'Cloud Architecture Certification',
    description: 'Certification pool used by the proctored architect exam.',
    categoryPath: ['Cloud', 'Architecture'],
    tags: ['aws', 'certification'],
    questionKeys: ['q-matching-aws', 'q-essay-cloud-native', 'q-coding-two-sum', 'q-video-interview'],
  },
  {
    key: 'soft-skills',
    orgKey: 'meridian-institute',
    ownerEmail: 'trainer@meridian.example.org',
    name: 'Communication & Feedback',
    description: 'Speaking, recording and survey-style items.',
    categoryPath: ['Professional Skills', 'Communication'],
    tags: ['feedback', 'language'],
    questionKeys: ['q-audio-speaking', 'q-video-interview', 'q-likert-confidence', 'q-rating-instructor', 'q-matrix-module-rating'],
  },
];

const REVIEWED_KEYS = new Set(['q-mcq-capitals', 'q-mcma-protocols', 'q-coding-two-sum', 'q-essay-cloud-native']);
const IN_REVIEW_KEYS = new Set(['q-hotspot-diagram', 'q-drawing-freebody']);

module.exports = async function seed(prisma, ctx) {
  // ---- categories (Subject -> Topic -> Subtopic) --------------------------
  const categoryByPath = {};
  for (const [orgKey, entry] of Object.entries(ctx.orgs)) {
    const org = entry.org;
    for (const bank of BANKS.filter((item) => item.orgKey === orgKey)) {
      let parentId = null;
      let pathSoFar = [];
      for (const [level, segment] of bank.categoryPath.entries()) {
        pathSoFar = [...pathSoFar, segment];
        const slug = slugify(pathSoFar.join('-'));
        const category = await prisma.questionCategory.upsert({
          where: { organizationId_slug: { organizationId: org.id, slug } },
          update: { level, sortOrder: level, parentId },
          create: { organizationId: org.id, slug, name: segment, level, parentId, sortOrder: level },
        });
        categoryByPath[`${orgKey}/${slug}`] = category;
        parentId = category.id;
      }
      bank._categoryId = parentId;
    }
  }

  // ---- banks --------------------------------------------------------------
  const banks = {};
  for (const bank of BANKS) {
    const org = ctx[bank.orgKey];
    const owner = ctx[bank.ownerEmail];
    const record = await prisma.questionBank.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: bank.key } },
      update: { name: bank.name, description: bank.description, categoryId: bank._categoryId ?? null },
      create: {
        organizationId: org.id,
        slug: bank.key,
        name: bank.name,
        description: bank.description,
        ownerId: owner.id,
        categoryId: bank._categoryId ?? null,
        tags: bank.tags,
        isShared: Boolean(bank.sharedWith?.length),
        settings: { allowStudentPreview: false, defaultDifficulty: 'MEDIUM' },
      },
    });

    for (const email of bank.sharedWith ?? []) {
      const user = ctx[email];
      if (!user) continue;
      await prisma.questionBankShare.upsert({
        where: { bankId_userId: { bankId: record.id, userId: user.id } },
        update: { access: 'EDIT' },
        create: { bankId: record.id, userId: user.id, access: 'EDIT' },
      });
    }

    banks[bank.key] = record;
    ctx[bank.key] = record;
  }

  // ---- questions (one per type at minimum) -------------------------------
  const questions = {};
  const fixtureByIndex = new Map(questionFixtures.map((item, index) => [item.key, { item, index }]));

  for (const bank of BANKS) {
    const org = ctx[bank.orgKey];
    const owner = ctx[bank.ownerEmail];
    for (const questionKey of bank.questionKeys) {
      const entry = fixtureByIndex.get(questionKey);
      if (!entry || questions[`${bank.key}:${questionKey}`]) continue;
      const { item } = entry;

      const status = REVIEWED_KEYS.has(item.key) ? 'APPROVED' : IN_REVIEW_KEYS.has(item.key) ? 'IN_REVIEW' : 'DRAFT';
      const id = `seed-${item.key}`;
      const reviewer = org ? ctx[`${bank.orgKey}:ORG_ADMIN`] : null;

      const question = await prisma.question.upsert({
        where: { id },
        update: {},
        create: {
          id,
          organizationId: org.id,
          bankId: banks[bank.key].id,
          categoryId: bank._categoryId ?? null,
          createdById: owner.id,
          type: item.type,
          status,
          prompt: item.prompt,
          promptPlain: item.prompt,
          content: item.content,
          explanation: item.explanation ?? null,
          solution: item.solution ?? null,
          imageUrls: item.imageUrls ?? [],
          marks: item.marks,
          negativePercent: item.negativePercent ?? 0,
          partialMarking: item.partialMarking ?? false,
          difficulty: item.difficulty,
          bloomsLevel: item.bloomsLevel ?? null,
          estimatedTimeSec: item.estimatedTimeSec,
          hint: buildHint(item),
          hintCostMarks: item.marks > 4 ? 1 : 0,
          language: item.language ?? 'en',
          learningObjectives: item.learningObjectives ?? [],
          topicTags: item.topicTags ?? [],
          codeConfig: item.type === 'CODING' ? item.content : null,
          rubricCriteria: item.rubricCriteria ?? [],
          currentVersion: 1,
          reviewedById: status === 'APPROVED' && reviewer ? reviewer.id : null,
          reviewedAt: status === 'APPROVED' && reviewer ? new Date() : null,
          reviewNote: status === 'APPROVED' ? 'Checked for ambiguity and answer-key correctness.' : null,
        },
      });

      // Version history: editing an approved question creates version 2 while
      // historic attempts keep referencing version 1.
      await prisma.questionVersion.upsert({
        where: { questionId_version: { questionId: question.id, version: 1 } },
        update: {},
        create: {
          questionId: question.id,
          version: 1,
          prompt: question.prompt,
          content: question.content,
          marks: question.marks,
          changedById: owner.id,
          changeNote: 'Initial revision',
        },
      });

      if (status !== 'DRAFT') {
        await prisma.questionVersion.upsert({
          where: { questionId_version: { questionId: question.id, version: 2 } },
          update: {},
          create: {
            questionId: question.id,
            version: 2,
            prompt: `${question.prompt} (clarity pass)`,
            content: question.content,
            marks: question.marks,
            changedById: owner.id,
            changeNote: 'Reworded stem for readability; answer key unchanged',
          },
        });
      }

      if (reviewer && status !== 'DRAFT') {
        await prisma.questionReview.create({
          data: {
            questionId: question.id,
            reviewerId: reviewer.id,
            action: status === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES',
            comment: status === 'APPROVED' ? 'Approved for the item bank.' : 'Please add a distractor rationale.',
          },
        });
      }

      questions[`${bank.key}:${questionKey}`] = question;
      questions[questionKey] = questions[questionKey] ?? question;
    }
  }

  for (const bank of BANKS) {
    const count = Object.entries(questions).filter(([key]) => key.startsWith(`${bank.key}:`)).length;
    await prisma.questionBank.update({ where: { id: banks[bank.key].id }, data: { questionCount: count } });
  }

  ctx.questions = questions;
  ctx.questionCount = Object.keys(questions).length;
  ctx.banks = banks;
  console.log(`  · ${ctx.questionCount} questions across ${BANKS.length} banks (all 19 types covered)`);
};

function buildHint(item) {
  const hints = {
    'q-mcq-capitals': 'It is not the largest city in the country.',
    'q-mcma-protocols': 'Think about which protocols establish end-to-end segments.',
    'q-coding-two-sum': 'A hash map turns the quadratic search into a linear one.',
    'q-essay-cloud-native': 'Address cost, reliability, and Conway\'s law explicitly.',
  };
  return hints[item.key] ?? null;
}
