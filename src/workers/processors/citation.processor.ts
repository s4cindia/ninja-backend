/**
 * Citation Processing Worker
 *
 * Handles background processing of citation detection and analysis
 */

import { Job } from 'bullmq';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';
import { citationAnalysisService } from '../../services/citation/citation-analysis.service';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';

export async function processCitationJob(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { type } = job.data;

  switch (type) {
    case JOB_TYPES.CITATION_DETECTION:
      return await processCitationDetection(job);

    default:
      throw new Error(`Unknown citation job type: ${type}`);
  }
}

async function processCitationDetection(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;
  const { options } = job.data;
  const documentId = options?.documentId as string;

  if (!documentId) {
    throw new Error('Missing documentId in job options');
  }

  logger.info(`[Citation Worker] Starting citation detection for document ${documentId}`);
  logger.info(`[Citation Worker] Job ID: ${jobId}, Job Name: ${job.name}`);

  try {
    // Stage 1: Fetch document
    await job.updateProgress(10);
    await queueService.updateJobProgress(jobId, 10);

    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        originalName: true,
        jobId: true,
        documentContent: {
          select: { fullText: true, fullHtml: true }
        },
      },
    });

    if (!document) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!document.documentContent?.fullText) {
      throw new Error(`Document has no text content: ${documentId}`);
    }

    // Stage 2: Update status to ANALYZING
    await job.updateProgress(20);
    await queueService.updateJobProgress(jobId, 20);

    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: 'ANALYZING' },
    });

    // Stage 3: Run AI analysis (this is the heavy lifting)
    await job.updateProgress(30);
    await queueService.updateJobProgress(jobId, 30);

    logger.info(`[Citation Worker] Running AI analysis for document ${documentId}`);

    await citationAnalysisService.analyzeDocument(
      documentId,
      document.documentContent.fullText,
      document.documentContent.fullHtml || undefined,
      // Progress callback for granular updates
      async (progress: number, message: string) => {
        // Map analysis progress (0-100) to job progress (30-90)
        const mappedProgress = 30 + Math.floor(progress * 0.6);
        await job.updateProgress(mappedProgress);
        await queueService.updateJobProgress(jobId, mappedProgress);
        logger.debug(`[Citation Worker] ${message} (${progress}%)`);
      }
    );

    // Stage 4: Get final counts
    await job.updateProgress(95);
    await queueService.updateJobProgress(jobId, 95);

    const [citationCount, referenceCount] = await Promise.all([
      prisma.citation.count({ where: { documentId } }),
      prisma.referenceListEntry.count({ where: { documentId } }),
    ]);

    // Stage 5: Update document status to COMPLETED
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: 'COMPLETED' },
    });

    // Update the job record if it exists
    if (document.jobId) {
      await prisma.job.update({
        where: { id: document.jobId },
        data: {
          status: 'COMPLETED',
          output: {
            citationsFound: citationCount,
            referencesFound: referenceCount,
            completedAt: new Date().toISOString(),
          },
        },
      });
    }

    await job.updateProgress(100);
    await queueService.updateJobProgress(jobId, 100);

    logger.info(
      `[Citation Worker] Completed analysis for ${documentId}: ${citationCount} citations, ${referenceCount} references`
    );

    return {
      success: true,
      data: {
        type: 'CITATION_DETECTION',
        documentId,
        citationsFound: citationCount,
        referencesFound: referenceCount,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Citation Worker] Failed to analyze document ${documentId}:`, error);

    // Update document status to FAILED
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: 'FAILED' },
    }).catch(() => {
      // Ignore errors updating status
    });

    // Update job record if it exists
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
      }).catch(() => {
        // Ignore errors updating job
      });
    }

    throw error;
  }
}
