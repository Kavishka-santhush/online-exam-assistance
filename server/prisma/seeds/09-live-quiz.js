const { createRandom, minutesAgo } = require('./lib/utils');

const TEAM_PRESETS = [
  { name: 'Quanta', color: '#ef4444' },
  { name: 'Byte Club', color: '#3b82f6' },
  { name: 'Null Pointers', color: '#22c55e' },
  { name: 'Cache Money', color: '#eab308' },
];

const REACTION_PRESETS = [
  { emoji: '🎉', count: 34 },
  { emoji: '🔥', count: 21 },
  { emoji: '😅', count: 12 },
  { emoji: '🤯', count: 9 },
  { emoji: '👏', count: 27 },
];

/**
 * Live quiz (Kahoot-style) session for the `kahoot-style-live-quiz` exam:
 * a RUNNING session with teams, ranked participants and per-question
 * option distributions the host dashboard can render immediately.
 */
module.exports = async function seed(prisma, ctx) {
  const random = createRandom(4242);
  const entry = ctx.exams['kahoot-style-live-quiz'];
  if (!entry) {
    console.log('  · skipped (no live quiz exam seeded)');
    return;
  }

  const exam = entry.exam;
  const liveConfig = exam.settings?.live ?? {};

  // Participants: prefer the registered candidates, top up with org members.
  const memberUsers = Object.values(ctx.orgs['northgate-university']?.members ?? {})
    .filter((user) => user && user.id)
    .map((user) => user.id);
  const pool = [...new Set([...(entry.candidateIds ?? []), ...memberUsers])];
  const participantIds = pool.slice(0, Math.min(10, Math.max(pool.length, 0)));
  if (participantIds.length === 0) {
    console.log('  · skipped (no candidate users available)');
    return;
  }

  const code = 'ALGB-2417';
  const session = await prisma.liveQuizSession.upsert({
    where: { code },
    update: {},
    create: {
      id: 'seed-livequiz-algebra-sprint',
      examId: exam.id,
      organizationId: exam.organizationId,
      hostId: entry.author.id,
      code,
      status: 'RUNNING',
      currentQuestionIndex: 2,
      questionTimeLimitSec: liveConfig.questionTimeLimitSec ?? 20,
      leaderboardVisible: liveConfig.leaderboardAfterEachQuestion ?? true,
      teamMode: liveConfig.teamMode ?? true,
      allowMobileJoin: liveConfig.allowMobileJoin ?? true,
      joinUrl: `/join/${code}`,
      participantCount: participantIds.length,
      answeredCount: participantIds.length * 2,
      reactionsJson: REACTION_PRESETS,
      startedAt: minutesAgo(6),
      createdAt: minutesAgo(14),
    },
  });

  // ---- teams ---------------------------------------------------------------
  const teams = [];
  const teamTotal = (liveConfig.teamMode ?? true) ? Math.min(TEAM_PRESETS.length, Math.ceil(participantIds.length / 2)) : 0;
  for (const [index, preset] of TEAM_PRESETS.slice(0, teamTotal).entries()) {
    const team = await prisma.team.upsert({
      where: { id: `seed-team-${preset.name.toLowerCase().replace(/[^a-z]+/g, '-')}` },
      update: {},
      create: {
        id: `seed-team-${preset.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        sessionId: session.id,
        name: preset.name,
        color: preset.color,
        score: 0,
        rank: index + 1,
        createdById: entry.author.id,
        createdAt: minutesAgo(12),
      },
    });
    teams.push({ team, index });
  }

  // ---- participants --------------------------------------------------------
  const userRecords = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true, displayName: true, email: true },
  });
  const userById = new Map(userRecords.map((user) => [user.id, user]));

  const rows = participantIds.map((userId, index) => {
    const correct = random.int(1, 3);
    const speedBonus = random.int(120, 980);
    return {
      userId,
      displayName: userById.get(userId)?.displayName ?? userById.get(userId)?.email ?? `Player ${index + 1}`,
      teamId: teams.length ? teams[index % teams.length].team.id : null,
      correctCount: correct,
      answeredCount: 3,
      bestStreak: correct >= 3 ? 3 : correct,
      score: correct * 1000 + speedBonus,
      lastAnswerMs: random.int(2400, 17_800),
      joinedAt: minutesAgo(11 - Math.min(9, index)),
    };
  });

  const ranked = [...rows].sort((a, b) => b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));

  for (const row of ranked) {
    await prisma.liveQuizParticipant.upsert({
      where: { sessionId_userId: { sessionId: session.id, userId: row.userId } },
      update: { score: row.score, rank: row.rank, correctCount: row.correctCount },
      create: {
        id: `seed-lqpart-${session.id}-${row.userId}`,
        sessionId: session.id,
        userId: row.userId,
        displayName: row.displayName,
        teamId: row.teamId,
        score: row.score,
        correctCount: row.correctCount,
        answeredCount: row.answeredCount,
        bestStreak: row.bestStreak,
        rank: row.rank,
        lastAnswerMs: row.lastAnswerMs,
        joinedAt: row.joinedAt,
        disconnectedAt: row.rank === ranked.length ? minutesAgo(2) : null,
      },
    });
  }

  // ---- team aggregates -----------------------------------------------------
  for (const { team } of teams) {
    const members = ranked.filter((row) => row.teamId === team.id);
    const total = members.reduce((sum, row) => sum + row.score, 0);
    await prisma.team.update({ where: { id: team.id }, data: { score: total } });
  }
  if (teams.length) {
    const ordered = [...teams].sort((a, b) => {
      const scoreA = ranked.filter((row) => row.teamId === a.team.id).reduce((sum, row) => sum + row.score, 0);
      const scoreB = ranked.filter((row) => row.teamId === b.team.id).reduce((sum, row) => sum + row.score, 0);
      return scoreB - scoreA;
    });
    for (const [rank, item] of ordered.entries()) {
      await prisma.team.update({ where: { id: item.team.id }, data: { rank: rank + 1 } });
    }
  }

  // ---- per-question results -------------------------------------------------
  const examQuestions = await prisma.examQuestion.findMany({
    where: { examId: exam.id },
    orderBy: { order: 'asc' },
    include: { question: true },
  });

  let resultCount = 0;
  for (const [questionIndex, examQuestion] of examQuestions.entries()) {
    const question = examQuestion.question;
    const optionCounts = distributeOptions(question, ranked, random);
    const correctCount = ranked.filter((row) => row.correctCount > questionIndex ? random.bool(0.62) : random.bool(0.2)).length;

    await prisma.liveQuizQuestionResult.upsert({
      where: { id: `seed-lqres-${session.id}-${questionIndex + 1}` },
      update: {},
      create: {
        id: `seed-lqres-${session.id}-${questionIndex + 1}`,
        sessionId: session.id,
        questionId: question.id,
        questionIndex,
        optionCounts,
        answerCount: questionIndex <= session.currentQuestionIndex ? ranked.length : 0,
        correctCount: questionIndex <= session.currentQuestionIndex ? correctCount : 0,
        avgResponseMs: questionIndex <= session.currentQuestionIndex ? random.int(3200, 15_400) : null,
        closedAt: questionIndex <= session.currentQuestionIndex ? minutesAgo(5 - questionIndex) : null,
        updatedById: entry.author.id,
      },
    });
    resultCount += 1;
  }

  ctx.liveQuizSession = session;
  ctx.liveQuizParticipantCount = ranked.length;
  console.log(`  · live quiz "${session.code}" with ${ranked.length} players, ${teams.length} teams, ${resultCount} question results`);
};

/** Bucket the answers of the seeded players over the option space of a question. */
function distributeOptions(question, ranked, random) {
  const content = question.content ?? {};
  const counts = {};

  if (Array.isArray(content.options) && content.options.length) {
    for (const option of content.options) {
      counts[option.id ?? option.text] = 0;
    }
    for (const row of ranked) {
      const keys = Object.keys(counts);
      const preferred = content.correctOptionId ?? content.correctOptionIds?.[0];
      const key = random.bool(preferred ? 0.55 : 0.4) && preferred
        ? preferred
        : random.pick(keys);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  if (question.type === 'TRUE_FALSE') {
    counts.true = ranked.filter(() => random.bool(0.7)).length;
    counts.false = ranked.length - counts.true;
    return counts;
  }

  if (question.type === 'RATING_SCALE' || question.type === 'LIKERT_SCALE') {
    const min = content.min ?? 1;
    const max = content.max ?? 5;
    for (let value = min; value <= max; value += 1) counts[String(value)] = 0;
    for (const row of ranked) {
      const value = Math.min(max, Math.max(min, random.int(Math.ceil(max * 0.5), max)));
      counts[String(value)] += 1;
    }
    return counts;
  }

  counts.matched = Math.max(1, Math.round(ranked.length * 0.6));
  counts.unmatched = Math.max(0, ranked.length - counts.matched);
  return counts;
}
