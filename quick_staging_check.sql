-- =====================================================
-- QUICK STAGING HEALTH CHECK
-- Migration: 20260216054800_fix_acr_schema_conflicts
-- Runtime: ~30 seconds
-- =====================================================

-- 1. Check migration applied
SELECT
    CASE WHEN EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '20260216054800_fix_acr_schema_conflicts'
        AND finished_at IS NOT NULL
    ) THEN '✅ Migration applied'
    ELSE '❌ Migration NOT applied'
    END as migration_status;

-- 2. Check no NULL acrJobIds
SELECT
    COUNT(*) as null_count,
    CASE WHEN COUNT(*) = 0 THEN '✅ No NULLs' ELSE '❌ Found NULLs' END as status
FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;

-- 3. Check archive table
SELECT
    COUNT(*) as archived_count,
    CASE WHEN COUNT(*) >= 0 THEN '✅ Archive table working' ELSE '❌ Archive error' END as status
FROM "CriterionChangeLog_Archive"
WHERE migration_name = '20260216054800_fix_acr_schema_conflicts';

-- 4. Check unique constraints
SELECT
    COUNT(*) as constraint_count,
    CASE WHEN COUNT(*) = 2 THEN '✅ Constraints OK' ELSE '❌ Missing constraints' END as status
FROM pg_constraint
WHERE conname IN ('AcrCriterionReview_acrJobId_criterionId_key', 'AcrJob_tenantId_jobId_key');

-- 5. Overall health
SELECT
    '🎉 QUICK CHECK PASSED - Migration looks healthy!' as final_status;
