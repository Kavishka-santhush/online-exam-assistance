-- ===========================================================================
-- Migration 20260101000008_live_quiz_analytics_ai
-- Live quiz sessions/teams/participants/results, analytics aggregates,
-- question statistics and AI usage logs.
-- ===========================================================================

CREATE TABLE "LiveQuizSession" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "organizationId" TEXT,
    "code" TEXT NOT NULL,
    "status" "public"."LiveQuizStatus" NOT NULL DEFAULT 'WAITING',
    "currentQuestionIndex" INTEGER NOT NULL DEFAULT 0,
    "questionTimeLimitSec" INTEGER NOT NULL DEFAULT 20,
    "leaderboardVisible" BOOLEAN NOT NULL DEFAULT true,
    "teamMode" BOOLEAN NOT NULL DEFAULT false,
    "allowMobileJoin" BOOLEAN NOT NULL DEFAULT true,
    "joinUrl" TEXT,
    "participantCount" INTEGER NOT NULL DEFAULT 0,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "reactionsJson" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "resultsSavedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveQuizSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Team" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "score" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveQuizParticipant" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "teamId" TEXT,
    "score" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "lastAnswerMs" INTEGER,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "LiveQuizParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveQuizQuestionResult" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionIndex" INTEGER NOT NULL DEFAULT 0,
    "optionCounts" JSONB NOT NULL DEFAULT '{}',
    "answerCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "avgResponseMs" INTEGER,
    "closedAt" TIMESTAMP(3),
    "updatedById" TEXT,

    CONSTRAINT "LiveQuizQuestionResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsAggregate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "scope" "public"."AnalyticsScope" NOT NULL,
    "organizationId" TEXT,
    "examId" TEXT,
    "userId" TEXT,
    "metric" TEXT NOT NULL,
    "dimension" JSONB NOT NULL DEFAULT '{}',
    "value" JSONB NOT NULL,
    "bucket" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsAggregate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionStat" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "questionId" TEXT NOT NULL,
    "examId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "incorrectCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "avgScorePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "avgTimeSec" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "difficultyIndex" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "discriminationIndex" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "optionDistribution" JSONB NOT NULL DEFAULT '{}',
    "hintUseCount" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionStat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT,
    "userId" TEXT,
    "examId" TEXT,
    "attemptId" TEXT,
    "questionId" TEXT,
    "feature" "public"."AiFeature" NOT NULL,
    "aiModel" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openrouter',
    "requestId" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "status" "public"."AiCallStatus" NOT NULL DEFAULT 'SUCCESS',
    "inputSummary" TEXT,
    "outputSummary" TEXT,
    "error" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "LiveQuizSession_code_key" ON "LiveQuizSession"("code");
CREATE INDEX "LiveQuizSession_examId_status_idx" ON "LiveQuizSession"("examId", "status");
CREATE INDEX "LiveQuizSession_status_createdAt_idx" ON "LiveQuizSession"("status", "createdAt");
CREATE INDEX "Team_sessionId_idx" ON "Team"("sessionId");
CREATE UNIQUE INDEX "LiveQuizParticipant_sessionId_userId_key" ON "LiveQuizParticipant"("sessionId", "userId");
CREATE INDEX "LiveQuizParticipant_sessionId_score_idx" ON "LiveQuizParticipant"("sessionId", "score");
CREATE INDEX "LiveQuizQuestionResult_sessionId_questionIndex_idx" ON "LiveQuizQuestionResult"("sessionId", "questionIndex");
CREATE INDEX "AnalyticsAggregate_scope_metric_bucket_idx" ON "AnalyticsAggregate"("scope", "metric", "bucket");
CREATE INDEX "AnalyticsAggregate_organizationId_createdAt_idx" ON "AnalyticsAggregate"("organizationId", "createdAt");
CREATE INDEX "AnalyticsAggregate_examId_metric_idx" ON "AnalyticsAggregate"("examId", "metric");
CREATE INDEX "AnalyticsAggregate_userId_metric_idx" ON "AnalyticsAggregate"("userId", "metric");
CREATE UNIQUE INDEX "QuestionStat_questionId_examId_key" ON "QuestionStat"("questionId", "examId");
CREATE INDEX "QuestionStat_examId_idx" ON "QuestionStat"("examId");
CREATE INDEX "QuestionStat_difficultyIndex_idx" ON "QuestionStat"("difficultyIndex");
CREATE INDEX "AiUsageLog_organizationId_createdAt_idx" ON "AiUsageLog"("organizationId", "createdAt");
CREATE INDEX "AiUsageLog_feature_createdAt_idx" ON "AiUsageLog"("feature", "createdAt");
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");
CREATE INDEX "AiUsageLog_status_idx" ON "AiUsageLog"("status");

-- Foreign keys
ALTER TABLE "LiveQuizSession" ADD CONSTRAINT "LiveQuizSession_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveQuizSession" ADD CONSTRAINT "LiveQuizSession_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveQuizSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveQuizParticipant" ADD CONSTRAINT "LiveQuizParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveQuizSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveQuizParticipant" ADD CONSTRAINT "LiveQuizParticipant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveQuizQuestionResult" ADD CONSTRAINT "LiveQuizQuestionResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveQuizSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveQuizQuestionResult" ADD CONSTRAINT "LiveQuizQuestionResult_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveQuizQuestionResult" ADD CONSTRAINT "LiveQuizQuestionResult_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalyticsAggregate" ADD CONSTRAINT "AnalyticsAggregate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsAggregate" ADD CONSTRAINT "AnalyticsAggregate_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsAggregate" ADD CONSTRAINT "AnalyticsAggregate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionStat" ADD CONSTRAINT "QuestionStat_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionStat" ADD CONSTRAINT "QuestionStat_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionStat" ADD CONSTRAINT "QuestionStat_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
