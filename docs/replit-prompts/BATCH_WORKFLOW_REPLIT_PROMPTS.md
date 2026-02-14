# Batch Processing Workflow - Replit Implementation Prompts

**Project:** Ninja Platform - Redesigned Batch Workflow
**Date:** January 21, 2026
**Design Doc:** BATCH_WORKFLOW_REDESIGN.md

This document contains detailed Replit prompts for implementing the redesigned batch processing workflow, organized by implementation phases.

---

## Table of Contents

**Backend Prompts:**
1. [Database Schema & Models](#backend-prompt-1-database-schema--models)
2. [Batch File Service](#backend-prompt-2-batch-file-service)
3. [Batch Orchestrator Service - Core](#backend-prompt-3-batch-orchestrator-service---core)
4. [Batch Orchestrator Service - Pipeline](#backend-prompt-4-batch-orchestrator-service---pipeline)
5. [API Routes & Controller](#backend-prompt-5-api-routes--controller)
6. [Worker & Queue Setup](#backend-prompt-6-worker--queue-setup)

**Frontend Prompts:**
7. [API Service & Hooks](#frontend-prompt-1-api-service--hooks)
8. [Batch Creation Page](#frontend-prompt-2-batch-creation-page)
9. [Batch Processing View](#frontend-prompt-3-batch-processing-view)
10. [Batch Results & Actions](#frontend-prompt-4-batch-results--actions)
11. [Routing & Navigation](#frontend-prompt-5-routing--navigation)

---

# Backend Prompts

## Backend Prompt 1: Database Schema & Models

```
Context:
I'm working on the Ninja Backend (Node.js/Express/TypeScript/Prisma/PostgreSQL) to implement a redesigned batch processing workflow. The new design creates a first-class Batch entity with automated audit → plan → remediate pipeline for EPUB files.

Task:
Create database schema and TypeScript type definitions for the new batch processing system.

Requirements:

1. Update Prisma Schema (prisma/schema.prisma):

Add the following models:

```prisma
// ============================================
// BATCH PROCESSING MODELS
// ============================================

model Batch {
  id              String       @id @default(uuid())
  tenantId        String
  userId          String
  name            String

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

  // ACR Generation Metadata
  acrGenerated         Boolean  @default(false)
  acrMode              String?
  acrWorkflowIds       String[]
  acrGeneratedAt       DateTime?

  // Relationships
  files           BatchFile[]
  tenant          Tenant       @relation(fields: [tenantId], references: [id])
  user            User         @relation(fields: [userId], references: [id])

  // Timestamps
  createdAt       DateTime     @default(now())
  startedAt       DateTime?
  completedAt     DateTime?

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
  originalName    String
  fileSize        Int
  mimeType        String       @default("application/epub+zip")
  storagePath     String
  storageType     String       @default("S3")

  // Processing Status
  status          FileStatus   @default(UPLOADED)

  // Job References
  auditJobId      String?
  planJobId       String?

  // Audit Results
  auditScore      Int?
  issuesFound     Int?

  // Plan Analysis
  issuesAutoFix   Int?
  issuesQuickFix  Int?
  issuesManual    Int?

  // Remediation Results
  issuesAutoFixed      Int?
  remainingQuickFix    Int?
  remainingManual      Int?

  // File Paths
  remediatedFilePath   String?
  comparisonReportPath String?

  // Error Handling
  error           String?
  errorDetails    Json?

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
  DRAFT
  QUEUED
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
}

enum FileStatus {
  UPLOADED
  AUDITING
  AUDITED
  PLANNING
  PLANNED
  REMEDIATING
  REMEDIATED
  FAILED
  SKIPPED
}
```

Also add relationships to existing models:

```prisma
model Tenant {
  // ... existing fields
  batches         Batch[]
}

model User {
  // ... existing fields
  batches         Batch[]
}
```

2. Run Migration:
```bash
npx prisma migrate dev --name add-batch-processing-models
npx prisma generate
```

3. Create Type Definitions (src/types/batch.types.ts):

```typescript
export interface BatchCreateRequest {
  name?: string;
}

export interface BatchFileUploadRequest {
  files: File[];
}

export interface BatchStartRequest {
  options?: {
    skipAudit?: boolean;
    autoRemediateOnly?: boolean;
  };
}

export interface BatchSummary {
  batchId: string;
  name: string;
  status: BatchStatus;

  totalFiles: number;
  filesUploaded: number;
  filesAudited: number;
  filesPlanned: number;
  filesRemediated: number;
  filesFailed: number;

  totalIssuesFound: number;
  autoFixedIssues: number;
  quickFixIssues: number;
  manualIssues: number;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BatchFileDetails {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  status: FileStatus;

  auditScore?: number;
  issuesFound?: number;
  issuesAutoFixed?: number;
  remainingQuickFix?: number;
  remainingManual?: number;

  error?: string;

  uploadedAt: string;
  remediationCompletedAt?: string;
}

export interface BatchWithFiles extends BatchSummary {
  files: BatchFileDetails[];
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

4. Verify Migration:
- Check Prisma Studio to confirm tables created
- Verify indexes exist
- Test basic CRUD operations

File Locations:
- Schema: prisma/schema.prisma
- Types: src/types/batch.types.ts

Follow existing patterns from the current Prisma schema.
```

---

## Backend Prompt 2: Batch File Service

```
Context:
Continuing batch processing implementation. Database schema is complete. Now creating the BatchFileService responsible for file upload, storage, and retrieval.

Task:
Implement BatchFileService for managing EPUB file uploads and storage.

Requirements:

1. Create Service (src/services/batch/batch-file.service.ts):

```typescript
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
      const uniqueFilename = this.generateUniqueFilename(file.filename);
      const storagePath = await this.uploadToStorage(batchId, uniqueFilename, file.buffer);

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
   * Delete file from batch (only in DRAFT status)
   */
  async deleteFile(fileId: string): Promise<void> {
    const file = await prisma.batchFile.findUnique({
      where: { id: fileId },
      include: { batch: true },
    });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    if (file.batch.status !== 'DRAFT') {
      throw new Error('Cannot delete files from batch that is not in DRAFT status');
    }

    // Delete from storage
    if (file.storageType === 'S3') {
      await s3Service.deleteFile(file.storagePath);
    } else {
      await fs.unlink(file.storagePath).catch(() => {});
    }

    // Delete database record
    await prisma.batchFile.delete({ where: { id: fileId } });

    // Update batch file count
    await prisma.batch.update({
      where: { id: file.batchId },
      data: {
        totalFiles: { decrement: 1 },
        filesUploaded: { decrement: 1 },
      },
    });

    logger.info(`Deleted file ${fileId} from batch ${file.batchId}`);
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
   * Generate unique filename with timestamp
   */
  private generateUniqueFilename(originalFilename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    const sanitized = basename.replace(/[^a-zA-Z0-9-_]/g, '-');
    return `${sanitized}-${timestamp}-${random}${ext}`;
  }
}

export const batchFileService = new BatchFileService();
```

2. Error Handling:
- Handle S3 upload failures gracefully
- Handle disk space issues for local storage
- Validate file types (must be .epub)
- Validate file sizes (max 100MB per file)

3. Testing:
- Test file upload to S3
- Test file upload to local storage
- Test file retrieval
- Test file deletion
- Test unique filename generation

File Location:
- src/services/batch/batch-file.service.ts

Follow patterns from existing file services (src/services/storage/).
```

---

## Backend Prompt 3: Batch Orchestrator Service - Core

```
Context:
Continuing batch processing implementation. BatchFileService is complete. Now creating the BatchOrchestratorService which coordinates the entire processing pipeline. This prompt focuses on batch management (create, start, get status).

Task:
Implement BatchOrchestratorService core methods for batch lifecycle management.

Requirements:

1. Create Service (src/services/batch/batch-orchestrator.service.ts):

```typescript
import { Batch, BatchFile, BatchStatus, FileStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { batchFileService } from './batch-file.service';
import { getBatchQueue, areQueuesAvailable } from '../../queues';

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

    // Validate files
    for (const file of files) {
      if (!file.filename.toLowerCase().endsWith('.epub')) {
        throw new Error(`Invalid file type: ${file.filename}. Only EPUB files are supported.`);
      }

      if (file.size > 100 * 1024 * 1024) { // 100MB
        throw new Error(`File too large: ${file.filename}. Maximum size is 100MB.`);
      }
    }

    // Upload files
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
   * Remove file from batch (only while DRAFT)
   */
  async removeFileFromBatch(batchId: string, fileId: string): Promise<void> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Cannot remove files from batch that is not in DRAFT status');
    }

    await batchFileService.deleteFile(fileId);
    logger.info(`Removed file ${fileId} from batch ${batchId}`);
  }

  /**
   * Start batch processing
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

    // Enqueue in BullMQ or process synchronously
    if (areQueuesAvailable()) {
      const queue = getBatchQueue();
      if (queue) {
        await queue.add(`batch-${batchId}`, {
          batchId,
          tenantId: batch.tenantId,
        }, {
          jobId: `batch-${batchId}`,
        });
        logger.info(`Batch ${batchId} queued for async processing`);
      }
    } else {
      // Process synchronously
      logger.info(`Batch ${batchId} processing synchronously (no queue available)`);
      this.processBatchSync(batchId).catch((err) => {
        logger.error(`Batch ${batchId} processing failed:`, err);
      });
    }

    return this.getBatch(batchId);
  }

  /**
   * Get batch with files
   */
  async getBatch(batchId: string): Promise<Batch & { files: BatchFile[] }> {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { files: { orderBy: { uploadedAt: 'asc' } } },
    });

    if (!batch) {
      throw new Error(`Batch not found: ${batchId}`);
    }

    return batch;
  }

  /**
   * Get batch for user (with tenant check)
   */
  async getBatchForUser(batchId: string, tenantId: string): Promise<Batch & { files: BatchFile[] }> {
    const batch = await prisma.batch.findFirst({
      where: {
        id: batchId,
        tenantId,
      },
      include: { files: { orderBy: { uploadedAt: 'asc' } } },
    });

    if (!batch) {
      throw new Error(`Batch not found or access denied`);
    }

    return batch;
  }

  /**
   * List batches for user
   */
  async listBatches(
    tenantId: string,
    page: number = 1,
    limit: number = 20,
    status?: BatchStatus
  ): Promise<{ batches: Batch[]; total: number }> {
    const where: any = { tenantId };

    if (status) {
      where.status = status;
    }

    const [batches, total] = await Promise.all([
      prisma.batch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.batch.count({ where }),
    ]);

    return { batches, total };
  }

  /**
   * Cancel batch processing
   */
  async cancelBatch(batchId: string): Promise<Batch> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'QUEUED' && batch.status !== 'PROCESSING') {
      throw new Error('Can only cancel batches that are queued or processing');
    }

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    // Update pending files to SKIPPED
    await prisma.batchFile.updateMany({
      where: {
        batchId,
        status: { in: ['UPLOADED', 'AUDITING', 'PLANNING', 'REMEDIATING'] },
      },
      data: {
        status: 'SKIPPED',
      },
    });

    logger.info(`Cancelled batch ${batchId}`);
    return this.getBatch(batchId);
  }

  /**
   * Main processing pipeline (placeholder - implemented in next prompt)
   */
  async processBatchSync(batchId: string): Promise<void> {
    // Will be implemented in Prompt 4
    logger.info(`Processing batch ${batchId} - implementation pending`);
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

2. Error Handling:
- Validate batch exists before operations
- Check batch status before state transitions
- Handle concurrent access (e.g., two users trying to start same batch)
- Proper error messages for validation failures

3. Testing:
- Create batch
- Add files to batch
- Remove file from batch
- Start batch processing
- Get batch status
- List batches
- Cancel batch

File Location:
- src/services/batch/batch-orchestrator.service.ts

Follow patterns from existing orchestrator services.
```

---

## Backend Prompt 4: Batch Orchestrator Service - Pipeline

```
Context:
Continuing batch processing implementation. BatchOrchestratorService core methods are complete. Now implementing the processing pipeline (audit → plan → remediate) for each file in the batch.

Task:
Implement the processBatchSync method and its helper methods (auditFile, createPlanForFile, autoRemediateFile) in BatchOrchestratorService.

Requirements:

1. Add to BatchOrchestratorService (src/services/batch/batch-orchestrator.service.ts):

Import additional services at the top:
```typescript
import { epubAuditService } from '../epub/epub-audit.service';
import { remediationService } from '../epub/remediation.service';
import { autoRemediationService } from '../epub/auto-remediation.service';
import { sseService } from '../../sse/sse.service';
```

Add the following methods:

```typescript
/**
 * Main processing pipeline (called by worker or synchronously)
 */
async processBatchSync(batchId: string): Promise<void> {
  logger.info(`[Batch ${batchId}] Starting processing pipeline`);

  const batch = await this.getBatch(batchId);

  // Update status to PROCESSING
  await prisma.batch.update({
    where: { id: batchId },
    data: { status: 'PROCESSING' },
  });

  const files = batch.files;

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
          errorDetails: error instanceof Error ? { stack: error.stack } : {},
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

  // Broadcast status
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

  // Wait for audit completion
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
 * Helper: Wait for job completion
 */
private async waitForJobCompletion(jobId: string, maxAttempts: number = 60): Promise<any> {
  let attempts = 0;

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
```

2. Error Handling:
- Handle audit failures gracefully (continue to next file)
- Handle plan creation failures
- Handle auto-remediation failures
- Ensure SSE broadcasts even on failure
- Update batch statistics correctly

3. Testing:
- Test complete pipeline (audit → plan → remediate)
- Test with file that fails audit
- Test with file that has no auto-fixable issues
- Test SSE broadcasts
- Verify database updates

File Location:
- src/services/batch/batch-orchestrator.service.ts (update existing file)

Follow patterns from existing epub processing services.
```

---

## Backend Prompt 5: API Routes & Controller

```
Context:
Batch processing services are complete. Now creating REST API endpoints and controller to expose batch functionality to the frontend.

Task:
Create batch routes and controller with all CRUD operations and batch actions.

Requirements:

1. Create Routes (src/routes/batch.routes.ts):

```typescript
import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { batchController } from '../controllers/batch.controller';
import {
  batchCreateSchema,
  batchStartSchema,
  batchListSchema,
  batchAcrGenerateSchema,
  batchExportSchema,
} from '../schemas/batch.schemas';
import { upload } from '../middleware/upload.middleware';

const router = Router();

// Batch Management
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchCreateSchema }),
  batchController.createBatch
);

router.post(
  '/:batchId/files',
  authenticate,
  authorize('ADMIN', 'USER'),
  upload.array('files', 50), // Max 50 files
  batchController.uploadFiles
);

router.delete(
  '/:batchId/files/:fileId',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchController.removeFile
);

router.post(
  '/:batchId/start',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchStartSchema }),
  batchController.startBatch
);

router.get(
  '/:batchId',
  authenticate,
  batchController.getBatch
);

router.get(
  '/',
  authenticate,
  validate({ query: batchListSchema }),
  batchController.listBatches
);

router.post(
  '/:batchId/cancel',
  authenticate,
  authorize('ADMIN', 'USER'),
  batchController.cancelBatch
);

// Batch Actions
router.post(
  '/:batchId/acr/generate',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchAcrGenerateSchema }),
  batchController.generateBatchAcr
);

router.post(
  '/:batchId/export',
  authenticate,
  authorize('ADMIN', 'USER'),
  validate({ body: batchExportSchema }),
  batchController.exportBatch
);

export default router;
```

2. Create Validation Schemas (src/schemas/batch.schemas.ts):

```typescript
import { z } from 'zod';

export const batchCreateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export const batchStartSchema = z.object({
  options: z.object({
    skipAudit: z.boolean().optional(),
    autoRemediateOnly: z.boolean().optional(),
  }).optional(),
});

export const batchListSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(['DRAFT', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
});

export const batchAcrGenerateSchema = z.object({
  mode: z.enum(['individual', 'aggregate']),
  options: z.object({
    edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']),
    batchName: z.string().min(1),
    vendor: z.string().min(1),
    contactEmail: z.string().email(),
    aggregationStrategy: z.enum(['conservative', 'optimistic']),
  }).optional(),
});

export const batchExportSchema = z.object({
  format: z.enum(['zip']).default('zip'),
  includeOriginals: z.boolean().optional().default(false),
  includeComparisons: z.boolean().optional().default(false),
});
```

3. Create Controller (src/controllers/batch.controller.ts):

```typescript
import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth.types';
import { batchOrchestratorService } from '../services/batch/batch-orchestrator.service';
import { batchAcrGeneratorService } from '../services/acr/batch-acr-generator.service';
import { logger } from '../lib/logger';

class BatchController {
  async createBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { name } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const batch = await batchOrchestratorService.createBatch(tenantId, userId, name);

      return res.status(201).json({
        success: true,
        data: {
          batchId: batch.id,
          name: batch.name,
          status: batch.status,
          totalFiles: batch.totalFiles,
          createdAt: batch.createdAt,
        },
      });
    } catch (error) {
      logger.error('Create batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to create batch',
          code: 'BATCH_CREATE_FAILED',
        },
      });
    }
  }

  async uploadFiles(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      // Verify batch belongs to user's tenant
      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const files = (req.files as Express.Multer.File[]) || [];

      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'No files uploaded',
            code: 'NO_FILES',
          },
        });
      }

      const uploadedFiles = files.map(f => ({
        buffer: f.buffer,
        filename: f.originalname,
        size: f.size,
      }));

      const batchFiles = await batchOrchestratorService.addFilesToBatch(batchId, uploadedFiles);

      return res.status(201).json({
        success: true,
        data: {
          filesAdded: batchFiles.length,
          files: batchFiles.map(f => ({
            fileId: f.id,
            fileName: f.fileName,
            originalName: f.originalName,
            fileSize: f.fileSize,
            status: f.status,
          })),
        },
      });
    } catch (error) {
      logger.error('Upload files failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to upload files',
          code: 'FILE_UPLOAD_FAILED',
        },
      });
    }
  }

  async removeFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId, fileId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);
      await batchOrchestratorService.removeFileFromBatch(batchId, fileId);

      return res.json({
        success: true,
        message: 'File removed from batch',
      });
    } catch (error) {
      logger.error('Remove file failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to remove file',
          code: 'FILE_REMOVE_FAILED',
        },
      });
    }
  }

  async startBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const batch = await batchOrchestratorService.startBatchProcessing(batchId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          status: batch.status,
          totalFiles: batch.totalFiles,
          startedAt: batch.startedAt,
        },
      });
    } catch (error) {
      logger.error('Start batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to start batch',
          code: 'BATCH_START_FAILED',
        },
      });
    }
  }

  async getBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batch = await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          name: batch.name,
          status: batch.status,

          totalFiles: batch.totalFiles,
          filesUploaded: batch.filesUploaded,
          filesAudited: batch.filesAudited,
          filesPlanned: batch.filesPlanned,
          filesRemediated: batch.filesRemediated,
          filesFailed: batch.filesFailed,

          totalIssuesFound: batch.totalIssuesFound,
          autoFixedIssues: batch.autoFixedIssues,
          quickFixIssues: batch.quickFixIssues,
          manualIssues: batch.manualIssues,

          files: batch.files.map(f => ({
            fileId: f.id,
            fileName: f.fileName,
            originalName: f.originalName,
            fileSize: f.fileSize,
            status: f.status,
            auditScore: f.auditScore,
            issuesFound: f.issuesFound,
            issuesAutoFixed: f.issuesAutoFixed,
            remainingQuickFix: f.remainingQuickFix,
            remainingManual: f.remainingManual,
            error: f.error,
            uploadedAt: f.uploadedAt,
            remediationCompletedAt: f.remediationCompletedAt,
          })),

          createdAt: batch.createdAt,
          startedAt: batch.startedAt,
          completedAt: batch.completedAt,
        },
      });
    } catch (error) {
      logger.error('Get batch failed', error);
      return res.status(404).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Batch not found',
          code: 'BATCH_NOT_FOUND',
        },
      });
    }
  }

  async listBatches(req: AuthenticatedRequest, res: Response) {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, status } = req.query;

      const result = await batchOrchestratorService.listBatches(
        tenantId,
        Number(page) || 1,
        Number(limit) || 20,
        status as any
      );

      return res.json({
        success: true,
        data: {
          batches: result.batches.map(b => ({
            batchId: b.id,
            name: b.name,
            status: b.status,
            totalFiles: b.totalFiles,
            filesRemediated: b.filesRemediated,
            createdAt: b.createdAt,
            completedAt: b.completedAt,
          })),
          total: result.total,
          page: Number(page) || 1,
          limit: Number(limit) || 20,
        },
      });
    } catch (error) {
      logger.error('List batches failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to list batches',
          code: 'BATCH_LIST_FAILED',
        },
      });
    }
  }

  async cancelBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      const batch = await batchOrchestratorService.cancelBatch(batchId);

      return res.json({
        success: true,
        data: {
          batchId: batch.id,
          status: batch.status,
          message: 'Batch cancelled successfully',
        },
      });
    } catch (error) {
      logger.error('Cancel batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to cancel batch',
          code: 'BATCH_CANCEL_FAILED',
        },
      });
    }
  }

  async generateBatchAcr(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const { mode, options } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const batch = await batchOrchestratorService.getBatchForUser(batchId, tenantId);

      if (batch.status !== 'COMPLETED') {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Batch must be completed before generating ACR',
            code: 'BATCH_NOT_COMPLETED',
          },
        });
      }

      // Get successful job IDs (from auditJobId or planJobId)
      const jobIds = batch.files
        .filter(f => f.status === 'REMEDIATED')
        .map(f => f.auditJobId!)
        .filter(Boolean);

      if (jobIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'No successfully remediated files to generate ACR from',
            code: 'NO_REMEDIATED_FILES',
          },
        });
      }

      const result = await batchAcrGeneratorService.generateBatchAcr(
        batchId,
        tenantId,
        userId,
        mode,
        options
      );

      return res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Generate batch ACR failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate batch ACR',
          code: 'BATCH_ACR_GENERATION_FAILED',
        },
      });
    }
  }

  async exportBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      // TODO: Implement ZIP export
      // For now, return placeholder

      return res.json({
        success: true,
        data: {
          downloadUrl: `https://example.com/batch-${batchId}.zip`,
          fileSize: 0,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (error) {
      logger.error('Export batch failed', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to export batch',
          code: 'BATCH_EXPORT_FAILED',
        },
      });
    }
  }
}

export const batchController = new BatchController();
```

4. Register Routes in Main App (src/app.ts or src/index.ts):

```typescript
import batchRoutes from './routes/batch.routes';

app.use('/api/v1/batch', batchRoutes);
```

5. Error Handling:
- 400 for validation errors
- 404 for batch not found
- 403 for tenant access denied
- 500 for server errors

File Locations:
- Routes: src/routes/batch.routes.ts
- Schemas: src/schemas/batch.schemas.ts
- Controller: src/controllers/batch.controller.ts

Follow patterns from existing routes and controllers.
```

---

## Backend Prompt 6: Worker & Queue Setup

```
Context:
All batch processing logic is complete. Now setting up the BullMQ worker to process batches asynchronously in the background.

Task:
Create BullMQ queue and worker for batch processing.

Requirements:

1. Update Queue Configuration (src/queues/index.ts):

Add batch queue:

```typescript
import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis';

// ... existing queues

let batchQueue: Queue | null = null;

export function getBatchQueue(): Queue | null {
  if (!batchQueue && areQueuesAvailable()) {
    batchQueue = new Queue('batch-processing', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // Don't retry entire batch
        removeOnComplete: {
          age: 24 * 60 * 60, // Keep completed for 24 hours
          count: 100,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60, // Keep failed for 7 days
        },
      },
    });
  }
  return batchQueue;
}

// ... export functions
```

2. Create Worker (src/workers/batch-processor.worker.ts):

```typescript
import { Worker, Job } from 'bullmq';
import { redisConnection } from '../lib/redis';
import { batchOrchestratorService } from '../services/batch/batch-orchestrator.service';
import { logger } from '../lib/logger';

interface BatchJobData {
  batchId: string;
  tenantId: string;
}

interface BatchJobResult {
  batchId: string;
  filesProcessed: number;
  filesRemediated: number;
  filesFailed: number;
}

export async function processBatchJob(
  job: Job<BatchJobData, BatchJobResult>
): Promise<BatchJobResult> {
  const { batchId, tenantId } = job.data;

  logger.info(`[BatchWorker] Starting batch ${batchId}`);

  try {
    await batchOrchestratorService.processBatchSync(batchId);

    // Get final batch status
    const batch = await batchOrchestratorService.getBatch(batchId);

    return {
      batchId,
      filesProcessed: batch.totalFiles,
      filesRemediated: batch.filesRemediated,
      filesFailed: batch.filesFailed,
    };
  } catch (error) {
    logger.error(`[BatchWorker] Batch ${batchId} failed:`, error);

    // Mark batch as failed
    await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
      },
    });

    throw error;
  }
}

// Create worker
export const batchWorker = new Worker<BatchJobData, BatchJobResult>(
  'batch-processing',
  processBatchJob,
  {
    connection: redisConnection,
    concurrency: 1, // Process one batch at a time
    limiter: {
      max: 5, // Max 5 jobs per duration
      duration: 60000, // 1 minute
    },
  }
);

batchWorker.on('completed', (job) => {
  logger.info(`[BatchWorker] Batch ${job.data.batchId} completed`);
});

batchWorker.on('failed', (job, err) => {
  logger.error(`[BatchWorker] Batch ${job?.data.batchId} failed:`, err);
});

batchWorker.on('error', (err) => {
  logger.error('[BatchWorker] Worker error:', err);
});

logger.info('[BatchWorker] Worker started');
```

3. Register Worker in Main App (src/index.ts):

```typescript
import './workers/batch-processor.worker';

// Worker will start automatically when imported
```

4. Graceful Shutdown:

Update shutdown handler to close batch worker:

```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing workers...');

  await batchWorker.close();
  // ... close other workers

  process.exit(0);
});
```

5. Testing:
- Create batch with files
- Start batch processing
- Verify worker picks up job
- Monitor worker logs
- Check batch status updates
- Verify SSE broadcasts

File Locations:
- Queue config: src/queues/index.ts
- Worker: src/workers/batch-processor.worker.ts

Follow patterns from existing workers (src/workers/processors/).
```

---

---

# Frontend Prompts

## Frontend Prompt 7: API Service & Hooks

```
Context:
I'm working on the Ninja Frontend (React 18/TypeScript/React Query) to implement the redesigned batch processing workflow. The backend API is complete with all batch endpoints. Now creating the frontend API service layer and React Query hooks.

Task:
Create batch API service, TypeScript types, and React Query hooks for batch operations.

Requirements:

1. Create Type Definitions (src/types/batch.types.ts):

```typescript
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

export interface BatchFile {
  fileId: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  status: FileStatus;

  auditScore?: number;
  issuesFound?: number;
  issuesAutoFixed?: number;
  remainingQuickFix?: number;
  remainingManual?: number;

  error?: string;

  uploadedAt: string;
  remediationCompletedAt?: string;
}

export interface Batch {
  batchId: string;
  name: string;
  status: BatchStatus;

  totalFiles: number;
  filesUploaded: number;
  filesAudited: number;
  filesPlanned: number;
  filesRemediated: number;
  filesFailed: number;

  totalIssuesFound: number;
  autoFixedIssues: number;
  quickFixIssues: number;
  manualIssues: number;

  files: BatchFile[];

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface BatchListItem {
  batchId: string;
  name: string;
  status: BatchStatus;
  totalFiles: number;
  filesRemediated: number;
  createdAt: string;
  completedAt?: string;
}

export interface CreateBatchRequest {
  name?: string;
}

export interface StartBatchRequest {
  options?: {
    skipAudit?: boolean;
    autoRemediateOnly?: boolean;
  };
}

export interface GenerateAcrRequest {
  mode: 'individual' | 'aggregate';
  options?: {
    edition: 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';
    batchName: string;
    vendor: string;
    contactEmail: string;
    aggregationStrategy: 'conservative' | 'optimistic';
  };
}

export interface BatchSSEEvent {
  type:
    | 'file_auditing'
    | 'file_audited'
    | 'file_planning'
    | 'file_planned'
    | 'file_remediating'
    | 'file_remediated'
    | 'file_failed'
    | 'batch_completed';
  batchId: string;
  fileId?: string;
  fileName?: string;
  [key: string]: any;
}
```

2. Create API Service (src/services/api/batch.service.ts):

```typescript
import axios from '../lib/axios';
import {
  Batch,
  BatchListItem,
  CreateBatchRequest,
  StartBatchRequest,
  GenerateAcrRequest,
} from '../../types/batch.types';

class BatchService {
  private baseUrl = '/api/v1/batch';

  /**
   * Create new batch
   */
  async createBatch(data: CreateBatchRequest): Promise<{ batchId: string }> {
    const response = await axios.post(this.baseUrl, data);
    return response.data.data;
  }

  /**
   * Upload files to batch
   */
  async uploadFiles(batchId: string, files: File[]): Promise<void> {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file);
    });

    await axios.post(`${this.baseUrl}/${batchId}/files`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  /**
   * Remove file from batch
   */
  async removeFile(batchId: string, fileId: string): Promise<void> {
    await axios.delete(`${this.baseUrl}/${batchId}/files/${fileId}`);
  }

  /**
   * Start batch processing
   */
  async startBatch(batchId: string, data?: StartBatchRequest): Promise<void> {
    await axios.post(`${this.baseUrl}/${batchId}/start`, data);
  }

  /**
   * Get batch details
   */
  async getBatch(batchId: string): Promise<Batch> {
    const response = await axios.get(`${this.baseUrl}/${batchId}`);
    return response.data.data;
  }

  /**
   * List batches
   */
  async listBatches(
    page: number = 1,
    limit: number = 20,
    status?: string
  ): Promise<{ batches: BatchListItem[]; total: number; page: number; limit: number }> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString()
    });

    if (status) {
      params.append('status', status);
    }

    const response = await axios.get(`${this.baseUrl}?${params}`);
    return response.data.data;
  }

  /**
   * Cancel batch
   */
  async cancelBatch(batchId: string): Promise<void> {
    await axios.post(`${this.baseUrl}/${batchId}/cancel`);
  }

  /**
   * Generate ACR
   */
  async generateAcr(batchId: string, data: GenerateAcrRequest): Promise<any> {
    const response = await axios.post(`${this.baseUrl}/${batchId}/acr/generate`, data);
    return response.data.data;
  }

  /**
   * Export batch files
   */
  async exportBatch(batchId: string): Promise<{ downloadUrl: string }> {
    const response = await axios.post(`${this.baseUrl}/${batchId}/export`, {
      format: 'zip',
      includeOriginals: false,
      includeComparisons: true,
    });
    return response.data.data;
  }

  /**
   * Subscribe to batch SSE updates
   */
  subscribeToBatch(batchId: string, onEvent: (event: any) => void): EventSource {
    const token = localStorage.getItem('token');
    const eventSource = new EventSource(
      `/api/v1/sse/subscribe?channel=batch:${batchId}&token=${token}`
    );

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch (error) {
        console.error('Failed to parse SSE event:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
    };

    return eventSource;
  }
}

export const batchService = new BatchService();
```

3. Create React Query Hooks (src/hooks/batch.hooks.ts):

```typescript
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { batchService } from '../services/api/batch.service';
import { useEffect, useRef } from 'react';
import { BatchSSEEvent } from '../types/batch.types';

/**
 * Create batch
 */
export function useCreateBatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { name?: string }) => batchService.createBatch(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
    },
  });
}

/**
 * Upload files to batch
 */
export function useUploadFiles(batchId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (files: File[]) => batchService.uploadFiles(batchId, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    },
  });
}

/**
 * Start batch processing
 */
export function useStartBatch(batchId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => batchService.startBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    },
  });
}

/**
 * Get batch details
 */
export function useBatch(batchId: string | undefined) {
  return useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => batchService.getBatch(batchId!),
    enabled: !!batchId,
    refetchInterval: 5000, // Poll every 5s when processing
  });
}

/**
 * List batches
 */
export function useBatches(page: number = 1, status?: string) {
  return useQuery({
    queryKey: ['batches', page, status],
    queryFn: () => batchService.listBatches(page, 20, status),
  });
}

/**
 * Cancel batch
 */
export function useCancelBatch(batchId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => batchService.cancelBatch(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    },
  });
}

/**
 * Generate ACR
 */
export function useGenerateAcr(batchId: string) {
  return useMutation({
    mutationFn: (data: any) => batchService.generateAcr(batchId, data),
  });
}

/**
 * Export batch
 */
export function useExportBatch(batchId: string) {
  return useMutation({
    mutationFn: () => batchService.exportBatch(batchId),
  });
}

/**
 * Subscribe to batch SSE updates
 */
export function useBatchSSE(
  batchId: string | undefined,
  onEvent: (event: BatchSSEEvent) => void
) {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!batchId) return;

    // Subscribe to SSE
    eventSourceRef.current = batchService.subscribeToBatch(batchId, (event) => {
      onEvent(event);

      // Invalidate batch query on any update
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    });

    return () => {
      eventSourceRef.current?.close();
    };
  }, [batchId, onEvent, queryClient]);
}
```

4. Error Handling:
- Handle network errors gracefully
- Show user-friendly error messages
- Retry failed requests automatically (React Query built-in)
- Handle SSE disconnections

5. Testing:
- Test API service methods
- Test React Query hooks
- Test SSE subscription
- Test error handling

File Locations:
- Types: src/types/batch.types.ts
- Service: src/services/api/batch.service.ts
- Hooks: src/hooks/batch.hooks.ts

Follow patterns from existing API services (src/services/api/) and hooks (src/hooks/).
```

---

## Frontend Prompt 8: Batch Creation Page

```
Context:
API service and hooks are complete. Now creating the batch creation page with drag-and-drop file upload UI.

Task:
Implement batch creation page with file selection and upload.

Requirements:

1. Create Batch Creation Page (src/pages/BatchCreation.tsx):

```typescript
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateBatch, useUploadFiles } from '../hooks/batch.hooks';
import { FileUploadZone } from '../components/batch/FileUploadZone';
import { FileList } from '../components/batch/FileList';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { toast } from 'react-hot-toast';

export function BatchCreationPage() {
  const navigate = useNavigate();
  const [batchName, setBatchName] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);

  const createBatchMutation = useCreateBatch();
  const uploadFilesMutation = useUploadFiles(batchId || '');

  const handleFilesSelected = (files: File[]) => {
    setSelectedFiles(prev => [...prev, ...files]);
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateBatch = async () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select at least one file');
      return;
    }

    try {
      // Step 1: Create batch
      const result = await createBatchMutation.mutateAsync({
        name: batchName || undefined,
      });

      setBatchId(result.batchId);

      // Step 2: Upload files
      await uploadFilesMutation.mutateAsync(selectedFiles);

      toast.success('Batch created successfully');

      // Navigate to batch processing page
      navigate(`/batch/${result.batchId}`);
    } catch (error) {
      toast.error('Failed to create batch');
      console.error(error);
    }
  };

  const isLoading = createBatchMutation.isPending || uploadFilesMutation.isPending;

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Create Batch
        </h1>
        <p className="text-gray-600">
          Upload EPUB files to process in batch. Files will be automatically audited,
          planned, and remediated.
        </p>
      </div>

      <div className="space-y-6">
        {/* Batch Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Batch Name (Optional)
          </label>
          <Input
            value={batchName}
            onChange={(e) => setBatchName(e.target.value)}
            placeholder="e.g., Q1 2026 EPUB Batch"
            disabled={isLoading}
          />
        </div>

        {/* File Upload Zone */}
        <FileUploadZone
          onFilesSelected={handleFilesSelected}
          disabled={isLoading}
        />

        {/* File List */}
        {selectedFiles.length > 0 && (
          <FileList
            files={selectedFiles}
            onRemove={handleRemoveFile}
            disabled={isLoading}
          />
        )}

        {/* Actions */}
        <div className="flex justify-between items-center pt-4 border-t">
          <div className="text-sm text-gray-600">
            {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
          </div>

          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={() => navigate('/batches')}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateBatch}
              disabled={selectedFiles.length === 0 || isLoading}
              loading={isLoading}
            >
              Create & Upload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

2. Create File Upload Zone Component (src/components/batch/FileUploadZone.tsx):

```typescript
import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { FiUpload } from 'react-icons/fi';

interface FileUploadZoneProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}

export function FileUploadZone({ onFilesSelected, disabled }: FileUploadZoneProps) {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    // Filter only EPUB files
    const epubFiles = acceptedFiles.filter(file =>
      file.name.toLowerCase().endsWith('.epub')
    );

    if (epubFiles.length !== acceptedFiles.length) {
      toast.error('Only EPUB files are supported');
    }

    if (epubFiles.length > 0) {
      onFilesSelected(epubFiles);
    }
  }, [onFilesSelected]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/epub+zip': ['.epub'],
    },
    multiple: true,
    disabled,
    maxSize: 100 * 1024 * 1024, // 100MB
  });

  return (
    <div
      {...getRootProps()}
      className={`
        border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
        transition-colors duration-200
        ${isDragActive
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-300 hover:border-gray-400'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <input {...getInputProps()} />

      <FiUpload className="mx-auto h-12 w-12 text-gray-400 mb-4" />

      <p className="text-lg font-medium text-gray-900 mb-2">
        {isDragActive ? 'Drop files here' : 'Drag & drop EPUB files'}
      </p>

      <p className="text-sm text-gray-600 mb-4">
        or click to browse
      </p>

      <p className="text-xs text-gray-500">
        Supports: .epub files up to 100MB each
      </p>
    </div>
  );
}
```

3. Create File List Component (src/components/batch/FileList.tsx):

```typescript
import React from 'react';
import { FiFile, FiX } from 'react-icons/fi';

interface FileListProps {
  files: File[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

export function FileList({ files, onRemove, disabled }: FileListProps) {
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-900 mb-3">
        Selected Files ({files.length})
      </h3>

      <div className="space-y-2">
        {files.map((file, index) => (
          <div
            key={index}
            className="flex items-center justify-between bg-white rounded p-3 shadow-sm"
          >
            <div className="flex items-center flex-1 min-w-0">
              <FiFile className="text-gray-400 mr-3 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {file.name}
                </p>
                <p className="text-xs text-gray-500">
                  {formatFileSize(file.size)}
                </p>
              </div>
            </div>

            <button
              onClick={() => onRemove(index)}
              disabled={disabled}
              className="ml-4 text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
            >
              <FiX className="h-5 w-5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

4. Styling & UX:
- Use drag-and-drop for intuitive file selection
- Show file previews with size information
- Allow removing files before upload
- Show loading states during upload
- Display validation errors

5. Testing:
- Test file drag-and-drop
- Test file selection via click
- Test file removal
- Test EPUB validation
- Test batch creation flow

File Locations:
- Page: src/pages/BatchCreation.tsx
- Components:
  - src/components/batch/FileUploadZone.tsx
  - src/components/batch/FileList.tsx

Install dependencies if needed:
```bash
npm install react-dropzone react-hot-toast
```

Follow patterns from existing upload components.
```

---

## Frontend Prompt 9: Batch Processing View

```
Context:
Batch creation page is complete. Now creating the batch processing view that shows real-time progress updates via SSE.

Task:
Implement batch processing view with real-time progress tracking and file status display.

Requirements:

1. Create Batch Processing Page (src/pages/BatchProcessing.tsx):

```typescript
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useBatch, useStartBatch, useBatchSSE, useCancelBatch } from '../hooks/batch.hooks';
import { BatchHeader } from '../components/batch/BatchHeader';
import { BatchProgress } from '../components/batch/BatchProgress';
import { FileStatusList } from '../components/batch/FileStatusList';
import { Button } from '../components/ui/Button';
import { toast } from 'react-hot-toast';
import { BatchSSEEvent } from '../types/batch.types';

export function BatchProcessingPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();

  const { data: batch, isLoading } = useBatch(batchId);
  const startBatchMutation = useStartBatch(batchId!);
  const cancelBatchMutation = useCancelBatch(batchId!);

  // SSE event handling
  useBatchSSE(batchId, (event: BatchSSEEvent) => {
    handleSSEEvent(event);
  });

  const handleSSEEvent = (event: BatchSSEEvent) => {
    switch (event.type) {
      case 'file_audited':
        toast.success(`Audit completed: ${event.fileName}`);
        break;
      case 'file_remediated':
        toast.success(`Remediation completed: ${event.fileName}`);
        break;
      case 'file_failed':
        toast.error(`File failed: ${event.fileName}`);
        break;
      case 'batch_completed':
        toast.success('Batch processing completed!');
        break;
    }
  };

  const handleStartProcessing = async () => {
    try {
      await startBatchMutation.mutateAsync();
      toast.success('Batch processing started');
    } catch (error) {
      toast.error('Failed to start batch processing');
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this batch?')) {
      return;
    }

    try {
      await cancelBatchMutation.mutateAsync();
      toast.success('Batch cancelled');
    } catch (error) {
      toast.error('Failed to cancel batch');
    }
  };

  const handleViewResults = () => {
    navigate(`/batch/${batchId}/results`);
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!batch) {
    return <div>Batch not found</div>;
  }

  const isDraft = batch.status === 'DRAFT';
  const isProcessing = batch.status === 'PROCESSING' || batch.status === 'QUEUED';
  const isCompleted = batch.status === 'COMPLETED';
  const canStart = isDraft && batch.totalFiles > 0;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <BatchHeader batch={batch} />

      <div className="mt-6 space-y-6">
        {/* Progress Section */}
        <BatchProgress batch={batch} />

        {/* File Status List */}
        <FileStatusList files={batch.files} />

        {/* Actions */}
        <div className="flex justify-between items-center pt-4 border-t">
          <div>
            {isDraft && (
              <p className="text-sm text-gray-600">
                Ready to start processing {batch.totalFiles} file{batch.totalFiles !== 1 ? 's' : ''}
              </p>
            )}
            {isProcessing && (
              <p className="text-sm text-gray-600">
                Processing {batch.filesRemediated} of {batch.totalFiles} files...
              </p>
            )}
            {isCompleted && (
              <p className="text-sm text-gray-600">
                Completed: {batch.filesRemediated} successful, {batch.filesFailed} failed
              </p>
            )}
          </div>

          <div className="flex gap-3">
            {isDraft && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => navigate('/batches')}
                >
                  Back to Batches
                </Button>
                <Button
                  variant="primary"
                  onClick={handleStartProcessing}
                  disabled={!canStart}
                  loading={startBatchMutation.isPending}
                >
                  Start Processing
                </Button>
              </>
            )}

            {isProcessing && (
              <Button
                variant="danger"
                onClick={handleCancel}
                loading={cancelBatchMutation.isPending}
              >
                Cancel Batch
              </Button>
            )}

            {isCompleted && (
              <Button
                variant="primary"
                onClick={handleViewResults}
              >
                View Results & Actions
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

2. Create Batch Header Component (src/components/batch/BatchHeader.tsx):

```typescript
import React from 'react';
import { Batch } from '../../types/batch.types';
import { Badge } from '../ui/Badge';

interface BatchHeaderProps {
  batch: Batch;
}

export function BatchHeader({ batch }: BatchHeaderProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'gray';
      case 'QUEUED': return 'blue';
      case 'PROCESSING': return 'yellow';
      case 'COMPLETED': return 'green';
      case 'FAILED': return 'red';
      case 'CANCELLED': return 'gray';
      default: return 'gray';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900">
              {batch.name}
            </h1>
            <Badge color={getStatusColor(batch.status)}>
              {batch.status}
            </Badge>
          </div>

          <div className="text-sm text-gray-600 space-y-1">
            <p>Batch ID: {batch.batchId}</p>
            <p>Created: {new Date(batch.createdAt).toLocaleString()}</p>
            {batch.startedAt && (
              <p>Started: {new Date(batch.startedAt).toLocaleString()}</p>
            )}
            {batch.completedAt && (
              <p>Completed: {new Date(batch.completedAt).toLocaleString()}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

3. Create Batch Progress Component (src/components/batch/BatchProgress.tsx):

```typescript
import React from 'react';
import { Batch } from '../../types/batch.types';
import { CircularProgress } from '../ui/CircularProgress';

interface BatchProgressProps {
  batch: Batch;
}

export function BatchProgress({ batch }: BatchProgressProps) {
  const progressPercent = batch.totalFiles > 0
    ? Math.round(((batch.filesRemediated + batch.filesFailed) / batch.totalFiles) * 100)
    : 0;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Processing Progress
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Overall Progress */}
        <div className="flex items-center gap-4">
          <CircularProgress value={progressPercent} size={100} />
          <div>
            <p className="text-2xl font-bold text-gray-900">
              {progressPercent}%
            </p>
            <p className="text-sm text-gray-600">
              {batch.filesRemediated + batch.filesFailed} of {batch.totalFiles} complete
            </p>
          </div>
        </div>

        {/* Statistics */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-gray-600">Remediated</p>
            <p className="text-2xl font-bold text-green-600">
              {batch.filesRemediated}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Failed</p>
            <p className="text-2xl font-bold text-red-600">
              {batch.filesFailed}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Issues Found</p>
            <p className="text-2xl font-bold text-gray-900">
              {batch.totalIssuesFound}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Auto-Fixed</p>
            <p className="text-2xl font-bold text-blue-600">
              {batch.autoFixedIssues}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

4. Create File Status List Component (src/components/batch/FileStatusList.tsx):

```typescript
import React from 'react';
import { BatchFile, FileStatus } from '../../types/batch.types';
import { Badge } from '../ui/Badge';
import { FiCheck, FiX, FiClock, FiLoader } from 'react-icons/fi';

interface FileStatusListProps {
  files: BatchFile[];
}

export function FileStatusList({ files }: FileStatusListProps) {
  const getStatusIcon = (status: FileStatus) => {
    switch (status) {
      case 'UPLOADED': return <FiClock className="text-gray-400" />;
      case 'AUDITING':
      case 'PLANNING':
      case 'REMEDIATING':
        return <FiLoader className="text-blue-500 animate-spin" />;
      case 'REMEDIATED': return <FiCheck className="text-green-500" />;
      case 'FAILED': return <FiX className="text-red-500" />;
      default: return <FiClock className="text-gray-400" />;
    }
  };

  const getStatusColor = (status: FileStatus) => {
    switch (status) {
      case 'UPLOADED': return 'gray';
      case 'AUDITING':
      case 'AUDITED':
      case 'PLANNING':
      case 'PLANNED':
      case 'REMEDIATING':
        return 'blue';
      case 'REMEDIATED': return 'green';
      case 'FAILED': return 'red';
      default: return 'gray';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-6 border-b">
        <h2 className="text-lg font-semibold text-gray-900">
          File Status ({files.length})
        </h2>
      </div>

      <div className="divide-y">
        {files.map((file) => (
          <div key={file.fileId} className="p-4 hover:bg-gray-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center flex-1 min-w-0">
                <div className="mr-3">
                  {getStatusIcon(file.status)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {file.originalName}
                  </p>
                  <div className="flex items-center gap-3 mt-1">
                    <Badge color={getStatusColor(file.status)} size="sm">
                      {file.status}
                    </Badge>
                    {file.auditScore !== undefined && (
                      <span className="text-xs text-gray-600">
                        Score: {file.auditScore}%
                      </span>
                    )}
                    {file.issuesFound !== undefined && (
                      <span className="text-xs text-gray-600">
                        Issues: {file.issuesFound}
                      </span>
                    )}
                    {file.issuesAutoFixed !== undefined && (
                      <span className="text-xs text-green-600">
                        Fixed: {file.issuesAutoFixed}
                      </span>
                    )}
                  </div>
                  {file.error && (
                    <p className="text-xs text-red-600 mt-1">
                      Error: {file.error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

5. Features:
- Real-time SSE updates
- Visual progress indicators
- File-level status tracking
- Error display
- Cancel functionality

6. Testing:
- Test batch start
- Test real-time updates
- Test cancel functionality
- Test completed state
- Test error states

File Locations:
- Page: src/pages/BatchProcessing.tsx
- Components:
  - src/components/batch/BatchHeader.tsx
  - src/components/batch/BatchProgress.tsx
  - src/components/batch/FileStatusList.tsx

Follow patterns from existing status pages.
```

---

## Frontend Prompt 10: Batch Results & Actions

```
Context:
Batch processing view is complete. Now creating the results page where users can perform actions on completed batches (generate ACR, export files, apply quick-fixes, manual remediation).

Task:
Implement batch results page with action buttons for ACR generation and file export.

Requirements:

1. Create Batch Results Page (src/pages/BatchResults.tsx):

```typescript
import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useBatch, useGenerateAcr, useExportBatch } from '../hooks/batch.hooks';
import { BatchSummary } from '../components/batch/BatchSummary';
import { FileResultsList } from '../components/batch/FileResultsList';
import { AcrGenerationModal } from '../components/batch/AcrGenerationModal';
import { Button } from '../components/ui/Button';
import { toast } from 'react-hot-toast';
import { FiDownload, FiFileText, FiEdit } from 'react-icons/fi';

export function BatchResultsPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();

  const { data: batch, isLoading } = useBatch(batchId);
  const generateAcrMutation = useGenerateAcr(batchId!);
  const exportBatchMutation = useExportBatch(batchId!);

  const [showAcrModal, setShowAcrModal] = useState(false);

  const handleGenerateAcr = async (mode: 'individual' | 'aggregate', options: any) => {
    try {
      const result = await generateAcrMutation.mutateAsync({ mode, options });
      toast.success('ACR generation started');
      setShowAcrModal(false);

      // Navigate to ACR workflow page
      if (mode === 'individual') {
        navigate('/acr-workflows');
      } else {
        navigate(`/acr-workflows/${result.workflowId}`);
      }
    } catch (error) {
      toast.error('Failed to generate ACR');
    }
  };

  const handleExport = async () => {
    try {
      const result = await exportBatchMutation.mutateAsync();

      // Trigger download
      window.open(result.downloadUrl, '_blank');
      toast.success('Export started');
    } catch (error) {
      toast.error('Failed to export batch');
    }
  };

  const handleQuickFix = () => {
    toast.info('Quick-fix feature coming soon');
    // TODO: Implement bulk quick-fix workflow
  };

  const handleManualRemediation = (fileId: string) => {
    navigate(`/remediation/${fileId}`);
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!batch) {
    return <div>Batch not found</div>;
  }

  const hasRemediatedFiles = batch.filesRemediated > 0;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Batch Results
        </h1>
        <p className="text-gray-600">
          Review results and choose next actions for your batch.
        </p>
      </div>

      {/* Summary */}
      <BatchSummary batch={batch} />

      {/* Actions */}
      <div className="mt-6 bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Available Actions
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Generate ACR */}
          <button
            onClick={() => setShowAcrModal(true)}
            disabled={!hasRemediatedFiles}
            className="flex flex-col items-center justify-center p-6 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FiFileText className="h-8 w-8 text-blue-600 mb-3" />
            <h3 className="font-medium text-gray-900 mb-1">Generate ACR</h3>
            <p className="text-sm text-gray-600 text-center">
              Create VPAT reports for your files
            </p>
          </button>

          {/* Export Files */}
          <button
            onClick={handleExport}
            disabled={!hasRemediatedFiles || exportBatchMutation.isPending}
            className="flex flex-col items-center justify-center p-6 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FiDownload className="h-8 w-8 text-green-600 mb-3" />
            <h3 className="font-medium text-gray-900 mb-1">Export Batch</h3>
            <p className="text-sm text-gray-600 text-center">
              Download all remediated files as ZIP
            </p>
          </button>

          {/* Apply Quick-Fixes */}
          <button
            onClick={handleQuickFix}
            disabled={batch.quickFixIssues === 0}
            className="flex flex-col items-center justify-center p-6 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FiEdit className="h-8 w-8 text-purple-600 mb-3" />
            <h3 className="font-medium text-gray-900 mb-1">Apply Quick-Fixes</h3>
            <p className="text-sm text-gray-600 text-center">
              {batch.quickFixIssues} issues need quick-fixes
            </p>
          </button>
        </div>
      </div>

      {/* File Results */}
      <div className="mt-6">
        <FileResultsList
          files={batch.files}
          onManualRemediation={handleManualRemediation}
        />
      </div>

      {/* ACR Generation Modal */}
      {showAcrModal && (
        <AcrGenerationModal
          batch={batch}
          onGenerate={handleGenerateAcr}
          onClose={() => setShowAcrModal(false)}
          isLoading={generateAcrMutation.isPending}
        />
      )}
    </div>
  );
}
```

2. Create Batch Summary Component (src/components/batch/BatchSummary.tsx):

```typescript
import React from 'react';
import { Batch } from '../../types/batch.types';
import { FiCheck, FiX, FiAlertCircle, FiZap } from 'react-icons/fi';

interface BatchSummaryProps {
  batch: Batch;
}

export function BatchSummary({ batch }: BatchSummaryProps) {
  const stats = [
    {
      label: 'Total Files',
      value: batch.totalFiles,
      icon: <FiCheck className="text-blue-600" />,
      color: 'blue',
    },
    {
      label: 'Successfully Remediated',
      value: batch.filesRemediated,
      icon: <FiCheck className="text-green-600" />,
      color: 'green',
    },
    {
      label: 'Failed',
      value: batch.filesFailed,
      icon: <FiX className="text-red-600" />,
      color: 'red',
    },
    {
      label: 'Issues Found',
      value: batch.totalIssuesFound,
      icon: <FiAlertCircle className="text-yellow-600" />,
      color: 'yellow',
    },
    {
      label: 'Auto-Fixed Issues',
      value: batch.autoFixedIssues,
      icon: <FiZap className="text-purple-600" />,
      color: 'purple',
    },
    {
      label: 'Remaining Quick-Fixes',
      value: batch.quickFixIssues,
      icon: <FiAlertCircle className="text-orange-600" />,
      color: 'orange',
    },
  ];

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Batch Summary
      </h2>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="text-center">
            <div className="flex justify-center mb-2">
              {stat.icon}
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {stat.value}
            </p>
            <p className="text-xs text-gray-600 mt-1">
              {stat.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

3. Create ACR Generation Modal (src/components/batch/AcrGenerationModal.tsx):

```typescript
import React, { useState } from 'react';
import { Batch } from '../../types/batch.types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Radio } from '../ui/Radio';
import { Input } from '../ui/Input';

interface AcrGenerationModalProps {
  batch: Batch;
  onGenerate: (mode: 'individual' | 'aggregate', options: any) => void;
  onClose: () => void;
  isLoading: boolean;
}

export function AcrGenerationModal({
  batch,
  onGenerate,
  onClose,
  isLoading,
}: AcrGenerationModalProps) {
  const [mode, setMode] = useState<'individual' | 'aggregate'>('individual');
  const [edition, setEdition] = useState('VPAT2.5-WCAG');
  const [batchName, setBatchName] = useState(batch.name);
  const [vendor, setVendor] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  const handleGenerate = () => {
    onGenerate(mode, {
      edition,
      batchName,
      vendor,
      contactEmail,
      aggregationStrategy: 'conservative',
    });
  };

  return (
    <Modal title="Generate ACR/VPAT" onClose={onClose} size="lg">
      <div className="space-y-6">
        {/* Mode Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-3">
            Generation Mode
          </label>
          <div className="space-y-3">
            <Radio
              checked={mode === 'individual'}
              onChange={() => setMode('individual')}
              label="Individual ACRs"
              description={`Generate ${batch.filesRemediated} separate ACR/VPAT documents (one per file)`}
            />
            <Radio
              checked={mode === 'aggregate'}
              onChange={() => setMode('aggregate')}
              label="Aggregate ACR"
              description="Generate 1 consolidated ACR/VPAT for all files"
            />
          </div>
        </div>

        {/* Edition */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            VPAT Edition
          </label>
          <select
            value={edition}
            onChange={(e) => setEdition(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          >
            <option value="VPAT2.5-WCAG">VPAT 2.5 WCAG</option>
            <option value="VPAT2.5-508">VPAT 2.5 Section 508</option>
            <option value="VPAT2.5-EU">VPAT 2.5 EU</option>
            <option value="VPAT2.5-INT">VPAT 2.5 INT</option>
          </select>
        </div>

        {/* Product Name */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Product/Batch Name
          </label>
          <Input
            value={batchName}
            onChange={(e) => setBatchName(e.target.value)}
            placeholder="e.g., Q1 2026 EPUB Collection"
          />
        </div>

        {/* Vendor */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Vendor/Company Name
          </label>
          <Input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="e.g., Acme Publishing"
          />
        </div>

        {/* Contact Email */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Contact Email
          </label>
          <Input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="e.g., contact@example.com"
          />
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleGenerate}
          loading={isLoading}
          disabled={!vendor || !contactEmail}
        >
          Generate ACR
        </Button>
      </div>
    </Modal>
  );
}
```

4. Testing:
- Test ACR modal flow
- Test export functionality
- Test action buttons
- Test disabled states
- Test navigation to manual remediation

File Locations:
- Page: src/pages/BatchResults.tsx
- Components:
  - src/components/batch/BatchSummary.tsx
  - src/components/batch/AcrGenerationModal.tsx
  - src/components/batch/FileResultsList.tsx

Follow patterns from existing result pages.
```

---

## Frontend Prompt 11: Routing & Navigation

```
Context:
All batch pages and components are complete. Now adding routes and navigation links to integrate the batch workflow into the application.

Task:
Add routing for batch pages and update navigation menus.

Requirements:

1. Update Routes (src/App.tsx or src/routes.tsx):

Add batch routes:

```typescript
import { BatchCreationPage } from './pages/BatchCreation';
import { BatchProcessingPage } from './pages/BatchProcessing';
import { BatchResultsPage } from './pages/BatchResults';
import { BatchListPage } from './pages/BatchList';

// In your routes configuration:
const routes = [
  // ... existing routes

  // Batch routes
  {
    path: '/batches',
    element: <BatchListPage />,
    auth: true,
  },
  {
    path: '/batches/new',
    element: <BatchCreationPage />,
    auth: true,
  },
  {
    path: '/batch/:batchId',
    element: <BatchProcessingPage />,
    auth: true,
  },
  {
    path: '/batch/:batchId/results',
    element: <BatchResultsPage />,
    auth: true,
  },
];
```

2. Create Batch List Page (src/pages/BatchList.tsx):

```typescript
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBatches } from '../hooks/batch.hooks';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { FiPlus } from 'react-icons/fi';

export function BatchListPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const { data, isLoading } = useBatches(page);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'gray';
      case 'QUEUED': return 'blue';
      case 'PROCESSING': return 'yellow';
      case 'COMPLETED': return 'green';
      case 'FAILED': return 'red';
      default: return 'gray';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Batch Processing
          </h1>
          <p className="text-gray-600">
            Manage and monitor your EPUB batch processing jobs
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => navigate('/batches/new')}
          icon={<FiPlus />}
        >
          Create New Batch
        </Button>
      </div>

      {isLoading ? (
        <div>Loading batches...</div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Batch Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Files
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Created
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data?.batches.map((batch) => (
                <tr
                  key={batch.batchId}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/batch/${batch.batchId}`)}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {batch.name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {batch.batchId}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge color={getStatusColor(batch.status)}>
                      {batch.status}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {batch.filesRemediated} / {batch.totalFiles}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {new Date(batch.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/batch/${batch.batchId}`);
                      }}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {data && data.total > 20 && (
            <div className="bg-gray-50 px-6 py-4 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                Showing {(page - 1) * 20 + 1} to {Math.min(page * 20, data.total)} of {data.total} batches
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => p + 1)}
                  disabled={page * 20 >= data.total}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

3. Update Navigation Menu (src/components/layout/Sidebar.tsx or Navigation.tsx):

Add batch navigation link:

```typescript
import { FiLayers } from 'react-icons/fi';

// In your navigation items:
const navItems = [
  // ... existing items
  {
    label: 'Batch Processing',
    icon: <FiLayers />,
    path: '/batches',
    description: 'Process multiple EPUBs at once',
  },
  // ... other items
];
```

4. Update Main Menu (if applicable):

Add prominent batch processing option to main dashboard or home page:

```typescript
<Link to="/batches/new">
  <div className="card">
    <FiLayers className="icon" />
    <h3>Batch Processing</h3>
    <p>Upload and process multiple EPUB files automatically</p>
  </div>
</Link>
```

5. Breadcrumbs (optional but recommended):

Create breadcrumb component for batch pages:

```typescript
// In BatchProcessingPage.tsx
<Breadcrumbs>
  <BreadcrumbItem to="/batches">Batches</BreadcrumbItem>
  <BreadcrumbItem>{batch.name}</BreadcrumbItem>
</Breadcrumbs>
```

6. Testing:
- Test navigation to all batch pages
- Test breadcrumbs
- Test back navigation
- Test deep linking with batch IDs
- Test auth-protected routes

File Locations:
- Routes: src/App.tsx or src/routes.tsx
- Batch List: src/pages/BatchList.tsx
- Navigation: src/components/layout/Sidebar.tsx

Follow patterns from existing routing and navigation.
```

---

# Implementation Complete!

This completes all Replit prompts for the redesigned batch processing workflow.

## Summary

**Backend (Prompts 1-6):**
- Database schema with Batch and BatchFile models
- BatchFileService for file upload and storage
- BatchOrchestratorService for pipeline coordination
- API routes and controller
- BullMQ worker for async processing

**Frontend (Prompts 7-11):**
- API service layer with TypeScript types
- React Query hooks for state management
- Batch creation page with drag-and-drop upload
- Processing view with real-time SSE updates
- Results page with ACR generation and export
- Complete routing and navigation

## Next Steps

1. Implement prompts sequentially (backend first, then frontend)
2. Test each module as you complete it
3. Create git feature branches before starting
4. Run smoke tests after implementation
5. Document any issues or deviations from the design

## Git Commands

Create feature branches:

```bash
# Backend
cd ninja-backend
git checkout -b feature/batch-workflow-redesign
git push -u origin feature/batch-workflow-redesign

# Frontend
cd ninja-frontend
git checkout -b feature/batch-workflow-redesign
git push -u origin feature/batch-workflow-redesign
```