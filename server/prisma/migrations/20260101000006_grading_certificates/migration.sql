-- ===========================================================================
-- Migration 20260101000006_grading_certificates
-- Rubrics, rubric scores, grading assignments, grade overrides, attempt
-- feedback, certificate templates, certificates and digital badges.
-- ===========================================================================

CREATE TABLE "GradingRubric" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "questionId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "totalMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "requireSecondGrader" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradingRubric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RubricScore" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "answerId" TEXT NOT NULL,
    "rubricId" TEXT,
    "criterionId" TEXT NOT NULL,
    "criterionName" TEXT,
    "marksAwarded" DECIMAL(7,2) NOT NULL,
    "maxMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "comment" TEXT,
    "graderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RubricScore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GradingAssignment" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "examId" TEXT NOT NULL,
    "attemptId" TEXT,
    "questionId" TEXT,
    "graderId" TEXT NOT NULL,
    "assignedById" TEXT,
    "status" "public"."GradingStatus" NOT NULL DEFAULT 'UNGRADED',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "isSecondGrader" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradingAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GradeOverride" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "answerId" TEXT,
    "previousScore" DECIMAL(7,2) NOT NULL,
    "newScore" DECIMAL(7,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "overrideById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttemptFeedback" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "kind" "public"."FeedbackKind" NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CertificateTemplate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "organizationId" TEXT NOT NULL,
    "examId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "backgroundImageUrl" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "certificateNo" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT,
    "candidateName" TEXT NOT NULL,
    "examTitle" TEXT NOT NULL,
    "scorePercent" DECIMAL(5,2) NOT NULL,
    "gradeLetter" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "status" "public"."CertificateStatus" NOT NULL DEFAULT 'PENDING',
    "pdfUrl" TEXT,
    "qrDataUrl" TEXT,
    "signatureHash" TEXT,
    "digitalSignature" JSONB NOT NULL DEFAULT '{}',
    "validityYears" INTEGER NOT NULL DEFAULT 3,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "verifyCount" INTEGER NOT NULL DEFAULT 0,
    "linkedInUrl" TEXT,
    "issuedById" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Badge" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "certificateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "criteria" JSONB NOT NULL DEFAULT '{}',
    "contextJson" JSONB NOT NULL DEFAULT '{}',
    "providerUrl" TEXT,
    "recipientEmail" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "GradingRubric_examId_idx" ON "GradingRubric"("examId");
CREATE INDEX "RubricScore_answerId_idx" ON "RubricScore"("answerId");
CREATE UNIQUE INDEX "GradingAssignment_examId_graderId_attemptId_key" ON "GradingAssignment"("examId", "graderId", "attemptId");
CREATE INDEX "GradingAssignment_graderId_status_idx" ON "GradingAssignment"("graderId", "status");
CREATE INDEX "GradingAssignment_examId_status_idx" ON "GradingAssignment"("examId", "status");
CREATE INDEX "GradeOverride_attemptId_idx" ON "GradeOverride"("attemptId");
CREATE INDEX "AttemptFeedback_attemptId_kind_idx" ON "AttemptFeedback"("attemptId", "kind");
CREATE UNIQUE INDEX "CertificateTemplate_examId_key" ON "CertificateTemplate"("examId");
CREATE INDEX "CertificateTemplate_organizationId_idx" ON "CertificateTemplate"("organizationId");
CREATE UNIQUE INDEX "Certificate_certificateNo_key" ON "Certificate"("certificateNo");
CREATE UNIQUE INDEX "Certificate_verifyToken_key" ON "Certificate"("verifyToken");
CREATE INDEX "Certificate_userId_status_idx" ON "Certificate"("userId", "status");
CREATE INDEX "Certificate_examId_idx" ON "Certificate"("examId");
CREATE INDEX "Certificate_organizationId_issuedAt_idx" ON "Certificate"("organizationId", "issuedAt");
CREATE INDEX "Certificate_status_expiresAt_idx" ON "Certificate"("status", "expiresAt");
CREATE UNIQUE INDEX "Badge_certificateId_key" ON "Badge"("certificateId");
CREATE INDEX "Badge_name_idx" ON "Badge"("name");

-- Foreign keys
ALTER TABLE "GradingRubric" ADD CONSTRAINT "GradingRubric_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradingRubric" ADD CONSTRAINT "GradingRubric_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RubricScore" ADD CONSTRAINT "RubricScore_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RubricScore" ADD CONSTRAINT "RubricScore_rubricId_fkey" FOREIGN KEY ("rubricId") REFERENCES "GradingRubric"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GradingAssignment" ADD CONSTRAINT "GradingAssignment_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradingAssignment" ADD CONSTRAINT "GradingAssignment_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradingAssignment" ADD CONSTRAINT "GradingAssignment_graderId_fkey" FOREIGN KEY ("graderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradingAssignment" ADD CONSTRAINT "GradingAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GradeOverride" ADD CONSTRAINT "GradeOverride_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradeOverride" ADD CONSTRAINT "GradeOverride_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GradeOverride" ADD CONSTRAINT "GradeOverride_overrideById_fkey" FOREIGN KEY ("overrideById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttemptFeedback" ADD CONSTRAINT "AttemptFeedback_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttemptFeedback" ADD CONSTRAINT "AttemptFeedback_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CertificateTemplate" ADD CONSTRAINT "CertificateTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CertificateTemplate" ADD CONSTRAINT "CertificateTemplate_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CertificateTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
