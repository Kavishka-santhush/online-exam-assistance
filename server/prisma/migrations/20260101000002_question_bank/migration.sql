-- ===========================================================================
-- Migration 20260101000002_question_bank
-- Categories, banks, sharing, questions, question versions, review workflow.
-- ===========================================================================

CREATE TABLE "QuestionCategory" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "level" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionBank" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBank_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionBankShare" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "bankId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "access" "public"."BankAccess" NOT NULL DEFAULT 'VIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionBankShare_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Question" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "bankId" TEXT,
    "categoryId" TEXT,
    "createdById" TEXT NOT NULL,
    "type" "public"."QuestionType" NOT NULL,
    "status" "public"."QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "prompt" TEXT NOT NULL,
    "promptPlain" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "explanation" TEXT,
    "solution" TEXT,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audioUrl" TEXT,
    "videoUrl" TEXT,
    "youtubeUrl" TEXT,
    "marks" DECIMAL(7,2) NOT NULL DEFAULT 1,
    "negativePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "partialMarking" BOOLEAN NOT NULL DEFAULT false,
    "difficulty" "public"."Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "bloomsLevel" "public"."BloomsLevel",
    "estimatedTimeSec" INTEGER NOT NULL DEFAULT 60,
    "hint" TEXT,
    "hintCostMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'en',
    "learningObjectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topicTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codeConfig" JSONB,
    "rubricCriteria" JSONB NOT NULL DEFAULT '[]',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "timesAnswered" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "avgScorePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "difficultyIndex" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "discriminationIndex" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "avgTimeSec" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "skipRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "isDeprecated" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionVersion" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "questionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "marks" DECIMAL(7,2) NOT NULL,
    "changeNote" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionReview" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "questionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "action" "public"."ReviewAction" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionReview_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "QuestionCategory_organizationId_slug_key" ON "QuestionCategory"("organizationId", "slug");
CREATE INDEX "QuestionCategory_organizationId_parentId_idx" ON "QuestionCategory"("organizationId", "parentId");
CREATE UNIQUE INDEX "QuestionBank_organizationId_slug_key" ON "QuestionBank"("organizationId", "slug");
CREATE INDEX "QuestionBank_organizationId_isArchived_idx" ON "QuestionBank"("organizationId", "isArchived");
CREATE INDEX "QuestionBank_ownerId_idx" ON "QuestionBank"("ownerId");
CREATE UNIQUE INDEX "QuestionBankShare_bankId_userId_key" ON "QuestionBankShare"("bankId", "userId");
CREATE INDEX "QuestionBankShare_userId_idx" ON "QuestionBankShare"("userId");
CREATE INDEX "Question_organizationId_status_idx" ON "Question"("organizationId", "status");
CREATE INDEX "Question_bankId_idx" ON "Question"("bankId");
CREATE INDEX "Question_type_difficulty_idx" ON "Question"("type", "difficulty");
CREATE INDEX "Question_createdById_idx" ON "Question"("createdById");
CREATE INDEX "Question_categoryId_idx" ON "Question"("categoryId");
CREATE INDEX "Question_createdAt_idx" ON "Question"("createdAt");
CREATE UNIQUE INDEX "QuestionVersion_questionId_version_key" ON "QuestionVersion"("questionId", "version");
CREATE INDEX "QuestionVersion_questionId_idx" ON "QuestionVersion"("questionId");
CREATE INDEX "QuestionReview_questionId_idx" ON "QuestionReview"("questionId");

-- Full-text / trigram search used by the question-bank search endpoints
CREATE INDEX "Question_prompt_trgm_idx" ON "Question" USING GIN ("prompt" gin_trgm_ops);
CREATE INDEX "Question_topicTags_gin_idx" ON "Question" USING GIN ("topicTags");
CREATE INDEX "Question_learningObjectives_gin_idx" ON "Question" USING GIN ("learningObjectives");
CREATE INDEX "Question_content_gin_idx" ON "Question" USING GIN ("content" jsonb_path_ops);

-- Foreign keys
ALTER TABLE "QuestionCategory" ADD CONSTRAINT "QuestionCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionCategory" ADD CONSTRAINT "QuestionCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "QuestionCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "QuestionCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBankShare" ADD CONSTRAINT "QuestionBankShare_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionBankShare" ADD CONSTRAINT "QuestionBankShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Question" ADD CONSTRAINT "Question_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuestionVersion" ADD CONSTRAINT "QuestionVersion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionVersion" ADD CONSTRAINT "QuestionVersion_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QuestionReview" ADD CONSTRAINT "QuestionReview_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionReview" ADD CONSTRAINT "QuestionReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
