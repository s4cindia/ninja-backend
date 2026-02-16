-- =====================================================
-- ACR Schema Migration ROLLBACK
-- Purpose: Undo changes from migration 20260216054800_fix_acr_schema_conflicts
-- WARNING: This may cause data loss. Use only if migration fails!
-- =====================================================

-- =====================================================
-- PART 1: Restore AcrJob columns
-- =====================================================

ALTER TABLE "AcrJob"
ADD COLUMN IF NOT EXISTS "applicableCriteria" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "passedCriteria" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "failedCriteria" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "naCriteria" INTEGER DEFAULT 0;

-- =====================================================
-- PART 2: Restore CriterionChangeLog old structure
-- =====================================================

-- Add back old columns
ALTER TABLE "CriterionChangeLog"
ADD COLUMN IF NOT EXISTS "criterionReviewId" TEXT,
ADD COLUMN IF NOT EXISTS "jobId" TEXT,
ADD COLUMN IF NOT EXISTS "changeType" TEXT,
ADD COLUMN IF NOT EXISTS "reason" TEXT;

-- Rename changedAt back to createdAt
ALTER TABLE "CriterionChangeLog"
RENAME COLUMN "changedAt" TO "createdAt";

-- Attempt to restore data (best effort - may not be 100% accurate)
-- WARNING: This recovery is best-effort and may not restore original criterionReviewId
-- if multiple AcrCriterionReview records exist for the same acrJobId.
-- Uses DISTINCT ON to select one review deterministically (most recent by createdAt).
-- NOTE: This is lossy if orphaned records were deleted (check CriterionChangeLog_Archive)
UPDATE "CriterionChangeLog" ccl
SET "criterionReviewId" = acr.id,
    "jobId" = acr."acrJobId",
    "changeType" = ccl."fieldName"
FROM (
  SELECT DISTINCT ON ("acrJobId") id, "acrJobId"
  FROM "AcrCriterionReview"
  ORDER BY "acrJobId", "createdAt" DESC
) acr
WHERE ccl."acrJobId" = acr."acrJobId";

-- Drop new columns
ALTER TABLE "CriterionChangeLog"
DROP COLUMN IF EXISTS "acrJobId",
DROP COLUMN IF EXISTS "fieldName";

-- Restore old indexes
CREATE INDEX IF NOT EXISTS "CriterionChangeLog_criterionReviewId_idx"
ON "CriterionChangeLog"("criterionReviewId");

CREATE INDEX IF NOT EXISTS "CriterionChangeLog_jobId_idx"
ON "CriterionChangeLog"("jobId");

CREATE INDEX IF NOT EXISTS "CriterionChangeLog_createdAt_idx"
ON "CriterionChangeLog"("createdAt");

-- Drop new indexes
DROP INDEX IF EXISTS "CriterionChangeLog_acrJobId_idx";
DROP INDEX IF EXISTS "CriterionChangeLog_changedAt_idx";

-- =====================================================
-- PART 3: Remove unique constraints
-- =====================================================

ALTER TABLE "AcrCriterionReview"
DROP CONSTRAINT IF EXISTS "AcrCriterionReview_acrJobId_criterionId_key";

ALTER TABLE "AcrJob"
DROP CONSTRAINT IF EXISTS "AcrJob_tenantId_jobId_key";

-- =====================================================
-- PART 4: Remove NOT NULL constraints from level and aiStatus
-- =====================================================

-- NOTE: DROP NOT NULL only removes the constraint, does not change existing values
-- Values set by forward migration ('A' and 'pending') will remain
ALTER TABLE "AcrCriterionReview"
ALTER COLUMN "level" DROP NOT NULL;

ALTER TABLE "AcrCriterionReview"
ALTER COLUMN "aiStatus" DROP NOT NULL;

-- Final rollback status messages
DO $$
BEGIN
  RAISE NOTICE 'ROLLBACK COMPLETE: Database restored to pre-migration state';
  RAISE WARNING 'NOTE: Some data may be lost, especially orphaned CriterionChangeLog records';
END$$;
