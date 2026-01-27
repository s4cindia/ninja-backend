import { Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { BatchProcessingJobData, BatchProcessingJobResult } from '../../queues';
import { batchOrchestratorService } from '../../services/batch/batch-orchestrator.service';
import { logger } from '../../lib/logger';

export async function processBatchProcessingJob(
  job: Job<BatchProcessingJobData, BatchProcessingJobResult>
): Promise<BatchProcessingJobResult> {
  const { batchId, tenantId } = job.data;

  logger.info(`[BatchProcessingWorker] Starting batch ${batchId}`);

  try {
    await batchOrchestratorService.processBatchSync(batchId);

    const batch = await batchOrchestratorService.getBatch(batchId);

    logger.info(`[BatchProcessingWorker] Batch ${batchId} completed: ${batch.filesRemediated} remediated, ${batch.filesFailed} failed`);

    return {
      batchId,
      filesProcessed: batch.totalFiles,
      filesRemediated: batch.filesRemediated,
      filesFailed: batch.filesFailed,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[BatchProcessingWorker] Batch ${batchId} failed: ${errorMessage}`);

    try {
      await prisma.batch.update({
        where: { id: batchId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      logger.error(`[BatchProcessingWorker] Failed to update batch status: ${updateError}`);
    }

    throw error;
  }
}
