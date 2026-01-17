# NINJA Backend Deployment Fix - Post-Mortem Report

**Date:** January 16, 2026
**Duration:** ~8 hours
**Affected Environment:** AWS Staging (ECS Fargate)
**Fixed By:** Sakthivel V
**Documented By:** Claude Code

---

## Executive Summary

The AWS ECS deployment was failing with container exit code 1. The root cause was a missing data file (`acrEditions.json`) that was:
1. Never created in the repository
2. Blocked by `.gitignore` when we tried to add it
3. Not being copied to the Docker image

---

## Issue Description

### Symptoms
- ECS container kept crashing within 3 seconds of startup
- Container exit code: 1
- ECS deployment would roll back to previous task definition
- ACR Workflow filter on Jobs page returned 400 error

### User-Facing Error
```
GET /api/v1/jobs?page=1&limit=10&type=ACR_WORKFLOW → 400 Bad Request

{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{
      "field": "type",
      "message": "Invalid option: expected one of \"PDF_ACCESSIBILITY\"|\"EPUB_ACCESSIBILITY\"|\"VPAT_GENERATION\"|\"ALT_TEXT_GENERATION\"|\"METADATA_EXTRACTION\"|\"BATCH_VALIDATION\"",
      "code": "invalid_value"
    }]
  }
}
```

---

## Root Cause Analysis

### Primary Issue: Missing Data File

The `AcrService` class (`src/services/acr.service.ts`) reads a JSON file at startup:

```typescript
// src/services/acr.service.ts - Line 56-59
constructor() {
  const dataPath = path.join(__dirname, '../data/acrEditions.json');
  const rawData = fs.readFileSync(dataPath, 'utf-8');  // CRASHES HERE
  this.editionsData = JSON.parse(rawData);
}
```

**Problem:** The file `src/data/acrEditions.json` was never created in the repository.

### Secondary Issue: .gitignore Blocking

When we created the file, it couldn't be pushed because `src/data` was in `.gitignore`:

```bash
$ git add src/data/acrEditions.json
The following paths are ignored by one of your .gitignore files:
src/data
```

### Tertiary Issue: Dockerfile Missing COPY

The original Dockerfile didn't copy the `data` folder to the production image:

```dockerfile
# Original - data folder NOT copied
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
```

---

## Timeline of Debugging

| Time | Action | Result |
|------|--------|--------|
| Day 1 Evening | Merged ACR_WORKFLOW fix to job.schema.ts | Deployment failed |
| Day 1 Evening | Checked ECS tasks | Container exit code 1 |
| Day 1 Evening | Found old CloudWatch logs (Dec 2025) | Misleading - wrong logs |
| Day 2 Morning | Found correct CloudWatch logs (Jan 16) | `ENOENT: acrEditions.json` |
| Day 2 Morning | Created `acrEditions.json` file | File created locally |
| Day 2 Morning | Updated Dockerfile to copy data folder | Dockerfile updated |
| Day 2 Morning | Pushed changes | Still failing |
| Day 2 Afternoon | Checked GitHub - file not present | File was blocked by .gitignore |
| Day 2 Afternoon | Used `git add -f` to force add | File pushed successfully |
| Day 2 Afternoon | Deployment succeeded | Issue resolved |

---

## AWS Debugging Guide

### Where to Find Logs

#### 1. CloudWatch Logs (Primary)

**Path:** AWS Console → CloudWatch → Log groups → `/ecs/ninja-backend-task`

**Direct URL:**
```
https://ap-south-1.console.aws.amazon.com/cloudwatch/home?region=ap-south-1#logsV2:log-groups/log-group/$252Fecs$252Fninja-backend-task
```

**CLI Command:**
```bash
aws logs tail /ecs/ninja-backend-task --follow --region ap-south-1
```

#### 2. ECS Task Logs

**Path:** AWS Console → ECS → Clusters → ninja-cluster → Services → ninja-backend-task-service → Tasks → [Task ID] → Logs tab

#### 3. ECS Task Details

**Path:** AWS Console → ECS → Clusters → ninja-cluster → Tasks → [Task ID] → Configuration tab

Shows:
- Exit code
- Stop reason
- Container status

### Key AWS Resources

| Resource | Name/ID |
|----------|---------|
| ECS Cluster | `ninja-cluster` |
| ECS Service | `ninja-backend-task-service` |
| Task Definition | `ninja-backend-task` |
| ECR Repository | `ninja-backend` |
| CloudFront (Backend) | `d1ruc3qmc844x9.cloudfront.net` |
| CloudFront (Frontend) | `dhi5xqbewozlg.cloudfront.net` |
| CloudWatch Log Group | `/ecs/ninja-backend-task` |
| Region | `ap-south-1` (Mumbai) |

### Common ECS Error Patterns

| Error | Meaning | Solution |
|-------|---------|----------|
| Exit code 1 | Application crash | Check CloudWatch logs for stack trace |
| Exit code 137 | Out of memory | Increase task memory |
| Exit code 143 | SIGTERM (graceful shutdown) | Normal during deployments |
| Health check failed | App not responding on /health | Check app startup logs |

---

## Files Changed

### 1. Created: `src/data/acrEditions.json`

Contains WCAG 2.1 criteria definitions for ACR/VPAT generation:
- 4 VPAT editions (508, WCAG, EU, INT)
- 37 WCAG criteria with descriptions and URLs

### 2. Modified: `Dockerfile`

Added lines to copy data folder:

```dockerfile
# In builder stage (line 8)
COPY src/data ./src/data

# In production stage (line 39)
COPY --from=builder /app/src/data ./dist/data
```

### 3. Modified: `src/schemas/job.schemas.ts`

Added `ACR_WORKFLOW` to the job type enum:

```typescript
export const jobTypeEnum = z.enum([
  'PDF_ACCESSIBILITY',
  'EPUB_ACCESSIBILITY',
  'VPAT_GENERATION',
  'ALT_TEXT_GENERATION',
  'METADATA_EXTRACTION',
  'BATCH_VALIDATION',
  'ACR_WORKFLOW'  // Added
]);
```

---

## How to Debug Similar Issues

### Step 1: Check Container Status
```bash
# AWS Console
ECS → Clusters → ninja-cluster → Tasks → Look for STOPPED tasks

# Note the exit code and stop reason
```

### Step 2: Check CloudWatch Logs
```bash
# CLI
aws logs tail /ecs/ninja-backend-task --follow --region ap-south-1

# Or AWS Console
CloudWatch → Log groups → /ecs/ninja-backend-task → Latest log stream
```

### Step 3: Common Startup Errors

| Error Pattern | Likely Cause |
|---------------|--------------|
| `ENOENT: no such file or directory` | Missing file in Docker image |
| `Cannot find module` | Missing dependency or build issue |
| `ECONNREFUSED` | Database/Redis not reachable |
| `Invalid environment variable` | Missing env var in task definition |

### Step 4: Verify Docker Build

Check if files are in the image:
```bash
# Run container locally
docker run -it --entrypoint sh <image>

# Check if file exists
ls -la /app/dist/data/
```

### Step 5: Check GitHub Actions

Path: GitHub → ninja-backend → Actions tab

- Look for failed workflows
- Check build logs for errors
- Verify the correct commit was deployed

---

## Prevention Measures

### 1. Pre-deployment Checklist

- [ ] All required files exist in repo (not in .gitignore)
- [ ] Dockerfile copies all necessary files
- [ ] Environment variables are set in AWS
- [ ] Local build succeeds: `npm run build`
- [ ] Docker build succeeds locally

### 2. Add CI Check for Required Files

```yaml
# .github/workflows/deploy.yml
- name: Verify required files
  run: |
    test -f src/data/acrEditions.json || exit 1
    echo "All required files present"
```

### 3. Improve Error Handling

Consider making AcrService fail gracefully:

```typescript
constructor() {
  try {
    const dataPath = path.join(__dirname, '../data/acrEditions.json');
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    this.editionsData = JSON.parse(rawData);
  } catch (error) {
    console.error('Failed to load acrEditions.json:', error);
    // Use default/empty data or throw more descriptive error
    throw new Error(`AcrService initialization failed: ${error.message}`);
  }
}
```

---

## Commits Related to This Fix

| Commit | Message | Author |
|--------|---------|--------|
| `7346bd4` | Merge branch 'fix/NINJA-jobs-acr-filter-error' | Sakthivel |
| `1510125` | fix: Add missing acrEditions.json data file | Sakthivel |
| `cc618b0` | Improve application reliability and production readiness | Replit Agent |
| Latest | fix: Add missing acrEditions.json data file (force add) | Sakthivel |

---

## Lessons Learned

1. **Check .gitignore early** - Files in ignored directories won't be pushed
2. **Verify files on GitHub** - Local existence doesn't mean it's in the repo
3. **Use correct CloudWatch logs** - Old logs can be misleading
4. **Synchronous file reads at startup are risky** - Consider async with proper error handling
5. **Docker builds need explicit COPY** - Files won't magically appear in the image

---

## Contact

For questions about this fix:
- **Sakthivel V** - Primary debugger
- **AVR** - Team lead

---

*Document generated: January 16, 2026*
