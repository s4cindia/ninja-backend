-- =====================================================
-- ACR Schema Migration Fix
-- Purpose: Fix schema conflicts blocking Prisma migrations
-- Date: 2026-02-16
-- =====================================================

BEGIN;

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

-- Step 2.1: Add new required columns with temporary defaults
ALTER TABLE "CriterionChangeLog"
ADD COLUMN "acrJobId" TEXT;

ALTER TABLE "CriterionChangeLog"
ADD COLUMN "fieldName" TEXT;

-- Step 2.2: Migrate data from old structure to new structure
-- Map criterionReviewId → acrJobId by looking up the parent AcrJob
UPDATE "CriterionChangeLog" ccl
SET "acrJobId" = acr."acrJobId"
FROM "AcrCriterionReview" acr
WHERE ccl."criterionReviewId" = acr.id;

-- Map changeType → fieldName (use changeType as fieldName for now)
UPDATE "CriterionChangeLog"
SET "fieldName" = COALESCE("changeType", 'unknown_field');

-- Step 2.3: Handle rows where acrJobId couldn't be mapped (orphaned records)
-- Option A: Delete orphaned records
DELETE FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;

-- Option B: Set to a placeholder (commented out - use only if you need to keep records)
-- UPDATE "CriterionChangeLog"
-- SET "acrJobId" = '00000000-0000-0000-0000-000000000000'
-- WHERE "acrJobId" IS NULL;

-- Step 2.4: Now make new columns NOT NULL
ALTER TABLE "CriterionChangeLog"
ALTER COLUMN "acrJobId" SET NOT NULL;

ALTER TABLE "CriterionChangeLog"
ALTER COLUMN "fieldName" SET NOT NULL;

-- Step 2.5: Rename createdAt to changedAt (if schema expects it)
ALTER TABLE "CriterionChangeLog"
RENAME COLUMN "createdAt" TO "changedAt";

-- Step 2.6: Drop old columns that are no longer in schema
ALTER TABLE "CriterionChangeLog"
DROP COLUMN "criterionReviewId",
DROP COLUMN "jobId",
DROP COLUMN "changeType",
DROP COLUMN "reason";

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
-- =====================================================

-- Drop columns that schema no longer has
ALTER TABLE "AcrJob"
DROP COLUMN IF EXISTS "applicableCriteria",
DROP COLUMN IF EXISTS "passedCriteria",
DROP COLUMN IF EXISTS "failedCriteria",
DROP COLUMN IF EXISTS "naCriteria";

-- =====================================================
-- PART 4: Fix duplicate data before adding unique constraints
-- =====================================================

-- Remove duplicate AcrJob records (keep most recent)
DELETE FROM "AcrJob" a USING "AcrJob" b
WHERE a."tenantId" = b."tenantId"
  AND a."jobId" = b."jobId"
  AND a."createdAt" < b."createdAt";

-- Remove duplicate AcrCriterionReview records (keep most recent) if any
DELETE FROM "AcrCriterionReview" a USING "AcrCriterionReview" b
WHERE a."acrJobId" = b."acrJobId"
  AND a."criterionId" = b."criterionId"
  AND a."createdAt" < b."createdAt";

-- =====================================================
-- PART 5: Add new unique constraints
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
    END IF;
END$$;

-- =====================================================
-- Verification Queries
-- =====================================================

-- Check AcrCriterionReview
SELECT
    COUNT(*) as total,
    COUNT("level") as has_level,
    COUNT("aiStatus") as has_aistatus
FROM "AcrCriterionReview";

-- Check CriterionChangeLog
SELECT
    COUNT(*) as total,
    COUNT("acrJobId") as has_acrjobid,
    COUNT("fieldName") as has_fieldname
FROM "CriterionChangeLog";

COMMIT;

-- Success message
SELECT 'ACR Schema Migration Completed Successfully!' as status;
