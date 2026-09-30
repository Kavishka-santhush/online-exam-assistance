-- ===========================================================================
-- Migration 20260101000010_full_text_search
-- Full-text search plumbing: tsvector columns maintained by database
-- triggers (so the Prisma client never has to write them) + GIN indexes.
-- Combined with the pg_trgm GIN indexes created in earlier migrations this
-- backs question-bank search, exam catalog search and candidate search.
-- ===========================================================================

CREATE FUNCTION exam_platform_search_tsv(weighted_text TEXT, tags TEXT[])
RETURNS tsvector LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(weighted_text, '')), 'A') ||
         setweight(to_tsvector('english', coalesce(array_to_string(tags, ' '), '')), 'B');
$$;

-- --- Question --------------------------------------------------------------
ALTER TABLE "Question" ADD COLUMN "searchBlob" TSVECTOR;

CREATE FUNCTION question_search_blob_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchBlob" := exam_platform_search_tsv(
    coalesce(NEW."promptPlain", NEW."prompt") || ' ' || coalesce(NEW."explanation", ''),
    NEW."topicTags" || NEW."learningObjectives"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Question_search_blob_bi" BEFORE INSERT OR UPDATE OF "prompt", "promptPlain", "explanation", "topicTags", "learningObjectives"
ON "Question" FOR EACH ROW EXECUTE FUNCTION question_search_blob_fill();

UPDATE "Question" SET "prompt" = "prompt";

CREATE INDEX "Question_searchBlob_idx" ON "Question" USING GIN ("searchBlob");

-- --- Exam ------------------------------------------------------------------
ALTER TABLE "Exam" ADD COLUMN "searchBlob" TSVECTOR;

CREATE FUNCTION exam_search_blob_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchBlob" := exam_platform_search_tsv(
    NEW."title" || ' ' || coalesce(NEW."description", '') || ' ' || coalesce(NEW."instructions", ''),
    ARRAY[NEW."language"]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Exam_search_blob_bi" BEFORE INSERT OR UPDATE OF "title", "description", "instructions", "language"
ON "Exam" FOR EACH ROW EXECUTE FUNCTION exam_search_blob_fill();

UPDATE "Exam" SET "title" = "title";

CREATE INDEX "Exam_searchBlob_idx" ON "Exam" USING GIN ("searchBlob");

-- --- QuestionBank ----------------------------------------------------------
ALTER TABLE "QuestionBank" ADD COLUMN "searchBlob" TSVECTOR;

CREATE FUNCTION question_bank_search_blob_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchBlob" := exam_platform_search_tsv(
    NEW."name" || ' ' || coalesce(NEW."description", ''),
    NEW."tags"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "QuestionBank_search_blob_bi" BEFORE INSERT OR UPDATE OF "name", "description", "tags"
ON "QuestionBank" FOR EACH ROW EXECUTE FUNCTION question_bank_search_blob_fill();

UPDATE "QuestionBank" SET "name" = "name";

CREATE INDEX "QuestionBank_searchBlob_idx" ON "QuestionBank" USING GIN ("searchBlob");

-- --- Organization ----------------------------------------------------------
ALTER TABLE "Organization" ADD COLUMN "searchBlob" TSVECTOR;

CREATE FUNCTION organization_search_blob_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchBlob" := exam_platform_search_tsv(
    NEW."name" || ' ' || coalesce(NEW."description", '') || ' ' || coalesce(NEW."industry", ''),
    ARRAY[]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Organization_search_blob_bi" BEFORE INSERT OR UPDATE OF "name", "description", "industry"
ON "Organization" FOR EACH ROW EXECUTE FUNCTION organization_search_blob_fill();

UPDATE "Organization" SET "name" = "name";

CREATE INDEX "Organization_searchBlob_idx" ON "Organization" USING GIN ("searchBlob");

-- --- Fuzzy trigram lookups --------------------------------------------------
CREATE INDEX IF NOT EXISTS "QuestionBank_name_trgm_idx" ON "QuestionBank" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Exam_title_trgm_idx" ON "Exam" USING GIN ("title" gin_trgm_ops);
