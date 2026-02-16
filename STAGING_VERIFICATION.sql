-- =====================================================
-- STAGING VERIFICATION SCRIPT
-- Migration: 20260216054800_fix_acr_schema_conflicts
-- Run this AFTER deploying to AWS staging
-- =====================================================

\echo '=========================================='
\echo 'STAGING MIGRATION VERIFICATION'
\echo 'Migration: 20260216054800_fix_acr_schema_conflicts'
\echo '=========================================='
\echo ''

-- =====================================================
-- PART 1: MIGRATION STATUS CHECK
-- =====================================================

\echo '1. MIGRATION STATUS'
\echo '-------------------'
SELECT
    migration_name,
    finished_at,
    CASE
        WHEN migration_name = '20260216054800_fix_acr_schema_conflicts' THEN '✅ TARGET MIGRATION'
        ELSE '  Previous migration'
    END as status
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 10;

\echo ''
\echo '2. VERIFY TARGET MIGRATION APPLIED'
\echo '----------------------------------'
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM "_prisma_migrations"
            WHERE migration_name = '20260216054800_fix_acr_schema_conflicts'
            AND finished_at IS NOT NULL
        ) THEN '✅ MIGRATION APPLIED SUCCESSFULLY'
        ELSE '❌ MIGRATION NOT FOUND OR FAILED'
    END as migration_status;

\echo ''

-- =====================================================
-- PART 2: SCHEMA VERIFICATION
-- =====================================================

\echo '=========================================='
\echo 'SCHEMA VERIFICATION'
\echo '=========================================='
\echo ''

\echo '3. CRITERIONCHANGELOG COLUMNS'
\echo '------------------------------'
SELECT
    column_name,
    data_type,
    is_nullable,
    CASE
        WHEN column_name IN ('acrJobId', 'fieldName', 'changedAt') THEN '✅ NEW'
        WHEN column_name IN ('criterionReviewId', 'jobId', 'changeType', 'reason', 'createdAt') THEN '❌ SHOULD BE REMOVED'
        ELSE '  '
    END as status
FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog'
ORDER BY ordinal_position;

\echo ''
\echo '4. VERIFY OLD COLUMNS REMOVED'
\echo '------------------------------'
SELECT
    CASE
        WHEN COUNT(*) = 0 THEN '✅ All old columns removed'
        ELSE '❌ Found ' || COUNT(*) || ' old columns that should be removed'
    END as result
FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog'
AND column_name IN ('criterionReviewId', 'jobId', 'changeType', 'reason', 'createdAt');

\echo ''
\echo '5. VERIFY NEW COLUMNS EXIST'
\echo '----------------------------'
SELECT
    CASE
        WHEN COUNT(*) = 3 THEN '✅ All 3 new columns exist'
        ELSE '❌ Expected 3 columns, found ' || COUNT(*)
    END as result
FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog'
AND column_name IN ('acrJobId', 'fieldName', 'changedAt');

\echo ''
\echo '6. ACRCRITERIONREVIEW NULL CHECK'
\echo '--------------------------------'
SELECT
    COUNT(*) as total_records,
    COUNT("level") as has_level,
    COUNT("aiStatus") as has_aistatus,
    COUNT(*) - COUNT("level") as null_level_count,
    COUNT(*) - COUNT("aiStatus") as null_aistatus_count,
    CASE
        WHEN COUNT(*) = COUNT("level") AND COUNT(*) = COUNT("aiStatus") THEN '✅ NO NULLS'
        ELSE '❌ FOUND NULLS'
    END as status
FROM "AcrCriterionReview";

\echo ''
\echo '7. ACRJOB OLD COLUMNS CHECK'
\echo '---------------------------'
SELECT
    CASE
        WHEN COUNT(*) = 0 THEN '✅ Old summary columns removed'
        ELSE '❌ Found ' || COUNT(*) || ' old columns'
    END as result
FROM information_schema.columns
WHERE table_name = 'AcrJob'
AND column_name IN ('applicableCriteria', 'passedCriteria', 'failedCriteria', 'naCriteria');

\echo ''

-- =====================================================
-- PART 3: CONSTRAINTS AND INDEXES
-- =====================================================

\echo '=========================================='
\echo 'CONSTRAINTS AND INDEXES'
\echo '=========================================='
\echo ''

\echo '8. UNIQUE CONSTRAINTS'
\echo '---------------------'
SELECT
    conname as constraint_name,
    conrelid::regclass as table_name,
    '✅' as status
FROM pg_constraint
WHERE conname IN (
    'AcrCriterionReview_acrJobId_criterionId_key',
    'AcrJob_tenantId_jobId_key'
);

\echo ''
\echo '9. VERIFY BOTH CONSTRAINTS EXIST'
\echo '---------------------------------'
SELECT
    CASE
        WHEN COUNT(*) = 2 THEN '✅ Both unique constraints exist'
        ELSE '❌ Expected 2 constraints, found ' || COUNT(*)
    END as result
FROM pg_constraint
WHERE conname IN (
    'AcrCriterionReview_acrJobId_criterionId_key',
    'AcrJob_tenantId_jobId_key'
);

\echo ''
\echo '10. CRITERIONCHANGELOG INDEXES'
\echo '-------------------------------'
SELECT
    indexname as index_name,
    tablename,
    '✅' as status
FROM pg_indexes
WHERE tablename = 'CriterionChangeLog'
AND indexname IN (
    'CriterionChangeLog_acrJobId_idx',
    'CriterionChangeLog_changedAt_idx'
);

\echo ''

-- =====================================================
-- PART 4: DATA INTEGRITY CHECKS
-- =====================================================

\echo '=========================================='
\echo 'DATA INTEGRITY CHECKS'
\echo '=========================================='
\echo ''

\echo '11. CRITERIONCHANGELOG NULL acrJobId CHECK'
\echo '------------------------------------------'
SELECT
    COUNT(*) as null_acrjobid_count,
    CASE
        WHEN COUNT(*) = 0 THEN '✅ NO NULL acrJobIds (correct!)'
        ELSE '❌ FOUND ' || COUNT(*) || ' NULL acrJobIds'
    END as status
FROM "CriterionChangeLog"
WHERE "acrJobId" IS NULL;

\echo ''
\echo '12. DUPLICATE RECORDS CHECK'
\echo '---------------------------'
-- Check AcrJob duplicates
WITH acr_job_dupes AS (
    SELECT "tenantId", "jobId", COUNT(*) as dup_count
    FROM "AcrJob"
    GROUP BY "tenantId", "jobId"
    HAVING COUNT(*) > 1
),
acr_review_dupes AS (
    SELECT "acrJobId", "criterionId", COUNT(*) as dup_count
    FROM "AcrCriterionReview"
    GROUP BY "acrJobId", "criterionId"
    HAVING COUNT(*) > 1
)
SELECT
    'AcrJob' as table_name,
    COUNT(*) as duplicate_groups,
    CASE WHEN COUNT(*) = 0 THEN '✅' ELSE '❌' END as status
FROM acr_job_dupes
UNION ALL
SELECT
    'AcrCriterionReview',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN '✅' ELSE '❌' END
FROM acr_review_dupes;

\echo ''

-- =====================================================
-- PART 5: ARCHIVE TABLE VERIFICATION
-- =====================================================

\echo '=========================================='
\echo 'ARCHIVE TABLE VERIFICATION'
\echo '=========================================='
\echo ''

\echo '13. ARCHIVE TABLE EXISTS'
\echo '------------------------'
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'CriterionChangeLog_Archive'
        ) THEN '✅ Archive table exists'
        ELSE '❌ Archive table NOT found'
    END as result;

\echo ''
\echo '14. ARCHIVED RECORDS COUNT'
\echo '--------------------------'
SELECT
    COUNT(*) as total_archived,
    COUNT(CASE WHEN migration_name = '20260216054800_fix_acr_schema_conflicts' THEN 1 END) as from_this_migration,
    MIN(archived_at) as first_archived,
    MAX(archived_at) as last_archived,
    CASE
        WHEN COUNT(*) = 0 THEN '✅ No orphaned records (clean data)'
        ELSE '✅ ' || COUNT(*) || ' orphaned records archived'
    END as status
FROM "CriterionChangeLog_Archive";

\echo ''
\echo '15. SAMPLE ARCHIVED RECORDS'
\echo '---------------------------'
SELECT
    id,
    archived_at,
    migration_name,
    reason,
    (original_data->>'id')::text as original_record_id,
    (original_data->>'criterionId')::text as criterion_id
FROM "CriterionChangeLog_Archive"
WHERE migration_name = '20260216054800_fix_acr_schema_conflicts'
ORDER BY archived_at DESC
LIMIT 5;

\echo ''

-- =====================================================
-- PART 6: RECORD COUNTS SUMMARY
-- =====================================================

\echo '=========================================='
\echo 'RECORD COUNTS SUMMARY'
\echo '=========================================='
\echo ''

\echo '16. TABLE RECORD COUNTS'
\echo '-----------------------'
SELECT
    'AcrJob' as table_name,
    COUNT(*) as total_records
FROM "AcrJob"
UNION ALL
SELECT
    'AcrCriterionReview',
    COUNT(*)
FROM "AcrCriterionReview"
UNION ALL
SELECT
    'CriterionChangeLog',
    COUNT(*)
FROM "CriterionChangeLog"
UNION ALL
SELECT
    'CriterionChangeLog_Archive',
    COUNT(*)
FROM "CriterionChangeLog_Archive";

\echo ''
\echo '17. CRITERIONCHANGELOG BREAKDOWN'
\echo '---------------------------------'
SELECT
    COUNT(*) as total_records,
    COUNT(CASE WHEN "acrJobId" IS NULL THEN 1 END) as null_acrjobid,
    COUNT(CASE WHEN "acrJobId" IS NOT NULL THEN 1 END) as has_acrjobid,
    COUNT(DISTINCT "acrJobId") as unique_acrjobs_referenced
FROM "CriterionChangeLog";

\echo ''

-- =====================================================
-- PART 7: FINAL HEALTH CHECK
-- =====================================================

\echo '=========================================='
\echo 'FINAL HEALTH CHECK'
\echo '=========================================='
\echo ''

\echo '18. OVERALL MIGRATION HEALTH'
\echo '-----------------------------'
WITH health_checks AS (
    SELECT
        'Migration Applied' as check_name,
        CASE WHEN EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260216054800_fix_acr_schema_conflicts' AND finished_at IS NOT NULL) THEN 1 ELSE 0 END as passed
    UNION ALL
    SELECT
        'Old Columns Removed',
        CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CriterionChangeLog' AND column_name IN ('criterionReviewId', 'jobId', 'changeType', 'reason', 'createdAt')) THEN 1 ELSE 0 END
    UNION ALL
    SELECT
        'New Columns Added',
        CASE WHEN (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'CriterionChangeLog' AND column_name IN ('acrJobId', 'fieldName', 'changedAt')) = 3 THEN 1 ELSE 0 END
    UNION ALL
    SELECT
        'No NULL acrJobIds',
        CASE WHEN NOT EXISTS (SELECT 1 FROM "CriterionChangeLog" WHERE "acrJobId" IS NULL) THEN 1 ELSE 0 END
    UNION ALL
    SELECT
        'Unique Constraints',
        CASE WHEN (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('AcrCriterionReview_acrJobId_criterionId_key', 'AcrJob_tenantId_jobId_key')) = 2 THEN 1 ELSE 0 END
    UNION ALL
    SELECT
        'No Duplicates',
        CASE WHEN NOT EXISTS (SELECT 1 FROM (SELECT "tenantId", "jobId" FROM "AcrJob" GROUP BY "tenantId", "jobId" HAVING COUNT(*) > 1) d) THEN 1 ELSE 0 END
    UNION ALL
    SELECT
        'Archive Table Exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CriterionChangeLog_Archive') THEN 1 ELSE 0 END
)
SELECT
    check_name,
    CASE WHEN passed = 1 THEN '✅ PASS' ELSE '❌ FAIL' END as status
FROM health_checks
ORDER BY
    CASE WHEN passed = 1 THEN 1 ELSE 0 END ASC,
    check_name;

\echo ''
\echo '19. MIGRATION SUCCESS SUMMARY'
\echo '------------------------------'
WITH health_checks AS (
    SELECT
        CASE WHEN EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260216054800_fix_acr_schema_conflicts' AND finished_at IS NOT NULL) THEN 1 ELSE 0 END +
        CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CriterionChangeLog' AND column_name IN ('criterionReviewId', 'jobId', 'changeType', 'reason', 'createdAt')) THEN 1 ELSE 0 END +
        CASE WHEN (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'CriterionChangeLog' AND column_name IN ('acrJobId', 'fieldName', 'changedAt')) = 3 THEN 1 ELSE 0 END +
        CASE WHEN NOT EXISTS (SELECT 1 FROM "CriterionChangeLog" WHERE "acrJobId" IS NULL) THEN 1 ELSE 0 END +
        CASE WHEN (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('AcrCriterionReview_acrJobId_criterionId_key', 'AcrJob_tenantId_jobId_key')) = 2 THEN 1 ELSE 0 END +
        CASE WHEN NOT EXISTS (SELECT 1 FROM (SELECT "tenantId", "jobId" FROM "AcrJob" GROUP BY "tenantId", "jobId" HAVING COUNT(*) > 1) d) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CriterionChangeLog_Archive') THEN 1 ELSE 0 END as total_passed
)
SELECT
    total_passed || '/7' as checks_passed,
    CASE
        WHEN total_passed = 7 THEN '🎉 ALL CHECKS PASSED - MIGRATION SUCCESSFUL!'
        WHEN total_passed >= 5 THEN '⚠️  MOSTLY OK - Review failed checks above'
        ELSE '❌ MIGRATION ISSUES - Review failed checks above'
    END as final_status
FROM health_checks;

\echo ''
\echo '=========================================='
\echo 'VERIFICATION COMPLETE'
\echo '=========================================='
\echo ''
\echo 'Next Steps:'
\echo '1. Review any ❌ FAIL items above'
\echo '2. Check application logs for errors'
\echo '3. Test ACR workflow functionality'
\echo '4. Monitor application for 30 minutes'
\echo ''
