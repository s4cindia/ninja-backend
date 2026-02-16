-- =====================================================
-- ACR Schema Migration Fix
-- Purpose: Align database with schema.prisma changes
-- Addresses: Schema evolution mismatch from manual edits
-- =====================================================

-- =====================================================
-- PART 1: Fix AcrCriterionReview NULL values
-- =====================================================

-- Set default values for NULL level (WCAG Level A is most permissive)
UPDATE "AcrCriterionReview"
SET "level" = 'A'
WHERE "level" IS NULL;

-- Set default values for NULL aiStatus (pending review)
UPDATE "AcrCriterionReview"
SET "aiStatus" = 'pending'
WHERE "aiStatus" IS NULL;

-- Now make columns NOT NULL (schema requires this)
ALTER TABLE "AcrCriterionReview"
ALTER COLUMN "level" SET NOT NULL;

ALTER TABLE "AcrCriterionReview"
ALTER COLUMN "aiStatus" SET NOT NULL;

-- =====================================================
-- PART 2: Fix CriterionChangeLog schema refactoring
-- =====================================================

-- Step 2.1: Add new required columns (idempotent - safe to re-run)
ALTER TABLE "CriterionChangeLog"
ADD COLUMN IF NOT EXISTS "acrJobId" TEXT;

ALTER TABLE "CriterionChangeLog"
ADD COLUMN IF NOT EXISTS "fieldName" TEXT;

-- Step 2.2: Migrate data from old structure to new structure (idempotent)
-- Only update if old columns exist and new columns are NULL
UPDATE "CriterionChangeLog" ccl
SET "acrJobId" = acr."acrJobId"
FROM "AcrCriterionReview" acr
WHERE ccl."criterionReviewId" = acr.id
  AND ccl."acrJobId" IS NULL;

-- Map changeType → fieldName (only if fieldName is NULL)
UPDATE "CriterionChangeLog"
SET "fieldName" = COALESCE("changeType", 'unknown_field')
WHERE "fieldName" IS NULL;

-- Step 2.3: Log orphaned records before deletion (for audit trail)
DO $$
DECLARE
  orphaned_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphaned_count
  FROM "CriterionChangeLog"
  WHERE "acrJobId" IS NULL;

  IF orphaned_count > 0 THEN
    RAISE NOTICE 'WARNING: Deleting % orphaned CriterionChangeLog records where acrJobId could not be mapped', orphaned_count;
  END IF;
END$$;

-- Delete orphaned records that couldn't be mapped
DELETE FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;

-- Step 2.4: Make new columns NOT NULL (idempotent - checks for NULLs first)
DO $$
DECLARE
  null_acr_job_count INTEGER;
  null_field_count INTEGER;
BEGIN
  -- Check for NULL values before setting NOT NULL
  SELECT COUNT(*) INTO null_acr_job_count
  FROM "CriterionChangeLog"
  WHERE "acrJobId" IS NULL;

  SELECT COUNT(*) INTO null_field_count
  FROM "CriterionChangeLog"
  WHERE "fieldName" IS NULL;

  IF null_acr_job_count > 0 THEN
    RAISE EXCEPTION 'Cannot set acrJobId to NOT NULL: % rows have NULL values', null_acr_job_count;
  END IF;

  IF null_field_count > 0 THEN
    RAISE EXCEPTION 'Cannot set fieldName to NOT NULL: % rows have NULL values', null_field_count;
  END IF;

  -- Safe to set NOT NULL
  EXECUTE 'ALTER TABLE "CriterionChangeLog" ALTER COLUMN "acrJobId" SET NOT NULL';
  EXECUTE 'ALTER TABLE "CriterionChangeLog" ALTER COLUMN "fieldName" SET NOT NULL';

  RAISE NOTICE 'Set acrJobId and fieldName to NOT NULL';
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'NOT NULL constraints already exist, skipping';
END$$;

-- Step 2.5: Rename createdAt to changedAt (idempotent - conditional on column existence)
DO $$
BEGIN
  -- Only rename if createdAt exists and changedAt does not
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CriterionChangeLog'
    AND column_name = 'createdAt'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CriterionChangeLog'
    AND column_name = 'changedAt'
  ) THEN
    ALTER TABLE "CriterionChangeLog" RENAME COLUMN "createdAt" TO "changedAt";
    RAISE NOTICE 'Renamed createdAt to changedAt';
  ELSE
    RAISE NOTICE 'Column rename skipped (createdAt does not exist or changedAt already exists)';
  END IF;
END$$;

-- Step 2.6: Drop old columns that are no longer in schema (idempotent)
ALTER TABLE "CriterionChangeLog"
DROP COLUMN IF EXISTS "criterionReviewId",
DROP COLUMN IF EXISTS "jobId",
DROP COLUMN IF EXISTS "changeType",
DROP COLUMN IF EXISTS "reason";

-- Step 2.7: Add new indexes for the new columns
CREATE INDEX IF NOT EXISTS "CriterionChangeLog_acrJobId_idx"
ON "CriterionChangeLog"("acrJobId");

CREATE INDEX IF NOT EXISTS "CriterionChangeLog_changedAt_idx"
ON "CriterionChangeLog"("changedAt");

-- Drop old indexes that reference dropped columns
DROP INDEX IF EXISTS "CriterionChangeLog_criterionReviewId_idx";
DROP INDEX IF EXISTS "CriterionChangeLog_jobId_idx";
DROP INDEX IF EXISTS "CriterionChangeLog_createdAt_idx";

-- =====================================================
-- PART 3: Fix AcrJob schema changes (remove old columns)
-- Rationale: These columns were added in migration 20260207055432
-- but removed from schema.prisma during refactoring
-- =====================================================

ALTER TABLE "AcrJob"
DROP COLUMN IF EXISTS "applicableCriteria",
DROP COLUMN IF EXISTS "passedCriteria",
DROP COLUMN IF EXISTS "failedCriteria",
DROP COLUMN IF EXISTS "naCriteria";

-- =====================================================
-- PART 4: Fix duplicate data before adding unique constraints
-- =====================================================

-- Log duplicate records before deletion
DO $$
DECLARE
  acr_job_duplicates INTEGER;
  acr_review_duplicates INTEGER;
BEGIN
  -- Count AcrJob duplicates
  SELECT COUNT(*) INTO acr_job_duplicates
  FROM (
    SELECT "tenantId", "jobId", COUNT(*) as cnt
    FROM "AcrJob"
    GROUP BY "tenantId", "jobId"
    HAVING COUNT(*) > 1
  ) as dupes;

  IF acr_job_duplicates > 0 THEN
    RAISE NOTICE 'WARNING: Removing % duplicate AcrJob records (keeping most recent)', acr_job_duplicates;
  END IF;

  -- Count AcrCriterionReview duplicates
  SELECT COUNT(*) INTO acr_review_duplicates
  FROM (
    SELECT "acrJobId", "criterionId", COUNT(*) as cnt
    FROM "AcrCriterionReview"
    GROUP BY "acrJobId", "criterionId"
    HAVING COUNT(*) > 1
  ) as dupes;

  IF acr_review_duplicates > 0 THEN
    RAISE NOTICE 'WARNING: Removing % duplicate AcrCriterionReview records (keeping most recent)', acr_review_duplicates;
  END IF;
END$$;

-- Remove duplicate AcrJob records (keep most recent)
DELETE FROM "AcrJob" a USING "AcrJob" b
WHERE a."tenantId" = b."tenantId"
  AND a."jobId" = b."jobId"
  AND a."createdAt" < b."createdAt";

-- Remove duplicate AcrCriterionReview records (keep most recent)
DELETE FROM "AcrCriterionReview" a USING "AcrCriterionReview" b
WHERE a."acrJobId" = b."acrJobId"
  AND a."criterionId" = b."criterionId"
  AND a."createdAt" < b."createdAt";

-- =====================================================
-- PART 5: Add unique constraints to prevent future duplicates
-- =====================================================

-- Add unique constraint for AcrCriterionReview (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AcrCriterionReview_acrJobId_criterionId_key'
    ) THEN
        ALTER TABLE "AcrCriterionReview"
        ADD CONSTRAINT "AcrCriterionReview_acrJobId_criterionId_key"
        UNIQUE ("acrJobId", "criterionId");
        RAISE NOTICE 'Added unique constraint: AcrCriterionReview_acrJobId_criterionId_key';
    END IF;
END$$;

-- Add unique constraint for AcrJob (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'AcrJob_tenantId_jobId_key'
    ) THEN
        ALTER TABLE "AcrJob"
        ADD CONSTRAINT "AcrJob_tenantId_jobId_key"
        UNIQUE ("tenantId", "jobId");
        RAISE NOTICE 'Added unique constraint: AcrJob_tenantId_jobId_key';
    END IF;
END$$;

-- =====================================================
-- Final Verification
-- =====================================================

DO $$
DECLARE
  acr_total INTEGER;
  acr_has_level INTEGER;
  acr_has_status INTEGER;
  ccl_total INTEGER;
  ccl_has_job INTEGER;
  ccl_has_field INTEGER;
BEGIN
  -- Verify AcrCriterionReview
  SELECT COUNT(*), COUNT("level"), COUNT("aiStatus")
  INTO acr_total, acr_has_level, acr_has_status
  FROM "AcrCriterionReview";

  RAISE NOTICE 'AcrCriterionReview: % total, % have level, % have aiStatus', acr_total, acr_has_level, acr_has_status;

  IF acr_total != acr_has_level OR acr_total != acr_has_status THEN
    RAISE EXCEPTION 'Verification failed: AcrCriterionReview has NULL values in required fields';
  END IF;

  -- Verify CriterionChangeLog
  SELECT COUNT(*), COUNT("acrJobId"), COUNT("fieldName")
  INTO ccl_total, ccl_has_job, ccl_has_field
  FROM "CriterionChangeLog";

  RAISE NOTICE 'CriterionChangeLog: % total, % have acrJobId, % have fieldName', ccl_total, ccl_has_job, ccl_has_field;

  IF ccl_total != ccl_has_job OR ccl_total != ccl_has_field THEN
    RAISE EXCEPTION 'Verification failed: CriterionChangeLog has NULL values in required fields';
  END IF;

  RAISE NOTICE 'SUCCESS: All verifications passed!';
END$$;
