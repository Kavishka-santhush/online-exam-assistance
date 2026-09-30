/**
 * The single source of truth for the 19 question types.
 *
 * For every type this file records:
 *   content  - what the *author* stores in `Question.content` (JSONB)
 *   response - what the *candidate* stores in `Answer.response` (JSONB)
 *   grading  - how the auto-grader derives the score
 *
 * The client `QuestionRenderer`, `server/src/utils/scoring.util.js` and the
 * AI prompt builders all read from here, so a type only has to be described
 * once. Enum values must stay in sync with `QuestionType` in schema.prisma.
 */

const QUESTION_TYPES = {
  MULTIPLE_CHOICE: {
    label: 'Multiple choice (single answer)',
    category: 'selection',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'selectedOptions',
    contentSchema: {
      options: '[{ id, text, imageUrl? }] (2-6)',
      correctOptionId: 'string',
      shuffleOptions: 'boolean?',
    },
    responseSchema: { optionId: 'string' },
    grading: 'exact option match',
    defaults: { marks: 1, estimatedTimeSec: 45 },
  },

  MULTIPLE_ANSWER: {
    label: 'Multiple choice (multiple answer)',
    category: 'selection',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'selectedOptions',
    contentSchema: {
      options: '[{ id, text, imageUrl? }]',
      correctOptionIds: 'string[]',
      partialCredit: 'boolean',
      scoringRule: "'ALL_OR_NOTHING' | 'PROPORTIONAL' | 'NEGATIVE_PARTIAL'",
    },
    responseSchema: { optionIds: 'string[]' },
    grading: 'proportional credit = (correctSelected - incorrectSelected)/totalCorrect, clamped to 0',
    defaults: { marks: 2, estimatedTimeSec: 90, partialMarking: true },
  },

  TRUE_FALSE: {
    label: 'True / false',
    category: 'selection',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'selectedOptions',
    contentSchema: {
      correct: 'boolean',
      trueLabel: 'string?',
      falseLabel: 'string?',
      options: '[{ id: "true"|"false", text }]? ',
    },
    responseSchema: { value: 'boolean' },
    grading: 'strict boolean equality',
    defaults: { marks: 1, estimatedTimeSec: 20 },
  },

  SHORT_ANSWER: {
    label: 'Short answer',
    category: 'text',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'textAnswer',
    contentSchema: {
      answers: 'string[] (accepted variants)',
      matchMode: "'EXACT' | 'CASE_INSENSITIVE' | 'KEYWORD' | 'REGEX' | 'FUZZY'",
      caseSensitive: 'boolean',
      acceptAlternatives: 'boolean',
      regex: 'string?',
      keywords: 'string[]',
      minMatchPercent: 'number (KEYWORD mode)',
    },
    responseSchema: { text: 'string' },
    grading: 'match against accepted answers; KEYWORD scores matched/total keywords',
    defaults: { marks: 2, estimatedTimeSec: 40 },
  },

  LONG_ANSWER: {
    label: 'Long answer / essay',
    category: 'text',
    autoGradable: false,
    needsManualGrading: true,
    answerField: 'textAnswer',
    contentSchema: {
      expectedAnswer: 'string (instructor only)',
      minWords: 'number?',
      maxWords: 'number?',
      richText: 'boolean',
      rubricCriteria: '[{ id, name, maxMarks, levels? }]',
      attachmentsAllowed: 'boolean?',
    },
    responseSchema: { text: 'string', html: 'string?', attachmentIds: 'string[]' },
    grading: 'manual or AI-assisted rubric scoring',
    defaults: { marks: 10, estimatedTimeSec: 600, partialMarking: true },
  },

  FILL_BLANK: {
    label: 'Fill in the blank',
    category: 'text',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'blankAnswers',
    contentSchema: {
      template: 'string with {{1}}, {{2}} placeholders (or ___ markers)',
      blanks: '[{ index, answers: string[], caseSensitive?, hint? }]',
      matchMode: "'EXACT' | 'CASE_INSENSITIVE' | 'FUZZY'",
      partialCredit: 'boolean',
    },
    responseSchema: { blanks: '[{ index, text }]' },
    grading: 'per-blank match; score = matched/total (or all-or-nothing)',
    defaults: { marks: 2, estimatedTimeSec: 60, partialMarking: true },
  },

  MATCHING: {
    label: 'Matching pairs',
    category: 'dragdrop',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'matchedPairs',
    contentSchema: {
      leftItems: '[{ id, text }]',
      rightItems: '[{ id, text }]',
      correctPairs: '[{ leftId, rightId }]',
      shuffleRight: 'boolean',
      partialCredit: 'boolean',
    },
    responseSchema: { pairs: '[{ leftId, rightId }]' },
    grading: 'correctPairs matched / total pairs',
    defaults: { marks: 4, estimatedTimeSec: 120, partialMarking: true },
  },

  ORDERING: {
    label: 'Ordering / sequencing',
    category: 'dragdrop',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'orderedItems',
    contentSchema: {
      items: '[{ id, text }]',
      correctOrder: 'string[] (item ids, first to last)',
      partialCredit: "boolean - 'POSITION' counts exact slots, 'KENDALL_TAU' counts swaps",
    },
    responseSchema: { order: 'string[]' },
    grading: 'position hits / total, or 1 - swaps/maxSwaps for partial credit',
    defaults: { marks: 3, estimatedTimeSec: 90, partialMarking: true },
  },

  DROPDOWN: {
    label: 'Dropdown select (cloze)',
    category: 'selection',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'blankAnswers',
    contentSchema: {
      template: 'string with {{1}} placeholders',
      dropdowns: '[{ index, options: string[], correctAnswer: string }]',
      partialCredit: 'boolean',
    },
    responseSchema: { answers: '[{ index, value }]' },
    grading: 'correct dropdowns / total dropdowns',
    defaults: { marks: 2, estimatedTimeSec: 60, partialMarking: true },
  },

  HOTSPOT: {
    label: 'Hotspot (image click)',
    category: 'media',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'hotspotClicks',
    contentSchema: {
      imageUrl: 'string',
      imageWidth: 'number',
      imageHeight: 'number',
      zones: '[{ id, shape: "rect"|"circle", x, y, w?, h?, r?, label?, correct: boolean }]',
      requiredHits: 'number?',
      allowExtraClicks: 'boolean',
    },
    responseSchema: { clicks: '[{ x, y, zoneId? }] (normalised 0-1 coordinates)' },
    grading: 'correct zones hit / correct zones, minus wrong-zone penalty',
    defaults: { marks: 3, estimatedTimeSec: 90 },
  },

  CODING: {
    label: 'Coding question',
    category: 'code',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'codeSource',
    contentSchema: {
      languages: "string[] - 'python'|'javascript'|'typescript'|'java'|'cpp'|'c'|'go'|'ruby'|'php'",
      defaultLanguage: 'string',
      starterCode: 'Record<language, string> | string',
      signature: 'string (function name candidates must implement)',
      testCases: '[{ id, input, expectedOutput, isSample }] (input serialized as JSON)',
      hiddenTestCount: 'number?',
      timeLimitMs: 'number',
      memoryLimitMb: 'number',
      scoringRule: "'PASSED_TEST_PERCENT' | 'ALL_TESTS'",
      allowedPackages: 'string[]?',
    },
    responseSchema: { language: 'string', code: 'string', runResults: '[{ testId, passed, output }]' },
    grading: 'sandbox run against test cases, score = passed/total (hidden tests included)',
    defaults: { marks: 10, estimatedTimeSec: 900 },
  },

  FILE_UPLOAD: {
    label: 'File upload answer',
    category: 'media',
    autoGradable: false,
    needsManualGrading: true,
    answerField: null,
    contentSchema: {
      acceptedTypes: 'string[] (mime or extensions)',
      maxFiles: 'number',
      maxFileSizeMb: 'number',
      instructions: 'string?',
    },
    responseSchema: { fileIds: 'string[]', captions: 'Record<string,string>' },
    grading: 'manual review of uploaded files',
    defaults: { marks: 10, estimatedTimeSec: 300 },
  },

  AUDIO_RECORDING: {
    label: 'Audio recording answer',
    category: 'media',
    autoGradable: false,
    needsManualGrading: true,
    answerField: null,
    contentSchema: {
      prompt: 'string?',
      maxDurationSec: 'number',
      minDurationSec: 'number?',
      allowUploadInstead: 'boolean',
      mimeType: "'audio/webm'",
    },
    responseSchema: { fileId: 'string', durationSec: 'number' },
    grading: 'manual review by the grader (transcription available via AI)',
    defaults: { marks: 5, estimatedTimeSec: 180 },
  },

  VIDEO_RECORDING: {
    label: 'Video recording answer',
    category: 'media',
    autoGradable: false,
    needsManualGrading: true,
    answerField: null,
    contentSchema: {
      prompt: 'string?',
      maxDurationSec: 'number',
      allowUploadInstead: 'boolean',
      mimeType: "'video/webm'",
    },
    responseSchema: { fileId: 'string', durationSec: 'number' },
    grading: 'manual review of the recorded clip',
    defaults: { marks: 8, estimatedTimeSec: 300 },
  },

  MATH_FORMULA: {
    label: 'Math / formula answer',
    category: 'text',
    autoGradable: true,
    needsManualGrading: false,
    answerField: 'mathLatex',
    contentSchema: {
      correctLatex: 'string | string[]',
      tolerance: 'number (relative numeric tolerance when both sides evaluate)',
      comparisonMode: "'LATEX_STRING' | 'NUMERIC' | 'SYMPY-equivalent'",
      showPalette: 'boolean',
      unitsRequired: 'boolean?',
    },
    responseSchema: { latex: 'string', display: 'boolean' },
    grading: 'normalised LaTeX comparison with optional numeric equivalence',
    defaults: { marks: 3, estimatedTimeSec: 120 },
  },

  DRAWING: {
    label: 'Drawing / diagram',
    category: 'media',
    autoGradable: false,
    needsManualGrading: true,
    answerField: null,
    contentSchema: {
      canvas: '{ width, height, background: "white"|"grid"|"graph", tools: string[] }',
      prompt: 'string?',
      referenceImageUrl: 'string?',
    },
    responseSchema: { fileId: 'string (PNG data uploaded through Multer)', dataUrl: 'string' },
    grading: 'manual review of the submitted image',
    defaults: { marks: 6, estimatedTimeSec: 420 },
  },

  LIKERT_SCALE: {
    label: 'Likert scale',
    category: 'survey',
    autoGradable: false,
    needsManualGrading: false,
    answerField: 'ratingValue',
    contentSchema: {
      statement: 'string',
      min: 'number (usually 1)',
      max: 'number (usually 5)',
      step: 'number',
      labels: '{ low: string, high: string, values?: Record<number,string> }',
      isSurvey: 'boolean (no score contributed)',
    },
    responseSchema: { value: 'number' },
    grading: 'survey item - aggregated, not scored',
    defaults: { marks: 1, estimatedTimeSec: 20 },
  },

  RATING_SCALE: {
    label: 'Rating scale',
    category: 'survey',
    autoGradable: false,
    needsManualGrading: false,
    answerField: 'ratingValue',
    contentSchema: {
      statement: 'string',
      min: 'number',
      max: 'number',
      step: 'number',
      icon: "'star'|'heart'|'number'",
      labels: '{ low, high }',
    },
    responseSchema: { value: 'number' },
    grading: 'optional exact-match grading via content.expectedValue for training quizzes',
    defaults: { marks: 1, estimatedTimeSec: 15 },
  },

  MATRIX: {
    label: 'Matrix / grid',
    category: 'survey',
    autoGradable: false,
    needsManualGrading: false,
    answerField: 'matrixResponses',
    contentSchema: {
      rows: '[{ id, label }]',
      columns: '[{ id, label, value? }]',
      cells: '[{ rowId, columnId, correct?: boolean }]? (graded matrices only)',
      requireAllRows: 'boolean',
      scaleType: "'LIKERT'|'YES_NO'|'FREQUENCY'",
    },
    responseSchema: { answers: 'Record<rowId, columnId>' },
    grading: 'correct cell matches / rows when `cells` defines keys, otherwise unscored',
    defaults: { marks: 5, estimatedTimeSec: 150 },
  },
};

const QUESTION_TYPE_VALUES = Object.keys(QUESTION_TYPES);

const CATEGORY_LABELS = {
  selection: 'Selection',
  text: 'Text',
  dragdrop: 'Drag & drop',
  media: 'Media',
  code: 'Code',
  survey: 'Survey',
};

/** Types whose answers always go through the manual grading queue. */
const MANUALLY_GRADED_TYPES = QUESTION_TYPE_VALUES.filter((key) => QUESTION_TYPES[key].needsManualGrading);

/** Types the auto-grader can score without a human. */
const AUTO_GRADED_TYPES = QUESTION_TYPE_VALUES.filter((key) => QUESTION_TYPES[key].autoGradable);

/** Survey-style types: never counted toward a pass mark unless the exam opts in. */
const SURVEY_TYPES = QUESTION_TYPE_VALUES.filter((key) => QUESTION_TYPES[key].category === 'survey');

/** Types that reference uploaded media on the answer row. */
const MEDIA_TYPES = ['FILE_UPLOAD', 'AUDIO_RECORDING', 'VIDEO_RECORDING', 'DRAWING', 'HOTSPOT'];

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];

const BLOOMS_LEVELS = ['REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE'];

const CODE_LANGUAGES = {
  python: { label: 'Python 3', extension: 'py', runner: 'python3' },
  javascript: { label: 'JavaScript (Node)', extension: 'js', runner: 'node' },
  typescript: { label: 'TypeScript', extension: 'ts', runner: 'ts-node' },
  java: { label: 'Java', extension: 'java', runner: 'javac/java' },
  cpp: { label: 'C++', extension: 'cpp', runner: 'g++' },
  c: { label: 'C', extension: 'c', runner: 'gcc' },
  go: { label: 'Go', extension: 'go', runner: 'go run' },
  ruby: { label: 'Ruby', extension: 'rb', runner: 'ruby' },
  php: { label: 'PHP', extension: 'php', runner: 'php' },
};

function describeType(type) {
  return QUESTION_TYPES[type] ?? null;
}

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(QUESTION_TYPES, type);
}

/** Default `content` payload for a brand new question of this type. */
function defaultContent(type) {
  switch (type) {
    case 'MULTIPLE_CHOICE':
      return { options: [{ id: 'a', text: '' }, { id: 'b', text: '' }], correctOptionId: null, shuffleOptions: false };
    case 'MULTIPLE_ANSWER':
      return { options: [{ id: 'a', text: '' }, { id: 'b', text: '' }], correctOptionIds: [], partialCredit: true, scoringRule: 'PROPORTIONAL' };
    case 'TRUE_FALSE':
      return { correct: true, trueLabel: 'True', falseLabel: 'False' };
    case 'SHORT_ANSWER':
      return { answers: [''], matchMode: 'CASE_INSENSITIVE', caseSensitive: false, acceptAlternatives: true };
    case 'LONG_ANSWER':
      return { expectedAnswer: '', minWords: 0, maxWords: 2000, richText: true, rubricCriteria: [] };
    case 'FILL_BLANK':
      return { template: 'The {{1}} is {{2}}.', blanks: [{ index: 1, answers: [''], caseSensitive: false }, { index: 2, answers: [''], caseSensitive: false }], matchMode: 'CASE_INSENSITIVE', partialCredit: true };
    case 'MATCHING':
      return { leftItems: [], rightItems: [], correctPairs: [], shuffleRight: true, partialCredit: true };
    case 'ORDERING':
      return { items: [], correctOrder: [], partialCredit: true, scoringRule: 'POSITION' };
    case 'DROPDOWN':
      return { template: 'Select {{1}} and {{2}}.', dropdowns: [], partialCredit: true };
    case 'HOTSPOT':
      return { imageUrl: '', imageWidth: 800, imageHeight: 600, zones: [], requiredHits: 1, allowExtraClicks: false };
    case 'CODING':
      return {
        languages: ['python', 'javascript'],
        defaultLanguage: 'python',
        starterCode: { python: 'def solution():\n    pass\n', javascript: 'function solution() {\n\n}\n' },
        signature: 'solution',
        testCases: [{ id: 't1', input: [], expectedOutput: null, isSample: true }],
        timeLimitMs: 5000,
        memoryLimitMb: 128,
        scoringRule: 'PASSED_TEST_PERCENT',
      };
    case 'FILE_UPLOAD':
      return { acceptedTypes: ['application/pdf', 'image/png'], maxFiles: 3, maxFileSizeMb: 20 };
    case 'AUDIO_RECORDING':
      return { maxDurationSec: 180, minDurationSec: 5, allowUploadInstead: true, mimeType: 'audio/webm' };
    case 'VIDEO_RECORDING':
      return { maxDurationSec: 300, allowUploadInstead: true, mimeType: 'video/webm' };
    case 'MATH_FORMULA':
      return { correctLatex: '', comparisonMode: 'LATEX_STRING', tolerance: 0.001, showPalette: true };
    case 'DRAWING':
      return { canvas: { width: 800, height: 500, background: 'white', tools: ['pen', 'line', 'rect', 'ellipse', 'text', 'eraser'] } };
    case 'LIKERT_SCALE':
      return { statement: '', min: 1, max: 5, step: 1, labels: { low: 'Strongly disagree', high: 'Strongly agree' }, isSurvey: true };
    case 'RATING_SCALE':
      return { statement: '', min: 1, max: 5, step: 1, icon: 'star', labels: { low: 'Poor', high: 'Excellent' } };
    case 'MATRIX':
      return { rows: [], columns: [{ id: 'always', label: 'Always' }, { id: 'never', label: 'Never' }], requireAllRows: true, scaleType: 'FREQUENCY' };
    default:
      return {};
  }
}

module.exports = {
  AUTO_GRADED_TYPES,
  BLOOMS_LEVELS,
  CATEGORY_LABELS,
  CODE_LANGUAGES,
  DIFFICULTIES,
  MANUALLY_GRADED_TYPES,
  MEDIA_TYPES,
  QUESTION_TYPES,
  QUESTION_TYPE_VALUES,
  SURVEY_TYPES,
  defaultContent,
  describeType,
  isKnownType,
};
