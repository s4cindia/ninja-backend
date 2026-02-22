/**
 * Style Processing Worker
 *
 * Handles background processing of style validation jobs
 */

import { Job } from 'bullmq';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';
import { styleValidation } from '../../services/style/style-validation.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';

export async function processStyleJob(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { type } = job.data;

  switch (type) {
    case JOB_TYPES.STYLE_VALIDATION:
      return await processStyleValidation(job);

    default:
      throw new Error(`Unknown style job type: ${type}`);
  }
}

async function processStyleValidation(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;
  const { options } = job.data;
  const documentId = options?.documentId as string;
  const ruleSetIds = (options?.ruleSetIds as string[]) || ['general'];
  // Use the pre-created validation job ID from the controller
  const validationJobId = options?.validationJobId as string;

  if (!documentId) {
    throw new Error('Missing documentId in job options');
  }

  if (!validationJobId) {
    throw new Error('Missing validationJobId in job options');
  }

  logger.info(`[Style Worker] Starting style validation for document ${documentId}`);
  logger.info(`[Style Worker] Job ID: ${jobId}, Validation Job ID: ${validationJobId}, Rule sets: ${ruleSetIds.join(', ')}`);

  try {
    // Stage 1: Update job progress (job was already created by controller)
    await job.updateProgress(5);
    await queueService.updateJobProgress(jobId, 5);

    // Stage 2: Execute validation with progress callbacks
    await job.updateProgress(10);
    await queueService.updateJobProgress(jobId, 10);

    const violationsFound = await styleValidation.executeValidation(
      validationJobId,
      async (progress: number, message: string) => {
        // Map validation progress (0-100) to job progress (10-95)
        const mappedProgress = 10 + Math.floor(progress * 0.85);
        await job.updateProgress(mappedProgress);
        await queueService.updateJobProgress(jobId, mappedProgress);
        logger.debug(`[Style Worker] ${message} (${progress}%)`);
      }
    );

    // Stage 3: Update job record
    await job.updateProgress(98);
    await queueService.updateJobProgress(jobId, 98);

    // Update the associated Job record if it exists (use transaction for consistency)
    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: { jobId: true },
    });

    if (document?.jobId) {
      await prisma.$transaction([
        prisma.styleValidationJob.update({
          where: { id: validationJobId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        }),
        prisma.job.update({
          where: { id: document.jobId },
          data: {
            status: 'COMPLETED',
            output: {
              styleValidationJobId: validationJobId,
              violationsFound,
              completedAt: new Date().toISOString(),
            },
          },
        }),
      ]);
    }

    await job.updateProgress(100);
    await queueService.updateJobProgress(jobId, 100);

    logger.info(
      `[Style Worker] Completed validation for ${documentId}: ${violationsFound} violations found`
    );

    return {
      success: true,
      data: {
        type: 'STYLE_VALIDATION',
        documentId,
        validationJobId: validationJobId,
        violationsFound,
        ruleSetIds,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Style Worker] Failed to validate document ${documentId}:`, error);

    // Update validation job status if it was created
    if (validationJobId) {
      await prisma.styleValidationJob.update({
        where: { id: validationJobId },
        data: {
          status: 'FAILED',
          error: errorMessage,
          completedAt: new Date(),
        },
      }).catch((updateError) => {
        logger.warn(`[Style Worker] Failed to update validation job status: ${updateError}`);
      });
    }

    // Update associated job record
    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: { jobId: true },
    });

    if (document?.jobId) {
      await prisma.job.update({
        where: { id: document.jobId },
        data: {
          status: 'FAILED',
          error: errorMessage,
        },
      }).catch((updateError) => {
        logger.warn(`[Style Worker] Failed to update job status: ${updateError}`);
      });
    }

    throw error;
  }
}
