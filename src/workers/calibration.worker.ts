import { Job } from 'bullmq';
import { runCalibration } from '../services/calibration/calibration.service';
import { createWorker } from './base.worker';
import { QUEUE_NAMES, type JobData, type JobResult } from '../queues';
import { logger } from '../lib/logger';

const processCalibrationJob = async (
  job: Job<JobData, JobResult>,
): Promise<JobResult> => {
  const { documentId, tenantId, fileId } = job.data.options as {
    documentId: string;
    tenantId: string;
    fileId: string;
  };

  logger.info(
    `[CalibrationWorker] Starting job for document ${documentId}`,
  );

  const result = await runCalibration(documentId, tenantId, fileId);

  logger.info(
    `[CalibrationWorker] Completed: ${result.calibrationRunId}` +
      ` — ${result.durationMs}ms` +
      ` G:${result.greenCount} A:${result.amberCount} R:${result.redCount}`,
  );

  return {
    success: true,
    data: result as unknown as Record<string, unknown>,
  };
};

export const startCalibrationWorker = () =>
  createWorker({
    queueName: QUEUE_NAMES.CALIBRATION,
    processor: processCalibrationJob,
    concurrency: 2,
    lockDuration: 10 * 60 * 1000,
  });
