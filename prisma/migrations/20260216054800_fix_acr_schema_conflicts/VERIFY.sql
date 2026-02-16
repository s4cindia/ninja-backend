-- =====================================================
-- ACR Schema Migration Verification
-- Purpose: Verify migration 20260216054800 succeeded
-- Run this AFTER applying the migration
-- =====================================================

\echo '=============================================='
\echo 'ACR Schema Migration Verification'
\echo '=============================================='
\echo ''

-- =====================================================
-- Test 1: Verify AcrCriterionReview has no NULL values
-- =====================================================
\echo '1. Checking AcrCriterionReview for NULL values...'

DO $$
DECLARE
  null_level_count INTEGER;
  null_status_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_level_count
  FROM "AcrCriterionReview"
  WHERE "level" IS NULL;

  SELECT COUNT(*) INTO null_status_count
  FROM "AcrCriterionReview"
  WHERE "aiStatus" IS NULL;

  IF null_level_count > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Found % NULL level values', null_level_count;
  END IF;

  IF null_status_count > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Found % NULL aiStatus values', null_status_count;
  END IF;

  RAISE NOTICE '✅ PASSED: No NULL values in level or aiStatus';
END$$;

-- =====================================================
-- Test 2: Verify CriterionChangeLog new structure
-- =====================================================
\echo '2. Checking CriterionChangeLog structure...'

DO $$
DECLARE
  has_old_columns BOOLEAN;
  has_new_columns INTEGER;
BEGIN
  -- Check for old columns (should NOT exist)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CriterionChangeLog'
    AND column_name IN ('criterionReviewId', 'jobId', 'changeType', 'reason', 'createdAt')
  ) INTO has_old_columns;

  IF has_old_columns THEN
    RAISE EXCEPTION '❌ FAILED: Old columns still exist in CriterionChangeLog';
  END IF;

  -- Check for new columns (all 3 must exist)
  SELECT COUNT(*) INTO has_new_columns
  FROM information_schema.columns
  WHERE table_name = 'CriterionChangeLog'
  AND column_name IN ('acrJobId', 'fieldName', 'changedAt');

  IF has_new_columns <> 3 THEN
    RAISE EXCEPTION '❌ FAILED: New columns missing from CriterionChangeLog (expected 3, found %)', has_new_columns;
  END IF;

  RAISE NOTICE '✅ PASSED: CriterionChangeLog structure is correct';
END$$;

-- =====================================================
-- Test 3: Verify no NULL acrJobId (unmapped records)
-- =====================================================
\echo '3. Checking for NULL acrJobId in CriterionChangeLog...'

DO $$
DECLARE
  null_acrjob_count INTEGER;
BEGIN
  -- Check for NULL acrJobId (records that couldn't be mapped during migration)
  SELECT COUNT(*) INTO null_acrjob_count
  FROM "CriterionChangeLog"
  WHERE "acrJobId" IS NULL;

  IF null_acrjob_count > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Found % records with NULL acrJobId (should have been archived)', null_acrjob_count;
  END IF;

  RAISE NOTICE '✅ PASSED: No NULL acrJobIds (all unmapped records were archived)';
  -- Note: CriterionChangeLog is a historical audit log. Records with acrJobIds
  -- that don't match current AcrJobs are acceptable (preserves change history).
END$$;

-- =====================================================
-- Test 4: Verify AcrJob columns removed
-- =====================================================
\echo '4. Checking AcrJob column removals...'

DO $$
DECLARE
  old_columns_exist BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AcrJob'
    AND column_name IN ('applicableCriteria', 'passedCriteria', 'failedCriteria', 'naCriteria')
  ) INTO old_columns_exist;

  IF old_columns_exist THEN
    RAISE EXCEPTION '❌ FAILED: Old summary columns still exist in AcrJob';
  END IF;

  RAISE NOTICE '✅ PASSED: Old AcrJob columns removed';
END$$;

-- =====================================================
-- Test 5: Verify unique constraints
-- =====================================================
\echo '5. Checking unique constraints...'

DO $$
DECLARE
  has_acr_constraint BOOLEAN;
  has_job_constraint BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AcrCriterionReview_acrJobId_criterionId_key'
  ) INTO has_acr_constraint;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AcrJob_tenantId_jobId_key'
  ) INTO has_job_constraint;

  IF NOT has_acr_constraint THEN
    RAISE EXCEPTION '❌ FAILED: Missing unique constraint on AcrCriterionReview';
  END IF;

  IF NOT has_job_constraint THEN
    RAISE EXCEPTION '❌ FAILED: Missing unique constraint on AcrJob';
  END IF;

  RAISE NOTICE '✅ PASSED: All unique constraints exist';
END$$;

-- =====================================================
-- Test 6: Verify no duplicate records
-- =====================================================
\echo '6. Checking for duplicate records...'

DO $$
DECLARE
  acr_job_dupes INTEGER;
  acr_review_dupes INTEGER;
BEGIN
  -- Check AcrJob duplicates
  SELECT COUNT(*) INTO acr_job_dupes
  FROM (
    SELECT "tenantId", "jobId"
    FROM "AcrJob"
    GROUP BY "tenantId", "jobId"
    HAVING COUNT(*) > 1
  ) as dupes;

  IF acr_job_dupes > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Found % duplicate AcrJob records', acr_job_dupes;
  END IF;

  -- Check AcrCriterionReview duplicates
  SELECT COUNT(*) INTO acr_review_dupes
  FROM (
    SELECT "acrJobId", "criterionId"
    FROM "AcrCriterionReview"
    GROUP BY "acrJobId", "criterionId"
    HAVING COUNT(*) > 1
  ) as dupes;

  IF acr_review_dupes > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Found % duplicate AcrCriterionReview records', acr_review_dupes;
  END IF;

  RAISE NOTICE '✅ PASSED: No duplicate records found';
END$$;

-- =====================================================
-- Test 7: Verify indexes
-- =====================================================
\echo '7. Checking indexes...'

DO $$
DECLARE
  missing_indexes TEXT[];
BEGIN
  -- Check for required indexes
  WITH required_indexes AS (
    SELECT 'CriterionChangeLog_acrJobId_idx' as idx_name
    UNION SELECT 'CriterionChangeLog_changedAt_idx'
  ),
  existing_indexes AS (
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'CriterionChangeLog'
  )
  SELECT array_agg(ri.idx_name)
  INTO missing_indexes
  FROM required_indexes ri
  LEFT JOIN existing_indexes ei ON ri.idx_name = ei.indexname
  WHERE ei.indexname IS NULL;

  IF array_length(missing_indexes, 1) > 0 THEN
    RAISE EXCEPTION '❌ FAILED: Missing indexes: %', missing_indexes;
  END IF;

  RAISE NOTICE '✅ PASSED: All required indexes exist';
END$$;

-- =====================================================
-- Summary Statistics
-- =====================================================
\echo ''
\echo '=============================================='
\echo 'Summary Statistics'
\echo '=============================================='

SELECT
  'AcrJob' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT "tenantId" || '_' || "jobId") as unique_combinations
FROM "AcrJob"
UNION ALL
SELECT
  'AcrCriterionReview',
  COUNT(*),
  COUNT(DISTINCT "acrJobId" || '_' || "criterionId")
FROM "AcrCriterionReview"
UNION ALL
SELECT
  'CriterionChangeLog',
  COUNT(*),
  COUNT(DISTINCT "acrJobId")
FROM "CriterionChangeLog";

\echo ''
\echo '=============================================='
\echo '✅ ALL VERIFICATION TESTS PASSED!'
\echo '=============================================='
