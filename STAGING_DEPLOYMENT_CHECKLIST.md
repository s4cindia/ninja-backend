# Staging Deployment Checklist
## PR #184 - ACR Schema Migration

**Use this checklist immediately after merging PR #184**

---

## ✅ Pre-Merge Checklist

- [ ] **CodeRabbit review complete** (waiting for final review)
- [ ] **All local tests pass** ✅ DONE
- [ ] **Team notified** about staging deployment
- [ ] **Time allocated** for monitoring (30-60 minutes)
- [ ] **AWS credentials ready** (can access AWS Console)

---

## 🚀 Merge & Deploy

### Step 1: Merge PR
```bash
# Option A: Via GitHub UI
# Go to https://github.com/s4cindia/ninja-backend/pull/184
# Click "Merge pull request"

# Option B: Via CLI
gh pr merge 184 --squash --delete-branch
```

- [ ] **PR merged** (timestamp: _____________)
- [ ] **Auto-deployment triggered** (check CI/CD pipeline)

### Step 2: Monitor Deployment
- [ ] **Deployment started** (timestamp: _____________)
- [ ] **Check deployment logs** (GitHub Actions / AWS CodePipeline / your CI/CD)
- [ ] **Deployment completed successfully** (timestamp: _____________)
- [ ] **No deployment errors** in logs

**Deployment URL:** Check your CI/CD for staging app URL

---

## 🔍 Verification Phase

### Step 3: Get Database Access

**Quick AWS Console Method:**

1. [ ] Go to [AWS RDS Console](https://console.aws.amazon.com/rds)
2. [ ] Click "Databases" → Find staging DB (e.g., `ninja-staging`)
3. [ ] Note the **Endpoint** (e.g., `xxx.abc.us-east-1.rds.amazonaws.com`)
4. [ ] Go to [Secrets Manager](https://console.aws.amazon.com/secretsmanager)
5. [ ] Find staging DB password secret → Retrieve password

**Record here:**
```
RDS Endpoint: _________________________________
Database Name: _________________________________
Username: _________________________________
Password: (from Secrets Manager)
```

**Quick Connection Test:**
```bash
# Set connection string
export STAGING_DATABASE_URL="postgresql://USERNAME:PASSWORD@ENDPOINT:5432/DATABASE?sslmode=require"

# Test connection (should return database name)
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT current_database();"
```

- [ ] **Connection successful** ✅

### Step 4: Run Quick Health Check (2 minutes)

```bash
# Navigate to your project
cd /c/Users/avrve/projects/ninja-workspace/ninja-backend-acr-fix

# Run quick check
npx prisma db execute --file quick_staging_check.sql --url "$STAGING_DATABASE_URL"
```

**Expected Output:**
```
✅ Migration applied
✅ No NULLs
✅ Archive table working
✅ Constraints OK
🎉 QUICK CHECK PASSED
```

- [ ] **Quick health check PASSED** ✅
- [ ] **All 5 checks show** ✅

**If any check shows ❌:** STOP and investigate before proceeding.

### Step 5: Run Full Verification (5 minutes)

```bash
# Create version without \echo (Prisma doesn't support it)
grep -v '^\\echo' STAGING_VERIFICATION.sql > STAGING_VERIFICATION_NOECHO.sql

# Run full verification
npx prisma db execute --file STAGING_VERIFICATION_NOECHO.sql --url "$STAGING_DATABASE_URL"
```

**Check the output for:**

- [ ] **Migration status:** `✅ MIGRATION APPLIED SUCCESSFULLY`
- [ ] **Schema verification:** All new columns exist, old columns removed
- [ ] **NULL check:** `✅ NO NULLS`
- [ ] **Constraints:** `✅ Both unique constraints exist`
- [ ] **Duplicates:** `✅ Both tables show 0 duplicate groups`
- [ ] **Archive table:** Exists and accessible
- [ ] **Final health:** `7/7 checks passed`

**Number of archived records:** _______ (may be 0, that's OK)

### Step 6: Check Specific Queries

```bash
# Check migration was applied
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<'EOF'
SELECT migration_name, finished_at
FROM "_prisma_migrations"
WHERE migration_name = '20260216054800_fix_acr_schema_conflicts';
EOF
```

- [ ] **Shows timestamp** (migration applied)

```bash
# Check CriterionChangeLog structure
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<'EOF'
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog'
ORDER BY ordinal_position;
EOF
```

- [ ] **Shows:** `id`, `criterionId`, `changedBy`, `previousValue`, `newValue`, `changedAt`, `acrJobId`, `fieldName`
- [ ] **Does NOT show:** `criterionReviewId`, `jobId`, `changeType`, `reason`, `createdAt`

---

## 🧪 Application Testing

### Step 7: Test ACR Functionality

**Navigate to staging app:** `https://your-staging-url.com`

- [ ] **App loads successfully** (no white screen of death)
- [ ] **Can login** to staging app
- [ ] **Navigate to ACR section** (jobs, reports, etc.)

**Create Test ACR Job:**

1. [ ] **Upload a test PDF/EPUB** (use a small test file)
2. [ ] **Start ACR analysis**
3. [ ] **Job completes successfully** (no errors)
4. [ ] **Can view ACR results**
5. [ ] **Can make changes to criteria** (tests CriterionChangeLog)

**Verify Database Updates:**
```bash
# Check if new changelog entries were created
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<'EOF'
SELECT COUNT(*), MAX("changedAt") as latest_change
FROM "CriterionChangeLog";
EOF
```

- [ ] **New changelog entries created** (count increased, recent timestamp)
- [ ] **No errors in application logs**

### Step 8: Check Application Logs

**CloudWatch Logs (if using):**
```bash
# Replace with your log group name
aws logs tail /aws/ecs/<your-app> --follow --since 30m --filter-pattern "ERROR"
```

- [ ] **No ERROR messages** related to database/ACR
- [ ] **No "column does not exist" errors**
- [ ] **No "relation does not exist" errors**

---

## 📊 Final Checks

### Step 9: Summary Verification

**Record these values:**

```
Total AcrJob records: _______
Total AcrCriterionReview records: _______
Total CriterionChangeLog records: _______
Total Archived records: _______

Migration applied at: _____________
Verification completed at: _____________
Duration: _______ minutes
```

- [ ] **All systems operational** ✅
- [ ] **No errors in past 30 minutes**
- [ ] **ACR workflow tested successfully**

---

## ✅ Success Criteria - ALL Must Pass

- [x] Local testing complete (done before merge)
- [ ] PR merged successfully
- [ ] Staging deployment successful
- [ ] Migration applied (shows in _prisma_migrations)
- [ ] 7/7 health checks PASS
- [ ] CriterionChangeLog schema correct (new columns, old removed)
- [ ] No NULL acrJobId values (0 count)
- [ ] Archive table exists and accessible
- [ ] No duplicate records
- [ ] ACR job creation works in UI
- [ ] Application logs clean (no errors)
- [ ] Monitoring for 30 minutes - stable

**Overall Status:**
- [ ] ✅ **STAGING DEPLOYMENT SUCCESSFUL** - Ready for production (when needed)
- [ ] ⚠️ **PARTIAL SUCCESS** - Minor issues, document and monitor
- [ ] ❌ **FAILED** - Rollback required

---

## 🚨 If Anything Fails

### Rollback Procedure

**ONLY if critical issues found:**

```bash
# 1. Connect to database
export STAGING_DATABASE_URL="postgresql://..."

# 2. Run rollback script
npx prisma db execute --file prisma/migrations/20260216054800_fix_acr_schema_conflicts/ROLLBACK.sql --url "$STAGING_DATABASE_URL"

# 3. Verify rollback
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<'EOF'
SELECT column_name FROM information_schema.columns
WHERE table_name = 'CriterionChangeLog';
EOF
```

**Expected after rollback:**
- Old columns restored: `criterionReviewId`, `jobId`, `changeType`, `createdAt`
- New columns removed: `acrJobId`, `fieldName`, `changedAt`

**Then:**
1. Document what failed
2. Notify team
3. Create issue with findings
4. Fix and create new PR

---

## 📝 Post-Deployment Notes

**Issues encountered:**
```
_______________________________________________________
_______________________________________________________
_______________________________________________________
```

**Resolution:**
```
_______________________________________________________
_______________________________________________________
_______________________________________________________
```

**Time to deploy:** _______ minutes
**Time to verify:** _______ minutes
**Total time:** _______ minutes

**Next steps:**
- [ ] Monitor staging for 24 hours
- [ ] Update team on success
- [ ] Continue with Phase 4 development
- [ ] (Later) Prepare for production deployment when needed

---

## 📞 Quick Reference

### Connection String Format
```bash
export STAGING_DATABASE_URL="postgresql://USERNAME:PASSWORD@ENDPOINT:5432/DATABASE?sslmode=require"
```

### Quick Test Query
```bash
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT current_database(), version();"
```

### Migration Status Check
```bash
npx prisma db execute --stdin --url "$STAGING_DATABASE_URL" <<< "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
```

### Health Check
```bash
npx prisma db execute --file quick_staging_check.sql --url "$STAGING_DATABASE_URL"
```

---

**DEPLOYMENT START TIME:** _____________
**DEPLOYMENT END TIME:** _____________
**VERIFIED BY:** _____________
**STATUS:** ________________
