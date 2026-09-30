-- ===========================================================================
-- Migration 20260101000004_attempts
-- Exam attempts, per-question answers, scratch-pad notes, uploaded files.
-- ===========================================================================

CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "examVersion" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "registrationId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "gradingStatus" "public"."GradingStatus" NOT NULL DEFAULT 'UNGRADED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "gradedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "timeLimitSec" INTEGER,
    "extraTimeSec" INTEGER NOT NULL DEFAULT 0,
    "usedTimeSec" INTEGER NOT NULL DEFAULT 0,
    "remainingTimeSec" INTEGER,
    "rawScore" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "negativeDeducted" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "partialAwarded" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "totalMarks" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "finalScore" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "scorePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "passed" BOOLEAN,
    "gradeLetter" TEXT,
    "percentile" DECIMAL(5,2),
    "abilityScore" DECIMAL(7,3),
    "abilityStdErr" DECIMAL(7,3),
    "isAdaptive" BOOLEAN NOT NULL DEFAULT false,
    "adaptiveState" JSONB NOT NULL DEFAULT '{}',
    "answerOrder" JSONB NOT NULL DEFAULT '[]',
    "sectionProgress" JSONB NOT NULL DEFAULT '{}',
    "currentSectionId" TEXT,
    "currentQuestionOrder" INTEGER,
    "answeredCount" INTEGER NOT NULL DEFAULT 0,
    "markedForReview" JSONB NOT NULL DEFAULT '[]',
    "hintsRevealed" JSONB NOT NULL DEFAULT '[]',
    "lastAutoSaveAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "riskScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "isTerminated" BOOLEAN NOT NULL DEFAULT false,
    "terminatedById" TEXT,
    "terminationReason" TEXT,
    "terminatedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceInfo" JSONB NOT NULL DEFAULT '{}',
    "shareToken" TEXT,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Answer" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "examQuestionId" TEXT,
    "questionVersion" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "sectionId" TEXT,
    "response" JSONB NOT NULL DEFAULT '{}',
    "textAnswer" TEXT,
    "selectedOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedPairs" JSONB NOT NULL DEFAULT '[]',
    "orderedItems" JSONB NOT NULL DEFAULT '[]',
    "blankAnswers" JSONB NOT NULL DEFAULT '[]',
    "hotspotClicks" JSONB NOT NULL DEFAULT '[]',
    "codeLanguage" TEXT,
    "codeSource" TEXT,
    "testRunResults" JSONB,
    "ratingValue" INTEGER,
    "matrixResponses" JSONB NOT NULL DEFAULT '{}',
    "mathLatex" TEXT,
    "maxMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "autoScore" DECIMAL(7,2),
    "manualScore" DECIMAL(7,2),
    "finalScore" DECIMAL(7,2),
    "isCorrect" BOOLEAN,
    "isPartial" BOOLEAN,
    "gradingStatus" "public"."GradingStatus" NOT NULL DEFAULT 'UNGRADED',
    "needsManualGrading" BOOLEAN NOT NULL DEFAULT false,
    "gradedById" TEXT,
    "gradedAt" TIMESTAMP(3),
    "graderNote" TEXT,
    "feedback" TEXT,
    "secondScore" DECIMAL(7,2),
    "secondGraderNote" TEXT,
    "secondGradedById" TEXT,
    "disagreement" BOOLEAN NOT NULL DEFAULT false,
    "aiScore" DECIMAL(7,2),
    "aiFeedback" TEXT,
    "aiRubricScores" JSONB NOT NULL DEFAULT '{}',
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "timeSpentSec" INTEGER NOT NULL DEFAULT 0,
    "isMarkedForReview" BOOLEAN NOT NULL DEFAULT false,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "wasSkipped" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamNote" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT,
    "organizationId" TEXT,
    "examId" TEXT,
    "attemptId" TEXT,
    "questionId" TEXT,
    "answerId" TEXT,
    "certificateId" TEXT,
    "kind" "public"."MediaKind" NOT NULL,
    "url" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" INTEGER,
    "isScanned" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "Attempt_shareToken_key" ON "Attempt"("shareToken");
CREATE INDEX "Attempt_examId_status_idx" ON "Attempt"("examId", "status");
CREATE INDEX "Attempt_userId_createdAt_idx" ON "Attempt"("userId", "createdAt");
CREATE INDEX "Attempt_organizationId_createdAt_idx" ON "Attempt"("organizationId", "createdAt");
CREATE INDEX "Attempt_status_expiresAt_idx" ON "Attempt"("status", "expiresAt");
CREATE INDEX "Attempt_gradingStatus_idx" ON "Attempt"("gradingStatus");
CREATE INDEX "Attempt_examId_userId_attemptNumber_idx" ON "Attempt"("examId", "userId", "attemptNumber");
CREATE INDEX "Attempt_createdAt_idx" ON "Attempt"("createdAt");
CREATE UNIQUE INDEX "Answer_attemptId_questionId_key" ON "Answer"("attemptId", "questionId");
CREATE INDEX "Answer_attemptId_idx" ON "Answer"("attemptId");
CREATE INDEX "Answer_questionId_idx" ON "Answer"("questionId");
CREATE INDEX "Answer_gradingStatus_idx" ON "Answer"("gradingStatus");
CREATE INDEX "Answer_needsManualGrading_gradingStatus_idx" ON "Answer"("needsManualGrading", "gradingStatus");
CREATE UNIQUE INDEX "ExamNote_attemptId_key" ON "ExamNote"("attemptId");
CREATE INDEX "UploadedFile_userId_idx" ON "UploadedFile"("userId");
CREATE INDEX "UploadedFile_kind_idx" ON "UploadedFile"("kind");
CREATE INDEX "UploadedFile_attemptId_idx" ON "UploadedFile"("attemptId");
CREATE INDEX "UploadedFile_answerId_idx" ON "UploadedFile"("answerId");
CREATE INDEX "UploadedFile_createdAt_idx" ON "UploadedFile"("createdAt");

-- Foreign keys
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_terminatedById_fkey" FOREIGN KEY ("terminatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExamNote" ADD CONSTRAINT "ExamNote_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
