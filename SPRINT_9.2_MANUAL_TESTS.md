# Sprint 9.2: Workflow Automation - Manual Testing Guide

## Test Environment Setup

### Prerequisites
1. ✅ Redis running (required for BullMQ queues)
2. ✅ Database migrated and seeded
3. ✅ Backend server running (`npm run dev`)
4. ✅ Frontend running (optional, for UI testing)
5. ✅ Workflow enabled for your tenant

### Enable Workflow for Tenant

```bash
# Option 1: Direct database update
psql -U postgres -d ninja_dev
UPDATE "Tenant" SET settings = jsonb_set(
  COALESCE(settings::jsonb, '{}'::jsonb),
  '{workflow,enabled}',
  'true'
) WHERE id = 'your-tenant-id';

# Option 2: API call (if tenant config endpoint exists)
curl -X PATCH http://localhost:5000/api/v1/tenant/config/workflow \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Verify Workers Running

```bash
# Check server logs for worker startup
# Expected output:
# ✅ Workflow automation worker started
# ✅ 7 workers started (or similar)
```

---

## Test Suite

### Test 1: Upload Triggers Workflow Creation
**Objective**: Verify file upload automatically creates a workflow instance

**Steps**:
1. Upload an EPUB or PDF file via API or UI
2. Note the file ID from response

**Verification**:
```sql
-- Check workflow created
SELECT id, "fileId", "currentState", "createdBy"
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Expected: 1 row with currentState = 'UPLOAD_RECEIVED' or 'PREPROCESSING'
```

**Expected Result**:
- ✅ WorkflowInstance created
- ✅ Initial state is UPLOAD_RECEIVED
- ✅ Auto-transitions to PREPROCESSING within seconds

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 2: Preprocessing → Audit Transition
**Objective**: Verify workflow auto-advances from PREPROCESSING to audit

**Steps**:
1. Wait 5-10 seconds after upload
2. Check workflow state

**Verification**:
```sql
SELECT id, "currentState", "stateData"
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Expected: currentState = 'RUNNING_EPUBCHECK' (EPUB) or 'RUNNING_MATTERHORN' (PDF)
```

**Expected Result**:
- ✅ State transitions to RUNNING_EPUBCHECK or RUNNING_MATTERHORN
- ✅ stateData contains file metadata

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 3: Audit Execution (EPUB)
**Objective**: Verify EPUBCheck + ACE + AI analysis runs automatically

**Steps**:
1. Wait 30-60 seconds for audit to complete
2. Check workflow state and job

**Verification**:
```sql
-- Check workflow state
SELECT "currentState", "stateData"::jsonb->'jobId' as job_id
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Check job created
SELECT id, type, status, "userId", "tenantId"
FROM "Job"
WHERE input::jsonb->>'fileId' = 'YOUR_FILE_ID';

-- Expected workflow state: 'AWAITING_AI_REVIEW' (HITL gate)
-- Expected job status: 'COMPLETED'
```

**Expected Result**:
- ✅ Job created with type 'EPUB_ACCESSIBILITY'
- ✅ Job status = COMPLETED
- ✅ Workflow state = AWAITING_AI_REVIEW
- ✅ jobId stored in workflow stateData

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 4: Audit Execution (PDF)
**Objective**: Verify Matterhorn + ACE runs automatically for PDFs

**Steps**:
1. Upload a PDF file
2. Wait 30-60 seconds for audit to complete
3. Check workflow state and job

**Verification**:
```sql
-- Same as Test 3, but expect:
-- Job type: 'PDF_ACCESSIBILITY'
-- Workflow state: 'AWAITING_AI_REVIEW'
```

**Expected Result**:
- ✅ Job created with type 'PDF_ACCESSIBILITY'
- ✅ Job status = COMPLETED
- ✅ Workflow state = AWAITING_AI_REVIEW

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 5: HITL Gate - AI Review Timeout
**Objective**: Verify HITL gate respects configured timeout

**Prerequisites**:
- Tenant workflow config has `hitlGates.AWAITING_AI_REVIEW` set (e.g., 10 seconds for testing)

**Steps**:
1. Wait for configured timeout + 5 seconds
2. Check if workflow auto-advanced

**Verification**:
```sql
SELECT "currentState", "createdAt", "updatedAt"
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Expected: currentState = 'AUTO_REMEDIATION'
```

**Expected Result**:
- ✅ Workflow auto-advances after timeout
- ✅ State = AUTO_REMEDIATION

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 6: Manual HITL Approval
**Objective**: Verify manual approval works (if timeout is disabled)

**Steps**:
1. Ensure workflow is in AWAITING_AI_REVIEW
2. Send approval event via API:
```bash
curl -X POST http://localhost:5000/api/v1/workflow/YOUR_WORKFLOW_ID/transition \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "AI_ACCEPTED"}'
```

**Verification**:
```sql
SELECT "currentState"
FROM "WorkflowInstance"
WHERE id = 'YOUR_WORKFLOW_ID';

-- Expected: AUTO_REMEDIATION
```

**Expected Result**:
- ✅ Workflow transitions to AUTO_REMEDIATION

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 7: Auto-Remediation Execution (EPUB)
**Objective**: Verify EPUB remediation runs and saves file

**Steps**:
1. Wait for remediation to complete (30-90 seconds)
2. Check remediated file saved

**Verification**:
```sql
-- Check workflow state
SELECT "currentState", "stateData"::jsonb->'remediationStats' as stats,
       "stateData"::jsonb->'remediatedFilePath' as remediated_path
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Expected state: 'AWAITING_REMEDIATION_REVIEW'
```

**Check File System** (if local storage):
```bash
# Find remediated file
ls -lh /path/to/uploads/*-remediated.epub
```

**Check S3** (if S3 storage):
```bash
aws s3 ls s3://your-bucket/remediated/ --recursive | grep YOUR_FILE
```

**Expected Result**:
- ✅ Remediated file saved (S3 or local)
- ✅ Workflow state = AWAITING_REMEDIATION_REVIEW
- ✅ stateData contains remediation stats (issuesFixed, issuesFailed)

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 8: Auto-Remediation Execution (PDF)
**Objective**: Verify PDF remediation runs and saves file

**Steps**:
1. Use a PDF workflow
2. Wait for remediation to complete
3. Verify remediated PDF saved

**Verification**:
```sql
-- Same as Test 7, but check for .pdf file
SELECT "currentState", "stateData"::jsonb->'remediationStats'
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_PDF_FILE_ID';
```

**Expected Result**:
- ✅ Remediated PDF saved
- ✅ Workflow state = AWAITING_REMEDIATION_REVIEW
- ✅ stateData contains remediation stats

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 9: Verification Audit
**Objective**: Verify remediated file is re-audited

**Steps**:
1. Approve remediation review (or wait for timeout)
2. Wait for verification audit to complete

**Verification**:
```sql
SELECT "currentState", "stateData"::jsonb->'verificationJobId' as verification_job
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Check verification job created
SELECT id, type, status
FROM "Job"
WHERE id = (
  SELECT "stateData"::jsonb->>'verificationJobId'
  FROM "WorkflowInstance"
  WHERE "fileId" = 'YOUR_FILE_ID'
);

-- Expected workflow state: 'CONFORMANCE_MAPPING'
-- Expected job status: 'COMPLETED'
```

**Expected Result**:
- ✅ Verification job created and completed
- ✅ Workflow state = CONFORMANCE_MAPPING

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 10: Conformance Mapping → ACR Generation
**Objective**: Verify conformance mapping triggers ACR generation

**Steps**:
1. Wait 5-10 seconds after CONFORMANCE_MAPPING
2. Check workflow progresses to ACR_GENERATION

**Verification**:
```sql
SELECT "currentState"
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Expected: 'ACR_GENERATION'
```

**Expected Result**:
- ✅ Auto-transitions to ACR_GENERATION

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 11: ACR Generation
**Objective**: Verify ACR/VPAT document is generated

**Steps**:
1. Wait 10-30 seconds for ACR generation
2. Verify ACR created in database

**Verification**:
```sql
-- Check workflow state
SELECT "currentState",
       "stateData"::jsonb->'acrJobId' as acr_job_id,
       "stateData"::jsonb->'acrEdition' as edition,
       "stateData"::jsonb->'acrCriteriaCount' as criteria_count
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- Check ACR job created
SELECT id, edition, status, "totalCriteria", "documentTitle"
FROM "AcrJob"
WHERE id = (
  SELECT "stateData"::jsonb->>'acrJobId'
  FROM "WorkflowInstance"
  WHERE "fileId" = 'YOUR_FILE_ID'
);

-- Check ACR criteria created
SELECT COUNT(*) as criteria_count
FROM "AcrCriterionReview"
WHERE "acrJobId" = (
  SELECT "stateData"::jsonb->>'acrJobId'
  FROM "WorkflowInstance"
  WHERE "fileId" = 'YOUR_FILE_ID'
);

-- Expected workflow state: 'AWAITING_ACR_SIGNOFF'
-- Expected ACR edition: 'VPAT2.5-INT'
-- Expected criteria count: ~50 (depends on edition)
```

**Expected Result**:
- ✅ AcrJob created
- ✅ Edition = 'VPAT2.5-INT' (International)
- ✅ Criteria count matches (~50 for VPAT2.5-INT)
- ✅ Workflow state = AWAITING_ACR_SIGNOFF
- ✅ acrJobId stored in workflow stateData

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 12: ACR Signoff (Manual)
**Objective**: Verify ACR signoff completes workflow

**Steps**:
1. Send ACR_SIGNED event:
```bash
curl -X POST http://localhost:5000/api/v1/workflow/YOUR_WORKFLOW_ID/transition \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "ACR_SIGNED"}'
```

**Verification**:
```sql
SELECT "currentState", "completedAt"
FROM "WorkflowInstance"
WHERE id = 'YOUR_WORKFLOW_ID';

-- Expected: currentState = 'COMPLETED'
-- completedAt should be set
```

**Expected Result**:
- ✅ Workflow state = COMPLETED
- ✅ completedAt timestamp set

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 13: End-to-End Workflow Events
**Objective**: Verify all workflow events are logged

**Verification**:
```sql
SELECT "eventType", "fromState", "toState", "createdAt"
FROM "WorkflowEvent"
WHERE "workflowId" = 'YOUR_WORKFLOW_ID'
ORDER BY "createdAt" ASC;
```

**Expected Events** (EPUB example):
1. PREPROCESS: UPLOAD_RECEIVED → PREPROCESSING
2. AUDIT_START: PREPROCESSING → RUNNING_EPUBCHECK
3. AUDIT_DONE: RUNNING_EPUBCHECK → AWAITING_AI_REVIEW
4. AI_ACCEPTED: AWAITING_AI_REVIEW → AUTO_REMEDIATION
5. REMEDIATION_DONE: AUTO_REMEDIATION → AWAITING_REMEDIATION_REVIEW
6. REMEDIATION_APPROVED: AWAITING_REMEDIATION_REVIEW → VERIFICATION_AUDIT
7. VERIFICATION_DONE: VERIFICATION_AUDIT → CONFORMANCE_MAPPING
8. CONFORMANCE_DONE: CONFORMANCE_MAPPING → ACR_GENERATION
9. ACR_DONE: ACR_GENERATION → AWAITING_ACR_SIGNOFF
10. ACR_SIGNED: AWAITING_ACR_SIGNOFF → COMPLETED

**Expected Result**:
- ✅ All 10 events logged
- ✅ No gaps in state transitions

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 14: Error Handling - Invalid File
**Objective**: Verify workflow transitions to FAILED on errors

**Steps**:
1. Upload a corrupted EPUB/PDF
2. Wait for processing
3. Check workflow state

**Verification**:
```sql
SELECT "currentState", "errorMessage", "retryCount"
FROM "WorkflowInstance"
WHERE "fileId" = 'CORRUPTED_FILE_ID';

-- Expected: currentState = 'FAILED'
-- errorMessage should contain error details
```

**Expected Result**:
- ✅ Workflow state = FAILED
- ✅ Error message populated

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 15: Workflow Disabled for Tenant
**Objective**: Verify workflow is NOT created when disabled

**Steps**:
1. Disable workflow for tenant:
```sql
UPDATE "Tenant" SET settings = jsonb_set(
  COALESCE(settings::jsonb, '{}'::jsonb),
  '{workflow,enabled}',
  'false'
) WHERE id = 'your-tenant-id';
```
2. Upload a file
3. Check workflow NOT created

**Verification**:
```sql
SELECT COUNT(*) as workflow_count
FROM "WorkflowInstance"
WHERE "fileId" = 'NEW_FILE_ID';

-- Expected: 0
```

**Expected Result**:
- ✅ No workflow created
- ✅ Traditional job processing still works

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 16: Storage Type Verification (S3)
**Objective**: Verify remediated files use same storage as original (S3)

**Prerequisites**: File uploaded to S3

**Verification**:
```sql
-- Check original file storage
SELECT "storageType", "storagePath"
FROM "File"
WHERE id = 'YOUR_FILE_ID';

-- Check workflow stateData for remediated path
SELECT "stateData"::jsonb->'remediatedFilePath' as remediated_path
FROM "WorkflowInstance"
WHERE "fileId" = 'YOUR_FILE_ID';

-- If S3, remediated path should be an S3 key
-- If local, should be a file system path
```

**Check S3**:
```bash
aws s3 ls s3://your-bucket/remediated/ --recursive
```

**Expected Result**:
- ✅ Remediated file in S3
- ✅ Storage type consistent with original

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 17: Storage Type Verification (Local)
**Objective**: Verify remediated files use same storage as original (local)

**Prerequisites**: File uploaded to local storage

**Verification**:
```sql
-- Check original file storage
SELECT "storageType", "path"
FROM "File"
WHERE id = 'YOUR_FILE_ID';

-- Should be storageType = 'LOCAL'
```

**Check File System**:
```bash
ls -lh /path/to/uploads/*-remediated.*
```

**Expected Result**:
- ✅ Remediated file in local file system
- ✅ Storage type consistent with original

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 18: Batch Workflow
**Objective**: Verify multiple files process independently

**Steps**:
1. Upload 3 files simultaneously
2. Monitor all 3 workflows
3. Verify no interference

**Verification**:
```sql
SELECT id, "fileId", "currentState", "updatedAt"
FROM "WorkflowInstance"
WHERE "createdAt" > NOW() - INTERVAL '5 minutes'
ORDER BY "createdAt" DESC;

-- All 3 should progress independently
```

**Expected Result**:
- ✅ All 3 workflows created
- ✅ All progress independently
- ✅ No blocking or interference

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 19: Worker Restart Resilience
**Objective**: Verify workflows resume after worker restart

**Steps**:
1. Start a workflow (upload file)
2. Wait for it to reach RUNNING_EPUBCHECK
3. Restart backend server
4. Check workflow resumes

**Verification**:
```sql
-- Before restart
SELECT "currentState" FROM "WorkflowInstance" WHERE id = 'WORKFLOW_ID';

-- After restart, wait 30 seconds, check again
SELECT "currentState" FROM "WorkflowInstance" WHERE id = 'WORKFLOW_ID';

-- Should progress to next state
```

**Expected Result**:
- ✅ Workflow resumes after restart
- ✅ No data loss
- ✅ Continues from last state

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

### Test 20: Workflow Phase Calculation
**Objective**: Verify phase and progress calculations

**Verification**:
```sql
-- Test all states
SELECT
  'UPLOAD_RECEIVED' as state,
  -- Call workflowService.computePhase() and computeProgress()
  -- Expected phase: 'ingest', progress: 5
UNION ALL
SELECT 'RUNNING_EPUBCHECK', -- phase: 'audit', progress: 20
UNION ALL
SELECT 'AUTO_REMEDIATION', -- phase: 'remediate', progress: 55
UNION ALL
SELECT 'ACR_GENERATION', -- phase: 'certify', progress: 85
UNION ALL
SELECT 'COMPLETED'; -- phase: 'complete', progress: 100
```

**Check via API** (if implemented):
```bash
curl http://localhost:5000/api/v1/workflow/YOUR_WORKFLOW_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response should include: phase, progress
```

**Expected Result**:
- ✅ Correct phase for each state
- ✅ Progress increases monotonically

**Status**: [ ] PASS / [ ] FAIL
**Notes**: _________________________________

---

## Summary Template

### Test Results Summary

**Total Tests**: 20
**Passed**: ___
**Failed**: ___
**Skipped**: ___

### Critical Issues
- [ ] None
- [ ] List issues here...

### Non-Critical Issues
- [ ] None
- [ ] List issues here...

### Performance Notes
- Upload → ACR generation time: _______ seconds
- Average state transition time: _______ seconds

### Recommendations
- [ ] Ready for merge
- [ ] Needs fixes (list above)
- [ ] Needs additional testing

---

## Troubleshooting

### Workflow Stuck in State
```sql
-- Check workflow events
SELECT * FROM "WorkflowEvent" WHERE "workflowId" = 'WORKFLOW_ID' ORDER BY "createdAt" DESC;

-- Check BullMQ jobs
-- Use Redis CLI or BullMQ UI to inspect queue
```

### Worker Not Processing
```bash
# Check worker logs
tail -f logs/worker.log

# Check Redis connection
redis-cli ping

# Restart workers
npm run dev
```

### File Not Found Errors
```sql
-- Check file record
SELECT id, "storageType", "storagePath", "path", filename
FROM "File"
WHERE id = 'FILE_ID';

-- Verify file exists
ls -lh /path/to/file  # or check S3
```

### ACR Generation Failed
```sql
-- Check job exists
SELECT id, status, output
FROM "Job"
WHERE input::jsonb->>'fileId' = 'FILE_ID';

-- Check workflow stateData
SELECT "stateData"::jsonb
FROM "WorkflowInstance"
WHERE "fileId" = 'FILE_ID';
```
