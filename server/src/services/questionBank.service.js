/**
 * Question bank service: collections, the category tree, sharing, and the
 * CSV/Excel import + export pipeline.
 *
 * Import is deliberately forgiving: a row that cannot be parsed is reported in
 * `errors` with its line number instead of aborting the whole file, because
 * instructors paste 300-row spreadsheets in one go.
 */

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const env = require('../config/env');
const logger = require('../utils/logger.util');
const { ApiError } = require('../utils/response.util');
const { QUESTION_TYPE_VALUES, defaultContent } = require('../constants/questionTypes');
const { createQuestion, validateContent } = require('./question.service');

const BANK_INCLUDE = {
  owner: { select: { id: true, displayName: true, imageUrl: true } },
  category: { select: { id: true, name: true, slug: true } },
  organization: { select: { id: true, name: true, slug: true } },
  shares: { include: { user: { select: { id: true, displayName: true, email: true } } } },
  _count: { select: { questions: true, pools: true } },
};

async function listBanks({ organizationId, search, ownerId, categoryId, includeArchived = false, page = 1, limit = 20 }) {
  const where = { organizationId };
  if (!includeArchived) where.isArchived = false;
  if (ownerId) where.ownerId = ownerId;
  if (categoryId) where.categoryId = categoryId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { tags: { hasSome: [search] } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.questionBank.findMany({
      where,
      include: BANK_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.questionBank.count({ where }),
  ]);

  return { items, total, page, limit };
}

/** Banks the user may pick questions from: own, shared with, or organization-wide. */
async function listAccessibleBanks({ userId, organizationId }) {
  const [owned, shared, organizationBanks] = await Promise.all([
    prisma.questionBank.findMany({ where: { ownerId: userId, isArchived: false }, include: BANK_INCLUDE }),
    prisma.questionBank.findMany({
      where: { shares: { some: { userId } }, isArchived: false },
      include: BANK_INCLUDE,
    }),
    prisma.questionBank.findMany({
      where: { organizationId, isShared: true, isArchived: false },
      include: BANK_INCLUDE,
    }),
  ]);

  const seen = new Set();
  return [...owned, ...shared, ...organizationBanks].filter((bank) => {
    if (seen.has(bank.id)) return false;
    seen.add(bank.id);
    return true;
  });
}

async function getBank(bankId, { actor } = {}) {
  const bank = await prisma.questionBank.findUnique({ where: { id: bankId }, include: BANK_INCLUDE });
  if (!bank) throw ApiError.notFound('Question bank not found');
  if (actor?.organizationId && bank.organizationId !== actor.organizationId && !bank.isShared) {
    throw ApiError.forbidden('This bank belongs to another organization');
  }
  return bank;
}

async function createBank(payload, actor) {
  const organizationId = payload.organizationId ?? actor.organizationId;
  if (!organizationId) throw ApiError.badRequest('An organization is required');

  const slug = await uniqueBankSlug(organizationId, payload.slug || payload.name);
  const bank = await prisma.questionBank.create({
    data: {
      organizationId,
      ownerId: actor.userId,
      categoryId: payload.categoryId ?? null,
      name: payload.name,
      slug,
      description: payload.description ?? null,
      isShared: Boolean(payload.isShared),
      tags: payload.tags ?? [],
      settings: payload.settings ?? {},
    },
    include: BANK_INCLUDE,
  });

  logger.info('question bank created', { bankId: bank.id, actorId: actor.userId });
  return bank;
}

async function uniqueBankSlug(organizationId, base) {
  const cleaned = normaliseSlug(base) || `bank-${Date.now().toString(36)}`;
  let candidate = cleaned;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await prisma.questionBank.findFirst({ where: { organizationId, slug: candidate } });
    if (!existing) return candidate;
    candidate = `${cleaned}-${attempt}`;
  }
}

function normaliseSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-|-$/g, '');
}

async function updateBank(bankId, payload, actor) {
  const bank = await getBank(bankId, { actor });
  const data = {};
  for (const field of ['name', 'description', 'isShared', 'isArchived', 'tags', 'settings', 'categoryId']) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }
  if (payload.isArchived === true) data.archivedAt = new Date();
  if (payload.isArchived === false) data.archivedAt = null;
  if (payload.slug) data.slug = await uniqueBankSlug(bank.organizationId, payload.slug);
  if (!Object.keys(data).length) throw ApiError.badRequest('Nothing to update');

  return prisma.questionBank.update({ where: { id: bankId }, data, include: BANK_INCLUDE });
}

/** Deleting a bank keeps its questions (`bankId` becomes null). */
async function deleteBank(bankId, { archiveOnly = true }, actor) {
  const bank = await getBank(bankId, { actor });
  if (archiveOnly) {
    return prisma.questionBank.update({
      where: { id: bankId },
      data: { isArchived: true, archivedAt: new Date() },
      include: BANK_INCLUDE,
    });
  }

  const usedInPools = await prisma.examPool.count({ where: { bankId } });
  if (usedInPools > 0) {
    throw ApiError.conflict('This bank feeds a randomised section - detach the pool first', { pools: usedInPools });
  }

  await prisma.$transaction([
    prisma.question.updateMany({ where: { bankId }, data: { bankId: null } }),
    prisma.questionBank.delete({ where: { id: bankId } }),
  ]);
  logger.warn('question bank deleted', { bankId, actorId: actor.userId });
  return { deleted: true, bankId };
}

/** Recompute `questionCount` from reality (the counter is a denormalisation). */
async function recountBank(bankId) {
  const count = await prisma.question.count({ where: { bankId } });
  await prisma.questionBank.update({ where: { id: bankId }, data: { questionCount: count } });
  return { bankId, questionCount: count };
}

async function shareBank({ bankId, userIds = [], access = 'VIEW' }, actor) {
  const bank = await getBank(bankId, { actor });
  if (!['VIEW', 'EDIT', 'MANAGE'].includes(access)) throw ApiError.badRequest('access must be VIEW, EDIT or MANAGE');

  const rows = await prisma.$transaction(userIds.map((userId) => prisma.questionBankShare.upsert({
    where: { bankId_userId: { bankId: bank.id, userId } },
    update: { access },
    create: { bankId: bank.id, userId, access },
  })));

  return { sharedWith: rows.length, access };
}

async function revokeShare({ bankId, userId }) {
  return prisma.questionBankShare.deleteMany({ where: { bankId, userId } });
}

/** Bank dashboard: type mix, difficulty mix, quality flags. */
async function bankInsights(bankId, { actor } = {}) {
  await getBank(bankId, { actor });
  const [questions, unused, stale, weak] = await Promise.all([
    prisma.question.groupBy({ by: ['type', 'difficulty'], where: { bankId }, _count: { _all: true } }),
    prisma.question.count({ where: { bankId, usageCount: 0 } }),
    prisma.question.count({ where: { bankId, updatedAt: { lt: new Date(Date.now() - 180 * 864e5) } } }),
    prisma.question.count({ where: { bankId, discriminationIndex: { lt: 0.2 }, timesAnswered: { gte: 10 } } }),
  ]);

  const total = questions.reduce((sum, row) => sum + row._count._all, 0);
  return {
    bankId,
    total,
    unused,
    stale,
    weakDiscrimination: weak,
    matrix: questions.map((row) => ({ type: row.type, difficulty: row.difficulty, count: row._count._all })),
  };
}

// ---------------------------------------------------------------------------
// Categories (nested tree)
// ---------------------------------------------------------------------------

async function listCategories(organizationId, { parentId = null, includeCounts = false } = {}) {
  const where = { organizationId };
  if (parentId !== undefined) where.parentId = parentId;

  const categories = await prisma.questionCategory.findMany({
    where,
    include: {
      children: { orderBy: { sortOrder: 'asc' } },
      ...(includeCounts ? { _count: { select: { banks: true } } } : {}),
    },
    orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  return categories;
}

async function createCategory(payload, actor) {
  const organizationId = payload.organizationId ?? actor.organizationId;
  if (!organizationId) throw ApiError.badRequest('An organization is required');

  let level = 0;
  if (payload.parentId) {
    const parent = await prisma.questionCategory.findUnique({ where: { id: payload.parentId } });
    if (!parent || parent.organizationId !== organizationId) throw ApiError.badRequest('Unknown parent category');
    level = parent.level + 1;
  }

  const slug = await uniqueCategorySlug(organizationId, payload.slug || payload.name);
  return prisma.questionCategory.create({
    data: {
      organizationId,
      parentId: payload.parentId ?? null,
      name: payload.name,
      slug,
      description: payload.description ?? null,
      level,
      sortOrder: payload.sortOrder ?? 0,
    },
  });
}

async function uniqueCategorySlug(organizationId, base) {
  const cleaned = normaliseSlug(base) || `cat-${Date.now().toString(36)}`;
  let candidate = cleaned;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await prisma.questionCategory.findFirst({ where: { organizationId, slug: candidate } });
    if (!existing) return candidate;
    candidate = `${cleaned}-${attempt}`;
  }
}

async function updateCategory(categoryId, payload, actor) {
  const category = await prisma.questionCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw ApiError.notFound('Category not found');
  if (category.organizationId !== actor.organizationId && actor.platformRole !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('This category belongs to another organization');
  }

  const data = {};
  for (const field of ['name', 'description', 'sortOrder', 'parentId']) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }
  if (payload.slug) data.slug = await uniqueCategorySlug(category.organizationId, payload.slug);
  if (payload.parentId !== undefined) {
    if (payload.parentId) {
      const parent = await prisma.questionCategory.findUnique({ where: { id: payload.parentId } });
      if (!parent || parent.organizationId !== category.organizationId) throw ApiError.badRequest('Unknown parent category');
      data.level = parent.level + 1;
    } else {
      data.level = 0;
    }
  }
  return prisma.questionCategory.update({ where: { id: categoryId }, data });
}

async function deleteCategory(categoryId, actor) {
  const category = await prisma.questionCategory.findUnique({
    where: { id: categoryId },
    include: { _count: { select: { children: true, banks: true } } },
  });
  if (!category) throw ApiError.notFound('Category not found');
  if (category._count.children > 0) throw ApiError.conflict('Move or delete the sub-categories first');
  if (category._count.banks > 0) throw ApiError.conflict('Move the banks in this category first');

  await prisma.questionCategory.delete({ where: { id: categoryId } });
  return { deleted: true, categoryId };
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'type', 'prompt', 'marks', 'difficulty', 'topicTags', 'explanation',
  'optionA', 'optionB', 'optionC', 'optionD', 'optionE', 'correctOptions',
];

/**
 * Parse an uploaded CSV/JSON/XLSX into question drafts.
 * Returns `{ rows, errors }` without touching the database so the UI can show a
 * preview table before committing.
 */
async function parseImportFile({ filePath, originalName, bankId, actor, dryRun = true }) {
  const extension = path.extname(originalName ?? filePath ?? '').toLowerCase();
  let rawRows = [];

  if (extension === '.json') {
    rawRows = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    if (!Array.isArray(rawRows)) throw ApiError.badRequest('A JSON import must be an array of questions');
  } else if (extension === '.xlsx' || extension === '.xls') {
    rawRows = await readWorkbook(filePath);
  } else if (extension === '.csv' || extension === '.txt') {
    rawRows = parseCsv(await fs.promises.readFile(filePath, 'utf8'));
  } else {
    throw ApiError.badRequest(`Unsupported import format "${extension || 'unknown'}" - use CSV, XLSX or JSON`);
  }

  const rows = [];
  const errors = [];
  rawRows.forEach((row, index) => {
    const line = index + 1;
    try {
      const draft = normaliseImportRow(row);
      const validation = validateContent({ type: draft.type, content: draft.content, marks: draft.marks });
      if (!validation.valid) {
        errors.push({ line, prompt: draft.prompt, problems: validation.problems });
        return;
      }
      rows.push({ line, draft, warnings: validation.warnings });
    } catch (error) {
      errors.push({ line, problems: [error.message] });
    }
  });

  if (dryRun) return { total: rawRows.length, importable: rows.length, rows: rows.slice(0, 200), errors: errors.slice(0, 200) };

  const created = [];
  for (const entry of rows) {
    try {
      const question = await createQuestion({ ...entry.draft, bankId, skipValidation: true }, actor);
      created.push({ line: entry.line, questionId: question.id });
    } catch (error) {
      errors.push({ line: entry.line, problems: [error.message] });
    }
  }
  if (created.length && bankId) await recountBank(bankId);

  return { total: rawRows.length, created: created.length, skipped: errors.length, questionIds: created.map((row) => row.questionId), errors: errors.slice(0, 200) };
}

/** Map one spreadsheet row onto the question + content contract. */
function normaliseImportRow(row) {
  const get = (...keys) => {
    for (const key of keys) {
      const match = Object.keys(row).find((column) => column.toLowerCase().replace(/[\s_]/g, '') === key.toLowerCase());
      if (match && row[match] !== undefined && row[match] !== null && String(row[match]).trim() !== '') return String(row[match]).trim();
    }
    return null;
  };

  const type = normaliseImportType(get('type', 'questionType') ?? 'MULTIPLE_CHOICE');
  const prompt = get('prompt', 'question', 'text');
  if (!prompt) throw new Error('the prompt column is empty');

  const content = defaultContent(type) ?? {};
  const options = ['optionA', 'optionB', 'optionC', 'optionD', 'optionE']
    .map((column, index) => {
      const text = get(column, `option${String.fromCharCode(65 + index)}`);
      return text ? { id: `opt-${index + 1}`, text } : null;
    })
    .filter(Boolean);

  if (options.length) {
    const correctRaw = get('correctOptions', 'correct', 'answer') ?? '';
    const letters = correctRaw.toUpperCase().split(/[,/\s]+/).filter(Boolean);
    const correctIndexes = letters
      .map((letter) => letter.charCodeAt(0) - 65)
      .filter((index) => index >= 0 && index < options.length);

    options.forEach((option, index) => {
      option.correct = correctIndexes.includes(index);
    });
    content.options = options;
    if (type === 'MULTIPLE_CHOICE') content.correctOptionId = options.find((option) => option.correct)?.id ?? null;
    if (type === 'MULTIPLE_ANSWER') content.correctOptionIds = options.filter((option) => option.correct).map((option) => option.id);
    if (type === 'TRUE_FALSE') content.correctOptionId = options.find((option) => option.correct)?.id ?? options[0]?.id ?? null;
  }

  if (type === 'SHORT_ANSWER') {
    const accepted = get('acceptedAnswers', 'answer', 'answers');
    content.acceptedAnswers = (accepted ?? '').split(/[;,|]/).map((value) => value.trim()).filter(Boolean);
    content.matchMode = get('matchMode') ?? 'CASE_INSENSITIVE';
  }
  if (type === 'FILL_BLANK') {
    const answers = (get('acceptedAnswers', 'answers') ?? '').split(/[;,|]/).map((value) => value.trim()).filter(Boolean);
    content.blanks = answers.map((value, index) => ({ id: `blank-${index + 1}`, text: `Blank ${index + 1}`, answers: [value] }));
  }
  if (type === 'ORDERING') {
    const items = (get('items', 'ordering') ?? '').split(/[;,|]/).map((value) => value.trim()).filter(Boolean);
    content.items = items.map((text, index) => ({ id: `item-${index + 1}`, text, correctPosition: index }));
  }
  if (type === 'MATCHING') {
    const pairs = (get('pairs') ?? '').split(';').filter(Boolean).map((pair, index) => {
      const [left, right] = pair.split(/[=>]+/);
      return { id: `pair-${index + 1}`, left: (left ?? '').trim(), right: (right ?? '').trim() };
    });
    content.pairs = pairs;
  }

  return {
    type,
    prompt,
    marks: Number(get('marks', 'points') ?? 1),
    difficulty: (get('difficulty') ?? 'MEDIUM').toUpperCase(),
    topicTags: (get('topicTags', 'tags', 'topic') ?? '').split(/[,;]/).map((tag) => tag.trim()).filter(Boolean),
    explanation: get('explanation', 'rationale'),
    content,
    status: (get('status') ?? 'DRAFT').toUpperCase(),
  };
}

function normaliseImportType(value) {
  const upper = String(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (QUESTION_TYPE_VALUES.includes(upper)) return upper;
  const aliases = {
    MCQ: 'MULTIPLE_CHOICE',
    CHOICE: 'MULTIPLE_CHOICE',
    SINGLE: 'MULTIPLE_CHOICE',
    MCMA: 'MULTIPLE_ANSWER',
    MULTI: 'MULTIPLE_ANSWER',
    TF: 'TRUE_FALSE',
    TRUEFALSE: 'TRUE_FALSE',
    SA: 'SHORT_ANSWER',
    LA: 'LONG_ANSWER',
    ESSAY: 'LONG_ANSWER',
    FIB: 'FILL_BLANK',
    BLANK: 'FILL_BLANK',
    CODE: 'CODING',
    RATING: 'RATING_SCALE',
    LIKERT: 'LIKERT_SCALE',
  };
  const alias = aliases[upper];
  if (alias) return alias;
  throw new Error(`unknown question type "${value}"`);
}

/** Minimal RFC-4180-ish CSV reader (quoted fields, embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [headers, ...body] = rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ''));
  if (!headers) return [];
  return body.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index] ?? ''])));
}

/** Serialise a CSV row for export/import round-trips. */
function toCsv(rows, headers = CSV_HEADERS) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

async function readWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers = (sheet.getRow(1).values ?? []).slice(1).map((value) => String(value ?? '').trim());
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      const value = row.getCell(index + 1).value;
      record[header] = value && typeof value === 'object' && 'result' in value ? value.result : value;
    });
    if (Object.values(record).some((value) => value !== null && value !== undefined && String(value).trim() !== '')) {
      rows.push(record);
    }
  });
  return rows;
}

/** Export a bank (or a filtered set) as CSV/JSON/XLSX ready for re-import. */
async function exportQuestions({ bankId, organizationId, format = 'csv', type, difficulty }, actor) {
  const where = { organizationId: organizationId ?? actor.organizationId };
  if (bankId) where.bankId = bankId;
  if (type) where.type = type;
  if (difficulty) where.difficulty = difficulty;

  const questions = await prisma.question.findMany({
    where,
    include: { bank: { select: { name: true } } },
    orderBy: [{ bankId: 'asc' }, { createdAt: 'asc' }],
    take: 5000,
  });

  const records = questions.map((question) => {
    const options = Array.isArray(question.content?.options) ? question.content.options : [];
    const correct = options
      .map((option, index) => (option.correct || question.content?.correctOptionId === option.id ? String.fromCharCode(65 + index) : null))
      .filter(Boolean);
    return {
      type: question.type,
      prompt: question.prompt,
      marks: Number(question.marks),
      difficulty: question.difficulty,
      topicTags: question.topicTags.join(';'),
      explanation: question.explanation ?? '',
      optionA: options[0]?.text ?? '',
      optionB: options[1]?.text ?? '',
      optionC: options[2]?.text ?? '',
      optionD: options[3]?.text ?? '',
      optionE: options[4]?.text ?? '',
      correctOptions: correct.join(','),
      bank: question.bank?.name ?? '',
      status: question.status,
    };
  });

  if (format === 'json') return { format: 'json', filename: `questions-${Date.now()}.json`, data: records };
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Questions');
    sheet.columns = Object.keys(records[0] ?? { type: '', prompt: '' }).map((key) => ({ header: key, key, width: Math.min(60, Math.max(12, key.length + 4)) }));
    records.forEach((record) => sheet.addRow(record));
    const directory = path.join(env.uploadRoot, 'exports');
    await fs.promises.mkdir(directory, { recursive: true });
    const filename = `questions-${Date.now()}.xlsx`;
    await workbook.xlsx.writeFile(path.join(directory, filename));
    return { format: 'xlsx', filename, url: `/exports/${filename}`, count: records.length };
  }

  return {
    format: 'csv',
    filename: `questions-${Date.now()}.csv`,
    csv: toCsv(records, [...CSV_HEADERS, 'bank', 'status']),
    count: records.length,
  };
}

/** Blank template so instructors start from the expected column names. */
function importTemplate() {
  return toCsv([
    {
      type: 'MULTIPLE_CHOICE',
      prompt: 'Which protocol secures HTTP traffic?',
      marks: 1,
      difficulty: 'EASY',
      topicTags: 'networking;security',
      explanation: 'TLS encrypts the transport layer.',
      optionA: 'FTP', optionB: 'HTTPS', optionC: 'SMTP', optionD: 'SNMP', optionE: '',
      correctOptions: 'B',
    },
    {
      type: 'SHORT_ANSWER',
      prompt: 'Name the sorting algorithm with average O(n log n) complexity that uses a pivot.',
      marks: 2,
      difficulty: 'MEDIUM',
      topicTags: 'algorithms',
      explanation: 'Quickselect/Quicksort both partition around a pivot.',
      optionA: '', optionB: '', optionC: '', optionD: '', optionE: '',
      correctOptions: 'quicksort;quicksort average',
    },
  ], [...CSV_HEADERS, 'acceptedAnswers']);
}

/** Duplicate detection for the bank quality panel. */
async function findDuplicates(bankId, { threshold = 0.85 } = {}) {
  const questions = await prisma.question.findMany({
    where: { bankId },
    select: { id: true, prompt: true, promptPlain: true, type: true },
    take: 2000,
  });

  const buckets = new Map();
  for (const question of questions) {
    const key = `${question.type}:${tokenise(question.promptPlain ?? question.prompt).slice(0, 60)}`;
    const list = buckets.get(key) ?? [];
    list.push(question);
    buckets.set(key, list);
  }

  const groups = [...buckets.values()].filter((group) => group.length > 1);
  if (threshold < 1) {
    // Fuzzy pass: same type + high word overlap for near-miss phrasings. It is
    // quadratic, so it is capped - the exact pass above already covers copies.
    const seen = new Set(groups.flat().map((question) => question.id));
    const byType = new Map();
    for (const question of questions.slice(0, 600)) {
      if (seen.has(question.id)) continue;
      const list = byType.get(question.type) ?? [];
      list.push(question);
      byType.set(question.type, list);
    }
    for (const list of byType.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (overlap(tokenise(list[i].prompt), tokenise(list[j].prompt)) >= threshold) {
            groups.push([list[i], list[j]]);
          }
        }
      }
    }
  }

  return groups.map((group) => ({
    count: group.length,
    questions: group.map((question) => ({ id: question.id, prompt: question.prompt })),
  }));
}

function tokenise(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2);
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((word) => setB.has(word)).length;
  return shared / Math.max(1, Math.max(new Set(a).size, setB.size));
}

module.exports = {
  CSV_HEADERS,
  bankInsights,
  createBank,
  createCategory,
  deleteBank,
  deleteCategory,
  exportQuestions,
  findDuplicates,
  getBank,
  importTemplate,
  listAccessibleBanks,
  listBanks,
  listCategories,
  normaliseImportRow,
  parseCsv,
  parseImportFile,
  recountBank,
  revokeShare,
  shareBank,
  toCsv,
  updateBank,
  updateCategory,
};
