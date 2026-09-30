/**
 * Question service: the item bank CRUD, the review workflow and search.
 *
 * `content` is free-form JSONB whose shape is documented in
 * `constants/questionTypes.js`; this module validates the parts that must exist
 * for grading to work (answer keys) and leaves the rest to the editor.
 */

const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const {
  AUTO_GRADED_TYPES, MANUALLY_GRADED_TYPES, defaultContent, isKnownType,
} = require('../constants/questionTypes');

const LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  prompt: true,
  marks: true,
  negativePercent: true,
  difficulty: true,
  bloomsLevel: true,
  estimatedTimeSec: true,
  topicTags: true,
  learningObjectives: true,
  imageUrls: true,
  usageCount: true,
  timesAnswered: true,
  timesCorrect: true,
  avgScorePercent: true,
  difficultyIndex: true,
  discriminationIndex: true,
  skipRate: true,
  currentVersion: true,
  bankId: true,
  categoryId: true,
  organizationId: true,
  createdById: true,
  isDeprecated: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true, imageUrl: true } },
  bank: { select: { id: true, name: true, slug: true } },
};

const DETAIL_INCLUDE = {
  createdBy: { select: { id: true, displayName: true, email: true, imageUrl: true } },
  bank: { select: { id: true, name: true, slug: true, isShared: true, organizationId: true } },
  category: true,
  reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } },
  versions: { orderBy: { version: 'desc' }, take: 20 },
  stats: true,
  _count: { select: { answers: true, examQuestions: true } },
};

/** Filters shared by the bank view, the exam builder picker and search. */
function buildWhere({ organizationId, bankId, bankIds, type, types, difficulty, difficulties, status, statuses, tags, topic, createdBy, categoryId, usedInExam, deprecated, search }) {
  const where = {};
  if (organizationId) where.organizationId = organizationId;
  if (bankId) where.bankId = bankId;
  if (Array.isArray(bankIds) && bankIds.length) where.bankId = { in: bankIds };
  if (type) where.type = type;
  else if (Array.isArray(types) && types.length) where.type = { in: types };
  if (difficulty) where.difficulty = difficulty;
  else if (Array.isArray(difficulties) && difficulties.length) where.difficulty = { in: difficulties };
  if (status) where.status = status;
  else if (Array.isArray(statuses) && statuses.length) where.status = { in: statuses };
  if (categoryId) where.categoryId = categoryId;
  if (createdBy) where.createdById = createdBy;
  if (deprecated !== undefined) where.isDeprecated = Boolean(deprecated);
  if (Array.isArray(tags) && tags.length) where.topicTags = { hasSome: tags };
  if (topic) where.topicTags = { hasSome: [topic] };
  if (search) {
    where.OR = [
      { prompt: { contains: search, mode: 'insensitive' } },
      { explanation: { contains: search, mode: 'insensitive' } },
      { topicTags: { hasSome: [search] } },
    ];
  }
  if (usedInExam) {
    where.examQuestions = { some: { examId: usedInExam } };
  }
  return where;
}

const SORTABLE = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  recentlyUpdated: { updatedAt: 'desc' },
  promptAsc: { prompt: 'asc' },
  marksDesc: { marks: 'desc' },
  mostUsed: { usageCount: 'desc' },
  hardest: { difficultyIndex: 'asc' },
  easiest: { difficultyIndex: 'desc' },
  discriminating: { discriminationIndex: 'desc' },
};

async function listQuestions(query = {}) {
  const { page = 1, limit = 20, sort = 'newest' } = query;
  const where = buildWhere(query);

  const [items, total] = await Promise.all([
    prisma.question.findMany({
      where,
      select: LIST_SELECT,
      orderBy: SORTABLE[sort] ?? SORTABLE.newest,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.question.count({ where }),
  ]);

  return { items: items.map(deserialiseQuestion), total, page, limit };
}

/**
 * Relevance-ranked full-text search backed by the `Question.searchBlob` tsvector
 * (maintained by a database trigger) with an ILIKE fallback so partial words
 * still match.
 */
async function searchQuestions({ organizationId, term, bankId, type, limit = 25 }) {
  if (!term || !String(term).trim()) return [];
  const cleaned = String(term).trim().slice(0, 200);

  const params = [cleaned, organizationId];
  const filters = ['q."organizationId" = $2'];
  if (bankId) {
    filters.push(`q."bankId" = $${params.push(bankId)}`);
  }
  if (type) {
    filters.push(`q."type"::text = $${params.push(type)}`);
  }

  const limitIndex = params.push(Math.min(100, Number(limit) || 25));

  // Parameterised fragments are built with Prisma.raw only for the numeric
  // placeholders and the rank expression - the user term stays bound.
  const rows = await prisma.$queryRaw`
    SELECT q."id", q."type", q."status", q."prompt", q."marks", q."difficulty", q."topicTags",
           q."bankId", q."updatedAt",
           ${Prisma.raw(`ts_rank(coalesce(q."searchBlob", to_tsvector('english', '')), to_tsquery('english', plainto_tsquery('english', $1)), 32)`)} AS relevance
    FROM "Question" q
    WHERE ${Prisma.raw(filters.join(' AND '))}
      AND (q."searchBlob" @@ to_tsquery('english', plainto_tsquery('english', $1)) OR q."prompt" ILIKE '%' || $1 || '%')
    ORDER BY relevance DESC, q."updatedAt" DESC
    LIMIT ${Prisma.raw(`$${limitIndex}`)}
  `;

  return rows.map((row) => ({
    ...row,
    marks: row.marks == null ? null : Number(row.marks),
    relevance: Number(row.relevance ?? 0),
  }));
}

/** Alias used by the AI natural-language search feature. */
async function nlSearch({ organizationId, questionText, filters = {}, limit = 20 }) {
  return searchQuestions({ organizationId, term: questionText, bankId: filters.bankId, type: filters.type, limit });
}

async function getQuestion(questionId, { actorOrganizationId = null } = {}) {
  const question = await prisma.question.findUnique({ where: { id: questionId }, include: DETAIL_INCLUDE });
  if (!question) throw ApiError.notFound('Question not found');
  if (actorOrganizationId && question.organizationId !== actorOrganizationId && !question.bank?.isShared) {
    throw ApiError.forbidden('This question belongs to another organization');
  }
  return deserialiseQuestion(question);
}

/**
 * Answer-key sanity check. Runs before create/update: a question the grader
 * cannot mark is worse than no question at all.
 */
function validateContent({ type, content = {}, marks }) {
  const problems = [];
  const warnings = [];

  if (!isKnownType(type)) problems.push(`Unknown question type "${type}"`);
  if (marks !== undefined && Number(marks) <= 0) problems.push('marks must be greater than zero');

  const options = Array.isArray(content.options) ? content.options : [];

  switch (type) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE': {
      const correct = content.correctOptionId ?? options.find((option) => option.correct)?.id;
      if (options.length < 2) problems.push('at least two options are required');
      if (!correct) problems.push('no option is marked correct');
      const distractors = options.filter((option) => !option.correct && option.id !== content.correctOptionId);
      if (type === 'MULTIPLE_CHOICE' && distractors.length === 0) warnings.push('every option is correct - candidates cannot answer wrongly');
      break;
    }
    case 'MULTIPLE_ANSWER': {
      const correct = content.correctOptionIds ?? options.filter((option) => option.correct).map((option) => option.id);
      if (!Array.isArray(correct) || correct.length === 0) problems.push('select at least one correct option');
      if (options.length && correct.length >= options.length) warnings.push('all options are correct, so partial credit is meaningless');
      break;
    }
    case 'SHORT_ANSWER': {
      const hasAnswer = [content.acceptedAnswers, content.answers, content.keywords].some((value) => Array.isArray(value) && value.length);
      if (!hasAnswer && !content.regex && content.exactAnswer === undefined) {
        problems.push('provide accepted answers, keywords or a regex');
      }
      if (String(content.matchMode ?? 'KEYWORD').toUpperCase() === 'REGEX' && !content.regex) problems.push('matchMode REGEX needs a regex');
      break;
    }
    case 'FILL_BLANK': {
      const blanks = Array.isArray(content.blanks) ? content.blanks : [];
      if (!blanks.length) problems.push('define at least one blank');
      if (blanks.some((blank) => !Array.isArray(blank.answers) || !blank.answers.length)) problems.push('every blank needs at least one accepted answer');
      break;
    }
    case 'MATCHING': {
      const pairs = Array.isArray(content.pairs) ? content.pairs : [];
      if (pairs.length < 2) problems.push('matching needs at least two pairs');
      if (pairs.some((pair) => !pair.left || !pair.right)) problems.push('every pair needs a left and a right side');
      break;
    }
    case 'ORDERING': {
      const items = Array.isArray(content.items) ? content.items : [];
      if (items.length < 2) problems.push('ordering needs at least two items');
      if (items.some((item) => item.correctPosition === undefined && item.position === undefined && !('correct' in item))) {
        warnings.push('items have no explicit correct order - the declared sequence will be used');
      }
      break;
    }
    case 'DROPDOWN': {
      const blanks = Array.isArray(content.blanks) ? content.blanks : [];
      if (!blanks.length) problems.push('add at least one dropdown blank');
      blanks.forEach((blank, index) => {
        if (!Array.isArray(blank.options) || blank.options.length < 2) problems.push(`blank ${index + 1} needs at least two options`);
        if (blank.correctIndex === undefined && blank.correctOptionId === undefined) problems.push(`blank ${index + 1} has no correct option`);
      });
      break;
    }
    case 'HOTSPOT': {
      const regions = Array.isArray(content.regions) ? content.regions : [];
      if (!regions.length) problems.push('mark at least one hot region on the image');
      if (!content.imageUrl) problems.push('hotspot questions need an image');
      break;
    }
    case 'CODING': {
      const tests = Array.isArray(content.testCases) ? content.testCases : [];
      if (!tests.length) warnings.push('no visible test cases - the submission can only be graded by a human');
      if (!content.starterCode) warnings.push('no starter code supplied');
      break;
    }
    case 'MATH_FORMULA': {
      if (!content.acceptedLatex && !content.numericAnswer && !Array.isArray(content.acceptedAnswers)) {
        problems.push('give an accepted LaTeX expression or a numeric answer');
      }
      break;
    }
    case 'MATRIX': {
      const rows = Array.isArray(content.rows) ? content.rows : [];
      const columns = Array.isArray(content.columns) ? content.columns : [];
      if (!rows.length || !columns.length) problems.push('a matrix needs rows and columns');
      break;
    }
    case 'LIKERT_SCALE':
    case 'RATING_SCALE': {
      if (content.min === undefined || content.max === undefined) warnings.push('no scale bounds declared');
      break;
    }
    default:
      break;
  }

  if (MANUALLY_GRADED_TYPES.includes(type) && !Array.isArray(content.rubric) && !content.modelAnswer) {
    warnings.push('manually graded question has no model answer or rubric');
  }

  return { valid: problems.length === 0, problems, warnings, autoGradable: AUTO_GRADED_TYPES.includes(type) };
}

/** Merge supplied content with the type's documented default shape. */
function normaliseContent(type, content = {}) {
  const base = defaultContent(type) ?? {};
  const merged = { ...base, ...content };
  if (Array.isArray(merged.options)) {
    merged.options = merged.options.map((option, index) => ({
      id: option.id ?? `opt-${index + 1}`,
      text: option.text ?? option.label ?? '',
      ...option,
    }));
  }
  return merged;
}

async function createQuestion(payload, actor) {
  if (!payload.prompt || !String(payload.prompt).trim()) throw ApiError.badRequest('The question prompt is required');
  if (!isKnownType(payload.type)) throw ApiError.badRequest(`Unsupported question type "${payload.type}"`);

  const content = normaliseContent(payload.type, payload.content ?? {});
  const validation = validateContent({ type: payload.type, content, marks: payload.marks });
  if (!validation.valid && payload.skipValidation !== true) {
    throw ApiError.unprocessable('This question cannot be graded yet', validation);
  }

  const question = await prisma.question.create({
    data: {
      organizationId: payload.organizationId ?? actor.organizationId,
      bankId: payload.bankId ?? null,
      categoryId: payload.categoryId ?? null,
      createdById: actor.userId,
      type: payload.type,
      status: payload.status ?? 'DRAFT',
      prompt: String(payload.prompt).trim(),
      promptPlain: plainText(payload.prompt),
      content,
      explanation: payload.explanation ?? null,
      solution: payload.solution ?? null,
      imageUrls: payload.imageUrls ?? [],
      audioUrl: payload.audioUrl ?? null,
      videoUrl: payload.videoUrl ?? null,
      youtubeUrl: payload.youtubeUrl ?? null,
      marks: payload.marks ?? 1,
      negativePercent: payload.negativePercent ?? 0,
      partialMarking: Boolean(payload.partialMarking),
      difficulty: payload.difficulty ?? 'MEDIUM',
      bloomsLevel: payload.bloomsLevel ?? null,
      estimatedTimeSec: payload.estimatedTimeSec ?? 60,
      hint: payload.hint ?? null,
      hintCostMarks: payload.hintCostMarks ?? 0,
      language: payload.language ?? 'en',
      learningObjectives: payload.learningObjectives ?? [],
      topicTags: payload.topicTags ?? [],
      codeConfig: payload.codeConfig ?? content.codeConfig ?? null,
      rubricCriteria: payload.rubricCriteria ?? content.rubric ?? [],
    },
    include: DETAIL_INCLUDE,
  });

  await prisma.questionVersion.create({
    data: {
      questionId: question.id,
      version: 1,
      prompt: question.prompt,
      content: question.content,
      marks: question.marks,
      changeNote: 'created',
      changedById: actor.userId,
    },
  });

  if (question.bankId) await bumpBankCount(question.bankId, 1);

  logger.info('question created', { questionId: question.id, type: question.type, actorId: actor.userId });
  return deserialiseQuestion(question);
}

/**
 * Update + version snapshot. Editing a question that is already attached to a
 * published exam is allowed but recorded: attempts keep `questionVersion` so
 * old submissions still refer to the content the candidate saw.
 */
async function updateQuestion(questionId, payload, actor) {
  const existing = await prisma.question.findUnique({
    where: { id: questionId },
    include: { bank: { select: { id: true } }, _count: { select: { examQuestions: true } } },
  });
  if (!existing) throw ApiError.notFound('Question not found');
  assertSameOrganization(existing, actor);

  const type = payload.type ?? existing.type;
  const content = payload.content ? normaliseContent(type, payload.content) : existing.content;
  const validation = validateContent({ type, content, marks: payload.marks ?? existing.marks });
  if (!validation.valid && payload.skipValidation !== true) {
    throw ApiError.unprocessable('This question cannot be graded yet', validation);
  }

  const data = {
    type,
    content,
    promptPlain: payload.prompt !== undefined ? plainText(payload.prompt) : existing.promptPlain,
  };
  for (const field of [
    'prompt', 'status', 'explanation', 'solution', 'imageUrls', 'audioUrl', 'videoUrl', 'youtubeUrl',
    'marks', 'negativePercent', 'partialMarking', 'difficulty', 'bloomsLevel', 'estimatedTimeSec',
    'hint', 'hintCostMarks', 'language', 'learningObjectives', 'topicTags', 'codeConfig',
    'rubricCriteria', 'categoryId', 'isDeprecated', 'bankId',
  ]) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }

  const substantive = ['prompt', 'content', 'marks', 'type'].some((field) => payload[field] !== undefined);
  const nextVersion = substantive ? existing.currentVersion + 1 : existing.currentVersion;
  if (substantive) data.currentVersion = nextVersion;

  const question = await prisma.question.update({ where: { id: questionId }, data, include: DETAIL_INCLUDE });

  if (substantive) {
    await prisma.questionVersion.create({
      data: {
        questionId,
        version: nextVersion,
        prompt: question.prompt,
        content: question.content,
        marks: question.marks,
        changeNote: payload.changeNote ?? 'edited',
        changedById: actor.userId,
      },
    });
  }

  if (payload.bankId && payload.bankId !== existing.bankId) {
    if (existing.bankId) await bumpBankCount(existing.bankId, -1);
    await bumpBankCount(payload.bankId, 1);
  }

  if (question._count?.examQuestions && substantive) {
    logger.warn('question attached to exams was edited', {
      questionId,
      examLinks: question._count.examQuestions,
      version: nextVersion,
      actorId: actor.userId,
    });
  }

  return deserialiseQuestion(question);
}

async function duplicateQuestion(questionId, { bankId, count = 1 }, actor) {
  const source = await prisma.question.findUnique({ where: { id: questionId } });
  if (!source) throw ApiError.notFound('Question not found');
  assertSameOrganization(source, actor);

  const created = [];
  for (let index = 0; index < Math.min(20, Number(count) || 1); index += 1) {
    const copy = await prisma.question.create({
      data: {
        organizationId: source.organizationId,
        bankId: bankId ?? source.bankId,
        categoryId: source.categoryId,
        createdById: actor.userId,
        type: source.type,
        status: 'DRAFT',
        prompt: `${source.prompt}${index ? ` (${index + 1})` : ' (copy)'}`,
        promptPlain: source.promptPlain,
        content: source.content,
        explanation: source.explanation,
        solution: source.solution,
        imageUrls: source.imageUrls,
        audioUrl: source.audioUrl,
        videoUrl: source.videoUrl,
        youtubeUrl: source.youtubeUrl,
        marks: source.marks,
        negativePercent: source.negativePercent,
        partialMarking: source.partialMarking,
        difficulty: source.difficulty,
        bloomsLevel: source.bloomsLevel,
        estimatedTimeSec: source.estimatedTimeSec,
        hint: source.hint,
        hintCostMarks: source.hintCostMarks,
        language: source.language,
        learningObjectives: source.learningObjectives,
        topicTags: source.topicTags,
        codeConfig: source.codeConfig ?? undefined,
        rubricCriteria: source.rubricCriteria,
      },
      select: LIST_SELECT,
    });
    await prisma.questionVersion.create({
      data: { questionId: copy.id, version: 1, prompt: copy.prompt, content: source.content, marks: source.marks, changeNote: `duplicated from ${questionId}`, changedById: actor.userId },
    });
    created.push(copy);
  }

  if (created.length && created[0].bank?.id) {
    await bumpBankCount(created[0].bank.id, created.length);
  }
  return created;
}

/**
 * Archive rather than delete by default: an archived question cannot be added
 * to new exams but historical attempts still resolve.
 */
async function archiveQuestion(questionId, { archive = true }, actor) {
  const question = await prisma.question.findUnique({ where: { id: questionId } });
  if (!question) throw ApiError.notFound('Question not found');
  assertSameOrganization(question, actor);
  return prisma.question.update({
    where: { id: questionId },
    data: { status: archive ? 'ARCHIVED' : 'APPROVED', archivedAt: archive ? new Date() : null },
    select: LIST_SELECT,
  });
}

/** Hard delete is refused while any exam still references the question. */
async function deleteQuestion(questionId, actor) {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    include: { _count: { select: { examQuestions: true, answers: true } } },
  });
  if (!question) throw ApiError.notFound('Question not found');
  assertSameOrganization(question, actor);

  if (question._count.examQuestions > 0 || question._count.answers > 0) {
    throw ApiError.conflict('This question is used by exams or past answers - archive it instead', {
      examLinks: question._count.examQuestions,
      answers: question._count.answers,
    });
  }

  await prisma.question.delete({ where: { id: questionId } });
  if (question.bankId) await bumpBankCount(question.bankId, -1);
  logger.info('question deleted', { questionId, actorId: actor.userId });
  return { deleted: true, questionId };
}

async function bulkUpdate({ questionIds = [], ...changes }, actor) {
  const ids = questionIds.slice(0, 500);
  if (!ids.length) throw ApiError.badRequest('Select at least one question');

  const owned = await prisma.question.count({
    where: { id: { in: ids }, organizationId: actor.organizationId ?? undefined },
  });
  if (owned !== ids.length) throw ApiError.forbidden('One or more questions belong to another organization');

  const data = {};
  for (const field of ['status', 'difficulty', 'bankId', 'categoryId', 'isDeprecated', 'partialMarking', 'negativePercent']) {
    if (changes[field] !== undefined) data[field] = changes[field];
  }
  if (Array.isArray(changes.addTags) && changes.addTags.length) {
    // Prisma has no array-append for String[]; compute per row instead.
    const rows = await prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, topicTags: true } });
    await prisma.$transaction(rows.map((row) => prisma.question.update({
      where: { id: row.id },
      data: { topicTags: [...new Set([...row.topicTags, ...changes.addTags.map(String)])] },
    })));
  }
  if (Array.isArray(changes.removeTags) && changes.removeTags.length) {
    const rows = await prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, topicTags: true } });
    const remove = new Set(changes.removeTags.map(String));
    await prisma.$transaction(rows.map((row) => prisma.question.update({
      where: { id: row.id },
      data: { topicTags: row.topicTags.filter((tag) => !remove.has(tag)) },
    })));
  }

  if (!Object.keys(data).length) return { updated: 0 };
  const result = await prisma.question.updateMany({ where: { id: { in: ids } }, data });
  return { updated: result.count };
}

/** Move questions between banks, keeping both counters correct. */
async function moveToBank({ questionIds = [], bankId }, actor) {
  const ids = questionIds.slice(0, 500);
  if (!ids.length || !bankId) throw ApiError.badRequest('questionIds and bankId are required');

  const bank = await prisma.questionBank.findUnique({ where: { id: bankId } });
  if (!bank) throw ApiError.notFound('Target bank not found');
  if (actor.organizationId && bank.organizationId !== actor.organizationId) throw ApiError.forbidden('That bank belongs to another organization');

  const rows = await prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, bankId: true } });
  const moved = rows.filter((row) => row.bankId !== bankId);
  if (!moved.length) return { moved: 0 };

  await prisma.$transaction([
    prisma.question.updateMany({ where: { id: { in: moved.map((row) => row.id) } }, data: { bankId } }),
    prisma.questionBank.update({ where: { id: bankId }, data: { questionCount: { increment: moved.length } } }),
    ...distinctCounts(rows, bankId),
  ]);

  return { moved: moved.length, bankId };
}

function distinctCounts(rows, targetBankId) {
  const sources = [...new Set(rows.map((row) => row.bankId).filter((id) => id && id !== targetBankId))];
  return sources.map((id) => prisma.questionBank.update({
    where: { id },
    data: { questionCount: { decrement: rows.filter((row) => row.bankId === id).length } },
  }));
}

/** Review workflow: submit, approve, reject, request changes. */
async function reviewQuestion({ questionId, action, comment }, actor) {
  const question = await prisma.question.findUnique({ where: { id: questionId } });
  if (!question) throw ApiError.notFound('Question not found');
  assertSameOrganization(question, actor);

  const statusByAction = { APPROVE: 'APPROVED', REJECT: 'REJECTED', REQUEST_CHANGES: 'DRAFT' };
  const status = statusByAction[String(action).toUpperCase()];
  if (!status) throw ApiError.badRequest('action must be APPROVE, REJECT or REQUEST_CHANGES');

  await prisma.questionReview.create({
    data: { questionId, reviewerId: actor.userId, action: String(action).toUpperCase(), comment: comment ?? null },
  });

  return prisma.question.update({
    where: { id: questionId },
    data: { status, reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: comment ?? null },
    include: DETAIL_INCLUDE,
  });
}

async function listReviewQueue({ organizationId, status = 'IN_REVIEW', page = 1, limit = 25 }) {
  const where = { organizationId, status };
  const [items, total] = await Promise.all([
    prisma.question.findMany({
      where,
      select: { ...LIST_SELECT, reviewedById: true, reviewNote: true },
      orderBy: { updatedAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.question.count({ where }),
  ]);
  return { items, total, page, limit };
}

async function listVersions(questionId) {
  return prisma.questionVersion.findMany({
    where: { questionId },
    include: { changedBy: { select: { id: true, displayName: true } } },
    orderBy: { version: 'desc' },
  });
}

/** Roll a question back to an earlier snapshot (creates a new version). */
async function restoreVersion({ questionId, version }, actor) {
  const snapshot = await prisma.questionVersion.findUnique({
    where: { questionId_version: { questionId, version: Number(version) } },
  });
  if (!snapshot) throw ApiError.notFound(`Version ${version} does not exist`);

  const current = await prisma.question.findUnique({ where: { id: questionId } });
  if (!current) throw ApiError.notFound('Question not found');
  assertSameOrganization(current, actor);

  const nextVersion = current.currentVersion + 1;
  const question = await prisma.question.update({
    where: { id: questionId },
    data: { prompt: snapshot.prompt, content: snapshot.content, marks: snapshot.marks, currentVersion: nextVersion },
    include: DETAIL_INCLUDE,
  });

  await prisma.questionVersion.create({
    data: { questionId, version: nextVersion, prompt: snapshot.prompt, content: snapshot.content, marks: snapshot.marks, changeNote: `restored from v${version}`, changedById: actor.userId },
  });

  return question;
}

/** Questions the author should see next: same topic, similar difficulty. */
async function relatedQuestions(questionId, { limit = 8 } = {}) {
  const question = await prisma.question.findUnique({ where: { id: questionId } });
  if (!question) throw ApiError.notFound('Question not found');
  return prisma.question.findMany({
    where: {
      organizationId: question.organizationId,
      id: { not: questionId },
      ...(question.topicTags.length ? { topicTags: { hasSome: question.topicTags } } : {}),
    },
    select: LIST_SELECT,
    take: limit,
    orderBy: { updatedAt: 'desc' },
  });
}

/** Bank/question counters used by the sidebar badges. */
async function questionFacets(organizationId, bankId = null) {
  const where = { organizationId, ...(bankId ? { bankId } : {}) };
  const [byType, byDifficulty, byStatus, total] = await Promise.all([
    prisma.question.groupBy({ by: ['type'], where, _count: { _all: true } }),
    prisma.question.groupBy({ by: ['difficulty'], where, _count: { _all: true } }),
    prisma.question.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.question.count({ where }),
  ]);
  const toMap = (rows, key) => rows.reduce((acc, row) => {
    acc[row[key]] = row._count._all;
    return acc;
  }, {});
  return { total, byType: toMap(byType, 'type'), byDifficulty: toMap(byDifficulty, 'difficulty'), byStatus: toMap(byStatus, 'status') };
}

async function bumpBankCount(bankId, delta) {
  if (!bankId) return null;
  const bank = await prisma.questionBank.findUnique({ where: { id: bankId }, select: { questionCount: true } });
  if (!bank) return null;
  return prisma.questionBank.update({
    where: { id: bankId },
    data: { questionCount: Math.max(0, bank.questionCount + delta) },
  });
}

function assertSameOrganization(record, actor) {
  if (!actor?.organizationId) return;
  if (record.organizationId !== actor.organizationId && actor.platformRole !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('This question belongs to another organization');
  }
}

/** Strip markup so the tsvector and previews see readable text. */
function plainText(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

/** Decimal columns arrive as objects; the client wants numbers. */
function deserialiseQuestion(question) {
  if (!question) return question;
  const numeric = ['marks', 'negativePercent', 'avgScorePercent', 'difficultyIndex', 'discriminationIndex', 'skipRate', 'hintCostMarks', 'avgTimeSec'];
  const out = { ...question };
  for (const field of numeric) {
    if (out[field] !== undefined && out[field] !== null) out[field] = Number(out[field]);
  }
  if (Array.isArray(out.content?.options) && out.type === 'MULTIPLE_CHOICE') {
    out.answerHint = out.content.correctOptionId ?? out.content.options.find((option) => option.correct)?.id ?? null;
  }
  return out;
}

/** Prisma is imported at the top; nothing else to initialise. */

module.exports = {
  DETAIL_INCLUDE,
  LIST_SELECT,
  archiveQuestion,
  bulkUpdate,
  createQuestion,
  deleteQuestion,
  deserialiseQuestion,
  duplicateQuestion,
  getQuestion,
  listQuestions,
  listReviewQueue,
  listVersions,
  moveToBank,
  nlSearch,
  plainText,
  questionFacets,
  relatedQuestions,
  restoreVersion,
  reviewQuestion,
  searchQuestions,
  updateQuestion,
  validateContent,
};
