import { Job } from 'bullmq';
import { BatchJobData, BatchJobResult } from '../../queues';
import { batchRemediationService } from '../../services/epub/batch-remediation.service';
import { logger } from '../../lib/logger';

export async function processBatchJob(
  job: Job<BatchJobData, BatchJobResult>
): Promise<BatchJobResult> {
  const { batchId, tenantId, options } = job.data;

  logger.info(`[BatchWorker] Starting batch ${batchId}`);

  try {
    const result = await batchRemediationService.processBatchSync(
      batchId,
      tenantId,
      options
    );

    return {
      batchId,
      completedJobs: result.completedJobs,
      failedJobs: result.failedJobs,
      totalIssuesFixed: result.summary.totalIssuesFixed,
    };
  } catch (error) {
    logger.error(`[BatchWorker] Batch ${batchId} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
