-- ===========================================================================
-- Migration 00000000000000_init_identity
-- PostgreSQL extensions, every enum type, and the identity tables
-- (User, CandidateProfile, InstructorProfile).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
CREATE TYPE "public"."PlatformRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER');
CREATE TYPE "public"."MemberRole" AS ENUM ('ORG_ADMIN', 'INSTRUCTOR', 'PROCTOR', 'CANDIDATE');
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED');
CREATE TYPE "public"."InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
CREATE TYPE "public"."QuestionType" AS ENUM ('MULTIPLE_CHOICE', 'MULTIPLE_ANSWER', 'TRUE_FALSE', 'SHORT_ANSWER', 'LONG_ANSWER', 'FILL_BLANK', 'MATCHING', 'ORDERING', 'DROPDOWN', 'HOTSPOT', 'CODING', 'FILE_UPLOAD', 'AUDIO_RECORDING', 'VIDEO_RECORDING', 'MATH_FORMULA', 'DRAWING', 'LIKERT_SCALE', 'RATING_SCALE', 'MATRIX');
CREATE TYPE "public"."Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD', 'EXPERT');
CREATE TYPE "public"."BloomsLevel" AS ENUM ('REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE');
CREATE TYPE "public"."QuestionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "public"."ReviewAction" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CHANGES');
CREATE TYPE "public"."BankAccess" AS ENUM ('VIEW', 'EDIT', 'MANAGE');
CREATE TYPE "public"."ExamType" AS ENUM ('QUIZ', 'TEST', 'MOCK_EXAM', 'CERTIFICATION', 'PRACTICE', 'SURVEY', 'ASSIGNMENT', 'LIVE_QUIZ');
CREATE TYPE "public"."ExamStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED');
CREATE TYPE "public"."AccessControl" AS ENUM ('PUBLIC', 'ORGANIZATION', 'SPECIFIC_CANDIDATES', 'ACCESS_CODE', 'INVITE_LINK');
CREATE TYPE "public"."ResultVisibility" AS ENUM ('IMMEDIATELY', 'AFTER_ALL_SUBMIT', 'ON_DATE', 'NEVER');
CREATE TYPE "public"."RefundPolicy" AS ENUM ('NO_REFUND', 'BEFORE_WINDOW', 'ALWAYS_REFUNDABLE');
CREATE TYPE "public"."RegistrationStatus" AS ENUM ('PENDING', 'REGISTERED', 'INVITED', 'PAID', 'COMPLETED', 'WITHDRAWN');
CREATE TYPE "public"."AttemptStatus" AS ENUM ('IN_PROGRESS', 'PAUSED', 'SUBMITTED', 'AUTO_SUBMITTED', 'GRADED', 'TERMINATED', 'EXPIRED');
CREATE TYPE "public"."GradingStatus" AS ENUM ('NOT_REQUIRED', 'UNGRADED', 'IN_PROGRESS', 'GRADED', 'RELEASED');
CREATE TYPE "public"."ProctorSessionStatus" AS ENUM ('PENDING_SETUP', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'ENDED');
CREATE TYPE "public"."ViolationType" AS ENUM ('TAB_SWITCH', 'WINDOW_SWITCH', 'FULLSCREEN_EXIT', 'FACE_NOT_DETECTED', 'MULTIPLE_FACES', 'COPY_PASTE', 'CUT_ATTEMPT', 'RIGHT_CLICK', 'KEYBOARD_SHORTCUT', 'DEVTOOLS_OPENED', 'SECOND_DEVICE', 'AUDIO_DETECTED', 'GAZE_ANOMALY', 'NETWORK_ANOMALY', 'MOVEMENT_DETECTED', 'PROCTOR_FLAG', 'AI_SUSPICION');
CREATE TYPE "public"."ViolationSeverity" AS ENUM ('WARNING', 'MINOR', 'MAJOR', 'CRITICAL');
CREATE TYPE "public"."RecordingKind" AS ENUM ('WEBCAM', 'SCREEN', 'AUDIO_ANSWER', 'VIDEO_ANSWER');
CREATE TYPE "public"."MediaKind" AS ENUM ('AVATAR', 'ORG_LOGO', 'EXAM_THUMBNAIL', 'QUESTION_IMAGE', 'QUESTION_AUDIO', 'QUESTION_VIDEO', 'ANSWER_ATTACHMENT', 'ANSWER_DRAWING', 'ID_DOCUMENT', 'SELFIE', 'ENVIRONMENT_SCAN', 'VIOLATION_SCREENSHOT', 'WEBCAM_RECORDING', 'SCREEN_RECORDING', 'RESULT_PDF', 'CERTIFICATE_PDF', 'INVOICE_PDF', 'REPORT_PDF', 'IMPORT_FILE', 'EXPORT_FILE');
CREATE TYPE "public"."MessageKind" AS ENUM ('MESSAGE', 'WARNING', 'PAUSE', 'RESUME', 'TERMINATE', 'EXTRA_TIME', 'SYSTEM');
CREATE TYPE "public"."CertificateStatus" AS ENUM ('PENDING', 'ISSUED', 'REVOKED', 'EXPIRED');
CREATE TYPE "public"."PaymentProvider" AS ENUM ('STRIPE', 'MANUAL', 'PROMO');
CREATE TYPE "public"."PaymentPurpose" AS ENUM ('EXAM_FEE', 'SUBSCRIPTION', 'CERTIFICATION_FEE', 'BULK_SEATS', 'REFUND');
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "public"."PlanTier" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'INCOMPLETE');
CREATE TYPE "public"."PromoKind" AS ENUM ('PERCENT', 'FIXED', 'SCHOLARSHIP');
CREATE TYPE "public"."NotificationType" AS ENUM ('EXAM_ASSIGNED', 'EXAM_REMINDER', 'EXAM_STARTING', 'EXAM_WINDOW_CLOSING', 'RESULTS_RELEASED', 'GRADING_COMPLETED', 'CERTIFICATE_ISSUED', 'VIOLATION_FLAGGED', 'PROCTOR_MESSAGE', 'NEW_EXAM_PUBLISHED', 'REGISTRATION_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'ORGANIZATION_INVITE', 'ANNOUNCEMENT', 'AI_LIMIT_WARNING', 'SUBSCRIPTION_WARNING');
CREATE TYPE "public"."NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH');
CREATE TYPE "public"."LiveQuizStatus" AS ENUM ('WAITING', 'RUNNING', 'PAUSED', 'ENDED');
CREATE TYPE "public"."AnalyticsScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'EXAM', 'SECTION', 'QUESTION', 'CANDIDATE', 'TOPIC');
CREATE TYPE "public"."AiFeature" AS ENUM ('QUESTION_GENERATOR', 'ESSAY_GRADER', 'CODE_REVIEWER', 'CHEATING_DETECTION', 'DIFFICULTY_CALIBRATOR', 'QUALITY_CHECKER', 'ADAPTIVE_ENGINE', 'FEEDBACK_GENERATOR', 'RETAKE_COACH', 'BLUEPRINT_GENERATOR', 'ANSWER_KEY_VALIDATOR', 'BANK_RECOMMENDATION', 'NL_SEARCH', 'PASS_RATE_PREDICTOR', 'SUMMARY_REPORT', 'PROCTOR_ASSISTANT');
CREATE TYPE "public"."AiCallStatus" AS ENUM ('SUCCESS', 'ERROR', 'TIMEOUT', 'RATE_LIMITED', 'BLOCKED_LIMIT');
CREATE TYPE "public"."AnnouncementAudience" AS ENUM ('ALL_USERS', 'ORGANIZATION', 'EXAM_CANDIDATES', 'INSTRUCTORS');
CREATE TYPE "public"."FeedbackKind" AS ENUM ('AI_PERSONALIZED', 'AI_RETAKE_COACH', 'INSTRUCTOR_NOTE', 'AI_EXAM_SUMMARY');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE "User" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "displayName" TEXT,
    "imageUrl" TEXT,
    "coverImageUrl" TEXT,
    "bio" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "language" TEXT NOT NULL DEFAULT 'en',
    "phone" TEXT,
    "country" TEXT,
    "platformRole" "public"."PlatformRole" NOT NULL DEFAULT 'USER',
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isPublicProfile" BOOLEAN NOT NULL DEFAULT true,
    "searchVector" TEXT,
    "lastActiveAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CandidateProfile" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "headline" TEXT,
    "institution" TEXT,
    "degree" TEXT,
    "graduationYear" INTEGER,
    "educationJson" JSONB NOT NULL DEFAULT '[]',
    "skillsJson" JSONB NOT NULL DEFAULT '[]',
    "interestsJson" JSONB NOT NULL DEFAULT '[]',
    "goals" TEXT,
    "totalExams" INTEGER NOT NULL DEFAULT 0,
    "totalCertificates" INTEGER NOT NULL DEFAULT 0,
    "averageScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "studyTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstructorProfile" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "expertise" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" TEXT,
    "website" TEXT,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "totalExams" INTEGER NOT NULL DEFAULT 0,
    "totalCandidates" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "awardsBadge" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstructorProfile_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_email_idx" ON "User"("email");
CREATE INDEX "User_platformRole_status_idx" ON "User"("platformRole", "status");
CREATE INDEX "User_displayName_idx" ON "User"("displayName");
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
CREATE UNIQUE INDEX "CandidateProfile_userId_key" ON "CandidateProfile"("userId");
CREATE INDEX "CandidateProfile_institution_idx" ON "CandidateProfile"("institution");
CREATE UNIQUE INDEX "InstructorProfile_userId_key" ON "InstructorProfile"("userId");
CREATE INDEX "InstructorProfile_rating_idx" ON "InstructorProfile"("rating");

-- Trigram GIN indexes power the pg_trgm full-text search used by the API
CREATE INDEX "User_displayName_trgm_idx" ON "User" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX "User_email_trgm_idx" ON "User" USING GIN ("email" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstructorProfile" ADD CONSTRAINT "InstructorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
