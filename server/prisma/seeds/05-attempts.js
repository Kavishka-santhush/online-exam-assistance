const { createRandom, hoursAgo, minutesAgo, roundTo } = require('./lib/utils');

/**
 * Build a candidate response + grading outcome for one question.
 * Mirrors the rules implemented in server/src/utils/scoring.util.js so seeded
 * scores are consistent with what the live auto-grader would produce.
 */
function buildResponse(question, random, competence) {
  const content = question.content ?? {};
  const isCorrect = random.next() < competence;
  const wrongPick = () => random.next() < 0.5;

  switch (question.type) {
    case 'MULTIPLE_CHOICE': {
      const options = content.options ?? [];
      const correctId = content.correctOptionId;
      const distractors = options.filter((option) => option.id !== correctId).map((option) => option.id);
      const selectedId = isCorrect ? correctId : random.pick(distractors) ?? correctId;
      return {
        response: { selectedOptionId: selectedId },
        selectedOptions: [selectedId],
        autoScore: selectedId === correctId ? Number(question.marks) : 0,
        isCorrect: selectedId === correctId,
      };
    }
    case 'MULTIPLE_ANSWER': {
      const correctIds = content.correctOptionIds ?? [];
      const allIds = (content.options ?? []).map((option) => option.id);
      const selected = isCorrect
        ? [...correctIds]
        : random.shuffle(allIds).slice(0, Math.max(1, correctIds.length - (wrongPick() ? 1 : 0)));
      const hits = selected.filter((id) => correctIds.includes(id)).length;
      const misses = selected.filter((id) => !correctIds.includes(id)).length;
      const partialRatio = Math.max(0, (hits - misses) / Math.max(1, correctIds.length));
      const score = content.partialCredit ? Number(question.marks) * partialRatio : hits === correctIds.length && misses === 0 ? Number(question.marks) : 0;
      return {
        response: { selectedOptionIds: selected },
        selectedOptions: selected,
        autoScore: roundTo(score),
        isCorrect: hits === correctIds.length && misses === 0,
        isPartial: score > 0 && score < Number(question.marks),
      };
    }
    case 'TRUE_FALSE':
      return {
        response: { booleanAnswer: isCorrect ? content.correct : !content.correct },
        autoScore: (isCorrect ? content.correct : !content.correct) === content.correct ? Number(question.marks) : 0,
        isCorrect: (isCorrect ? content.correct : !content.correct) === content.correct,
      };
    case 'SHORT_ANSWER': {
      const expected = (content.answers ?? [''])[0];
      const text = isCorrect ? expected : `${expected}s`;
      const correct = text.toLowerCase() === String(expected).toLowerCase();
      return { response: { text }, textAnswer: text, autoScore: correct ? Number(question.marks) : 0, isCorrect: correct };
    }
    case 'FILL_BLANK': {
      const blanks = content.blanks ?? [];
      const blankAnswers = blanks.map((blank, index) => ({
        id: blank.id,
        value: isCorrect || index === 0 ? (blank.answers ?? [''])[0] : 'unnknown',
      }));
      const correctCount = blankAnswers.filter((item, index) => (blanks[index].answers ?? []).includes(item.value)).length;
      const score = (Number(question.marks) * correctCount) / Math.max(1, blanks.length);
      return {
        response: { blankAnswers },
        blankAnswers: blankAnswers.map((item) => ({ id: item.id, value: item.value })),
        autoScore: roundTo(score),
        isCorrect: correctCount === blanks.length,
        isPartial: correctCount > 0 && correctCount < blanks.length,
      };
    }
    case 'MATCHING': {
      const pairs = content.pairs ?? [];
      const rightIds = (content.right ?? []).map((item) => item.id);
      const matchedPairs = pairs.map((pair, index) => ({
        leftId: pair.leftId,
        rightId: isCorrect || index === pairs.length - 1 ? pair.rightId : random.pick(rightIds),
      }));
      const hits = matchedPairs.filter((item, index) => item.rightId === pairs[index].rightId).length;
      return {
        response: { matchedPairs },
        matchedPairs,
        autoScore: roundTo((Number(question.marks) * hits) / Math.max(1, pairs.length)),
        isCorrect: hits === pairs.length,
        isPartial: hits > 0 && hits < pairs.length,
      };
    }
    case 'ORDERING': {
      const correct = content.correctOrder ?? [];
      const ordered = isCorrect ? [...correct] : random.shuffle(correct);
      let inversions = 0;
      for (let i = 0; i < ordered.length; i += 1) {
        for (let j = i + 1; j < ordered.length; j += 1) {
          if (correct.indexOf(ordered[i]) > correct.indexOf(ordered[j])) inversions += 1;
        }
      }
      const maxInversions = (ordered.length * (ordered.length - 1)) / 2;
      const ratio = maxInversions === 0 ? 1 : 1 - inversions / maxInversions;
      return {
        response: { orderedItemIds: ordered },
        orderedItems: ordered,
        autoScore: roundTo(Number(question.marks) * ratio),
        isCorrect: inversions === 0,
        isPartial: ratio > 0.6 && ratio < 1,
      };
    }
    case 'DROPDOWN': {
      const dropdowns = content.dropdowns ?? [];
      const answers = dropdowns.map((dropdown) => ({
        id: dropdown.id,
        value: isCorrect ? dropdown.correctOption : random.pick(dropdown.options),
      }));
      const hits = answers.filter((item, index) => item.value === dropdowns[index].correctOption).length;
      return {
        response: { dropdownAnswers: answers },
        autoScore: roundTo((Number(question.marks) * hits) / Math.max(1, dropdowns.length)),
        isCorrect: hits === dropdowns.length,
      };
    }
    case 'HOTSPOT': {
      const zone = (content.zones ?? [])[0] ?? { x: 0, y: 0, w: 10, h: 10 };
      const clicks = isCorrect
        ? [{ x: zone.x + Math.round(zone.w / 2), y: zone.y + Math.round(zone.h / 2) }]
        : [{ x: zone.x + 600, y: zone.y + 400 }];
      const correctIds = content.correctZoneIds ?? [];
      const inside = clicks.some((click) =>
        (content.zones ?? []).some(
          (item) => correctIds.includes(item.id) && click.x >= item.x && click.x <= item.x + item.w && click.y >= item.y && click.y <= item.y + item.h,
        ),
      );
      return { response: { clicks }, hotspotClicks: clicks, autoScore: inside ? Number(question.marks) : 0, isCorrect: inside };
    }
    case 'CODING': {
      const cases = content.testCases ?? [];
      const passedSamples = cases.filter((item) => item.isSample).length;
      const passed = isCorrect ? cases.length : Math.max(1, passedSamples);
      const results = cases.map((testCase, index) => ({
        id: testCase.id,
        passed: index < passed,
        expected: testCase.expectedOutput,
        actual: index < passed ? testCase.expectedOutput : '[]',
        runtimeMs: random.int(12, 240),
        isSample: testCase.isSample,
      }));
      return {
        response: { language: content.defaultLanguage, code: sampleSolution(question), testResults: results },
        codeLanguage: content.defaultLanguage,
        codeSource: sampleSolution(question),
        testRunResults: results,
        autoScore: roundTo((Number(question.marks) * passed) / Math.max(1, cases.length)),
        isCorrect: passed === cases.length,
        isPartial: passed > 0 && passed < cases.length,
      };
    }
    case 'MATH_FORMULA': {
      const latex = isCorrect ? (content.equivalentLatex ?? [])[0] ?? content.latexAnswer : 'x = 1';
      return {
        response: { latex },
        mathLatex: latex,
        autoScore: latex === content.latexAnswer || (content.equivalentLatex ?? []).includes(latex) ? Number(question.marks) : 0,
        isCorrect: latex === content.latexAnswer,
      };
    }
    case 'LIKERT_SCALE': {
      const value = random.int(content.scale?.min ?? 1, content.scale?.max ?? 5);
      return { response: { scaleValue: value }, ratingValue: value, autoScore: Number(question.marks), isCorrect: null, gradingStatus: 'NOT_REQUIRED' };
    }
    case 'RATING_SCALE': {
      const value = random.int(content.min ?? 1, content.max ?? 10);
      return { response: { ratingValue: value }, ratingValue: value, autoScore: Number(question.marks), isCorrect: null, gradingStatus: 'NOT_REQUIRED' };
    }
    case 'MATRIX': {
      const columns = content.columns ?? [];
      const matrixResponses = (content.rows ?? []).map((row) => ({
        rowId: row.id,
        columnId: random.pick(columns)?.id ?? null,
      }));
      return { response: { matrixResponses }, matrixResponses, autoScore: Number(question.marks), isCorrect: null, gradingStatus: 'NOT_REQUIRED' };
    }
    case 'LONG_ANSWER': {
      const words = random.int(content.minWords ?? 120, content.maxWords ?? 600);
      return {
        response: { html: essayHtml(question, words), plain: essayPlain(words) },
        textAnswer: essayPlain(words),
        wordCount: words,
        needsManualGrading: true,
        gradingStatus: 'UNGRADED',
        autoScore: null,
        aiSuggestion: roundTo(Number(question.marks) * (0.6 + competence * 0.35)),
      };
    }
    case 'FILE_UPLOAD':
    case 'AUDIO_RECORDING':
    case 'VIDEO_RECORDING':
    case 'DRAWING':
      return {
        response: {
          fileRefs: [`/uploads/answers/${question.id}/attempt-file.${question.type === 'FILE_UPLOAD' ? 'pdf' : question.type === 'AUDIO_RECORDING' ? 'webm' : 'png'}`],
          durationSec: question.type === 'AUDIO_RECORDING' || question.type === 'VIDEO_RECORDING' ? random.int(20, content.maxDurationSec ?? 60) : null,
        },
        needsManualGrading: true,
        gradingStatus: 'UNGRADED',
        autoScore: null,
        attachment: true,
      };
    default:
      return { response: {}, autoScore: 0, isCorrect: false };
  }
}

function sampleSolution(question) {
  if (question.id.includes('two-sum')) {
    return 'function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i += 1) {\n    const need = target - nums[i];\n    if (seen.has(need)) return [seen.get(need), i];\n    seen.set(nums[i], i);\n  }\n  return [];\n}\n';
  }
  return 'def solve():\n    pass\n';
}

function essayPlain(words) {
  const sentence =
    'Cloud-native decomposition trades a simpler operational model for per-service autonomy, which raises platform cost but shortens feedback loops for large teams. ';
  let out = '';
  while (out.split(' ').length < words) out += sentence;
  return out.trim();
}

function essayHtml(words) {
  return `<p>${essayPlain(words).replace(/\. /g, '.</p><p>')}</p>`;
}

module.exports = async function seed(prisma, ctx) {
  const random = createRandom(4242);
  const attemptsByExam = {};
  let attemptCount = 0;

  for (const [examKey, entry] of Object.entries(ctx.exams)) {
    const { exam, fixture, candidateIds } = entry;
    const examQuestions = await prisma.examQuestion.findMany({
      where: { examId: exam.id },
      include: { question: true },
      orderBy: { order: 'asc' },
    });
    if (!examQuestions.length) continue;

    // Cap the seeded cohort so the demo dataset stays small but varied.
    const participants = candidateIds.slice(0, examKey === 'aws-solutions-architect' ? 5 : 4);
    const attemptsForExam = [];

    for (const [index, userId] of participants.entries()) {
      const competence = roundTo(0.35 + index * 0.11 + random.next() * 0.15, 2);
      const startedMinutesAgo = 60 + index * 37;
      const totalSeconds = exam.durationMinutes * 60;
      const usedSeconds = Math.min(totalSeconds, random.int(Math.round(totalSeconds * 0.45), totalSeconds));
      const submittedAt = minutesAgo(startedMinutesAgo - Math.round(usedSeconds / 60));
      const status = exam.type === 'LIVE_QUIZ' ? 'SUBMITTED' : examKey === 'adaptive-math-practice' ? 'IN_PROGRESS' : 'SUBMITTED';

      const attempt = await prisma.attempt.upsert({
        where: { id: `seed-attempt-${examKey}-${index + 1}` },
        update: { lastActivityAt: new Date() },
        create: {
          id: `seed-attempt-${examKey}-${index + 1}`,
          examId: exam.id,
          examVersion: 1,
          userId,
          organizationId: exam.organizationId,
          attemptNumber: 1,
          status,
          gradingStatus: 'UNGRADED',
          startedAt: minutesAgo(startedMinutesAgo),
          expiresAt: status === 'IN_PROGRESS' ? new Date(Date.now() + (totalSeconds - usedSeconds) * 1000) : submittedAt,
          submittedAt: status === 'SUBMITTED' ? submittedAt : null,
          timeLimitSec: totalSeconds,
          usedTimeSec: status === 'IN_PROGRESS' ? Math.round(usedSeconds / 3) : usedSeconds,
          remainingTimeSec: status === 'IN_PROGRESS' ? totalSeconds - Math.round(usedSeconds / 3) : 0,
          isAdaptive: Boolean(exam.isAdaptive),
          answerOrder: examQuestions.map((item) => item.questionId),
          currentQuestionOrder: status === 'IN_PROGRESS' ? 1 : examQuestions.length,
          ip: `203.0.113.${10 + index}`,
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          deviceInfo: { platform: 'linux', browser: 'chrome', screen: '1920x1080', memoryGb: 16 },
          shareToken: `seed-share-${examKey}-${index + 1}`,
          metadata: { seeded: true, competence },
          lastAutoSaveAt: status === 'IN_PROGRESS' ? new Date() : submittedAt,
          lastActivityAt: status === 'IN_PROGRESS' ? minutesAgo(2) : submittedAt,
        },
      });

      const answeredQuestions = status === 'IN_PROGRESS' ? examQuestions.slice(0, Math.ceil(examQuestions.length / 2)) : examQuestions;
      let rawScore = 0;
      let totalMarks = 0;
      let negativeDeducted = 0;

      for (const [qIndex, examQuestion] of answeredQuestions.entries()) {
        const question = examQuestion.question;
        totalMarks += Number(examQuestion.marks);
        const built = buildResponse(question, random, competence);
        const wasSkipped = built.autoScore === null && !built.needsManualGrading && random.bool(0.12);
        const needsManual = Boolean(built.needsManualGrading);
        const score = wasSkipped ? 0 : built.autoScore ?? 0;

        if (!needsManual && built.isCorrect === false && exam.negativeMarking) {
          negativeDeducted += Number(examQuestion.marks) * (Number(examQuestion.negativePercent ?? 0) / 100);
        } else if (!needsManual) {
          rawScore += score;
        }

        await prisma.answer.upsert({
          where: { attemptId_questionId: { attemptId: attempt.id, questionId: question.id } },
          update: { response: built.response },
          create: {
            attemptId: attempt.id,
            questionId: question.id,
            examQuestionId: examQuestion.id,
            questionVersion: question.currentVersion,
            order: qIndex + 1,
            sectionId: examQuestion.sectionId,
            response: built.response,
            textAnswer: built.textAnswer ?? null,
            selectedOptions: built.selectedOptions ?? [],
            matchedPairs: built.matchedPairs ?? [],
            orderedItems: built.orderedItems ?? [],
            blankAnswers: built.blankAnswers ?? [],
            hotspotClicks: built.hotspotClicks ?? [],
            codeLanguage: built.codeLanguage ?? null,
            codeSource: built.codeSource ?? null,
            testRunResults: built.testRunResults ?? null,
            ratingValue: built.ratingValue ?? null,
            matrixResponses: built.matrixResponses ?? [],
            mathLatex: built.mathLatex ?? null,
            maxMarks: examQuestion.marks,
            autoScore: needsManual || wasSkipped ? null : score,
            finalScore: needsManual || wasSkipped ? null : score,
            isCorrect: built.isCorrect ?? null,
            isPartial: built.isPartial ?? false,
            needsManualGrading: needsManual,
            gradingStatus: built.gradingStatus ?? (needsManual ? 'UNGRADED' : 'GRADED'),
            wordCount: built.wordCount ?? (built.textAnswer ? built.textAnswer.split(/\s+/).length : 0),
            timeSpentSec: random.int(20, Math.max(40, question.estimatedTimeSec * 2)),
            wasSkipped,
            isMarkedForReview: random.bool(0.15),
            answeredAt: wasSkipped ? null : new Date(attempt.startedAt.getTime() + qIndex * 90_000),
          },
        });

        if (built.attachment) {
          await prisma.uploadedFile.upsert({
            where: { id: `seed-file-${attempt.id}-${question.id}` },
            update: {},
            create: {
              id: `seed-file-${attempt.id}-${question.id}`,
              userId,
              attemptId: attempt.id,
              questionId: question.id,
              kind:
                question.type === 'FILE_UPLOAD'
                  ? 'ANSWER_ATTACHMENT'
                  : question.type === 'DRAWING'
                    ? 'ANSWER_DRAWING'
                    : question.type === 'AUDIO_RECORDING'
                      ? 'QUESTION_AUDIO'
                      : 'QUESTION_VIDEO',
              url: (built.response.fileRefs ?? ['/uploads/answers/sample'])[0],
              storagePath: `uploads/answers/${question.id}/${attempt.id}`,
              originalName: `answer-${question.type.toLowerCase()}`,
              mimeType: question.type === 'FILE_UPLOAD' ? 'application/pdf' : question.type === 'AUDIO_RECORDING' ? 'audio/webm' : 'video/webm',
              sizeBytes: random.int(120_000, 8_400_000),
              durationSec: built.response.durationSec ?? null,
              metadata: { virusScan: 'CLEAN', seeded: true },
            },
          });
        }

        if (built.aiSuggestion !== undefined) {
          await prisma.answer.update({
            where: { attemptId_questionId: { attemptId: attempt.id, questionId: question.id } },
            data: { aiScore: built.aiSuggestion, aiFeedback: 'AI draft score - awaiting instructor confirmation.' },
          });
        }
      }

      const gradedCount = status === 'SUBMITTED' ? answeredQuestions.length : 0;
      const scorePercent = totalMarks > 0 ? roundTo((rawScore / totalMarks) * 100, 2) : 0;

      await prisma.attempt.update({
        where: { id: attempt.id },
        data: {
          rawScore: roundTo(rawScore),
          negativeDeducted: roundTo(negativeDeducted),
          finalScore: roundTo(Math.max(0, rawScore - negativeDeducted)),
          totalMarks: roundTo(totalMarks),
          scorePercent: status === 'SUBMITTED' ? scorePercent : 0,
          answeredCount: gradedCount,
          passed: status === 'SUBMITTED' ? scorePercent >= Number(exam.passingPercent) : null,
          gradingStatus: status === 'SUBMITTED' ? 'UNGRADED' : 'NOT_REQUIRED',
          abilityScore: exam.isAdaptive ? roundTo(-1 + competence * 2.4, 3) : null,
          abilityStdErr: exam.isAdaptive ? roundTo(0.42, 3) : null,
          adaptiveState: exam.isAdaptive
            ? { theta: roundTo(-1 + competence * 2.4, 3), standardError: 0.42, served: answeredQuestions.map((item) => item.questionId), nextDifficulty: 'HARD', askedCount: answeredQuestions.length }
            : {},
          sectionProgress: { '1': { answered: answeredQuestions.length, total: examQuestions.length } },
        },
      });

      await prisma.examNote.upsert({
        where: { attemptId: attempt.id },
        update: {},
        create: { attemptId: attempt.id, content: 'Remember: subnet mask /22 -> 1024 addresses. Check the ordering answer before submitting.' },
      });

      attemptsForExam.push({ attempt, userId, scorePercent: status === 'SUBMITTED' ? scorePercent : 0 });
      attemptCount += 1;
    }

    // Percentile + grade letter once every attempt of the exam is known
    const sorted = [...attemptsForExam].sort((a, b) => a.scorePercent - b.scorePercent);
    for (const item of sorted) {
      const rank = sorted.findIndex((candidate) => candidate.attempt.id === item.attempt.id);
      const percentile = roundTo(((rank + 1) / sorted.length) * 100, 2);
      const gradeLetter = toGradeLetter(item.scorePercent, exam.gradeBoundaries);
      await prisma.attempt.update({
        where: { id: item.attempt.id },
        data: { percentile: Number.isFinite(percentile) ? percentile : null, gradeLetter },
      });
    }

    const submitted = attemptsForExam.filter((item) => item.scorePercent > 0);
    const average = submitted.length ? roundTo(submitted.reduce((sum, item) => sum + item.scorePercent, 0) / submitted.length, 2) : 0;
    const passRate = submitted.length
      ? roundTo((submitted.filter((item) => item.scorePercent >= Number(exam.passingPercent)).length / submitted.length) * 100, 2)
      : 0;

    await prisma.exam.update({
      where: { id: exam.id },
      data: { totalAttempts: attemptsForExam.length, averageScore: average, passRate, status: exam.status === 'PUBLISHED' ? 'ACTIVE' : exam.status },
    });

    attemptsByExam[examKey] = attemptsForExam;
  }

  ctx.attemptsByExam = attemptsByExam;
  ctx.attemptCount = attemptCount;
  console.log(`  · ${attemptCount} attempts with answers, autosave notes and percentiles`);
};

function toGradeLetter(percent, boundaries) {
  const map = boundaries && typeof boundaries === 'object' ? boundaries : { A: 90, B: 80, C: 70, D: 60, F: 0 };
  if (percent >= map.A) return 'A';
  if (percent >= map.B) return 'B';
  if (percent >= map.C) return 'C';
  if (percent >= map.D) return 'D';
  return 'F';
}

module.exports.buildResponse = buildResponse;
