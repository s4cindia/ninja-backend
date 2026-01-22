import { Batch, BatchFile, BatchStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { batchFileService } from './batch-file.service';
import { epubAuditService } from '../epub/epub-audit.service';
import { remediationService } from '../epub/remediation.service';
import { autoRemediationService } from '../epub/auto-remediation.service';
import { sseService } from '../../sse/sse.service';

class BatchOrchestratorService {
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

  async addFilesToBatch(
    batchId: string,
    files: Array<{ buffer: Buffer; filename: string; size: number }>
  ): Promise<BatchFile[]> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Cannot add files to batch that is not in DRAFT status');
    }

    for (const file of files) {
      if (!file.filename.toLowerCase().endsWith('.epub')) {
        throw new Error(`Invalid file type: ${file.filename}. Only EPUB files are supported.`);
      }

      if (file.size > 100 * 1024 * 1024) {
        throw new Error(`File too large: ${file.filename}. Maximum size is 100MB.`);
      }
    }

    const batchFiles = await batchFileService.uploadFiles(batchId, files);

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

  async removeFileFromBatch(batchId: string, fileId: string): Promise<void> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Cannot remove files from batch that is not in DRAFT status');
    }

    await batchFileService.deleteFile(fileId);
    logger.info(`Removed file ${fileId} from batch ${batchId}`);
  }

  async startBatchProcessing(batchId: string): Promise<Batch> {
    const batch = await this.getBatch(batchId);

    if (batch.status !== 'DRAFT') {
      throw new Error('Batch must be in DRAFT status to start');
    }

    if (batch.totalFiles === 0) {
      throw new Error('Cannot start batch with no files');
    }

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'QUEUED',
        startedAt: new Date(),
      },
    });

    this.processBatchSync(batchId).catch((err) => {
      logger.error(`Batch ${batchId} processing failed:`, err);
    });

    return this.getBatch(batchId);
  }

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

  async listBatches(
    tenantId: string,
    page: number = 1,
    limit: number = 20,
    status?: BatchStatus
  ): Promise<{ batches: Batch[]; total: number }> {
    const where: { tenantId: string; status?: BatchStatus } = { tenantId };

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

  async processBatchSync(batchId: string): Promise<void> {
    logger.info(`[Batch ${batchId}] Starting processing pipeline`);

    const batch = await this.getBatch(batchId);

    await prisma.batch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING' },
    });

    const files = batch.files;
    let filesRemediated = 0;
    let filesFailed = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        logger.info(`[Batch ${batchId}] Processing file ${i + 1}/${files.length}: ${file.fileName}`);

        const auditJobId = await this.auditFile(batchId, file);
        await this.createPlanForFile(batchId, file, auditJobId);
        await this.autoRemediateFile(batchId, file, auditJobId);

        filesRemediated++;
        logger.info(`[Batch ${batchId}] File ${file.fileName} completed successfully`);

      } catch (error) {
        logger.error(`[Batch ${batchId}] File ${file.fileName} failed:`, error);
        filesFailed++;

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

        sseService.broadcastToChannel(`batch:${batchId}`, {
          type: 'file_failed',
          batchId,
          fileId: file.id,
          fileName: file.fileName,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, batch.tenantId);
      }
    }

    // Verify and correct issue count totals before marking complete
    const batchTotals = await prisma.batch.findUnique({
      where: { id: batchId },
      select: {
        autoFixedIssues: true,
        quickFixIssues: true,
        manualIssues: true,
        totalIssuesFound: true
      }
    });

    if (batchTotals) {
      const calculatedTotal =
        (batchTotals.autoFixedIssues || 0) +
        (batchTotals.quickFixIssues || 0) +
        (batchTotals.manualIssues || 0);

      if (calculatedTotal !== batchTotals.totalIssuesFound) {
        logger.warn(
          `[Batch ${batchId}] Issue count mismatch: stored=${batchTotals.totalIssuesFound}, ` +
          `calculated=${calculatedTotal} (auto=${batchTotals.autoFixedIssues}, ` +
          `quick=${batchTotals.quickFixIssues}, manual=${batchTotals.manualIssues}). Correcting...`
        );

        await prisma.batch.update({
          where: { id: batchId },
          data: { totalIssuesFound: calculatedTotal }
        });
      }
    }

    const updatedBatch = await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'batch_completed',
      batchId,
      totalFiles: updatedBatch.totalFiles,
      filesRemediated: updatedBatch.filesRemediated,
      filesFailed: updatedBatch.filesFailed,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Processing completed: ${filesRemediated}/${files.length} successful`);
  }

  private async auditFile(batchId: string, file: BatchFile): Promise<string> {
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'AUDITING',
        auditStartedAt: new Date(),
      },
    });

    const batch = await this.getBatch(batchId);
    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_auditing',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
    }, batch.tenantId);

    const epubBuffer = await batchFileService.getFileBuffer(file.id);

    const job = await prisma.job.create({
      data: {
        tenantId: batch.tenantId,
        userId: batch.userId,
        type: 'EPUB_ACCESSIBILITY',
        status: 'PROCESSING',
        input: {
          fileName: file.originalName,
          batchId,
          batchFileId: file.id,
        },
        startedAt: new Date(),
      },
    });

    const auditResult = await epubAuditService.runAudit(epubBuffer, job.id, file.originalName);

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        output: auditResult as unknown as Record<string, unknown>,
      },
    });

    const score = auditResult.score || 0;
    const totalIssues = auditResult.combinedIssues?.length || 0;

    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'AUDITED',
        auditJobId: job.id,
        auditScore: score,
        issuesFound: totalIssues,
        auditCompletedAt: new Date(),
      },
    });

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesAudited: { increment: 1 },
        totalIssuesFound: { increment: totalIssues || 0 },
      },
    });

    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_audited',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
      score,
      issuesFound: totalIssues,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Audit completed for ${file.fileName}: ${score}% score, ${totalIssues} issues`);

    return job.id;
  }

  private async createPlanForFile(batchId: string, file: BatchFile, auditJobId: string): Promise<void> {
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

    const plan = await remediationService.createRemediationPlan(auditJobId);

    const autoTasks = plan.tasks.filter((t: { type: string }) => t.type === 'auto');
    const quickFixTasks = plan.tasks.filter((t: { type: string }) => t.type === 'quickfix');
    const manualTasks = plan.tasks.filter((t: { type: string }) => t.type === 'manual');

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

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesPlanned: { increment: 1 },
        quickFixIssues: { increment: quickFixTasks.length || 0 },
        manualIssues: { increment: manualTasks.length || 0 },
      },
    });

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

  private async autoRemediateFile(batchId: string, file: BatchFile, auditJobId: string): Promise<void> {
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

    const epubBuffer = await batchFileService.getFileBuffer(file.id);

    const result = await autoRemediationService.runAutoRemediation(
      epubBuffer,
      auditJobId,
      file.originalName
    );

    const remediatedPath = await batchFileService.saveRemediatedFile(
      file.id,
      result.remediatedBuffer
    );

    const updatedFile = await prisma.batchFile.findUnique({ where: { id: file.id } });

    const issuesFixed = result.totalIssuesFixed || 0;
    
    await prisma.batchFile.update({
      where: { id: file.id },
      data: {
        status: 'REMEDIATED',
        issuesAutoFixed: issuesFixed,
        remainingQuickFix: updatedFile?.issuesQuickFix || 0,
        remainingManual: updatedFile?.issuesManual || 0,
        remediatedFilePath: remediatedPath,
        remediationCompletedAt: new Date(),
      },
    });

    await prisma.batch.update({
      where: { id: batchId },
      data: {
        filesRemediated: { increment: 1 },
        autoFixedIssues: { increment: issuesFixed },
      },
    });

    sseService.broadcastToChannel(`batch:${batchId}`, {
      type: 'file_remediated',
      batchId,
      fileId: file.id,
      fileName: file.fileName,
      issuesFixed,
    }, batch.tenantId);

    logger.info(`[Batch ${batchId}] Remediation completed for ${file.fileName}: ${issuesFixed} issues fixed`);
  }

  private generateBatchName(): string {
    const date = new Date().toISOString().split('T')[0];
    return `Batch ${date}`;
  }
}

export const batchOrchestratorService = new BatchOrchestratorService();
