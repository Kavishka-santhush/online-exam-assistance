/**
 * Question-type catalogue — single source of truth shared by the exam builder,
 * the question bank UI and the candidate-facing `QuestionRenderer`.
 *
 * The string keys mirror the Prisma `QuestionType` enum on the server so a value
 * produced here can be persisted verbatim; the display metadata (label, icon
 * hint, whether it is auto-grable, the shape of its `answer` payload) drives the
 * generic editors without a `switch` scattered across components.
 */

export const QUESTION_TYPE = {
  MULTIPLE_CHOICE: 'MULTIPLE_CHOICE',
  MULTIPLE_ANSWER: 'MULTIPLE_ANSWER',
  TRUE_FALSE: 'TRUE_FALSE',
  SHORT_ANSWER: 'SHORT_ANSWER',
  LONG_ANSWER: 'LONG_ANSWER',
  FILL_BLANK: 'FILL_BLANK',
  MATCHING: 'MATCHING',
  ORDERING: 'ORDERING',
  DROPDOWN: 'DROPDOWN',
  HOTSPOT: 'HOTSPOT',
  CODING: 'CODING',
  NUMERIC: 'NUMERIC',
  RATING: 'RATING',
  MATRIX: 'MATRIX',
  FILE_UPLOAD: 'FILE_UPLOAD',
  DATE: 'DATE',
};

/** Types whose correctness the server can decide without a human grader. */
const AUTO_GRADABLE = new Set([
  QUESTION_TYPE.MULTIPLE_CHOICE,
  QUESTION_TYPE.MULTIPLE_ANSWER,
  QUESTION_TYPE.TRUE_FALSE,
  QUESTION_TYPE.SHORT_ANSWER,
  QUESTION_TYPE.FILL_BLANK,
  QUESTION_TYPE.MATCHING,
  QUESTION_TYPE.ORDERING,
  QUESTION_TYPE.DROPDOWN,
  QUESTION_TYPE.HOTSPOT,
  QUESTION_TYPE.NUMERIC,
  QUESTION_TYPE.RATING,
  QUESTION_TYPE.MATRIX,
]);

/** Types that always require a manual (or AI-assisted) grader. */
export const NEEDS_MANUAL_GRADING = new Set([
  QUESTION_TYPE.LONG_ANSWER,
  QUESTION_TYPE.CODING,
  QUESTION_TYPE.FILE_UPLOAD,
]);

export const QUESTION_TYPE_META = {
  [QUESTION_TYPE.MULTIPLE_CHOICE]: {
    label: 'Multiple Choice (Single)',
    group: 'Choice',
    description: 'Radio buttons, 2–6 options, one correct answer.',
    hasOptions: true,
    singleChoice: true,
  },
  [QUESTION_TYPE.MULTIPLE_ANSWER]: {
    label: 'Multiple Choice (Multiple)',
    group: 'Choice',
    description: 'Checkboxes — select all that apply, partial credit supported.',
    hasOptions: true,
    singleChoice: false,
  },
  [QUESTION_TYPE.TRUE_FALSE]: {
    label: 'True / False',
    group: 'Choice',
    description: 'Binary choice with an optional explanation.',
    hasOptions: false,
    singleChoice: true,
  },
  [QUESTION_TYPE.SHORT_ANSWER]: {
    label: 'Short Answer',
    group: 'Text',
    description: 'One-line text — exact or keyword match grading.',
    hasOptions: false,
  },
  [QUESTION_TYPE.LONG_ANSWER]: {
    label: 'Long Answer / Essay',
    group: 'Text',
    description: 'Rich-text answer graded manually or by AI, with word limits.',
    hasOptions: false,
  },
  [QUESTION_TYPE.FILL_BLANK]: {
    label: 'Fill in the Blank',
    group: 'Text',
    description: 'Sentence with blanks; exact or fuzzy match per blank.',
    hasOptions: false,
  },
  [QUESTION_TYPE.MATCHING]: {
    label: 'Matching',
    group: 'Interactive',
    description: 'Match items across two columns (drag and drop).',
    hasOptions: true,
  },
  [QUESTION_TYPE.ORDERING]: {
    label: 'Ordering / Sequencing',
    group: 'Interactive',
    description: 'Arrange items into the correct order (drag and drop).',
    hasOptions: true,
  },
  [QUESTION_TYPE.DROPDOWN]: {
    label: 'Dropdown Select',
    group: 'Interactive',
    description: 'Inline dropdown(s) embedded within a sentence.',
    hasOptions: true,
  },
  [QUESTION_TYPE.HOTSPOT]: {
    label: 'Hotspot (Image Click)',
    group: 'Interactive',
    description: 'Click the correct zone on an image.',
    hasOptions: false,
  },
  [QUESTION_TYPE.CODING]: {
    label: 'Coding Question',
    group: 'Code',
    description: 'Write code in the Monaco editor against test cases.',
    hasOptions: false,
  },
  [QUESTION_TYPE.NUMERIC]: {
    label: 'Numeric',
    group: 'Text',
    description: 'Number input with optional tolerance / units.',
    hasOptions: false,
  },
  [QUESTION_TYPE.RATING]: {
    label: 'Rating Scale',
    group: 'Survey',
    description: 'Numeric rating input (e.g. 1–5).',
    hasOptions: false,
  },
  [QUESTION_TYPE.MATRIX]: {
    label: 'Matrix / Grid',
    group: 'Survey',
    description: 'Multiple rows sharing the same scale.',
    hasOptions: true,
  },
  [QUESTION_TYPE.FILE_UPLOAD]: {
    label: 'File Upload',
    group: 'Interactive',
    description: 'Candidate uploads a file during the exam.',
    hasOptions: false,
  },
  [QUESTION_TYPE.DATE]: {
    label: 'Date',
    group: 'Text',
    description: 'Date picker answer.',
    hasOptions: false,
  },
};

export const QUESTION_GROUPS = ['Choice', 'Text', 'Interactive', 'Code', 'Survey'];

export const DIFFICULTY_LEVELS = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];

export const BLOOM_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE'];

/** Languages offered in the Monaco coding editor (spec: Python, JavaScript…). */
export const CODING_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'sql', label: 'SQL' },
];

export function isAutoGrable(type) {
  return AUTO_GRADABLE.has(type);
}

export function requiresManualGrading(type) {
  return NEEDS_MANUAL_GRADING.has(type);
}

export function metaFor(type) {
  return QUESTION_TYPE_META[type] ?? { label: type, group: 'Other', hasOptions: false };
}

/** Ordered list for builder `<select>` menus, grouped by category. */
export function questionTypeOptions() {
  return Object.entries(QUESTION_TYPE_META).map(([value, meta]) => ({
    value,
    label: meta.label,
    group: meta.group,
  }));
}

export default QUESTION_TYPE;
