-- ===========================================================================
-- Migration 20260101000005_proctoring
-- Proctoring sessions, violation log, proctor<->candidate messaging,
-- exam recordings.
-- ===========================================================================

CREATE TABLE "ProctorSession" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."ProctorSessionStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "systemCheck" JSONB NOT NULL DEFAULT '{}',
    "idDocFrontUrl" TEXT,
    "idDocBackUrl" TEXT,
    "selfieUrl" TEXT,
    "environmentUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "faceMatchScore" DECIMAL(5,2),
    "termsAccepted" BOOLEAN NOT NULL DEFAULT false,
    "termsAcceptedAt" TIMESTAMP(3),
    "recordingConsent" BOOLEAN NOT NULL DEFAULT false,
    "lockdownEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fullscreenRequired" BOOLEAN NOT NULL DEFAULT true,
    "browserInfo" JSONB NOT NULL DEFAULT '{}',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProctorSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Violation" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "proctorSessionId" TEXT,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."ViolationType" NOT NULL,
    "severity" "public"."ViolationSeverity" NOT NULL DEFAULT 'MINOR',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "screenshotUrl" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "aiRiskScore" DECIMAL(5,2),
    "aiReason" TEXT,
    "manualFlag" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Violation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProctorMessage" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "proctorSessionId" TEXT,
    "examId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "kind" "public"."MessageKind" NOT NULL DEFAULT 'MESSAGE',
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamRecording" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "attemptId" TEXT NOT NULL,
    "proctorSessionId" TEXT,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "public"."RecordingKind" NOT NULL,
    "url" TEXT NOT NULL,
    "storagePath" TEXT,
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RECORDING',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamRecording_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "ProctorSession_attemptId_key" ON "ProctorSession"("attemptId");
CREATE INDEX "ProctorSession_examId_status_idx" ON "ProctorSession"("examId", "status");
CREATE INDEX "ProctorSession_status_createdAt_idx" ON "ProctorSession"("status", "createdAt");
CREATE INDEX "Violation_attemptId_occurredAt_idx" ON "Violation"("attemptId", "occurredAt");
CREATE INDEX "Violation_examId_type_idx" ON "Violation"("examId", "type");
CREATE INDEX "Violation_userId_idx" ON "Violation"("userId");
CREATE INDEX "Violation_severity_isResolved_idx" ON "Violation"("severity", "isResolved");
CREATE INDEX "Violation_occurredAt_idx" ON "Violation"("occurredAt");
CREATE INDEX "ProctorMessage_attemptId_createdAt_idx" ON "ProctorMessage"("attemptId", "createdAt");
CREATE INDEX "ProctorMessage_proctorSessionId_idx" ON "ProctorMessage"("proctorSessionId");
CREATE INDEX "ProctorMessage_toUserId_readAt_idx" ON "ProctorMessage"("toUserId", "readAt");
CREATE INDEX "ExamRecording_attemptId_kind_idx" ON "ExamRecording"("attemptId", "kind");
CREATE INDEX "ExamRecording_examId_idx" ON "ExamRecording"("examId");
CREATE INDEX "ExamRecording_createdAt_idx" ON "ExamRecording"("createdAt");

-- Foreign keys
ALTER TABLE "ProctorSession" ADD CONSTRAINT "ProctorSession_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProctorSession" ADD CONSTRAINT "ProctorSession_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Violation" ADD CONSTRAINT "Violation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Violation" ADD CONSTRAINT "Violation_proctorSessionId_fkey" FOREIGN KEY ("proctorSessionId") REFERENCES "ProctorSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Violation" ADD CONSTRAINT "Violation_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProctorMessage" ADD CONSTRAINT "ProctorMessage_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProctorMessage" ADD CONSTRAINT "ProctorMessage_proctorSessionId_fkey" FOREIGN KEY ("proctorSessionId") REFERENCES "ProctorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProctorMessage" ADD CONSTRAINT "ProctorMessage_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProctorMessage" ADD CONSTRAINT "ProctorMessage_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamRecording" ADD CONSTRAINT "ExamRecording_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamRecording" ADD CONSTRAINT "ExamRecording_proctorSessionId_fkey" FOREIGN KEY ("proctorSessionId") REFERENCES "ProctorSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
