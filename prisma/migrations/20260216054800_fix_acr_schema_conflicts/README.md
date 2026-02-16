# Migration 20260216054800: Fix ACR Schema Conflicts

## Overview

This migration resolves schema conflicts that occurred when `schema.prisma` was manually edited without creating corresponding database migrations.

## Problem Statement

**What happened:**
1. Migration `20260207055432_add_review_edit_fields` added columns to `AcrJob` and created `CriterionChangeLog`
2. Someone manually edited `schema.prisma` to:
   - Remove `applicableCriteria`, `passedCriteria`, `failedCriteria`, `naCriteria` from `AcrJob`
   - Refactor `CriterionChangeLog` structure
3. **No migration was created** to reflect these changes
4. Result: Database and schema.prisma are out of sync → migrations fail

## Changes Applied

### 1. AcrCriterionReview
- Set default `level = 'A'` for NULL values (57 records affected)
- Set default `aiStatus = 'pending'` for NULL values (114 records affected)
- Made both columns NOT NULL as required by schema

### 2. CriterionChangeLog (Schema Refactoring)
**Old Structure:**
- `criterionReviewId` → Link to AcrCriterionReview
- `jobId` → Redundant job reference
- `changeType` → Type of change made
- `reason` → Free-text explanation
- `createdAt` → Timestamp

**New Structure:**
- `acrJobId` → Link to AcrJob (via lookup from criterionReviewId)
- `fieldName` → Which field changed (mapped from changeType)
- `changedAt` → Timestamp (renamed from createdAt)

**Data Migration:**
- Mapped `criterionReviewId` → `acrJobId` via `AcrCriterionReview.acrJobId`
- Mapped `changeType` → `fieldName`
- Deleted orphaned records where mapping failed

### 3. AcrJob
- Removed columns: `applicableCriteria`, `passedCriteria`, `failedCriteria`, `naCriteria`
- **Rationale:** These were added in migration `20260207055432` but removed from schema.prisma during refactoring. The summary counts are now calculated dynamically instead of stored.

### 4. Duplicate Removal
- Removed duplicate `AcrJob` records (kept most recent by `createdAt`)
- Removed duplicate `AcrCriterionReview` records (kept most recent)

### 5. Unique Constraints
- Added: `AcrCriterionReview (acrJobId, criterionId)` UNIQUE
- Added: `AcrJob (tenantId, jobId)` UNIQUE

## Pre-Flight Checklist

Before running this migration in production:

- [ ] Backup database: `pg_dump ninja > backup_pre_acr_fix.sql`
- [ ] Verify orphaned records count:
  ```sql
  SELECT COUNT(*) FROM "CriterionChangeLog" ccl
  LEFT JOIN "AcrCriterionReview" acr ON ccl."criterionReviewId" = acr.id
  WHERE acr.id IS NULL;
  ```
- [ ] Verify duplicate records:
  ```sql
  -- AcrJob duplicates
  SELECT "tenantId", "jobId", COUNT(*)
  FROM "AcrJob"
  GROUP BY "tenantId", "jobId"
  HAVING COUNT(*) > 1;

  -- AcrCriterionReview duplicates
  SELECT "acrJobId", "criterionId", COUNT(*)
  FROM "AcrCriterionReview"
  GROUP BY "acrJobId", "criterionId"
  HAVING COUNT(*) > 1;
  ```
- [ ] Review what will be deleted (export for audit):
  ```sql
  COPY (
    SELECT * FROM "CriterionChangeLog" ccl
    LEFT JOIN "AcrCriterionReview" acr ON ccl."criterionReviewId" = acr.id
    WHERE acr.id IS NULL
  ) TO '/tmp/orphaned_changelog.csv' CSV HEADER;
  ```

## Testing

### Local Testing
```bash
# 1. Apply migration
npx prisma migrate deploy

# 2. Verify schema matches
npx prisma db pull
git diff prisma/schema.prisma  # Should show no changes

# 3. Verify data integrity
psql -d ninja -f verify-migration.sql
```

### Staging Testing
```bash
# 1. Backup first!
pg_dump -h staging-db -U user ninja > backup_staging.sql

# 2. Apply migration
DATABASE_URL="postgresql://..." npx prisma migrate deploy

# 3. Smoke test ACR functionality
curl -X GET https://staging-api/api/v1/acr/jobs/:jobId
```

## Rollback Procedure

If migration fails or causes issues:

```bash
# Option 1: Use rollback script
psql -d ninja -f prisma/migrations/20260216054800_fix_acr_schema_conflicts/ROLLBACK.sql

# Option 2: Restore from backup
pg_restore -d ninja backup_pre_acr_fix.sql

# Option 3: Manual rollback (if needed)
npx prisma migrate resolve --rolled-back 20260216054800_fix_acr_schema_conflicts
```

**WARNING:** Rollback may cause data loss for orphaned records that were deleted.

## Impact Assessment

### Expected Impact
- **AcrCriterionReview:** 171 records updated (57 level + 114 aiStatus)
- **CriterionChangeLog:** Unknown number of orphaned records deleted
- **AcrJob:** Columns dropped (data remains in backup)
- **Duplicate records:** Removed (older versions lost)

### Risk Level: 🟡 MEDIUM
- **Data Loss:** Orphaned changelog records will be deleted
- **Downtime:** None (migration is fast, < 1 second)
- **Reversibility:** Partial (rollback script available but lossy)

### Mitigation
- Full database backup before migration
- Export orphaned records for audit trail
- Test in staging first
- Monitor application logs after deployment

## Post-Migration Verification

```sql
-- Verify no NULL constraints violations
SELECT COUNT(*) FROM "AcrCriterionReview" WHERE "level" IS NULL OR "aiStatus" IS NULL;
-- Expected: 0

-- Verify no orphaned changelog records
SELECT COUNT(*) FROM "CriterionChangeLog" ccl
LEFT JOIN "AcrJob" aj ON ccl."acrJobId" = aj.id
WHERE aj.id IS NULL;
-- Expected: 0

-- Verify unique constraints exist
SELECT conname FROM pg_constraint
WHERE conname IN ('AcrCriterionReview_acrJobId_criterionId_key', 'AcrJob_tenantId_jobId_key');
-- Expected: 2 rows

-- Verify column removals
SELECT column_name FROM information_schema.columns
WHERE table_name = 'AcrJob'
AND column_name IN ('applicableCriteria', 'passedCriteria', 'failedCriteria', 'naCriteria');
-- Expected: 0 rows
```

## Future Prevention

To prevent similar issues:

1. **Never manually edit schema.prisma without creating a migration**
2. Always use: `npx prisma migrate dev --name descriptive_name`
3. Review migration SQL before applying
4. Test migrations in local/staging before production

## Questions/Discussion

- **Why were the AcrJob columns removed?** The summary counts (`applicableCriteria`, etc.) are now calculated dynamically instead of stored. This follows the "single source of truth" principle and avoids stale data.

- **Why delete orphaned changelog records?** These records had `criterionReviewId` pointing to non-existent reviews. Keeping them would violate referential integrity and serve no purpose.

- **Can we recover deleted data?** Yes, from the pre-migration backup. The ROLLBACK script can restore the schema but won't recover deleted data.

## Author & Contact

- **Created:** 2026-02-16
- **Author:** Claude Code (Sonnet 4.5)
- **Reviewed By:** [Pending]
- **Approved By:** [Pending]
