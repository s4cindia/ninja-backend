import { Job } from 'bullmq';
import { PdfBatchItemJobData, PdfBatchItemJobResult } from '../../queues';
import { pdfBatchOrchestratorService } from '../../services/pdf-batch/pdf-batch-orchestrator.service';
import { logger } from '../../lib/logger';

export async function processPdfBatchItemJob(
  job: Job<PdfBatchItemJobData, PdfBatchItemJobResult>
): Promise<PdfBatchItemJobResult> {
  const { batchId, itemId } = job.data;

  logger.info(`[PdfBatchItemWorker] Starting item ${itemId} (batch ${batchId})`);

  // No try/catch needed here: processItem already catches its own errors
  // and marks the item FAILED (releasing any held lease) before returning
  // normally -- it never rethrows in the ordinary failure case. If it ever
  // does throw (a genuinely unexpected bug, not a modeled failure), letting
  // it propagate is correct: the item's lease-holding `finally` blocks will
  // still have run, and reconcileStaleLeases is the backstop for anything
  // that escapes a cleanly-caught state.
  await pdfBatchOrchestratorService.processItem(batchId, itemId);

  logger.info(`[PdfBatchItemWorker] Finished item ${itemId} (batch ${batchId})`);

  return { batchId, itemId };
}
