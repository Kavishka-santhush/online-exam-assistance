/**
 * Seed fixtures covering EVERY question type supported by the platform.
 *
 * `content` JSONB contract (shared with server/src/constants/questionTypes.js
 * and the client QuestionRenderer):
 *
 *   MULTIPLE_CHOICE   { options:[{id,text,imageUrl?}], correctOptionId }
 *   MULTIPLE_ANSWER   { options:[{id,text,imageUrl?}], correctOptionIds[], partialCredit }
 *   TRUE_FALSE        { correct: boolean, trueLabel, falseLabel }
 *   SHORT_ANSWER      { answers:[String], matchMode, caseSensitive, acceptAlternatives }
 *   LONG_ANSWER       { minWords, maxWords, gradingMode, richText, attachmentsAllowed }
 *   FILL_BLANK        { template, blanks:[{id, answers:[String], matchMode}] }
 *   MATCHING          { left:[{id,text}], right:[{id,text}], pairs:[{leftId,rightId}] }
 *   ORDERING          { items:[{id,text}], correctOrder:[id] }
 *   DROPDOWN          { template, dropdowns:[{id, options:[String], correctOption }] }
 *   HOTSPOT           { imageUrl, zones:[{id,label,shape,x,y,w,h,r}] }
 *   CODING            { languages:[], starterCode:{lang}, testCases:[{id,input,expectedOutput,isSample}], timeLimitMs, memoryLimitMb }
 *   FILE_UPLOAD       { allowedMimeTypes:[], maxFiles, maxSizeMb, instructions }
 *   AUDIO_RECORDING   { maxDurationSec, promptText }
 *   VIDEO_RECORDING   { maxDurationSec, aspectRatio }
 *   MATH_FORMULA      { latexAnswer, equivalentLatex:[], tolerance, matchMode }
 *   DRAWING           { canvas:{width,height}, tools:[], background }
 *   LIKERT_SCALE      { statement, scale:{min,max,minLabel,maxLabel} }
 *   RATING_SCALE      { statement, min, max, step, labels:{low,high} }
 *   MATRIX            { rows:[{id,label}], columns:[{id,label}], cellsPerRow, allowNA }
 */

const MCQ_OPTION = (id, text, extra = {}) => ({ id, text, ...extra });

const questionFixtures = [
  {
    key: 'q-mcq-capitals',
    type: 'MULTIPLE_CHOICE',
    prompt: 'Which of the following is the capital of Australia?',
    difficulty: 'EASY',
    marks: 1,
    estimatedTimeSec: 45,
    bloomsLevel: 'REMEMBER',
    topicTags: ['geography', 'capitals'],
    learningObjectives: ['Identify world capitals'],
    language: 'en',
    explanation: 'Canberra was selected in 1908 as a compromise between Sydney and Melbourne.',
    content: {
      options: [
        MCQ_OPTION('a', 'Sydney'),
        MCQ_OPTION('b', 'Melbourne'),
        MCQ_OPTION('c', 'Canberra'),
        MCQ_OPTION('d', 'Perth'),
      ],
      correctOptionId: 'c',
    },
  },
  {
    key: 'q-mcq-img-symptom',
    type: 'MULTIPLE_CHOICE',
    prompt: 'The radiograph below most likely shows which condition?',
    difficulty: 'HARD',
    marks: 2,
    estimatedTimeSec: 90,
    bloomsLevel: 'ANALYZE',
    topicTags: ['radiology', 'clinical'],
    imageUrls: ['/uploads/questions/chest-xray-sample.svg'],
    content: {
      options: [
        MCQ_OPTION('a', 'Pneumothorax', { imageUrl: '/uploads/questions/opt-a.svg' }),
        MCQ_OPTION('b', 'Pleural effusion', { imageUrl: '/uploads/questions/opt-b.svg' }),
        MCQ_OPTION('c', 'Consolidation', { imageUrl: '/uploads/questions/opt-c.svg' }),
      ],
      correctOptionId: 'a',
    },
  },
  {
    key: 'q-mcma-protocols',
    type: 'MULTIPLE_ANSWER',
    prompt: 'Select ALL transport layer protocols from the list below.',
    difficulty: 'MEDIUM',
    marks: 4,
    partialMarking: true,
    negativePercent: 0,
    estimatedTimeSec: 80,
    bloomsLevel: 'UNDERSTAND',
    topicTags: ['networking', 'osi-model'],
    explanation: 'HTTP/DNS sit above the transport layer; TCP and SCTP are transport protocols.',
    content: {
      options: [
        MCQ_OPTION('a', 'TCP'),
        MCQ_OPTION('b', 'HTTP'),
        MCQ_OPTION('c', 'SCTP'),
        MCQ_OPTION('d', 'UDP'),
        MCQ_OPTION('e', 'DNS'),
      ],
      correctOptionIds: ['a', 'c', 'd'],
      partialCredit: true,
      scoringRule: 'PROPORTIONAL',
    },
  },
  {
    key: 'q-tf-sql-drop',
    type: 'TRUE_FALSE',
    prompt: '`DROP TABLE` removes a table structure and all of its rows.',
    difficulty: 'EASY',
    marks: 1,
    estimatedTimeSec: 20,
    bloomsLevel: 'REMEMBER',
    topicTags: ['sql', 'ddl'],
    explanation: 'TRUNCATE keeps the table, DROP removes it entirely.',
    content: { correct: true, trueLabel: 'True', falseLabel: 'False' },
  },
  {
    key: 'q-short-entropy',
    type: 'SHORT_ANSWER',
    prompt: 'The measure of uncertainty in information theory is called ______.',
    difficulty: 'MEDIUM',
    marks: 2,
    estimatedTimeSec: 40,
    bloomsLevel: 'REMEMBER',
    topicTags: ['information-theory'],
    content: {
      answers: ['entropy', 'shannon entropy'],
      matchMode: 'KEYWORD',
      caseSensitive: false,
      acceptAlternatives: true,
    },
  },
  {
    key: 'q-essay-cloud-native',
    type: 'LONG_ANSWER',
    prompt:
      'Discuss the trade-offs of migrating a monolithic application to a cloud-native architecture. Cover cost, reliability and team topology.',
    difficulty: 'EXPERT',
    marks: 20,
    estimatedTimeSec: 1500,
    bloomsLevel: 'EVALUATE',
    topicTags: ['architecture', 'cloud'],
    content: {
      minWords: 250,
      maxWords: 900,
      gradingMode: 'AI_WITH_MANUAL_REVIEW',
      richText: true,
      attachmentsAllowed: false,
    },
    rubricCriteria: [
      { id: 'c1', name: 'Accuracy', maxMarks: 6, description: 'Technical correctness of claims' },
      { id: 'c2', name: 'Coherence', maxMarks: 5, description: 'Structure and logical flow' },
      { id: 'c3', name: 'Depth', maxMarks: 6, description: 'Nuance and trade-off analysis' },
      { id: 'c4', name: 'Grammar', maxMarks: 3, description: 'Language quality' },
    ],
  },
  {
    key: 'q-fill-blank-tcp',
    type: 'FILL_BLANK',
    prompt: 'TCP uses a three-way {b1} and {b2} control to avoid congestion.',
    difficulty: 'MEDIUM',
    marks: 2,
    estimatedTimeSec: 60,
    topicTags: ['networking'],
    content: {
      template: 'TCP uses a three-way {b1} and {b2} control to avoid congestion.',
      blanks: [
        { id: 'b1', answers: ['handshake'], matchMode: 'CASE_INSENSITIVE' },
        { id: 'b2', answers: ['congestion', 'flow'], matchMode: 'CASE_INSENSITIVE' },
      ],
      matchMode: 'FUZZY',
      fuzzyThreshold: 0.82,
    },
  },
  {
    key: 'q-matching-aws',
    type: 'MATCHING',
    prompt: 'Match each AWS service with what it primarily does.',
    difficulty: 'MEDIUM',
    marks: 5,
    estimatedTimeSec: 180,
    topicTags: ['aws', 'cloud'],
    content: {
      left: [
        { id: 'l1', text: 'S3' },
        { id: 'l2', text: 'Lambda' },
        { id: 'l3', text: 'RDS' },
        { id: 'l4', text: 'CloudFront' },
        { id: 'l5', text: 'SQS' },
      ],
      right: [
        { id: 'r1', text: 'Object storage' },
        { id: 'r2', text: 'Serverless functions' },
        { id: 'r3', text: 'Managed relational database' },
        { id: 'r4', text: 'Content delivery network' },
        { id: 'r5', text: 'Message queue' },
        { id: 'r6', text: 'Data warehouse' },
      ],
      pairs: [
        { leftId: 'l1', rightId: 'r1' },
        { leftId: 'l2', rightId: 'r2' },
        { leftId: 'l3', rightId: 'r3' },
        { leftId: 'l4', rightId: 'r4' },
        { leftId: 'l5', rightId: 'r5' },
      ],
      shuffleRight: true,
    },
  },
  {
    key: 'q-ordering-pipeline',
    type: 'ORDERING',
    prompt: 'Arrange the CI/CD pipeline stages in the correct execution order.',
    difficulty: 'MEDIUM',
    marks: 4,
    estimatedTimeSec: 120,
    topicTags: ['devops', 'cicd'],
    content: {
      items: [
        { id: 'i1', text: 'Build' },
        { id: 'i2', text: 'Unit test' },
        { id: 'i3', text: 'Static analysis' },
        { id: 'i4', text: 'Package' },
        { id: 'i5', text: 'Deploy to staging' },
        { id: 'i6', text: 'Smoke test' },
        { id: 'i7', text: 'Promote to production' },
      ],
      correctOrder: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'],
      scoringRule: 'KENDALL_TAU_PARTIAL',
    },
  },
  {
    key: 'q-dropdown-verbs',
    type: 'DROPDOWN',
    prompt: 'The team {d1} the release and {d2} the rollout to all regions.',
    difficulty: 'EASY',
    marks: 2,
    estimatedTimeSec: 50,
    topicTags: ['language', 'business-english'],
    content: {
      template: 'The team {d1} the release and {d2} the rollout to all regions.',
      dropdowns: [
        { id: 'd1', options: ['shipped', 'shipping', 'shippen'], correctOption: 'shipped' },
        { id: 'd2', options: ['postponed', 'completed', 'cancelled'], correctOption: 'completed' },
      ],
    },
  },
  {
    key: 'q-hotspot-diagram',
    type: 'HOTSPOT',
    prompt: 'Click the region of the diagram that represents the load balancer.',
    difficulty: 'MEDIUM',
    marks: 2,
    estimatedTimeSec: 45,
    topicTags: ['architecture', 'diagrams'],
    imageUrls: ['/uploads/questions/system-diagram.svg'],
    content: {
      imageUrl: '/uploads/questions/system-diagram.svg',
      zones: [
        { id: 'z1', label: 'Load balancer', shape: 'rect', x: 320, y: 140, w: 180, h: 70 },
        { id: 'z2', label: 'Database', shape: 'rect', x: 640, y: 420, w: 150, h: 80 },
      ],
      correctZoneIds: ['z1'],
      tolerancePx: 12,
    },
  },
  {
    key: 'q-coding-two-sum',
    type: 'CODING',
    prompt:
      'Implement `twoSum(nums, target)` that returns the indices of the two numbers adding up to `target`. First match wins.',
    difficulty: 'MEDIUM',
    marks: 10,
    estimatedTimeSec: 900,
    bloomsLevel: 'APPLY',
    topicTags: ['algorithms', 'arrays', 'hash-map'],
    solution: 'function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i += 1) {\n    const need = target - nums[i];\n    if (seen.has(need)) return [seen.get(need), i];\n    seen.set(nums[i], i);\n  }\n  return [];\n}',
    content: {
      languages: ['javascript', 'python', 'java', 'cpp', 'c', 'go', 'ruby', 'php'],
      defaultLanguage: 'javascript',
      entryFunction: 'twoSum',
      starterCode: {
        javascript: 'function twoSum(nums, target) {\n  // your code\n}\n\nmodule.exports = { twoSum };\n',
        python: 'def two_sum(nums, target):\n    pass\n',
      },
      signature: 'twoSum(nums: number[], target: number): number[]',
      testCases: [
        { id: 't1', input: '[[2,7,11,15], 9]', expectedOutput: '[0, 1]', isSample: true },
        { id: 't2', input: '[[3,2,4], 6]', expectedOutput: '[1, 2]', isSample: true },
        { id: 't3', input: '[[3,3], 6]', expectedOutput: '[0, 1]', isSample: false },
        { id: 't4', input: '[[1,2,3,4,5], 10]', expectedOutput: '[3, 4]', isSample: false },
        { id: 't5', input: '[]', expectedOutput: '[]', isSample: false },
      ],
      timeLimitMs: 5000,
      memoryLimitMb: 128,
      scoringRule: 'PASSED_TEST_PERCENT',
    },
  },
  {
    key: 'q-file-upload-essay',
    type: 'FILE_UPLOAD',
    prompt: 'Upload your lab report as a PDF (max 10 MB).',
    difficulty: 'MEDIUM',
    marks: 15,
    estimatedTimeSec: 600,
    topicTags: ['lab', 'reporting'],
    content: {
      allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'application/zip'],
      maxFiles: 3,
      maxSizeMb: 10,
      instructions: 'Filename must start with your candidate ID.',
      gradingMode: 'MANUAL',
    },
  },
  {
    key: 'q-audio-speaking',
    type: 'AUDIO_RECORDING',
    prompt: 'Record a 60-second answer: describe your favourite festival and why you enjoy it.',
    difficulty: 'EASY',
    marks: 8,
    estimatedTimeSec: 120,
    topicTags: ['speaking', 'language'],
    content: { maxDurationSec: 90, minDurationSec: 15, mimeType: 'audio/webm', gradingMode: 'MANUAL' },
  },
  {
    key: 'q-video-interview',
    type: 'VIDEO_RECORDING',
    prompt: 'Record a short video answer explaining the business case for the proposal.',
    difficulty: 'MEDIUM',
    marks: 12,
    estimatedTimeSec: 240,
    topicTags: ['communication', 'interview'],
    content: { maxDurationSec: 180, aspectRatio: '16:9', mimeType: 'video/webm', gradingMode: 'MANUAL' },
  },
  {
    key: 'q-math-quadratic',
    type: 'MATH_FORMULA',
    prompt: 'Type the solutions of x² − 5x + 6 = 0 using the KaTeX equation editor.',
    difficulty: 'MEDIUM',
    marks: 4,
    estimatedTimeSec: 180,
    bloomsLevel: 'APPLY',
    topicTags: ['algebra', 'quadratics'],
    content: {
      latexAnswer: 'x = 2 \\;\\text{or}\\; x = 3',
      equivalentLatex: ['x=2, x=3', '\\{2,3\\}'],
      matchMode: 'STRUCTURAL_LATEX',
      tolerance: 0.001,
      requiredSymbols: ['=', 'x'],
    },
  },
  {
    key: 'q-drawing-freebody',
    type: 'DRAWING',
    prompt: 'Draw the free-body diagram of a block resting on a 30° incline.',
    difficulty: 'HARD',
    marks: 6,
    estimatedTimeSec: 300,
    topicTags: ['physics', 'mechanics'],
    content: {
      canvas: { width: 900, height: 600 },
      tools: ['pen', 'line', 'arrow', 'rect', 'ellipse', 'eraser', 'text'],
      background: 'grid',
      gradingMode: 'MANUAL',
    },
  },
  {
    key: 'q-likert-confidence',
    type: 'LIKERT_SCALE',
    prompt: 'The training material matched the difficulty of the actual exam.',
    difficulty: 'EASY',
    marks: 1,
    estimatedTimeSec: 20,
    topicTags: ['feedback', 'survey'],
    content: {
      statement: 'The training material matched the difficulty of the actual exam.',
      scale: { min: 1, max: 5, minLabel: 'Strongly disagree', maxLabel: 'Strongly agree' },
    },
  },
  {
    key: 'q-rating-instructor',
    type: 'RATING_SCALE',
    prompt: 'How would you rate the clarity of the exam instructions?',
    difficulty: 'EASY',
    marks: 1,
    estimatedTimeSec: 15,
    topicTags: ['feedback', 'survey'],
    content: { statement: 'Clarity of instructions', min: 1, max: 10, step: 1, labels: { low: 'Very unclear', high: 'Crystal clear' } },
  },
  {
    key: 'q-matrix-module-rating',
    type: 'MATRIX',
    prompt: 'Rate each module on the following dimensions.',
    difficulty: 'EASY',
    marks: 5,
    estimatedTimeSec: 150,
    topicTags: ['feedback', 'survey'],
    content: {
      rows: [
        { id: 'm1', label: 'Networking' },
        { id: 'm2', label: 'Databases' },
        { id: 'm3', label: 'Security' },
      ],
      columns: [
        { id: 'c1', label: 'Well explained' },
        { id: 'c2', label: 'Good exercises' },
        { id: 'c3', label: 'Too long' },
        { id: 'c4', label: 'Would recommend' },
      ],
      cellsPerRow: 1,
      allowNA: true,
      randomizeRows: false,
    },
  },
];

module.exports = { questionFixtures, MCQ_OPTION };
