import { Batch, BatchFile, BatchStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { batchFileService } from './batch-file.service';

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
    logger.info(`Processing batch ${batchId} - implementation pending`);
  }

  private generateBatchName(): string {
    const date = new Date().toISOString().split('T')[0];
    return `Batch ${date}`;
  }
}

export const batchOrchestratorService = new BatchOrchestratorService();
