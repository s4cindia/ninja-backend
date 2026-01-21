# Batch ACR/VPAT Generation - Final Design Document

**Date:** January 21, 2026
**Project:** Ninja Platform - Batch ACR/VPAT Feature
**Repositories:** ninja-frontend, ninja-backend

---

## Table of Contents

1. [Overview](#overview)
2. [Current System Analysis](#current-system-analysis)
3. [Design Decisions](#design-decisions)
4. [Architecture](#architecture)
5. [Data Structures](#data-structures)
6. [User Experience Flow](#user-experience-flow)
7. [Implementation Checklist](#implementation-checklist)

---

## Overview

This document specifies the design for enabling **Batch ACR/VPAT generation** in the Ninja Platform. Users will be able to generate Accessibility Conformance Reports (ACR) for multiple remediated EPUB files in two modes:

1. **Individual ACRs** - One ACR/VPAT per EPUB (standard format)
2. **Aggregate ACR** - Single ACR/VPAT for all EPUBs in batch (batch collection format)

---

## Current System Analysis

### Batch Remediation (Existing)

**Status:** ✅ Fully Implemented

**How it works:**
- User selects multiple EPUB jobs
- Creates `BATCH_VALIDATION` job
- Sequentially processes each EPUB with auto-remediation
- Tracks progress with Server-Sent Events (SSE)
- Returns summary: total jobs, issues fixed, success rate

**API Endpoints:**
```
POST   /api/v1/epub/batch                    # Create batch
POST   /api/v1/epub/batch/:batchId/start     # Start processing
GET    /api/v1/epub/batch/:batchId/status    # Get status
POST   /api/v1/epub/batch/:batchId/cancel    # Cancel batch
GET    /api/v1/epub/batch                    # List batches
```

**Output Structure:**
```typescript
interface BatchRemediationResult {
  batchId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  jobs: BatchJob[];
  summary: {
    totalIssuesFixed: number;
    totalIssuesFailed: number;
    successRate: number;
  };
  startedAt: Date;
  completedAt?: Date;
}
```

### Single EPUB ACR Workflow (Existing)

**Status:** ✅ Fully Implemented

**How it works:**
- User completes remediation on single EPUB
- Clicks "Transfer to ACR Workflow"
- Creates `ACR_WORKFLOW` job with pending issues mapped to WCAG criteria
- Creates `AcrJob` record for verification UI
- Creates `AcrCriterionReview` records for each WCAG criterion
- User verifies conformance levels
- Exports VPAT as PDF/DOCX/HTML

**API Endpoint:**
```
POST /api/v1/epub/job/:jobId/transfer-to-acr
```

**Service Method:**
```typescript
remediationService.transferToAcr(jobId)
```

---

## Design Decisions

Based on requirements analysis, the following decisions were made:

### Q1: ACR Generation Mode
**Decision: C) Both options (user chooses)**
- Support both individual and aggregate modes
- User selects via radio button in modal

### Q2: Failed Jobs Handling
**Decision: A) Include only successful jobs**
- Generate ACR only for jobs with status 'completed'
- Show warning: "X of Y jobs failed and will be excluded from ACR generation"

### Q3: Aggregation Strategy Default
**Decision: A) Conservative (safer for compliance)**
- Default selection: Conservative
- Show both options with tooltips:
  - **Conservative:** Any EPUB failure → "Does Not Support" (safer for compliance)
  - **Optimistic:** Majority pass → "Partially Supports" (shows progress)

### Q4: Batch Name Auto-Generation
**Decision: C) Auto-generate but allow editing**
- Pattern: `"Batch {YYYY-MM-DD} - {count} EPUBs"`
- Example: `"Batch 2026-01-21 - 8 EPUBs"`
- User can edit before generating

### Q5: ACR Workflow Status
**Decision: C) Link batch to ACR jobs but don't change status**
- Keep batch job status as "Completed"
- Add metadata to batch job output:
  ```typescript
  {
    acrGenerated: true,
    acrWorkflowIds: ["acr-1", "acr-2"],
    acrGeneratedAt: "2026-01-21T10:30:00Z",
    acrMode: "aggregate" | "individual"
  }
  ```
- Show "ACR Generated ✓" badge in UI

### Q6: Re-generation
**Decision: A) Yes, allow multiple ACR generations**
- Users can generate multiple ACRs from same batch
- Useful for trying different strategies (conservative vs optimistic)
- Show list of previously generated ACRs with timestamps

### Q7: Partially Completed Batches
**Decision: A) Be disabled (wait for batch completion)**
- "Generate ACR" button disabled until batch status = 'completed'
- Tooltip: "Complete batch processing before generating ACR"

### Q8: Frontend Routing
**Individual Mode:**
- **Decision: A) Redirect to list of all created ACR workflows**
- Shows table with ACR ID, EPUB name, status, and "Verify" button

**Aggregate Mode:**
- **Decision: B) Redirect to aggregate ACR editor page**
- Directly opens verification/editing interface for the batch ACR

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND                            │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Pages:                                                  │
│  - BatchRemediation.tsx (existing)                      │
│    └─> [Generate ACR] button                           │
│                                                          │
│  New Components:                                         │
│  - BatchAcrConfigModal.tsx                              │
│    └─> Mode selection (individual/aggregate)           │
│    └─> Batch info form (if aggregate)                  │
│    └─> Aggregation strategy selector                   │
│                                                          │
│  - BatchAcrList.tsx (individual mode result)           │
│    └─> Table of created ACR workflows                  │
│                                                          │
│  - BatchAcrViewer.tsx (aggregate mode result)          │
│    └─> Batch ACR document viewer                       │
│    └─> Criteria table with per-EPUB breakdown          │
│                                                          │
│  API Service:                                            │
│  - acrService.generateBatchAcr()                        │
│  - acrService.getBatchAcr()                             │
│  - acrService.exportBatchAcr()                          │
│                                                          │
│  Hooks:                                                  │
│  - useGenerateBatchAcr()                                │
│  - useBatchAcr()                                        │
│  - useExportBatchAcr()                                  │
│                                                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ HTTP/REST
┌─────────────────────────────────────────────────────────┐
│                     BACKEND                             │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Routes (acr.routes.ts):                                │
│  POST   /acr/batch/generate                             │
│  GET    /acr/batch/:batchAcrId                          │
│  POST   /acr/batch/:batchAcrId/export                   │
│  GET    /acr/batch/:batchAcrId/history                  │
│                                                          │
│  Controller (acr.controller.ts):                        │
│  - generateBatchAcr()                                   │
│  - getBatchAcr()                                        │
│  - exportBatchAcr()                                     │
│  - getBatchAcrHistory()                                 │
│                                                          │
│  Services:                                               │
│  - batch-acr-generator.service.ts (NEW)                │
│    └─> generateIndividualAcrs()                        │
│    └─> generateAggregateAcr()                          │
│    └─> aggregateConformance()                          │
│    └─> generateCompositeRemarks()                      │
│                                                          │
│  - batch-remediation.service.ts (EXTEND)               │
│    └─> Add acrMetadata to batch output                │
│                                                          │
│  Database (Prisma):                                      │
│  - Job model (EXTEND)                                   │
│    └─> Add batchSourceJobIds: String[]                │
│    └─> Add isBatchAcr: Boolean                        │
│                                                          │
│  - BatchAcrHistory model (NEW - Optional)              │
│    └─> Track multiple ACR generations per batch        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

#### Individual ACR Mode

```
1. User selects "Individual ACRs" in modal
   ↓
2. POST /acr/batch/generate
   Body: { batchId, mode: "individual" }
   ↓
3. Backend (BatchAcrGeneratorService.generateIndividualAcrs):
   For each completed job in batch:
     → Call remediationService.transferToAcr(jobId)
     → Collect acrWorkflowId
   ↓
4. Update batch job output:
   {
     ...existingBatchResult,
     acrGenerated: true,
     acrMode: "individual",
     acrWorkflowIds: ["acr-1", "acr-2", "acr-3"],
     acrGeneratedAt: "2026-01-21T10:30:00Z"
   }
   ↓
5. Return: { mode: "individual", acrWorkflowIds: [...] }
   ↓
6. Frontend redirects to BatchAcrList page
   Shows table with all ACR workflows
```

#### Aggregate ACR Mode

```
1. User selects "Aggregate ACR" in modal
   Fills out:
   - Batch Name: "Q1 2026 EPUB Collection"
   - Vendor: "ACME Publishing"
   - Contact Email: "a11y@acme.com"
   - VPAT Edition: "VPAT2.5-WCAG"
   - Aggregation Strategy: "Conservative"
   ↓
2. POST /acr/batch/generate
   Body: {
     batchId,
     mode: "aggregate",
     options: {
       edition, batchName, vendor,
       contactEmail, aggregationStrategy
     }
   }
   ↓
3. Backend (BatchAcrGeneratorService.generateAggregateAcr):
   → Fetch all completed jobs in batch
   → For each job, get remediation plan with pending tasks
   → Map pending tasks to WCAG criteria
   → Group by WCAG criterion (e.g., all 1.1.1 issues across EPUBs)
   → For each criterion:
      * Apply aggregation strategy
      * Generate composite remarks with per-EPUB breakdown
   → Create single ACR_WORKFLOW job with:
      * isBatchAcr: true
      * batchSourceJobIds: [job1, job2, job3]
      * batchInfo: { totalDocuments, documentList, ... }
   → Create AcrJob record
   → Create AcrCriterionReview records (aggregate conformance)
   ↓
4. Update batch job output (same as individual mode)
   ↓
5. Return: { mode: "aggregate", acrWorkflowId: "acr-batch-123" }
   ↓
6. Frontend redirects to AcrEditor page for batch ACR
   Shows aggregate ACR with batch details
```

---

## Data Structures

### Backend Database Schema Changes

```prisma
// Extend Job model
model Job {
  // ... existing fields

  // New fields for batch ACR support
  batchSourceJobIds  String[]  // Array of job IDs if this is a batch ACR
  isBatchAcr         Boolean   @default(false)

  // ... rest of model
}
```

### Batch Job Output Extension

```typescript
interface BatchRemediationResult {
  // ... existing fields

  // New ACR metadata
  acrGenerated?: boolean;
  acrMode?: 'individual' | 'aggregate';
  acrWorkflowIds?: string[];
  acrGeneratedAt?: string;
  acrGenerationHistory?: Array<{
    mode: 'individual' | 'aggregate';
    acrWorkflowIds: string[];
    generatedAt: string;
    generatedBy: string;
  }>;
}
```

### Aggregate ACR Document Structure

```typescript
interface AggregateAcrDocument extends AcrDocument {
  // Standard ACR fields
  edition: 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';

  productInfo: {
    name: string;              // Batch name
    version: string;           // "2026.Q1"
    description: string;       // "Batch evaluation of X EPUBs"
    vendor: string;
    contactEmail: string;
    evaluationDate: Date;
  };

  // Batch-specific metadata
  batchInfo: {
    isBatch: true;
    totalDocuments: number;
    documentList: Array<{
      fileName: string;
      jobId: string;
    }>;
    aggregationStrategy: 'conservative' | 'optimistic';
    sourceJobIds: string[];
  };

  // Aggregate criteria
  criteria: AggregateAcrCriterion[];
}

interface AggregateAcrCriterion {
  criterionId: string;          // "1.1.1"
  criterionName: string;        // "Non-text Content"
  level: 'A' | 'AA' | 'AAA';
  conformanceLevel: ConformanceLevel;  // Aggregate result
  remarks: string;              // Composite remarks with breakdown

  // Per-EPUB breakdown
  perEpubDetails: Array<{
    fileName: string;
    jobId: string;
    status: ConformanceLevel;
    issueCount: number;
    issues?: Array<{
      code: string;
      message: string;
      location?: string;
    }>;
  }>;
}

type ConformanceLevel =
  | 'Supports'
  | 'Partially Supports'
  | 'Does Not Support'
  | 'Not Applicable';
```

### API Request/Response Formats

#### Generate Batch ACR Request

```typescript
// Individual Mode
POST /api/v1/acr/batch/generate
{
  "batchId": "batch-12345",
  "mode": "individual"
}

// Aggregate Mode
POST /api/v1/acr/batch/generate
{
  "batchId": "batch-12345",
  "mode": "aggregate",
  "options": {
    "edition": "VPAT2.5-WCAG",
    "batchName": "Q1 2026 EPUB Collection",
    "vendor": "ACME Publishing",
    "contactEmail": "a11y@acme.com",
    "aggregationStrategy": "conservative"
  }
}
```

#### Response

```typescript
// Individual Mode Response
{
  "success": true,
  "data": {
    "mode": "individual",
    "acrWorkflowIds": ["acr-1", "acr-2", "acr-3"],
    "totalAcrs": 3,
    "message": "Created 3 ACR workflows"
  }
}

// Aggregate Mode Response
{
  "success": true,
  "data": {
    "mode": "aggregate",
    "acrWorkflowId": "acr-batch-123",
    "totalDocuments": 8,
    "totalCriteria": 50,
    "message": "Created aggregate ACR for 8 EPUBs"
  }
}
```

### Aggregation Logic

#### Conservative Strategy

```typescript
function aggregateConformanceConservative(
  criterion: string,
  epubResults: Array<{ fileName: string; status: ConformanceLevel; issueCount: number }>
): ConformanceLevel {
  const hasNotApplicable = epubResults.every(r => r.status === 'Not Applicable');
  if (hasNotApplicable) return 'Not Applicable';

  const hasDoesNotSupport = epubResults.some(r => r.status === 'Does Not Support');
  if (hasDoesNotSupport) return 'Does Not Support';

  const hasPartiallySupports = epubResults.some(r => r.status === 'Partially Supports');
  if (hasPartiallySupports) return 'Partially Supports';

  // All support
  return 'Supports';
}
```

#### Optimistic Strategy

```typescript
function aggregateConformanceOptimistic(
  criterion: string,
  epubResults: Array<{ fileName: string; status: ConformanceLevel; issueCount: number }>
): ConformanceLevel {
  const hasNotApplicable = epubResults.every(r => r.status === 'Not Applicable');
  if (hasNotApplicable) return 'Not Applicable';

  const supportsCount = epubResults.filter(r => r.status === 'Supports').length;
  const total = epubResults.length;

  if (supportsCount === total) return 'Supports';
  if (supportsCount >= total * 0.5) return 'Partially Supports';

  return 'Does Not Support';
}
```

#### Composite Remarks Generation

```typescript
function generateCompositeRemarks(
  criterion: string,
  epubResults: Array<{
    fileName: string;
    status: ConformanceLevel;
    issueCount: number;
    issues: Array<{ code: string; message: string }>;
  }>
): string {
  const supportsCount = epubResults.filter(r => r.status === 'Supports').length;
  const total = epubResults.length;
  const percentage = Math.round((supportsCount / total) * 100);

  const failedEpubs = epubResults.filter(r => r.status !== 'Supports');

  let remarks = `${supportsCount} of ${total} EPUBs (${percentage}%) fully support this criterion.\n\n`;

  if (failedEpubs.length > 0) {
    remarks += `EPUBs requiring attention:\n`;

    for (const epub of failedEpubs) {
      remarks += `\n- "${epub.fileName}" (${epub.issueCount} issue${epub.issueCount !== 1 ? 's' : ''})\n`;

      // Show first 3 issues
      const issuesToShow = epub.issues.slice(0, 3);
      for (const issue of issuesToShow) {
        remarks += `  • ${issue.message}\n`;
      }

      if (epub.issues.length > 3) {
        remarks += `  • ... and ${epub.issues.length - 3} more\n`;
      }
    }
  }

  return remarks.trim();
}
```

---

## User Experience Flow

### Batch Remediation Page (Extended)

```
┌──────────────────────────────────────────────────────────┐
│  Batch Remediation Results                               │
│                                                           │
│  Batch ID: batch-2026-01-21-abc123                       │
│  Status: ✅ Completed                                    │
│  Created: 2026-01-21 10:15 AM                           │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Summary Statistics                               │    │
│  │                                                   │    │
│  │  Total Jobs: 10                                  │    │
│  │  ✅ Successful: 8                                │    │
│  │  ❌ Failed: 2                                    │    │
│  │  📊 Issues Fixed: 247                            │    │
│  │  📈 Success Rate: 80%                            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Job Results (8 successful, 2 failed)             │    │
│  ├─────────────────────────────────────────────────┤    │
│  │ ✅ book1.epub        15 issues fixed             │    │
│  │ ✅ book2.epub        23 issues fixed             │    │
│  │ ❌ book3.epub        Error: Invalid EPUB         │    │
│  │ ✅ book4.epub        18 issues fixed             │    │
│  │ ...                                               │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌────────────────────────────────────────────────┐     │
│  │ [📄 Generate ACR/VPAT Report]                  │     │
│  └────────────────────────────────────────────────┘     │
│                                                           │
│  Previously Generated ACRs: (if any)                     │
│  • Aggregate ACR (Conservative) - 2026-01-21 11:00 AM   │
│    [View ACR]                                            │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Batch ACR Configuration Modal

```
┌──────────────────────────────────────────────────────────┐
│  Generate ACR/VPAT Report                            [×] │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ⚠️  Note: 2 of 10 jobs failed and will be excluded     │
│     from ACR generation                                  │
│                                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                           │
│  Choose ACR Generation Mode:                             │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ○ Individual ACRs (1 per EPUB)              ℹ️  │    │
│  │                                                   │    │
│  │   Generate separate ACR/VPAT for each EPUB.     │    │
│  │   Best for: Sharing individual reports          │    │
│  │   Output: 8 separate ACR workflows              │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ● Aggregate ACR (1 for all EPUBs)           ℹ️  │    │
│  │                                                   │    │
│  │   Generate single ACR/VPAT for the batch.       │    │
│  │   Best for: Procurement & compliance review     │    │
│  │   Output: 1 aggregate ACR workflow              │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                           │
│  [Shown only if Aggregate selected:]                     │
│                                                           │
│  Batch Information:                                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Batch Name *                                     │    │
│  │ [Batch 2026-01-21 - 8 EPUBs_________________]   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Vendor Name *                                    │    │
│  │ [ACME Publishing_____________________________]   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Contact Email *                                  │    │
│  │ [a11y@acme.com_______________________________]   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  VPAT Edition:                                           │
│  [VPAT 2.5 WCAG ▼]                                      │
│                                                           │
│  Aggregation Strategy:                                   │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ● Conservative (Safer for compliance)       ℹ️  │    │
│  │   Any EPUB failure → "Does Not Support"         │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ○ Optimistic (Shows progress)               ℹ️  │    │
│  │   Majority pass → "Partially Supports"          │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                           │
│  [Cancel]                    [Generate ACR(s)] →         │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Individual ACR List (After Generation)

```
┌──────────────────────────────────────────────────────────┐
│  ACR Workflows Created                                   │
│                                                           │
│  ✓ Successfully created 8 ACR workflows                  │
│  Source Batch: batch-2026-01-21-abc123                  │
│  Generated: 2026-01-21 11:05 AM                         │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ ACR ID        │ EPUB File    │ Status  │ Action   │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ acr-001       │ book1.epub   │ Pending │ [Verify] │ │
│  │ acr-002       │ book2.epub   │ Pending │ [Verify] │ │
│  │ acr-003       │ book4.epub   │ Pending │ [Verify] │ │
│  │ acr-004       │ book5.epub   │ Pending │ [Verify] │ │
│  │ acr-005       │ book6.epub   │ Pending │ [Verify] │ │
│  │ acr-006       │ book7.epub   │ Pending │ [Verify] │ │
│  │ acr-007       │ book9.epub   │ Pending │ [Verify] │ │
│  │ acr-008       │ book10.epub  │ Pending │ [Verify] │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  [← Back to Batch]                                       │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### Aggregate ACR Viewer

```
┌──────────────────────────────────────────────────────────┐
│  Aggregate ACR/VPAT Document                             │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Batch ACR Information                               │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ Batch Name: Q1 2026 EPUB Collection                │ │
│  │ Vendor: ACME Publishing                            │ │
│  │ Contact: a11y@acme.com                             │ │
│  │ Edition: VPAT 2.5 WCAG                             │ │
│  │ Strategy: Conservative                              │ │
│  │                                                     │ │
│  │ Documents Included: 8 EPUBs                        │ │
│  │ • book1.epub                                       │ │
│  │ • book2.epub                                       │ │
│  │ • book4.epub                                       │ │
│  │ ... (show all)                                     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Overall Compliance Summary                          │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ Supports: 35 criteria (70%)                        │ │
│  │ Partially Supports: 10 criteria (20%)              │ │
│  │ Does Not Support: 5 criteria (10%)                 │ │
│  │ Not Applicable: 0 criteria (0%)                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  WCAG Criteria Evaluation:                               │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ 1.1.1 Non-text Content (Level A)                   │ │
│  │ Conformance: Partially Supports                    │ │
│  │                                                     │ │
│  │ Remarks:                                            │ │
│  │ 6 of 8 EPUBs (75%) fully support this criterion.  │ │
│  │                                                     │ │
│  │ EPUBs requiring attention:                         │ │
│  │ - "book4.epub" (3 issues)                          │ │
│  │   • Missing alt text on line chart                 │ │
│  │   • Missing alt text on diagram                    │ │
│  │   • Decorative image not marked                    │ │
│  │ - "book7.epub" (1 issue)                           │ │
│  │   • Complex image missing long description         │ │
│  │                                                     │ │
│  │ [▼ View Per-EPUB Breakdown]                        │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
│  [More criteria...]                                      │
│                                                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │ [Export PDF] [Export DOCX] [Export HTML]          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Backend Tasks

- [ ] **Database Migration**
  - [ ] Add `batchSourceJobIds: String[]` to Job model
  - [ ] Add `isBatchAcr: Boolean @default(false)` to Job model
  - [ ] Run `npx prisma migrate dev --name add-batch-acr-fields`
  - [ ] Generate Prisma client

- [ ] **Type Definitions**
  - [ ] Create `BatchAcrOptions` interface
  - [ ] Create `AggregateAcrDocument` interface
  - [ ] Extend `AcrDocument` with `batchInfo` field
  - [ ] Create `AggregateAcrCriterion` interface

- [ ] **Batch ACR Generator Service**
  - [ ] Create `src/services/acr/batch-acr-generator.service.ts`
  - [ ] Implement `generateIndividualAcrs(batchId, tenantId)`
  - [ ] Implement `generateAggregateAcr(batchId, tenantId, options)`
  - [ ] Implement `aggregateConformanceConservative(criterion, results)`
  - [ ] Implement `aggregateConformanceOptimistic(criterion, results)`
  - [ ] Implement `generateCompositeRemarks(criterion, results)`
  - [ ] Add error handling for missing jobs, failed jobs, tenant mismatch

- [ ] **Batch Remediation Service Extension**
  - [ ] Update `BatchRemediationResult` interface with ACR metadata
  - [ ] Add `updateBatchAcrMetadata(batchId, acrData)` method

- [ ] **Routes**
  - [ ] Add `POST /acr/batch/generate` route
  - [ ] Add `GET /acr/batch/:batchAcrId` route
  - [ ] Add `POST /acr/batch/:batchAcrId/export` route
  - [ ] Add `GET /acr/batch/:batchAcrId/history` route (optional)

- [ ] **Controller**
  - [ ] Implement `generateBatchAcr()` method
  - [ ] Implement `getBatchAcr()` method
  - [ ] Implement `exportBatchAcr()` method
  - [ ] Implement `getBatchAcrHistory()` method (optional)

- [ ] **Validation Schemas**
  - [ ] Create `batchAcrGenerateSchema` (Zod)
  - [ ] Create `batchAcrExportSchema` (Zod)
  - [ ] Add validation middleware to routes

- [ ] **Testing**
  - [ ] Unit tests for `aggregateConformanceConservative()`
  - [ ] Unit tests for `aggregateConformanceOptimistic()`
  - [ ] Unit tests for `generateCompositeRemarks()`
  - [ ] Integration test for individual ACR generation
  - [ ] Integration test for aggregate ACR generation
  - [ ] Test error cases (invalid batch, tenant mismatch, failed jobs)

### Frontend Tasks

- [ ] **API Service**
  - [ ] Add `generateBatchAcr()` method to `acrService.ts`
  - [ ] Add `getBatchAcr()` method to `acrService.ts`
  - [ ] Add `exportBatchAcr()` method to `acrService.ts`

- [ ] **React Query Hooks**
  - [ ] Create `useGenerateBatchAcr()` mutation hook
  - [ ] Create `useBatchAcr(batchAcrId)` query hook
  - [ ] Create `useExportBatchAcr()` mutation hook

- [ ] **Components**
  - [ ] Create `BatchAcrConfigModal.tsx`
    - [ ] Mode selection (radio buttons)
    - [ ] Aggregate form fields (conditional)
    - [ ] Validation (required fields, email format)
    - [ ] Failed jobs warning
  - [ ] Create `BatchAcrList.tsx`
    - [ ] Table of individual ACR workflows
    - [ ] "Verify" button for each ACR
  - [ ] Create `BatchAcrViewer.tsx`
    - [ ] Batch info section
    - [ ] Document list
    - [ ] Summary statistics
    - [ ] Criteria table with per-EPUB breakdown
    - [ ] Export buttons
  - [ ] Create `BatchAcrResultsSummary.tsx`
    - [ ] Conformance breakdown chart
    - [ ] Most common issues

- [ ] **Page Updates**
  - [ ] Update `BatchRemediation.tsx`
    - [ ] Add "Generate ACR" button
    - [ ] Disable button if batch not completed
    - [ ] Show ACR generation history
    - [ ] Integrate `BatchAcrConfigModal`
  - [ ] Add route for `BatchAcrList` page
  - [ ] Extend `AcrEditor.tsx` to support batch ACRs (or create new page)

- [ ] **State Management**
  - [ ] Update batch state with ACR metadata
  - [ ] Handle ACR generation success/error states
  - [ ] Cache batch ACR data

- [ ] **UI/UX**
  - [ ] Add tooltips for aggregation strategies
  - [ ] Add loading states during generation
  - [ ] Add success/error toast notifications
  - [ ] Show "ACR Generated ✓" badge on batch results page
  - [ ] Style per-EPUB breakdown in aggregate viewer

- [ ] **Testing**
  - [ ] Component tests for `BatchAcrConfigModal`
  - [ ] Component tests for `BatchAcrViewer`
  - [ ] Integration test: Individual mode flow
  - [ ] Integration test: Aggregate mode flow
  - [ ] Test form validation
  - [ ] Test error handling

### Documentation

- [ ] Update API documentation with new endpoints
- [ ] Add user guide for batch ACR generation
- [ ] Document aggregation strategies
- [ ] Add examples for composite remarks format
- [ ] Update README with feature description

---

## Success Criteria

### Feature Complete When:

1. ✅ User can generate individual ACRs from completed batch
2. ✅ User can generate aggregate ACR from completed batch
3. ✅ Failed jobs are excluded from ACR generation with warning
4. ✅ Conservative aggregation works correctly (any fail → "Does Not Support")
5. ✅ Optimistic aggregation works correctly (majority pass → "Partially Supports")
6. ✅ Composite remarks show per-EPUB breakdown
7. ✅ User can re-generate ACRs with different strategies
8. ✅ Export works for both individual and aggregate ACRs
9. ✅ UI shows ACR generation history
10. ✅ All tests pass (unit + integration)

---

## Timeline Estimate

- **Backend Implementation:** 3-4 days
- **Frontend Implementation:** 3-4 days
- **Testing & QA:** 2-3 days
- **Documentation:** 1 day

**Total:** 9-12 days (approximately 2 weeks)

---

## Notes

- Start with backend implementation first
- Test individual mode thoroughly before aggregate mode
- Conservative aggregation should be default for compliance safety
- Consider adding batch ACR generation to background queue for large batches (>20 EPUBs)
- Future enhancement: Add AI suggestions for aggregation strategy based on batch characteristics

---

**Document Version:** 1.0
**Last Updated:** January 21, 2026
