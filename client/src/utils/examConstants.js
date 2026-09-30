/**
 * Exam-domain constants shared across the builder, list/grid views and the
 * candidate portal. String values mirror the Prisma enums on the server
 * (`ExamType`, `ExamStatus`, `ResultVisibility`, `ExamAccess`) so drafts can be
 * validated and submitted without a translation layer.
 */

export const EXAM_TYPE = {
  QUIZ: 'QUIZ',
  TEST: 'TEST',
  MOCK_EXAM: 'MOCK_EXAM',
  CERTIFICATION: 'CERTIFICATION',
  PRACTICE: 'PRACTICE',
  SURVEY: 'SURVEY',
  ASSIGNMENT: 'ASSIGNMENT',
  LIVE_QUIZ: 'LIVE_QUIZ',
};

export const EXAM_TYPE_OPTIONS = [
  { value: EXAM_TYPE.QUIZ, label: 'Quiz' },
  { value: EXAM_TYPE.TEST, label: 'Test' },
  { value: EXAM_TYPE.MOCK_EXAM, label: 'Mock Exam' },
  { value: EXAM_TYPE.CERTIFICATION, label: 'Certification Exam' },
  { value: EXAM_TYPE.PRACTICE, label: 'Practice Exam' },
  { value: EXAM_TYPE.SURVEY, label: 'Survey' },
  { value: EXAM_TYPE.ASSIGNMENT, label: 'Assignment' },
  { value: EXAM_TYPE.LIVE_QUIZ, label: 'Live Quiz (Kahoot-style)' },
];

export const EXAM_STATUS = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  PUBLISHED: 'PUBLISHED',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  ARCHIVED: 'ARCHIVED',
};

export const EXAM_STATUS_META = {
  [EXAM_STATUS.DRAFT]: { label: 'Draft', tone: 'muted' },
  [EXAM_STATUS.SCHEDULED]: { label: 'Scheduled', tone: 'info' },
  [EXAM_STATUS.PUBLISHED]: { label: 'Published', tone: 'success' },
  [EXAM_STATUS.ACTIVE]: { label: 'In progress', tone: 'warning' },
  [EXAM_STATUS.CLOSED]: { label: 'Closed', tone: 'muted' },
  [EXAM_STATUS.ARCHIVED]: { label: 'Archived', tone: 'muted' },
};

/** When candidates may see their result. */
export const RESULT_VISIBILITY = {
  IMMEDIATE: 'IMMEDIATE',
  AFTER_ALL_SUBMIT: 'AFTER_ALL_SUBMIT',
  ON_DATE: 'ON_DATE',
  NEVER: 'NEVER',
  MANUAL: 'MANUAL',
};

export const RESULT_VISIBILITY_OPTIONS = [
  { value: RESULT_VISIBILITY.IMMEDIATE, label: 'Immediately after submitting' },
  { value: RESULT_VISIBILITY.AFTER_ALL_SUBMIT, label: 'After all candidates submit' },
  { value: RESULT_VISIBILITY.ON_DATE, label: 'On a specific date' },
  { value: RESULT_VISIBILITY.MANUAL, label: 'After grading is released' },
  { value: RESULT_VISIBILITY.NEVER, label: 'Never shown' },
];

/** Who may open the exam. */
export const EXAM_ACCESS = {
  PUBLIC: 'PUBLIC',
  ORG_MEMBERS: 'ORG_MEMBERS',
  SPECIFIC_CANDIDATES: 'SPECIFIC_CANDIDATES',
  ACCESS_CODE: 'ACCESS_CODE',
  INVITE_LINK: 'INVITE_LINK',
};

export const EXAM_ACCESS_OPTIONS = [
  { value: EXAM_ACCESS.PUBLIC, label: 'Public — anyone with the link' },
  { value: EXAM_ACCESS.ORG_MEMBERS, label: 'Organization members only' },
  { value: EXAM_ACCESS.SPECIFIC_CANDIDATES, label: 'Specific invited candidates' },
  { value: EXAM_ACCESS.ACCESS_CODE, label: 'Requires an access code' },
  { value: EXAM_ACCESS.INVITE_LINK, label: 'Unique invite links' },
];

/**
 * Defaults for the exam settings drawer — kept here so the builder, the server
 * `settings` JSON and the candidate runtime agree on the same shape.
 */
export const DEFAULT_EXAM_SETTINGS = {
  totalMarks: null,
  passingScorePercent: 40,
  timeLimitSec: null,
  perQuestionTimeSec: null,
  attemptLimit: 1,
  negativeMarking: { enabled: false, percent: 25 },
  partialMarking: { enabled: true },
  shuffleQuestions: false,
  shuffleOptions: false,
  showCorrectAnswers: false,
  answerReviewAfter: RESULT_VISIBILITY.IMMEDIATE,
  calculatorAllowed: false,
  scratchpadAllowed: false,
  attachmentAllowed: false,
  accessibility: { fontSize: 16, highContrast: false, screenReader: true },
  languages: ['en'],
  isProctored: false,
  proctoring: {
    requireCamera: true,
    requireMicrophone: false,
    requireScreenShare: false,
    browserLockdown: true,
    fullscreenRequired: true,
    autoTerminateAfterViolations: 0,
  },
  resultVisibility: RESULT_VISIBILITY.IMMEDIATE,
  access: EXAM_ACCESS.ORG_MEMBERS,
  fee: { amount: 0, currency: 'USD' },
};

export const TIMER_WARN_THRESHOLDS = [600, 300, 60]; // seconds → toast nudges
