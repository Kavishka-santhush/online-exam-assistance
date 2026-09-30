-- ===========================================================================
-- Migration 20260101000003_exams
-- Exam categories, exams, versions, templates, sections, questions, pools,
-- candidate registrations.
-- ===========================================================================

CREATE TABLE "ExamCategory" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Exam" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "categoryId" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "thumbnailUrl" TEXT,
    "type" "public"."ExamType" NOT NULL DEFAULT 'TEST',
    "status" "public"."ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "accessControl" "public"."AccessControl" NOT NULL DEFAULT 'ORGANIZATION',
    "accessCode" TEXT,
    "inviteToken" TEXT,
    "previewToken" TEXT,
    "examFeeCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "refundPolicy" "public"."RefundPolicy" NOT NULL DEFAULT 'NO_REFUND',
    "certificationFeeCents" INTEGER NOT NULL DEFAULT 0,
    "totalMarks" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "passingPercent" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "perQuestionSec" INTEGER,
    "attemptLimit" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "resultsVisibleAt" TIMESTAMP(3),
    "resultVisibility" "public"."ResultVisibility" NOT NULL DEFAULT 'IMMEDIATELY',
    "gradeBoundaries" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "proctoringConfig" JSONB NOT NULL DEFAULT '{}',
    "adaptiveConfig" JSONB NOT NULL DEFAULT '{}',
    "scoringConfig" JSONB NOT NULL DEFAULT '{}',
    "accessibilityConfig" JSONB NOT NULL DEFAULT '{}',
    "isProctored" BOOLEAN NOT NULL DEFAULT false,
    "isAdaptive" BOOLEAN NOT NULL DEFAULT false,
    "isAutoGraded" BOOLEAN NOT NULL DEFAULT true,
    "answerReviewEnabled" BOOLEAN NOT NULL DEFAULT true,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT false,
    "negativeMarking" BOOLEAN NOT NULL DEFAULT false,
    "partialMarking" BOOLEAN NOT NULL DEFAULT false,
    "calculatorAllowed" BOOLEAN NOT NULL DEFAULT false,
    "scratchpadAllowed" BOOLEAN NOT NULL DEFAULT false,
    "attachmentAllowed" BOOLEAN NOT NULL DEFAULT false,
    "requireCamera" BOOLEAN NOT NULL DEFAULT false,
    "requireScreenShare" BOOLEAN NOT NULL DEFAULT false,
    "recordWebcam" BOOLEAN NOT NULL DEFAULT false,
    "recordScreen" BOOLEAN NOT NULL DEFAULT false,
    "maxCandidates" INTEGER NOT NULL DEFAULT 1000,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "gradesReleasedAt" TIMESTAMP(3),
    "clonedFromId" TEXT,
    "derivedFromTemplateId" TEXT,
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "totalRegistrations" INTEGER NOT NULL DEFAULT 0,
    "averageScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "passRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamVersion" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamTemplate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "structure" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamSection" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER,
    "questionCount" INTEGER NOT NULL DEFAULT 0,
    "poolSize" INTEGER,
    "pickCount" INTEGER,
    "randomFromPool" BOOLEAN NOT NULL DEFAULT false,
    "sectionMarks" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "canNavigateBack" BOOLEAN NOT NULL DEFAULT true,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamQuestion" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "sectionId" TEXT,
    "questionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "marks" DECIMAL(7,2) NOT NULL DEFAULT 1,
    "weightage" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "negativePercent" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamPool" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sectionId" TEXT NOT NULL,
    "bankId" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "pickCount" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamPool_pkey" PRIMARY KEY ("id")
);

-- Implicit many-to-many between ExamPool and Question generated by Prisma
CREATE TABLE "_ExamPoolToQuestion" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE TABLE "ExamCandidate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "assignedById" TEXT,
    "inviteToken" TEXT,
    "paidAmountCents" INTEGER NOT NULL DEFAULT 0,
    "paymentId" TEXT,
    "seatNumber" INTEGER,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessGrantedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "withdrawalReason" TEXT,

    CONSTRAINT "ExamCandidate_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "ExamCategory_organizationId_slug_key" ON "ExamCategory"("organizationId", "slug");
CREATE INDEX "ExamCategory_organizationId_idx" ON "ExamCategory"("organizationId");
CREATE UNIQUE INDEX "Exam_organizationId_slug_key" ON "Exam"("organizationId", "slug");
CREATE UNIQUE INDEX "Exam_inviteToken_key" ON "Exam"("inviteToken");
CREATE UNIQUE INDEX "Exam_previewToken_key" ON "Exam"("previewToken");
CREATE INDEX "Exam_organizationId_status_idx" ON "Exam"("organizationId", "status");
CREATE INDEX "Exam_createdById_idx" ON "Exam"("createdById");
CREATE INDEX "Exam_type_status_idx" ON "Exam"("type", "status");
CREATE INDEX "Exam_startsAt_endsAt_idx" ON "Exam"("startsAt", "endsAt");
CREATE INDEX "Exam_status_publishedAt_idx" ON "Exam"("status", "publishedAt");
CREATE INDEX "Exam_createdAt_idx" ON "Exam"("createdAt");
CREATE UNIQUE INDEX "ExamVersion_examId_version_key" ON "ExamVersion"("examId", "version");
CREATE INDEX "ExamVersion_examId_idx" ON "ExamVersion"("examId");
CREATE INDEX "ExamTemplate_organizationId_idx" ON "ExamTemplate"("organizationId");
CREATE INDEX "ExamSection_examId_order_idx" ON "ExamSection"("examId", "order");
CREATE UNIQUE INDEX "ExamQuestion_examId_questionId_key" ON "ExamQuestion"("examId", "questionId");
CREATE INDEX "ExamQuestion_examId_order_idx" ON "ExamQuestion"("examId", "order");
CREATE INDEX "ExamQuestion_sectionId_idx" ON "ExamQuestion"("sectionId");
CREATE INDEX "ExamQuestion_questionId_idx" ON "ExamQuestion"("questionId");
CREATE INDEX "ExamPool_sectionId_idx" ON "ExamPool"("sectionId");
CREATE UNIQUE INDEX "_ExamPoolToQuestion_AB_unique" ON "_ExamPoolToQuestion"("A", "B");
CREATE INDEX "_ExamPoolToQuestion_B_index" ON "_ExamPoolToQuestion"("B");
CREATE UNIQUE INDEX "ExamCandidate_examId_userId_key" ON "ExamCandidate"("examId", "userId");
CREATE UNIQUE INDEX "ExamCandidate_inviteToken_key" ON "ExamCandidate"("inviteToken");
CREATE INDEX "ExamCandidate_examId_status_idx" ON "ExamCandidate"("examId", "status");
CREATE INDEX "ExamCandidate_userId_status_idx" ON "ExamCandidate"("userId", "status");

CREATE INDEX "Exam_title_trgm_idx" ON "Exam" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Exam_description_trgm_idx" ON "Exam" USING GIN ("description" gin_trgm_ops);

-- Foreign keys
ALTER TABLE "ExamCategory" ADD CONSTRAINT "ExamCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamCategory" ADD CONSTRAINT "ExamCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExamCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_clonedFromId_fkey" FOREIGN KEY ("clonedFromId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExamVersion" ADD CONSTRAINT "ExamVersion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamVersion" ADD CONSTRAINT "ExamVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExamTemplate" ADD CONSTRAINT "ExamTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTemplate" ADD CONSTRAINT "ExamTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamSection" ADD CONSTRAINT "ExamSection_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ExamSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExamQuestion" ADD CONSTRAINT "ExamQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamPool" ADD CONSTRAINT "ExamPool_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ExamSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamPool" ADD CONSTRAINT "ExamPool_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "_ExamPoolToQuestion" ADD CONSTRAINT "_ExamPoolToQuestion_A_fkey" FOREIGN KEY ("A") REFERENCES "ExamPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ExamPoolToQuestion" ADD CONSTRAINT "_ExamPoolToQuestion_B_fkey" FOREIGN KEY ("B") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamCandidate" ADD CONSTRAINT "ExamCandidate_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamCandidate" ADD CONSTRAINT "ExamCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamCandidate" ADD CONSTRAINT "ExamCandidate_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
