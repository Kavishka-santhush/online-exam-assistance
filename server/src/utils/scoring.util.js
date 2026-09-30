/**
 * Auto-grading engine.
 *
 * Pure functions only - no database access - so the same code path is reused
 * by the submit flow (`attempt.service`), the re-grade tool (`grading.service`),
 * the seeder and unit tests.
 *
 * `content` follows the contract documented in `src/constants/questionTypes.js`.
 * `response` is the candidate's JSONB answer.
 */

const { MANUALLY_GRADED_TYPES } = require('../constants/questionTypes');

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const normaliseText = (value, caseSensitive) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return caseSensitive ? text : text.toLowerCase();
};

const levenshtein = (a, b) => {
  if (a === b) return 0;
  const source = a.length;
  const target = b.length;
  if (!source) return target;
  if (!target) return source;
  let previous = Array.from({ length: target + 1 }, (_, index) => index);
  for (let i = 1; i <= source; i += 1) {
    const current = [i];
    for (let j = 1; j <= target; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[target];
};

const fuzzyEquals = (a, b, threshold = 0.8) => {
  if (!a.length || !b.length) return false;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length) >= threshold;
};

/**
 * Score a single answer.
 *
 * @param {object} params
 * @param {string} params.type        QuestionType enum value
 * @param {object} params.content     Question.content (author-side answer key)
 * @param {object} params.response    Answer.response (candidate-side answer)
 * @param {number} params.maxMarks    marks allocated to this question
 * @param {number} [params.negativePercent] percentage of maxMarks deducted for a wrong answer
 * @returns {{ ratio: number, score: number, awarded: number, deducted: number, isCorrect: boolean, isPartial: boolean, needsManualGrading: boolean, detail: object }}
 */
function gradeAnswer({ type, content = {}, response = {}, maxMarks = 1, negativePercent = 0 }) {
  const marks = Number(maxMarks) || 0;
  const result = {
    ratio: 0,
    score: 0,
    awarded: 0,
    deducted: 0,
    isCorrect: false,
    isPartial: false,
    needsManualGrading: MANUALLY_GRADED_TYPES.includes(type),
    detail: {},
  };

  if (result.needsManualGrading) {
    result.detail = { reason: `${type} answers are routed to the manual grading queue` };
    return result;
  }

  if (isEmptyResponse(type, response)) {
    result.detail = { reason: 'no answer provided' };
    result.deducted = 0;
    return result;
  }

  const graded = GRADERS[type]?.(content, response, marks) ?? { ratio: 0, detail: { reason: `no grader for type ${type}` } };
  result.ratio = clamp(Number(graded.ratio) || 0, 0, 1);
  result.isCorrect = result.ratio >= 0.999;
  result.isPartial = result.ratio > 0 && !result.isCorrect;
  result.detail = graded.detail ?? {};

  result.awarded = round(result.ratio * marks, 2);
  const shouldDeduct = result.ratio === 0 && Number(negativePercent) > 0;
  result.deducted = shouldDeduct ? round((Number(negativePercent) / 100) * marks, 2) : 0;
  result.score = round(result.awarded - result.deducted, 2);
  return result;
}

const GRADERS = {
  MULTIPLE_CHOICE(content, response) {
    const selected = response.optionId ?? response.value ?? (Array.isArray(response.optionIds) ? response.optionIds[0] : undefined);
    const correct = content.correctOptionId ?? content.options?.find?.((option) => option.correct)?.id;
    return { ratio: selected != null && selected === correct ? 1 : 0, detail: { correct, selected } };
  },

  MULTIPLE_ANSWER(content, response) {
    const correct = new Set(content.correctOptionIds ?? content.options?.filter?.((option) => option.correct).map((option) => option.id) ?? []);
    const selected = new Set(response.optionIds ?? response.selectedOptions ?? []);
    const options = content.options ?? [];
    const rule = content.scoringRule ?? (content.partialCredit === false ? 'ALL_OR_NOTHING' : 'PROPORTIONAL');

    let hits = 0;
    let misses = 0;
    for (const id of selected) {
      if (correct.has(id)) hits += 1;
      else misses += 1;
    }

    if (rule === 'ALL_OR_NOTHING') {
      return { ratio: hits === correct.size && misses === 0 ? 1 : 0, detail: { hits, misses, needed: correct.size } };
    }

    if (rule === 'NEGATIVE_PARTIAL') {
      const ratio = correct.size ? clamp((hits - misses) / correct.size) : 0;
      return { ratio, detail: { hits, misses, total: correct.size } };
    }

    // PROPORTIONAL: credit for each correct selection, penalty for extra ones.
    const extraRatio = options.length ? (options.length - correct.size) / options.length : 1;
    const positive = correct.size ? hits / correct.size : 0;
    const negative = extraRatio > 0 ? (misses / extraRatio) * positive : 0;
    return {
      ratio: clamp(positive - negative),
      detail: { hits, misses, total: correct.size, rule: 'PROPORTIONAL' },
    };
  },

  TRUE_FALSE(content, response) {
    const selected = typeof response.value === 'boolean' ? response.value : String(response.value ?? response.optionId) === 'true';
    const correct = Boolean(content.correct);
    return { ratio: selected === correct ? 1 : 0, detail: { correct, selected } };
  },

  SHORT_ANSWER(content, response) {
    const text = response.text ?? response.value ?? '';
    const caseSensitive = Boolean(content.caseSensitive);
    const accepted = (content.answers ?? []).filter((entry) => String(entry ?? '').length);
    const mode = content.matchMode ?? (caseSensitive ? 'EXACT' : 'CASE_INSENSITIVE');
    const candidate = normaliseText(text, caseSensitive);

    if (mode === 'REGEX') {
      try {
        const regex = new RegExp(content.regex ?? accepted[0] ?? '', caseSensitive ? '' : 'i');
        return { ratio: regex.test(String(text)) ? 1 : 0, detail: { mode } };
      } catch (error) {
        return { ratio: 0, detail: { mode, error: `invalid regex: ${error.message}` } };
      }
    }

    if (mode === 'KEYWORD') {
      const keywords = (content.keywords ?? accepted).map((keyword) => normaliseText(keyword, false)).filter(Boolean);
      const haystack = ` ${candidate.toLowerCase()} `;
      const matched = keywords.filter((keyword) => haystack.includes(` ${keyword} `) || haystack.includes(keyword));
      const required = content.minMatchPercent ? Math.ceil((keywords.length * Number(content.minMatchPercent)) / 100) : keywords.length;
      return {
        ratio: keywords.length && matched.length >= required ? clamp(matched.length / keywords.length) : matched.length / Math.max(required, 1),
        detail: { mode, matched: matched.length, keywords: keywords.length, required },
      };
    }

    if (mode === 'FUZZY') {
      const hit = accepted.some((entry) => fuzzyEquals(candidate, normaliseText(entry, caseSensitive)));
      return { ratio: hit ? 1 : 0, detail: { mode } };
    }

    const hit = accepted.some((entry) => normaliseText(entry, caseSensitive) === candidate);
    return { ratio: hit ? 1 : 0, detail: { mode } };
  },

  FILL_BLANK(content, response) {
    const blanks = content.blanks ?? [];
    const answers = response.blanks ?? [];
    const caseSensitive = Boolean(content.caseSensitive);
    const mode = content.matchMode ?? 'CASE_INSENSITIVE';
    if (!blanks.length) return { ratio: 0, detail: { reason: 'no blanks configured' } };

    let hits = 0;
    const perBlank = blanks.map((blank) => {
      const given = answers.find((entry) => Number(entry.index) === Number(blank.index));
      const candidates = (blank.answers ?? []).filter(Boolean);
      const text = normaliseText(given?.text ?? '', blank.caseSensitive ?? caseSensitive);
      const matched = candidates.some((entry) => {
        const expected = normaliseText(entry, blank.caseSensitive ?? caseSensitive);
        if (mode === 'FUZZY') return fuzzyEquals(text, expected);
        return text === expected;
      });
      if (matched) hits += 1;
      return { index: blank.index, matched: text, correct: matched };
    });

    return { ratio: hits / blanks.length, detail: { hits, total: blanks.length, perBlank } };
  },

  MATCHING(content, response) {
    const expected = content.correctPairs ?? [];
    const given = response.pairs ?? [];
    if (!expected.length) return { ratio: 0, detail: { reason: 'no correct pairs configured' } };
    const givenMap = new Map(given.map((pair) => [String(pair.leftId), String(pair.rightId)]));
    let hits = 0;
    for (const pair of expected) {
      if (givenMap.get(String(pair.leftId)) === String(pair.rightId)) hits += 1;
    }
    const distractors = given.length - hits;
    const ratio = content.partialCredit === false
      ? hits === expected.length && distractors === 0 ? 1 : 0
      : clamp(hits / expected.length - (distractors / expected.length) * 0.25);
    return { ratio, detail: { hits, total: expected.length } };
  },

  ORDERING(content, response) {
    const expected = (content.correctOrder ?? []).map(String);
    const given = (response.order ?? []).map(String);
    if (!expected.length) return { ratio: 0, detail: { reason: 'no correct order configured' } };

    const positionHits = given.filter((item, index) => item === expected[index]).length;
    const rule = content.scoringRule ?? (content.partialCredit === false ? 'ALL_OR_NOTHING' : 'POSITION');

    if (rule === 'ALL_OR_NOTHING') {
      return { ratio: positionHits === expected.length ? 1 : 0, detail: { rule } };
    }

    if (rule === 'KENDALL_TAU') {
      const rank = new Map(expected.map((item, index) => [item, index]));
      const values = given.map((item) => rank.get(item) ?? expected.length);
      let inversions = 0;
      for (let i = 0; i < values.length; i += 1) {
        for (let j = i + 1; j < values.length; j += 1) if (values[i] > values[j]) inversions += 1;
      }
      const maxInversions = (expected.length * (expected.length - 1)) / 2 || 1;
      return { ratio: clamp(1 - inversions / maxInversions), detail: { rule, inversions } };
    }

    return { ratio: positionHits / expected.length, detail: { rule, hits: positionHits, total: expected.length } };
  },

  DROPDOWN(content, response) {
    const dropdowns = content.dropdowns ?? [];
    const answers = response.answers ?? [];
    if (!dropdowns.length) return { ratio: 0, detail: { reason: 'no dropdowns configured' } };
    let hits = 0;
    for (const dropdown of dropdowns) {
      const given = answers.find((entry) => Number(entry.index) === Number(dropdown.index));
      const correct = normaliseText(dropdown.correctAnswer, false) === normaliseText(given?.value ?? '', false);
      if (correct) hits += 1;
    }
    return { ratio: hits / dropdowns.length, detail: { hits, total: dropdowns.length } };
  },

  HOTSPOT(content, response) {
    const zones = content.zones ?? [];
    const clicks = response.clicks ?? [];
    const correctZones = zones.filter((zone) => zone.correct);
    const required = content.requiredHits ?? (correctZones.length || 1);
    if (!zones.length) return { ratio: 0, detail: { reason: 'no zones configured' } };

    const hitZoneIds = new Set();
    let wrongHits = 0;
    for (const click of clicks) {
      const zone = zones.find((entry) => zoneContains(entry, click, response));
      if (!zone) continue;
      if (zone.correct) hitZoneIds.add(String(zone.id));
      else if (content.allowExtraClicks === false) wrongHits += 1;
    }

    const ratio = clamp(hitZoneIds.size / Math.max(1, Math.min(required, correctZones.length || required)))
      - (content.allowExtraClicks === false ? wrongHits * 0.1 : 0);
    return { ratio: clamp(ratio), detail: { hitZones: [...hitZoneIds], required, wrongHits } };
  },

  CODING(content, response) {
    const testCases = content.testCases ?? [];
    const results = response.runResults ?? [];
    if (!testCases.length) return { ratio: 0, detail: { reason: 'no test cases configured' } };
    if (!results.length) return { ratio: 0, detail: { reason: 'code was never executed' } };

    const passed = results.filter((entry) => entry.passed).length;
    const hiddenCount = Number(content.hiddenTestCount ?? 0);
    const denominator = testCases.length + hiddenCount;
    const rule = content.scoringRule ?? 'PASSED_TEST_PERCENT';
    const ratio = rule === 'ALL_TESTS' ? (passed === denominator ? 1 : 0) : passed / Math.max(1, denominator);
    return { ratio: clamp(ratio), detail: { passed, total: denominator, rule } };
  },

  MATH_FORMULA(content, response) {
    const expectedList = Array.isArray(content.correctLatex) ? content.correctLatex : [content.correctLatex];
    const given = normaliseLatex(response.latex ?? response.text ?? '');
    const mode = content.comparisonMode ?? 'LATEX_STRING';

    const matched = expectedList.some((entry) => {
      const expected = normaliseLatex(entry);
      if (given === expected) return true;
      if (mode === 'NUMERIC') {
        const left = evaluateSimple(given);
        const right = evaluateSimple(expected);
        if (left === null || right === null) return false;
        const tolerance = Number(content.tolerance ?? 0.001);
        return Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * tolerance);
      }
      return false;
    });

    return { ratio: matched ? 1 : 0, detail: { mode, expected: expectedList, given } };
  },

  LIKERT_SCALE() {
    return { ratio: 0, detail: { reason: 'survey item - not scored' } };
  },

  RATING_SCALE(content, response) {
    if (content.correctValue === undefined || content.correctValue === null) {
      return { ratio: 0, detail: { reason: 'survey item - not scored' } };
    }
    return { ratio: Number(response.value) === Number(content.correctValue) ? 1 : 0, detail: {} };
  },

  MATRIX(content, response) {
    const cells = content.cells ?? [];
    if (!cells.length) return { ratio: 0, detail: { reason: 'unscored matrix - survey mode' } };
    const answers = response.answers ?? {};
    let hits = 0;
    for (const cell of cells) {
      if (cell.correct && answers[String(cell.rowId)] === String(cell.columnId)) hits += 1;
    }
    const required = cells.filter((cell) => cell.correct).length || 1;
    return { ratio: clamp(hits / required), detail: { hits, required } };
  },
};

/** True when the candidate left the item blank for the given type. */
function isEmptyResponse(type, response = {}) {
  switch (type) {
    case 'MULTIPLE_CHOICE':
      return !(response.optionId ?? response.value);
    case 'MULTIPLE_ANSWER':
      return !(response.optionIds ?? response.selectedOptions ?? []).length;
    case 'TRUE_FALSE':
      return response.value === undefined || response.value === null;
    case 'SHORT_ANSWER':
      return !String(response.text ?? response.value ?? '').trim();
    case 'LONG_ANSWER':
      return !String(response.text ?? response.html ?? '').trim();
    case 'FILL_BLANK':
      return !(response.blanks ?? []).some((entry) => String(entry.text ?? '').trim());
    case 'MATCHING':
      return !(response.pairs ?? []).length;
    case 'ORDERING':
      return !(response.order ?? []).length;
    case 'DROPDOWN':
      return !(response.answers ?? []).some((entry) => entry.value);
    case 'HOTSPOT':
      return !(response.clicks ?? []).length;
    case 'CODING':
      return !String(response.code ?? '').trim();
    case 'FILE_UPLOAD':
      return !(response.fileIds ?? []).length;
    case 'AUDIO_RECORDING':
    case 'VIDEO_RECORDING':
    case 'DRAWING':
      return !response.fileId;
    case 'MATH_FORMULA':
      return !String(response.latex ?? '').trim();
    case 'LIKERT_SCALE':
    case 'RATING_SCALE':
      return response.value === undefined || response.value === null;
    case 'MATRIX':
      return !Object.keys(response.answers ?? {}).length;
    default:
      return !Object.keys(response).length;
  }
}

/** Does a click land inside a hotspot zone (rect or circle, normalised 0-1). */
function zoneContains(zone, click, response) {
  if (click.zoneId && String(click.zoneId) === String(zone.id)) return true;
  const x = Number(click.x);
  const y = Number(click.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  if (zone.shape === 'circle') {
    const radius = Number(zone.r) || 0.05;
    const dx = (x - Number(zone.x)) / radius;
    const dy = (y - Number(zone.y)) / radius;
    return dx * dx + dy * dy <= 1;
  }

  return x >= zone.x && x <= zone.x + (zone.w ?? 0) && y >= zone.y && y <= zone.y + (zone.h ?? 0);
}

function normaliseLatex(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\div|\//g, '/')
    .replace(/\\pi/g, 'pi')
    .toLowerCase();
}

/** Very small arithmetic evaluator used by NUMERIC latex comparison. */
function evaluateSimple(expression) {
  if (!/^[-+*/(). 0-9^pi]*$/.test(expression)) return null;
  try {
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${expression.replace(/\^/g, '**').replace(/pi/g, 'Math.PI')});`)();
  } catch {
    return null;
  }
}

/**
 * Aggregate graded answers into an attempt score.
 *
 * @param {Array<{question: object, examQuestion?: object, grading: object, sectionId?: string}>} entries
 * @param {object} exam { totalMarks, passingPercent, gradeBoundaries, scoringConfig }
 */
function aggregateScore(entries, exam = {}) {
  let awarded = 0;
  let deducted = 0;
  let obtainable = 0;
  const sections = new Map();
  const pendingManual = [];

  for (const entry of entries) {
    const maxMarks = Number(entry.examQuestion?.marks ?? entry.question?.marks ?? 0);
    const negativePercent = Number(entry.examQuestion?.negativePercent ?? entry.question?.negativePercent ?? exam.scoringConfig?.negativeMarkingPercent ?? 0);
    const grading = entry.grading ?? gradeAnswer({
      type: entry.question.type,
      content: entry.question.content ?? {},
      response: entry.response ?? {},
      maxMarks,
      negativePercent,
    });

    awarded += grading.awarded;
    deducted += grading.deducted;
    obtainable += maxMarks;

    if (grading.needsManualGrading) pendingManual.push(entry);

    const key = entry.sectionId ?? 'unassigned';
    const section = sections.get(key) ?? { sectionId: entry.sectionId ?? null, awarded: 0, deducted: 0, obtainable: 0, questions: 0 };
    section.awarded += grading.awarded;
    section.deducted += grading.deducted;
    section.obtainable += maxMarks;
    section.questions += 1;
    sections.set(key, section);
  }

  const totalMarks = Number(exam.totalMarks ?? obtainable) || obtainable || 1;
  const rawScore = round(awarded, 2);
  const finalScore = round(Math.max(0, awarded - deducted), 2);
  const scorePercent = round((finalScore / totalMarks) * 100, 2);
  const passingPercent = Number(exam.passingPercent ?? 0);

  return {
    rawScore,
    negativeDeducted: round(deducted, 2),
    partialAwarded: round(entries.reduce((sum, entry) => sum + (entry.grading?.isPartial ? entry.grading.awarded : 0), 0), 2),
    finalScore,
    totalMarks,
    scorePercent,
    passed: pendingManual.length ? null : scorePercent >= passingPercent,
    pendingManualCount: pendingManual.length,
    answerSummary: {
      total: entries.length,
      correct: entries.filter((entry) => entry.grading?.isCorrect).length,
      partial: entries.filter((entry) => entry.grading?.isPartial).length,
      incorrect: entries.filter((entry) => entry.grading && !entry.grading.isCorrect && !entry.grading.isPartial && !entry.grading.needsManualGrading).length,
      skipped: entries.filter((entry) => entry.grading?.detail?.reason === 'no answer provided').length,
    },
    sections: [...sections.values()].map((section) => {
      const sectionScore = round(Math.max(0, section.awarded - section.deducted), 2);
      return {
        ...section,
        finalScore: sectionScore,
        scorePercent: round((sectionScore / (section.obtainable || 1)) * 100, 2),
      };
    }),
    gradeLetter: gradeLetter(scorePercent, exam.gradeBoundaries),
  };
}

/** A/B/C/D/F from a configurable boundary map, e.g. { A: 90, B: 80, C: 70, D: 60, F: 0 }. */
function gradeLetter(scorePercent, boundaries = { A: 90, B: 80, C: 70, D: 60, F: 0 }) {
  const percent = Number(scorePercent) || 0;
  const ordered = Object.entries(boundaries ?? {})
    .filter(([letter]) => letter !== 'F')
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [letter, threshold] of ordered) {
    if (percent >= Number(threshold)) return letter;
  }
  return ordered.length ? 'F' : null;
}

/** Rank one score against the distribution of all scores for the exam. */
function percentile(scorePercent, distribution = []) {
  const values = distribution.map(Number).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  const lower = values.filter((value) => value < scorePercent).length;
  const same = values.filter((value) => value === scorePercent).length;
  return round(((lower + 0.5 * same) / values.length) * 100, 2);
}

/**
 * One item of an IRT/logistic adaptive engine: expected score under a
 * 2-parameter model, and the information gain used to pick the next item.
 */
function irtProbability(ability, { difficulty, discrimination = 1 }) {
  const exponent = Number(discrimination) * (Number(ability) - Number(difficulty));
  return 1 / (1 + Math.exp(-exponent));
}

function itemInformation(ability, { difficulty, discrimination = 1 }) {
  const p = irtProbability(ability, { difficulty, discrimination });
  return Number(discrimination) ** 2 * p * (1 - p);
}

module.exports = {
  GRADERS,
  aggregateScore,
  evaluateSimple,
  fuzzyEquals,
  gradeAnswer,
  gradeLetter,
  isEmptyResponse,
  itemInformation,
  irtProbability,
  normaliseLatex,
  percentile,
  round,
};
