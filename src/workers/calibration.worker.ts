import { Job } from 'bullmq';
import { runCalibration } from '../services/calibration/calibration.service';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, type JobData, type JobResult } from '../queues';
import { logger } from '../lib/logger';
import prisma from '../lib/prisma';

const processCalibrationJob = async (
  job: Job<JobData, JobResult>,
): Promise<JobResult> => {
  const { documentId, tenantId, fileId, runId, taggedPdfPath } = job.data.options as {
    documentId: string;
    tenantId: string;
    fileId?: string;
    runId?: string;
    taggedPdfPath?: string;
  };

  logger.info(
    `[CalibrationWorker] Starting job for document ${documentId}` +
      (runId ? ` (existing run ${runId})` : '') +
      (taggedPdfPath ? ` (tagged PDF: ${taggedPdfPath})` : ''),
  );

  try {
    const result = await runCalibration(documentId, tenantId, {
      fileId,
      existingRunId: runId,
      taggedPdfPath,
    });

    logger.info(
      `[CalibrationWorker] Completed: ${result.calibrationRunId}` +
        ` — ${result.durationMs}ms` +
        ` G:${result.greenCount} A:${result.amberCount} R:${result.redCount}`,
    );

    return {
      success: true,
      data: result as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[CalibrationWorker] Failed for document ${documentId}: ${errorMessage}`);

    // Persist error to CalibrationRun so the UI can show it
    if (runId) {
      await prisma.calibrationRun.update({
        where: { id: runId },
        data: {
          completedAt: new Date(),
          summary: { status: 'FAILED', error: errorMessage },
        },
      }).catch((dbErr) => {
        logger.warn(`[CalibrationWorker] Could not update run ${runId} with failure: ${dbErr}`);
      });
    }

    throw err;
  }
};

export const startCalibrationWorker = () =>
  createWorker({
    queueName: QUEUE_NAMES.CALIBRATION,
    processor: processCalibrationJob,
    concurrency: 2,
    // Docling ML inference can take 15–20+ min on CPU; lock must exceed that
    lockDuration: 30 * 60 * 1000,
  });
