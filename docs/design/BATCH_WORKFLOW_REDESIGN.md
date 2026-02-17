# Batch Processing Workflow - Redesigned Architecture

**Date:** January 21, 2026
**Status:** Design Approved - Ready for Implementation
**Version:** 2.0

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problems with Current Design](#problems-with-current-design)
3. [New Workflow Overview](#new-workflow-overview)
4. [Architecture Design](#architecture-design)
5. [Data Model](#data-model)
6. [Service Architecture](#service-architecture)
7. [API Design](#api-design)
8. [User Experience Flow](#user-experience-flow)
9. [Implementation Phases](#implementation-phases)
10. [Migration Strategy](#migration-strategy)

---

## Executive Summary

### Current State Problems

1. **Workflow Confusion** - Users must create individual remediation plans before batch processing
2. **Fragmented Jobs** - Batch uses existing job types not designed for batching
3. **Poor UX** - Upload files one-at-a-time, then select for batch
4. **No Batch Context** - Files processed individually, no batch-level tracking
5. **Testing Blocker** - Batch ACR feature can't be tested due to workflow issues

### Redesigned Solution

**Core Concept:** Batch is a first-class entity with automated end-to-end processing pipeline.

**User Journey:**
```
Create Batch → Upload Files → Start Processing → Review Results → Generate ACR
```

**Automated Pipeline:**
```
For each file: Audit → Plan → Auto-Remediate → Ready for ACR
```

**Benefits:**
- ✅ Intuitive batch creation UX
- ✅ Bulk file upload (drag-drop 5-50 files)
- ✅ Automated audit → plan → remediate pipeline
- ✅ Clear batch-level progress tracking
- ✅ Seamless ACR generation
- ✅ Scalable architecture

---

## Problems with Current Design

### Issue 1: Workflow Dependency Chain

**Current Flow:**
```
1. Upload File → EPUB saved
2. Create EPUB_ACCESSIBILITY job → Audit runs
3. Manually create Remediation Plan → Plan job created
4. Select jobs for batch → Create BATCH_VALIDATION job
5. Start batch → Expects pre-existing plans → FAILS if missing
```

**Problem:** Users must understand and execute 4 separate steps before batch works.

### Issue 2: Job Type Confusion

```typescript
// Current structure mixes concerns
Job {
  type: 'EPUB_ACCESSIBILITY'     // Audit job
  type: 'BATCH_VALIDATION'       // Could be: remediation plan OR batch job
  type: 'ACR_WORKFLOW'           // ACR generation job
}
```

**Problem:** `BATCH_VALIDATION` is used for both remediation plans and batches, causing lookup failures.

### Issue 3: No Batch Entity

**Current:** Batch is just a job with an array of job IDs
```json
{
  "type": "BATCH_VALIDATION",
  "input": {
    "recordType": "batch_remediation",
    "jobIds": ["job1", "job2", "job3"]
  }
}
```

**Problem:**
- No persistent batch identity
- Can't track batch lifecycle
- Can't add/remove files from batch
- No batch-level metadata

### Issue 4: One-at-a-Time Upload

**Current:** User must upload files individually, then select them for batch.

**Problem:**
- Poor UX for bulk operations
- No way to see "these files belong to this batch"
- Can't review batch before processing

---

## New Workflow Overview

### Three-Phase Design

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: Batch Creation & File Upload                       │
│ User Action: Create batch → Upload files → Review → Start   │
│ System: Stores files, creates Batch entity (DRAFT)          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Automated Processing Pipeline                      │
│ System Action: For each file → Audit → Plan → Remediate     │
│ User: Monitors progress in real-time via SSE                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Results & User Actions                             │
│ User Choices:                                                │
│  - Review quick-fix suggestions                             │
│  - Generate ACR/VPAT (individual or aggregate)              │
│  - Export remediated files (ZIP)                            │
│  - Manual remediation for remaining issues                  │
└─────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Batch-First Design** - Batch is created upfront, files belong to batch
2. **Automated Pipeline** - System handles audit → plan → remediate without user intervention
3. **Transparent Progress** - Real-time visibility into each file's processing stage
4. **Flexible Actions** - User chooses next steps based on results
5. **Batch Context Preservation** - All files processed together maintain batch relationship

---

## Architecture Design

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND                                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Pages:                                                       │
│  ├─ BatchCreate.tsx          (New)                          │
│  │  └─ Bulk file upload, batch naming                       │
│  │                                                            │
│  ├─ BatchProcessing.tsx      (New)                          │
│  │  └─ Real-time progress, file status                      │
│  │                                                            │
│  ├─ BatchResults.tsx         (Redesigned)                   │
│  │  └─ Summary, action buttons (ACR, Export, Quick-fix)     │
│  │                                                            │
│  └─ BatchAcrGeneration.tsx   (Reuses existing ACR code)     │
│                                                               │
│  Components:                                                  │
│  ├─ BulkFileUploader.tsx     (New - drag-drop)              │
│  ├─ BatchProgressTracker.tsx (New - SSE updates)            │
│  ├─ FileStatusTable.tsx      (New - per-file status)        │
│  └─ BatchActionButtons.tsx   (New - post-processing actions)│
│                                                               │
│  Services:                                                    │
│  ├─ batchService.ts          (New API client)               │
│  └─ batchAcrService.ts       (Reuses existing)              │
│                                                               │
│  Hooks:                                                       │
│  ├─ useBatch()               (New)                          │
│  ├─ useBatchProgress()       (New - SSE)                    │
│  └─ useBatchActions()        (New)                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼ HTTP/REST + SSE
┌─────────────────────────────────────────────────────────────┐
│                     BACKEND                                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Routes (batch.routes.ts):                                   │
│  ├─ POST   /batch                    (Create batch)         │
│  ├─ POST   /batch/:id/files          (Upload files)         │
│  ├─ DELETE /batch/:id/files/:fileId  (Remove file - DRAFT)  │
│  ├─ POST   /batch/:id/start          (Start processing)     │
│  ├─ GET    /batch/:id                (Get status)           │
│  ├─ GET    /batch                    (List batches)         │
│  ├─ POST   /batch/:id/acr/generate   (Generate ACR)         │
│  ├─ POST   /batch/:id/export         (Export ZIP)           │
│  └─ POST   /batch/:id/quick-fix      (Apply quick-fixes)    │
│                                                               │
│  Controllers (batch.controller.ts):                          │
│  ├─ createBatch()                                            │
│  ├─ uploadFiles()                                            │
│  ├─ startBatchProcessing()                                   │
│  ├─ getBatchStatus()                                         │
│  └─ ... (other actions)                                      │
│                                                               │
│  Services:                                                    │
│  ├─ batch-orchestrator.service.ts   (New - Main pipeline)   │
│  │  └─ Coordinates: audit → plan → remediate                │
│  │                                                            │
│  ├─ batch-file.service.ts           (New - File management) │
│  │  └─ Upload, storage, retrieval                           │
│  │                                                            │
│  ├─ epub-audit.service.ts           (Existing)              │
│  ├─ remediation.service.ts          (Existing)              │
│  ├─ auto-remediation.service.ts     (Existing)              │
│  └─ batch-acr-generator.service.ts  (Existing from prev)    │
│                                                               │
│  Workers:                                                     │
│  ├─ batch-processor.worker.ts       (New)                   │
│  └─ Processes batch through pipeline stages                 │
│                                                               │
│  Database (Prisma):                                          │
│  ├─ Batch model                     (New)                   │
│  ├─ BatchFile model                 (New)                   │
│  └─ Job model (for audit/plan jobs) (Existing)              │
│                                                               │
│  Queue (BullMQ):                                             │
│  └─ batch-processing queue          (New)                   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow - Complete Journey

```
1. User Creates Batch
   POST /batch
   → Batch created (status: DRAFT)
   → Returns batchId

2. User Uploads Files (can upload multiple times)
   POST /batch/:id/files (multipart/form-data)
   → Files uploaded to storage (S3 or local)
   → BatchFile records created (status: UPLOADED)
   → Returns file IDs

3. User Reviews & Starts Processing
   POST /batch/:id/start
   → Batch status: DRAFT → QUEUED
   → Job enqueued in BullMQ
   → Returns batch with processing status

4. Background Worker Processes Batch
   For each BatchFile:

   a) AUDIT STAGE
      → Create EPUB_ACCESSIBILITY job
      → Run DAISY ACE + EPUBCheck
      → Store results in Job.output
      → Update BatchFile:
         * status: UPLOADED → AUDITED
         * auditJobId: <job-id>
         * auditScore: 76
         * issuesFound: 50
      → SSE broadcast: file_audited

   b) PLAN STAGE
      → Call remediationService.createRemediationPlan(auditJobId)
      → Creates BATCH_VALIDATION job with plan
      → Analyze plan (classify by type)
      → Update BatchFile:
         * status: AUDITED → PLANNED
         * planJobId: <plan-job-id>
         * issuesAutoFix: 32
         * issuesQuickFix: 5
         * issuesManual: 13
      → SSE broadcast: file_planned

   c) AUTO-REMEDIATE STAGE
      → Fetch EPUB from storage
      → Call autoRemediationService.runAutoRemediation(epubBuffer, auditJobId, fileName)
      → Apply automatic fixes
      → Save remediated EPUB
      → Update BatchFile:
         * status: PLANNED → REMEDIATED
         * issuesAutoFixed: 32 (actual)
         * remainingQuickFix: 5
         * remainingManual: 13
      → SSE broadcast: file_remediated

   d) Update Batch Summary
      → Increment filesRemediated counter
      → Aggregate: totalIssuesFound, autoFixedIssues, quickFixIssues, manualIssues
      → If all files processed: Batch status → COMPLETED
      → SSE broadcast: batch_completed

5. User Views Results
   GET /batch/:id
   → Returns Batch with all BatchFiles
   → Shows summary statistics
   → Lists per-file results

6. User Takes Action

   Option A: Generate ACR
   POST /batch/:id/acr/generate
   {
     "mode": "individual" | "aggregate",
     "options": { ... }
   }
   → Reuses existing batch-acr-generator.service
   → Uses auditJobId or planJobId for each file
   → Creates ACR_WORKFLOW jobs

   Option B: Export Remediated Files
   POST /batch/:id/export
   → Creates ZIP with all remediated EPUBs
   → Returns download URL

   Option C: Apply Quick Fixes
   POST /batch/:id/quick-fix
   {
     "fileId": "...",
     "taskIds": ["task1", "task2"]
   }
   → Applies quick-fix suggestions
   → Updates remediation plan
   → Re-runs auto-remediation
```

---

## Data Model

### Database Schema (Prisma)

```prisma
// ============================================
// BATCH PROCESSING MODELS (NEW)
// ============================================

model Batch {
  id              String       @id @default(uuid())
  tenantId        String
  userId          String
  name            String       // User-provided or auto-generated

  status          BatchStatus  @default(DRAFT)

  // Progress Tracking
  totalFiles      Int          @default(0)
  filesUploaded   Int          @default(0)
  filesAudited    Int          @default(0)
  filesPlanned    Int          @default(0)
  filesRemediated Int          @default(0)
  filesFailed     Int          @default(0)

  // Summary Statistics
  totalIssuesFound     Int @default(0)
  autoFixedIssues      Int @default(0)
  quickFixIssues       Int @default(0)
  manualIssues         Int @default(0)

  // ACR Generation Metadata (added when ACR created)
  acrGenerated         Boolean  @default(false)
  acrMode              String?  // 'individual' | 'aggregate'
  acrWorkflowIds       String[]
  acrGeneratedAt       DateTime?

  // Relationships
  files           BatchFile[]
  tenant          Tenant       @relation(fields: [tenantId], references: [id])
  user            User         @relation(fields: [userId], references: [id])

  // Timestamps
  createdAt       DateTime     @default(now())
  startedAt       DateTime?    // When processing started
  completedAt     DateTime?    // When all files processed

  @@index([tenantId, status])
  @@index([userId])
  @@index([createdAt])
}

model BatchFile {
  id              String       @id @default(uuid())
  batchId         String
  batch           Batch        @relation(fields: [batchId], references: [id], onDelete: Cascade)

  // File Info
  fileName        String
  originalName    String       // User's original filename
  fileSize        Int          // Bytes
  mimeType        String       @default("application/epub+zip")
  storagePath     String       // S3 key or local path
  storageType     String       @default("S3") // 'S3' | 'LOCAL'

  // Processing Status
  status          FileStatus   @default(UPLOADED)

  // Job References (link to existing Job model)
  auditJobId      String?      // EPUB_ACCESSIBILITY job
  planJobId       String?      // BATCH_VALIDATION job (remediation plan)

  // Audit Results
  auditScore      Int?
  issuesFound     Int?

  // Plan Analysis
  issuesAutoFix   Int?         // Issues that can be auto-fixed
  issuesQuickFix  Int?         // Issues that need quick-fix
  issuesManual    Int?         // Issues requiring manual intervention

  // Remediation Results
  issuesAutoFixed      Int?    // Actually fixed issues
  remainingQuickFix    Int?    // Still need quick-fix
  remainingManual      Int?    // Still need manual work

  // File Paths
  remediatedFilePath   String? // Path to remediated EPUB
  comparisonReportPath String? // Path to comparison PDF

  // Error Handling
  error           String?      // Error message if failed
  errorDetails    Json?        // Detailed error info

  // Timestamps
  uploadedAt      DateTime     @default(now())
  auditStartedAt  DateTime?
  auditCompletedAt DateTime?
  planCreatedAt   DateTime?
  remediationStartedAt DateTime?
  remediationCompletedAt DateTime?

  @@index([batchId])
  @@index([status])
}

enum BatchStatus {
  DRAFT          // User creating batch, adding files
  QUEUED         // Ready for processing, in queue
  PROCESSING     // Currently being processed
  COMPLETED      // All files processed (may have failures)
  FAILED         // Batch-level failure (all files failed)
  CANCELLED      // User cancelled processing
}

enum FileStatus {
  UPLOADED       // File uploaded, waiting for processing
  AUDITING       // Audit in progress
  AUDITED        // Audit completed
  PLANNING       // Creating remediation plan
  PLANNED        // Plan created
  REMEDIATING    // Auto-remediation in progress
  REMEDIATED     // Auto-remediation completed
  FAILED         // Processing failed
  SKIPPED        // Skipped due to batch error/cancellation
}

// ============================================
// EXISTING MODELS (Updated Relations)
// ============================================

model Tenant {
  // ... existing fields
  batches         Batch[]
}

model User {
  // ... existing fields
  batches         Batch[]
}

// Job model remains unchanged - used for audit/plan/acr jobs
```

### Type Definitions (TypeScript)

```typescript
// src/types/batch.types.ts

export interface BatchCreateRequest {
  name?: string;  // Optional - will auto-generate if not provided
}

export interface BatchFileUploadRequest {
  files: File[];  // Multipart form data
}

export interface BatchStartRequest {
  options?: {
    skipAudit?: boolean;        // Skip audit if files already audited
    autoRemediateOnly?: boolean; // Don't wait for user quick-fix review
  };
}

export interface BatchSummary {
  batchId: string;
  name: string;
  status: BatchStatus;

  // Progress
  totalFiles: number;
  filesUploaded: number;
  filesAudited: number;
  filesPlanned: number;
  filesRemediated: number;
  filesFailed: number;

  // Statistics
  totalIssuesFound: number;
  autoFixedIssues: number;
  quickFixIssues: number;
  manualIssues: number;

  // Timestamps
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BatchFileDetails {
  id: string;
  fileName: string;
  fileSize: number;
  status: FileStatus;

  // Results
  auditScore?: number;
  issuesFound?: number;
  issuesAutoFixed?: number;
  remainingQuickFix?: number;
  remainingManual?: number;

  error?: string;

  // Timestamps
  uploadedAt: string;
  remediationCompletedAt?: string;
}

export interface BatchWithFiles extends BatchSummary {
  files: BatchFileDetails[];
}

export interface BatchActionRequest {
  action: 'generate-acr' | 'export' | 'quick-fix';
  params?: Record<string, any>;
}

export type BatchStatus =
  | 'DRAFT'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type FileStatus =
  | 'UPLOADED'
  | 'AUDITING'
  | 'AUDITED'
  | 'PLANNING'
  | 'PLANNED'
  | 'REMEDIATING'
  | 'REMEDIATED'
  | 'FAILED'
  | 'SKIPPED';
```

---

## Service Architecture

### Service Hierarchy

```
BatchController
      ↓
BatchOrchestratorService (Main coordinator)
      ↓
      ├─→ BatchFileService (File management)
      ├─→ EpubAuditService (Existing - audit EPUBs)
      ├─→ RemediationService (Existing - create plans)
      ├─→ AutoRemediationService (Existing - auto-fix)
      ├─→ EpubComparisonService (Existing - compare before/after)
      └─→ BatchAcrGeneratorService (Existing - generate ACR)
```

### BatchOrchestratorService (New)

**Responsibility:** Coordinates the entire batch processing pipeline.

```typescript
// src/services/batch/batch-orchestrator.service.ts

import { Batch, BatchFile, BatchStatus, FileStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { batchFileService } from './batch-file.service';
import { epubAuditService } from '../epub/epub-audit.service';
import { remediationService } from '../epub/remediation.service';
import { autoRemediationService } from '../epub/auto-remediation.service';
import { sseService } from '../../sse/sse.service';

class BatchOrchestratorService {
  /**
   * Create a new batch
   */
  async createBatch(
    tenantId: string,
    userId: string,
    name?: string
  ): Promise<Batch> {
    const batchName = name || this.generateBatchName();

    const batch = await prisma.batch.create({
      data: {
        tenantId,
        userId,
        name: batchName,
        status: 'DRAFT',
      },
    });

    logger.info(`Created batch ${batch.id}: "${batchName}"`);
    return batch;
  }

  /**
   * Add files to batch (can be called multiple times while DRAFT)
   */
  async addFilesToBatch(
    batchId: string,
    files: Array<{ buffer: Buffer; filename: string; size: number }>
  ): Promise<BatchFile[]> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Cannot add files to batch that is not in DRAFT status');
    }

    const batchFiles = await batchFileService.uploadFiles(batchId, files);

    // Update batch file count
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        totalFiles: { increment: files.length },
        filesUploaded: { increment: files.length },
      },
    });

    logger.info(`Added ${files.length} files to batch ${batchId}`);
    return batchFiles;
  }

  /**
   * Start batch processing (enqueue in BullMQ)
   */
  async startBatchProcessing(batchId: string): Promise<Batch> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Batch must be in DRAFT status to start');
    }

    if (batch.totalFiles === 0) {
      throw new Error('Cannot start batch with no files');
    }

    // Update status
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'QUEUED',
        startedAt: new Date(),
      },
    });

    // Enqueue in BullMQ (or process synchronously if no Redis)
    const queue = getBatchQueue();
    if (queue) {
      await queue.add(`batch-${batchId}`, {
        batchId,
        tenantId: batch.tenantId,
      });
      logger.info(`Batch ${batchId} queued for processing`);
    } else {
      // Process synchronously
      this.processBatchSync(batchId).catch((err) => {
        logger.error(`Batch ${batchId} processing failed:`, err);
      });
    }

    return this.getBatch(batchId);
  }

  /**
   * Main processing pipeline (called by worker)
   */
  async processBatchSync(batchId: string): Promise<void> {
    logger.info(`[Batch ${batchId}] Starting processing pipeline`);

    const batch = await this.getBatch(batchId);

    // Update status
    await prisma.batch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING' },
    });

    const files = await prisma.batchFile.findMany({
      where: { batchId },
      orderBy: { uploadedAt: 'asc' },
    });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        logger.info(`[Batch ${batchId}] Processing file ${i + 1}/${files.length}: ${file.fileName}`);

        // Step 1: Audit
        await this.auditFile(batchId, file);

        // Step 2: Create Plan
        await this.createPlanForFile(batchId, file);

        // Step 3: Auto-Remediate
        await this.autoRemediateFile(batchId, file);

        logger.info(`[Batch ${batchId}] File ${file.fileName} completed successfully`);

      } catch (error) {
        logger.error(`[Batch ${batchId}] File ${file.fileName} failed:`, error);

        await prisma.batchFile.update({
          where: { id: file.id },
          data: {
            status: 'FAILED',
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });

        await prisma.batch.update({
          where: { id: batchId },
          data: { filesFailed: { increment: 1 } },
        });

        // Broadcast failure
        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'file_failed',
          batchId,
          fileId: file.id,
          fileName: file.fileName,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, batch.tenantId);
      }
    }

    // Mark batch as completed
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    // Broadcast completion
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'batch_completed',
      batchId,
      totalFiles: batch.totalFiles,
      filesRemediated: batch.filesRemediated,
      filesFailed: batch.filesFailed,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Processing completed: ${batch.filesRemediated}/${batch.totalFiles} successful`);
  }

  /**
   * Step 1: Audit EPUB
   */
  private async auditFile(batchId: string, file: BatchFile): Promise<void> {
    // Update status
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'AUDITING',
        auditStartedAt: new Date(),
      },
    });

    // Broadcast status change
    const batch = await this.getBatch(batchId);
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_auditing',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
    }, batch.tenantId);

    // Get EPUB buffer
    const epubBuffer = await batchFileService.getFileBuffer(file.id);

    // Run audit (creates EPUB_ACCESSIBILITY job)
    const auditJob = await epubAuditService.auditEpub(
      epubBuffer,
      file.fileName,
      batch.tenantId,
      batch.userId
    );

    // Wait for audit completion (or poll if async)
    const auditResults = await this.waitForJobCompletion(auditJob.id);

    // Extract results
    const score = auditResults.score || 0;
    const totalIssues = auditResults.totalIssues || 0;

    // Update file
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'AUDITED',
        auditJobId: auditJob.id,
        auditScore: score,
        issuesFound: totalIssues,
        auditCompletedAt: new Date(),
      },
    });

    // Update batch summary
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesAudited: { increment: 1 },
        totalIssuesFound: { increment: totalIssues },
      },
    });

    // Broadcast completion
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_audited',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
      score,
      issuesFound: totalIssues,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Audit completed for ${file.fileName}: ${score}% score, ${totalIssues} issues`);
  }

  /**
   * Step 2: Create Remediation Plan
   */
  private async createPlanForFile(batchId: string, file: BatchFile): Promise<void> {
    await prisma.batchFile.update({
      where: { id: file.id },
      data: { status: 'PLANNING' },
    });

    const batch = await this.getBatch(batchId);
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_planning',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
    }, batch.tenantId);

    // Create remediation plan
    const plan = await remediationService.createRemediationPlan(file.auditJobId!);

    // Analyze plan by type
    const autoTasks = plan.tasks.filter(t => t.type === 'auto');
    const quickFixTasks = plan.tasks.filter(t => t.type === 'quickfix');
    const manualTasks = plan.tasks.filter(t => t.type === 'manual');

    // Update file
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'PLANNED',
        planJobId: plan.jobId,
        issuesAutoFix: autoTasks.length,
        issuesQuickFix: quickFixTasks.length,
        issuesManual: manualTasks.length,
        planCreatedAt: new Date(),
      },
    });

    // Update batch summary
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesPlanned: { increment: 1 },
        quickFixIssues: { increment: quickFixTasks.length },
        manualIssues: { increment: manualTasks.length },
      },
    });

    // Broadcast
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_planned',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
      autoTasks: autoTasks.length,
      quickFixTasks: quickFixTasks.length,
      manualTasks: manualTasks.length,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Plan created for ${file.fileName}: ${autoTasks.length} auto, ${quickFixTasks.length} quick, ${manualTasks.length} manual`);
  }

  /**
   * Step 3: Auto-Remediate
   */
  private async autoRemediateFile(batchId: string, file: BatchFile): Promise<void> {
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'REMEDIATING',
        remediationStartedAt: new Date(),
      },
    });

    const batch = await this.getBatch(batchId);
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_remediating',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
    }, batch.tenantId);

    // Get EPUB buffer
    const epubBuffer = await batchFileService.getFileBuffer(file.id);

    // Run auto-remediation
    const result = await autoRemediationService.runAutoRemediation(
      epubBuffer,
      file.auditJobId!,
      file.fileName
    );

    // Save remediated EPUB
    const remediatedPath = await batchFileService.saveRemediatedFile(
      file.id,
      file.fileName.replace('.epub', '_remediated.epub'),
      result.remediatedBuffer
    );

    // Update file
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'REMEDIATED',
        issuesAutoFixed: result.totalIssuesFixed,
        remainingQuickFix: file.issuesQuickFix,
        remainingManual: file.issuesManual,
        remediatedFilePath: remediatedPath,
        remediationCompletedAt: new Date(),
      },
    });

    // Update batch summary
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesRemediated: { increment: 1 },
        autoFixedIssues: { increment: result.totalIssuesFixed },
      },
    });

    // Broadcast
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_remediated',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
      issuesFixed: result.totalIssuesFixed,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Remediation completed for ${file.fileName}: ${result.totalIssuesFixed} issues fixed`);
  }

  /**
   * Get batch with files
   */
  async getBatch(batchId: string): Promise<Batch> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { files: true },
    });

    if (!batch) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    return batch;
  }

  /**
   * Helper: Wait for job completion
   */
  private async waitForJobCompletion(jobId: string): Promise<any> {
    // Poll job status until completed
    // This could use a promise + SSE listener for efficiency
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes

    while (attempts < maxAttempts) {
      const job = await prisma.job.findUnique({ where: { id: jobId } });

      if (job?.status === 'COMPLETED') {
        return job.output;
      }

      if (job?.status === 'FAILED') {
        throw new Error(`Job failed: ${jobId}`);
      }

      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
      attempts++;
    }

    throw new Error(`Job timeout: ${jobId}`);
  }

  /**
   * Generate batch name
   */
  private generateBatchName(): string {
    const date = new Date().toISOString().split('T')[0];
    return `Batch ${date}`;
  }
}

export const batchOrchestratorService = new BatchOrchestratorService();
```

### BatchFileService (New)

**Responsibility:** File upload, storage, and retrieval.

```typescript
// src/services/batch/batch-file.service.ts

import prisma from '../../lib/prisma';
import { s3Service } from '../storage/s3.service';
import { logger } from '../../lib/logger';
import { BatchFile } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';

class BatchFileService {
  /**
   * Upload files to storage and create BatchFile records
   */
  async uploadFiles(
    batchId: string,
    files: Array<{ buffer: Buffer; filename: string; size: number }>
  ): Promise<BatchFile[]> {
    const batchFiles: BatchFile[] = [];

    for (const file of files) {
      // Generate unique filename
      const uniqueFilename = this.generateUniqueFilename(file.filename);

      // Upload to storage (S3 or local)
      const storagePath = await this.uploadToStorage(batchId, uniqueFilename, file.buffer);

      // Create database record
      const batchFile = await prisma.batchFile.create({
        data: {
          batchId,
          fileName: uniqueFilename,
          originalName: file.filename,
          fileSize: file.size,
          mimeType: 'application/epub+zip',
          storagePath,
          storageType: process.env.STORAGE_TYPE || 'S3',
          status: 'UPLOADED',
        },
      });

      batchFiles.push(batchFile);
      logger.info(`Uploaded file ${file.filename} to batch ${batchId}`);
    }

    return batchFiles;
  }

  /**
   * Get file buffer from storage
   */
  async getFileBuffer(fileId: string): Promise<Buffer> {
    const file = await prisma.batchFile.findUnique({ where: { id: fileId } });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    if (file.storageType === 'S3') {
      return await s3Service.downloadFile(file.storagePath);
    } else {
      return await fs.readFile(file.storagePath);
    }
  }

  /**
   * Save remediated file
   */
  async saveRemediatedFile(
    fileId: string,
    filename: string,
    buffer: Buffer
  ): Promise<string> {
    const file = await prisma.batchFile.findUnique({ where: { id: fileId } });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const remediatedPath = file.storagePath.replace('.epub', '_remediated.epub');

    if (file.storageType === 'S3') {
      await s3Service.uploadFile(remediatedPath, buffer);
    } else {
      await fs.writeFile(remediatedPath, buffer);
    }

    return remediatedPath;
  }

  /**
   * Upload to storage (S3 or local)
   */
  private async uploadToStorage(
    batchId: string,
    filename: string,
    buffer: Buffer
  ): Promise<string> {
    const storageType = process.env.STORAGE_TYPE || 'S3';

    if (storageType === 'S3') {
      const s3Key = `batches/${batchId}/${filename}`;
      await s3Service.uploadFile(s3Key, buffer);
      return s3Key;
    } else {
      const uploadDir = process.env.BATCH_UPLOAD_DIR || './data/batches';
      const batchDir = path.join(uploadDir, batchId);
      await fs.mkdir(batchDir, { recursive: true });
      const filePath = path.join(batchDir, filename);
      await fs.writeFile(filePath, buffer);
      return filePath;
    }
  }

  /**
   * Generate unique filename
   */
  private generateUniqueFilename(originalFilename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    return `${basename}-${timestamp}-${random}${ext}`;
  }
}

export const batchFileService = new BatchFileService();
```

---

## API Design

### REST Endpoints

```typescript
// Base URL: /api/v1/batch

// ========================================
// BATCH MANAGEMENT
// ========================================

/**
 * Create new batch
 */
POST /batch
Authorization: Bearer <token>
Body: {
  "name": "Q1 2026 EPUB Batch" // Optional
}
Response (201): {
  "success": true,
  "data": {
    "batchId": "uuid",
    "name": "Q1 2026 EPUB Batch",
    "status": "DRAFT",
    "totalFiles": 0,
    "createdAt": "2026-01-21T10:00:00Z"
  }
}

/**
 * Upload files to batch (multipart/form-data)
 * Can be called multiple times while status = DRAFT
 */
POST /batch/:batchId/files
Authorization: Bearer <token>
Content-Type: multipart/form-data
Body: FormData with files[]
Response (201): {
  "success": true,
  "data": {
    "filesAdded": 5,
    "files": [
      {
        "fileId": "uuid",
        "fileName": "book1-1737456789-abc123.epub",
        "originalName": "book1.epub",
        "fileSize": 3812,
        "status": "UPLOADED"
      },
      // ... more files
    ]
  }
}

/**
 * Remove file from batch (only while DRAFT)
 */
DELETE /batch/:batchId/files/:fileId
Authorization: Bearer <token>
Response (200): {
  "success": true,
  "message": "File removed from batch"
}

/**
 * Start batch processing
 */
POST /batch/:batchId/start
Authorization: Bearer <token>
Body: {
  "options": {
    "skipAudit": false,        // Optional
    "autoRemediateOnly": true  // Optional
  }
}
Response (200): {
  "success": true,
  "data": {
    "batchId": "uuid",
    "status": "QUEUED",
    "totalFiles": 5,
    "startedAt": "2026-01-21T10:05:00Z"
  }
}

/**
 * Get batch status (with file details)
 */
GET /batch/:batchId
Authorization: Bearer <token>
Response (200): {
  "success": true,
  "data": {
    "batchId": "uuid",
    "name": "Q1 2026 EPUB Batch",
    "status": "PROCESSING",

    // Progress
    "totalFiles": 5,
    "filesUploaded": 5,
    "filesAudited": 3,
    "filesPlanned": 3,
    "filesRemediated": 2,
    "filesFailed": 0,

    // Summary
    "totalIssuesFound": 187,
    "autoFixedIssues": 124,
    "quickFixIssues": 23,
    "manualIssues": 40,

    // Files
    "files": [
      {
        "fileId": "uuid",
        "fileName": "book1-xxx.epub",
        "originalName": "book1.epub",
        "status": "REMEDIATED",
        "auditScore": 76,
        "issuesFound": 50,
        "issuesAutoFixed": 32,
        "remainingQuickFix": 5,
        "remainingManual": 13,
        "uploadedAt": "2026-01-21T10:01:00Z",
        "remediationCompletedAt": "2026-01-21T10:12:00Z"
      },
      // ... more files
    ],

    // Timestamps
    "createdAt": "2026-01-21T10:00:00Z",
    "startedAt": "2026-01-21T10:05:00Z",
    "completedAt": null
  }
}

/**
 * List all batches
 */
GET /batch
Authorization: Bearer <token>
Query: ?page=1&limit=20&status=COMPLETED
Response (200): {
  "success": true,
  "data": {
    "batches": [
      {
        "batchId": "uuid",
        "name": "Q1 2026 EPUB Batch",
        "status": "COMPLETED",
        "totalFiles": 5,
        "filesRemediated": 5,
        "createdAt": "2026-01-21T10:00:00Z",
        "completedAt": "2026-01-21T10:20:00Z"
      },
      // ... more batches
    ],
    "total": 47,
    "page": 1,
    "limit": 20
  }
}

/**
 * Cancel batch processing
 */
POST /batch/:batchId/cancel
Authorization: Bearer <token>
Response (200): {
  "success": true,
  "message": "Batch processing cancelled"
}

// ========================================
// BATCH ACTIONS (POST-PROCESSING)
// ========================================

/**
 * Generate ACR/VPAT for batch
 */
POST /batch/:batchId/acr/generate
Authorization: Bearer <token>
Body: {
  "mode": "individual" | "aggregate",
  "options": {
    "edition": "VPAT2.5-WCAG",
    "batchName": "Q1 2026 EPUB Collection",
    "vendor": "ACME Publishing",
    "contactEmail": "a11y@acme.com",
    "aggregationStrategy": "conservative"
  }
}
Response (201): {
  "success": true,
  "data": {
    "mode": "aggregate",
    "acrWorkflowId": "uuid",
    "totalDocuments": 5,
    "totalCriteria": 50
  }
}

/**
 * Export remediated files as ZIP
 */
POST /batch/:batchId/export
Authorization: Bearer <token>
Body: {
  "format": "zip",
  "includeOriginals": false,
  "includeComparisons": false
}
Response (200): {
  "success": true,
  "data": {
    "downloadUrl": "https://s3.../batch-remediated.zip",
    "fileSize": 15728640,
    "expiresAt": "2026-01-21T22:00:00Z"
  }
}

/**
 * Apply quick-fix suggestions
 */
POST /batch/:batchId/quick-fix
Authorization: Bearer <token>
Body: {
  "fileId": "uuid",
  "taskIds": ["task-1", "task-2", "task-3"]
}
Response (200): {
  "success": true,
  "data": {
    "appliedFixes": 3,
    "newScore": 89,
    "remainingQuickFix": 2,
    "remainingManual": 13
  }
}

// ========================================
// SSE (Server-Sent Events)
// ========================================

/**
 * Subscribe to batch progress updates
 */
GET /sse/subscribe?channel=batch:uuid
Authorization: Bearer <token>

Events:
- file_auditing
- file_audited
- file_planning
- file_planned
- file_remediating
- file_remediated
- file_failed
- batch_completed
```

---

## User Experience Flow

### Phase 1: Create Batch & Upload Files

**Page: `/batch/create`**

```
┌────────────────────────────────────────────────────────────┐
│  ← Back                                                     │
│                                                              │
│  📦 Create New Batch                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  Batch Name (Optional)                                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Q1 2026 EPUB Collection                              │  │
│  └──────────────────────────────────────────────────────┘  │
│  Leave blank to auto-generate                              │
│                                                              │
│  Upload EPUB Files                                          │
│  ┌────────────────────────────────────────────────────────┐│
│  │                                                          ││
│  │  ⬆️  Drop EPUB files here or click to browse          ││
│  │                                                          ││
│  │  Supported: .epub files                                ││
│  │  Maximum: 50 files per batch                           ││
│  │  Max file size: 100 MB per file                        ││
│  │                                                          ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  Files Added (5):                                           │
│  ┌────────────────────────────────────────────────────────┐│
│  │ ✓ 01-accessible-baseline.epub       3.8 KB      [×]    ││
│  │ ✓ 02-missing-alt-text.epub          4.2 KB      [×]    ││
│  │ ✓ 03-empty-alt-text.epub            3.7 KB      [×]    ││
│  │ ✓ 04-science-textbook.epub          977 KB      [×]    ││
│  │ ✓ 05-history-atlas.epub             1.2 MB      [×]    ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  Total: 5 files | 2.4 MB                                   │
│                                                              │
│  [Cancel]            [Add More Files]  [Start Processing]→ │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

**User Actions:**
1. ✅ User can provide batch name or leave blank for auto-generation
2. ✅ Drag-drop multiple EPUB files at once
3. ✅ Can remove files before starting (click [×])
4. ✅ Can add more files with "Add More Files" button
5. ✅ Click "Start Processing" when ready

**API Calls:**
```javascript
// 1. Create batch
POST /api/v1/batch
{ "name": "Q1 2026 EPUB Collection" }
→ Returns batchId

// 2. Upload files (FormData)
POST /api/v1/batch/{batchId}/files
FormData: { files: [file1, file2, file3, file4, file5] }
→ Returns file IDs

// 3. Start processing
POST /api/v1/batch/{batchId}/start
→ Batch status: DRAFT → QUEUED
```

---

### Phase 2: Real-Time Processing View

**Page: `/batch/{batchId}/processing`**

**Auto-redirects here after clicking "Start Processing"**

```
┌────────────────────────────────────────────────────────────┐
│  ← Back to Batches                                         │
│                                                              │
│  📦 Batch Processing: Q1 2026 EPUB Collection              │
│  Status: 🔄 Processing (3/5 files completed)               │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  Overall Progress                                           │
│  [████████████████████░░░░░░░░░░░░░] 60%                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ Summary                                                 ││
│  ├────────────────────────────────────────────────────────┤│
│  │ Total Files: 5                                         ││
│  │ ✅ Remediated: 3                                       ││
│  │ 🔄 In Progress: 1                                      ││
│  │ ⏳ Queued: 1                                           ││
│  │ ❌ Failed: 0                                           ││
│  │                                                         ││
│  │ Issues Found: 187                                      ││
│  │ Auto-Fixed: 124                                        ││
│  │ Quick-Fix Needed: 23                                   ││
│  │ Manual Work: 40                                        ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  File Processing Details                                    │
│  ┌────────────────────────────────────────────────────────┐│
│  │ File                        Status          Details     ││
│  ├────────────────────────────────────────────────────────┤│
│  │ 01-accessible-baseline.epub                            ││
│  │ ✅ Remediated                                          ││
│  │    Audit: 91% | Fixed: 15/15 | Quick: 3 | Manual: 8  ││
│  │    Completed at 10:08 AM                               ││
│  │                                                         ││
│  │ 02-missing-alt-text.epub                               ││
│  │ ✅ Remediated                                          ││
│  │    Audit: 76% | Fixed: 32/37 | Quick: 5 | Manual: 13  ││
│  │    Completed at 10:10 AM                               ││
│  │                                                         ││
│  │ 03-empty-alt-text.epub                                 ││
│  │ ✅ Remediated                                          ││
│  │    Audit: 91% | Fixed: 17/22 | Quick: 0 | Manual: 5   ││
│  │    Completed at 10:12 AM                               ││
│  │                                                         ││
│  │ 04-science-textbook.epub                               ││
│  │ 🔄 Remediating...                                      ││
│  │    Audit: 68% | Issues: 78                             ││
│  │    Plan: 50 auto, 10 quick, 18 manual                  ││
│  │                                                         ││
│  │ 05-history-atlas.epub                                  ││
│  │ ⏳ Queued                                               ││
│  │    Waiting for processing...                           ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  [Cancel Batch]                       [View Full Details] │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

**Real-Time Updates via SSE:**
```javascript
// Frontend listens to SSE channel
const eventSource = new EventSource('/api/v1/sse/subscribe?channel=batch:uuid');

eventSource.addEventListener('file_audited', (event) => {
  const { fileId, fileName, score, issuesFound } = JSON.parse(event.data);
  // Update UI to show audit completed
});

eventSource.addEventListener('file_remediated', (event) => {
  const { fileId, fileName, issuesFixed } = JSON.parse(event.data);
  // Update UI to show remediation completed
  // Update progress bar
});

eventSource.addEventListener('batch_completed', (event) => {
  // Redirect to results page
  window.location.href = `/batch/${batchId}/results`;
});
```

**User Actions:**
1. ✅ Watch real-time progress updates
2. ✅ See each file's current stage (Auditing → Planned → Remediating → Remediated)
3. ✅ Monitor overall batch progress
4. ✅ Can cancel batch if needed
5. ✅ Auto-redirects to results when completed

---

### Phase 3: Batch Results & Actions

**Page: `/batch/{batchId}/results`**

**Auto-navigates here when batch completes**

```
┌────────────────────────────────────────────────────────────┐
│  ← Back to Batches                                         │
│                                                              │
│  🎉 Batch Processing Complete                              │
│  Q1 2026 EPUB Collection                                   │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ Summary                                                 ││
│  ├────────────────────────────────────────────────────────┤│
│  │ ✅ 5 of 5 files processed successfully                 ││
│  │ 📊 187 total issues found                              ││
│  │ 🔧 124 issues auto-fixed (66%)                         ││
│  │ ⚡ 23 quick-fix issues remaining (12%)                ││
│  │ ✏️ 40 manual issues remaining (21%)                   ││
│  │                                                         ││
│  │ 📈 Average audit score: 75% → 88% (projected)         ││
│  │ ⏱️ Processing time: 15 minutes                        ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  What would you like to do next?                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ 🔍 Review Quick-Fix Suggestions                        ││
│  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ││
│  │ 23 issues can be fixed with guided suggestions        ││
│  │ Review and apply quick-fixes to improve compliance     ││
│  │                                                         ││
│  │ [Review & Apply] →                                     ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ 📄 Generate ACR/VPAT Report                            ││
│  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ││
│  │ Create accessibility conformance report                ││
│  │ • Individual ACRs (1 per EPUB)                         ││
│  │ • Aggregate ACR (1 for entire batch)                   ││
│  │                                                         ││
│  │ [Generate ACR] →                                       ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ 💾 Export Remediated Files                             ││
│  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ││
│  │ Download all auto-remediated EPUBs as ZIP              ││
│  │ Files: 5 | Total size: 2.4 MB                          ││
│  │                                                         ││
│  │ [Download ZIP] ⬇️                                      ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ ✏️ Manual Remediation                                  ││
│  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ││
│  │ Address remaining issues individually per file         ││
│  │ 40 issues require manual review and editing            ││
│  │                                                         ││
│  │ [Start Manual Review] →                                ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐│
│  │ File Results (5)                                       ││
│  ├────────────────────────────────────────────────────────┤│
│  │ 01-accessible-baseline.epub                            ││
│  │ ✅ Remediated | Score: 91% → 96%                       ││
│  │ Issues: 15 found → 0 auto-fixed → 3 quick, 8 manual   ││
│  │ [View Details] [Download]                              ││
│  │                                                         ││
│  │ 02-missing-alt-text.epub                               ││
│  │ ✅ Remediated | Score: 76% → 89%                       ││
│  │ Issues: 50 found → 32 auto-fixed → 5 quick, 13 manual ││
│  │ [View Details] [Download]                              ││
│  │                                                         ││
│  │ ... (more files)                                       ││
│  └────────────────────────────────────────────────────────┘│
│                                                              │
└────────────────────────────────────────────────────────────┘
```

**User Actions:**

1. **Review Quick-Fix Suggestions**
   - Redirects to `/batch/{batchId}/quick-fix`
   - Shows issues with suggested fixes
   - User can approve/reject each
   - Applied fixes update remediation plan

2. **Generate ACR**
   - Opens modal (same as original design)
   - Choose Individual or Aggregate mode
   - Configure ACR options
   - Redirects to ACR viewer

3. **Export Remediated Files**
   - API creates ZIP with all `_remediated.epub` files
   - Returns download URL
   - Browser initiates download

4. **Manual Remediation**
   - Redirects to `/batch/{batchId}/manual`
   - Shows list of files with manual issues
   - Click file → opens remediation workflow

5. **View/Download Individual Files**
   - Click "View Details" → file-specific results page
   - Click "Download" → downloads remediated EPUB

---

## Implementation Phases

### Phase 1: Database & Core Services (Backend)

**Estimated Time:** 2-3 days

**Tasks:**
1. ✅ Create Prisma schema (Batch, BatchFile models)
2. ✅ Run database migration
3. ✅ Create BatchOrchestratorService skeleton
4. ✅ Create BatchFileService (file upload/storage)
5. ✅ Update existing services (EpubAuditService, etc.) if needed
6. ✅ Create BullMQ batch-processing queue

**Deliverables:**
- Database tables created
- File upload working
- Batch creation working
- No UI yet (test via Postman)

**Testing:**
- Create batch via API ✅
- Upload files via API ✅
- Files stored in S3/local ✅
- BatchFile records created ✅

---

### Phase 2: Processing Pipeline (Backend)

**Estimated Time:** 3-4 days

**Tasks:**
1. ✅ Implement `processBatchSync()` in BatchOrchestratorService
2. ✅ Implement `auditFile()` - integrate with EpubAuditService
3. ✅ Implement `createPlanForFile()` - integrate with RemediationService
4. ✅ Implement `autoRemediateFile()` - integrate with AutoRemediationService
5. ✅ Add SSE broadcasts for progress updates
6. ✅ Add error handling and retry logic
7. ✅ Create batch-processor.worker.ts

**Deliverables:**
- End-to-end pipeline working
- Files processed: Audit → Plan → Remediate
- SSE events broadcasting
- Worker processing batches

**Testing:**
- Start batch via API ✅
- Monitor SSE events ✅
- Verify files remediated ✅
- Check database records ✅

---

### Phase 3: API Routes & Controllers (Backend)

**Estimated Time:** 2 days

**Tasks:**
1. ✅ Create batch.routes.ts
2. ✅ Create batch.controller.ts
3. ✅ Add validation schemas (Zod)
4. ✅ Add authentication middleware
5. ✅ Add authorization (RBAC)
6. ✅ Implement all endpoints (create, upload, start, get, list, export, etc.)

**Deliverables:**
- All API endpoints working
- Request validation in place
- Auth/authz enforced
- API documentation updated

**Testing:**
- Test all endpoints via Postman ✅
- Test error cases ✅
- Test permissions ✅

---

### Phase 4: Frontend - Batch Creation UI

**Estimated Time:** 2-3 days

**Tasks:**
1. ✅ Create BatchCreate page
2. ✅ Create BulkFileUploader component (drag-drop)
3. ✅ Create batchService.ts API client
4. ✅ Create useBatch() hook
5. ✅ Implement file upload with progress
6. ✅ Add file list with remove capability
7. ✅ Add "Start Processing" button

**Deliverables:**
- Batch creation page working
- Bulk file upload working
- Files can be removed before processing
- Start processing triggers API call

**Testing:**
- Upload 5 files ✅
- Remove 1 file ✅
- Start processing ✅
- Batch created and queued ✅

---

### Phase 5: Frontend - Processing View UI

**Estimated Time:** 2-3 days

**Tasks:**
1. ✅ Create BatchProcessing page
2. ✅ Create BatchProgressTracker component
3. ✅ Create FileStatusTable component
4. ✅ Implement SSE connection (useBatchProgress hook)
5. ✅ Add real-time progress updates
6. ✅ Add auto-redirect on completion

**Deliverables:**
- Processing page shows real-time progress
- SSE updates reflected in UI
- Progress bar updates
- Auto-redirects when done

**Testing:**
- Start batch, watch progress ✅
- Verify real-time updates ✅
- Test auto-redirect ✅

---

### Phase 6: Frontend - Results & Actions UI

**Estimated Time:** 3-4 days

**Tasks:**
1. ✅ Create BatchResults page
2. ✅ Create BatchActionButtons component
3. ✅ Integrate batch ACR generation (reuse existing modal)
4. ✅ Implement export ZIP functionality
5. ✅ Add quick-fix review page (optional - can defer)
6. ✅ Add routing and navigation
7. ✅ Add breadcrumbs

**Deliverables:**
- Results page shows summary and actions
- ACR generation works (individual & aggregate)
- Export ZIP downloads remediated files
- All actions functional

**Testing:**
- View batch results ✅
- Generate individual ACRs ✅
- Generate aggregate ACR ✅
- Export ZIP ✅
- Download individual files ✅

---

### Phase 7: Integration & E2E Testing

**Estimated Time:** 2-3 days

**Tasks:**
1. ✅ End-to-end user journey testing
2. ✅ Test with various batch sizes (1, 5, 10, 25 files)
3. ✅ Test error scenarios (failed audits, etc.)
4. ✅ Test cancellation
5. ✅ Performance testing (large files)
6. ✅ UI/UX refinements
7. ✅ Bug fixes

**Deliverables:**
- Complete user flow working
- Edge cases handled
- Performance acceptable
- UI polished

**Testing:**
- Complete journey: Create → Upload → Process → View Results → Generate ACR ✅
- Test failures and retries ✅
- Test large batches ✅

---

## Migration Strategy

### Handling Existing Batch Remediation Code

**Option A: Deprecate Old System**
- Mark existing `BATCH_VALIDATION` job type as deprecated
- Add migration script to convert old batches to new format (if needed)
- Update UI to hide old batch remediation feature
- New Batch entity becomes the standard

**Option B: Coexist (Not Recommended)**
- Keep old system for backward compatibility
- New system used for all new batches
- Eventually sunset old system

**Recommendation:** Option A - Clean break with new system.

### Database Migration Steps

1. **Create new tables** (Batch, BatchFile)
2. **Add indexes** for performance
3. **Test migration** on staging environment
4. **Deploy to production** (tables created, no data migration needed)
5. **Update frontend** to use new batch creation flow
6. **(Optional)** Migrate old batch data if needed

### Rollout Plan

**Week 1-2:** Backend implementation (Phases 1-3)
**Week 3-4:** Frontend implementation (Phases 4-6)
**Week 5:** Testing & refinement (Phase 7)
**Week 6:** Production deployment

**Total Estimated Time:** 5-6 weeks

---

## Success Criteria

### Feature Complete When:

1. ✅ User can create batch and upload 5-50 EPUB files via drag-drop
2. ✅ Batch processing automatically: audits → plans → remediates all files
3. ✅ Real-time progress visible during processing
4. ✅ Batch results page shows summary statistics
5. ✅ User can generate individual ACRs (1 per EPUB)
6. ✅ User can generate aggregate ACR (1 for all EPUBs)
7. ✅ User can export remediated files as ZIP
8. ✅ Error handling works (failed files don't block batch)
9. ✅ SSE updates work reliably
10. ✅ All tests pass (unit + integration + E2E)

---

## Appendix: Key Differences from Original Design

| Aspect | Original Design | Redesigned Workflow |
|--------|----------------|---------------------|
| **Batch Creation** | Select existing jobs | Create batch first, then upload files |
| **File Upload** | One-at-a-time | Bulk upload (drag-drop 5-50 files) |
| **Pipeline** | Manual (audit → create plan → select for batch) | Automated (audit → plan → remediate) |
| **Job Types** | Reuses BATCH_VALIDATION | New Batch entity + BatchFile |
| **Progress Tracking** | Batch job output field | Dedicated Batch table with counters |
| **User Actions** | Must create plans manually first | System auto-creates plans |
| **ACR Generation** | Works only if plans exist | Always works (plans auto-created) |
| **UX Flow** | 4 separate steps | 1 unified flow |

---

**Document Status:** ✅ Design Approved - Ready for Implementation
**Next Step:** Create Replit implementation prompts

**Last Updated:** January 21, 2026
