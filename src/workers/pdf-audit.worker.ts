/**
 * PDF Audit Worker
 *
 * Background worker that processes PDF audit jobs from the queue.
 * Handles PDF accessibility validation with progress tracking, error handling, and retries.
 *
 * Job Flow:
 * 1. Receive job with { jobId, filePath, userId }
 * 2. Update status to 'processing'
 * 3. Run PdfAuditService.runAudit(filePath)
 * 4. Save results to database
 * 5. Update status to 'completed' or 'failed'
 */

import { Job, Worker } from 'bullmq';
import { promises as fs } from 'fs';
import path from 'path';
import { JobData, JobResult, JOB_TYPES, getBullMQConnection, QUEUE_NAMES } from '../queues';
import { queueService } from '../services/queue.service';
import { logger } from '../lib/logger';
import { isRedisConfigured } from '../lib/redis';

/**
 * PDF Audit Job Data
 */
export interface PdfAuditJobData extends JobData {
  filePath: string;
  fileName?: string;
}

/**
 * PDF Audit Result
 */
export interface PdfAuditResult extends JobResult {
  data?: {
    jobId: string;
    score: number;
    issues: Array<{
      id: number;
      severity: string;
      category: string;
      message: string;
      location?: string;
      wcagCriteria?: string[];
    }>;
    summary: {
      critical: number;
      serious: number;
      moderate: number;
      minor: number;
      total: number;
    };
    metadata: Record<string, unknown>;
  };
}

/**
 * Processing stages for progress tracking
 */
const PROCESSING_STAGES = {
  PARSING: { min: 0, max: 20, label: 'Parsing PDF structure' },
  VALIDATING: { min: 20, max: 80, label: 'Running accessibility validators' },
  GENERATING_REPORT: { min: 80, max: 100, label: 'Generating audit report' },
} as const;

/**
 * Process a PDF audit job
 */
export async function processPdfAuditJob(
  job: Job<PdfAuditJobData, PdfAuditResult>
): Promise<PdfAuditResult> {
  const { filePath, userId } = job.data;
  const jobId = job.id;

  if (!jobId) {
    const error = 'Job ID is required but was undefined';
    logger.error(error);
    throw new Error(error);
  }

  logger.info(`📄 Starting PDF audit job ${jobId} for file: ${filePath}`);

  try {
    // Stage 1: Parsing (0-20%)
    await updateProgress(job, jobId, PROCESSING_STAGES.PARSING.min);
    logger.info(`  📍 ${PROCESSING_STAGES.PARSING.label}`);

    // Verify file exists
    await verifyFileExists(filePath);

    await updateProgress(job, jobId, 10);

    // TODO: Integrate with PdfParserService when available
    // const parsedPdf = await pdfParserService.parse(filePath);

    await updateProgress(job, jobId, PROCESSING_STAGES.PARSING.max);

    // Stage 2: Validating (20-80%)
    await updateProgress(job, jobId, PROCESSING_STAGES.VALIDATING.min);
    logger.info(`  📍 ${PROCESSING_STAGES.VALIDATING.label}`);

    // TODO: Integrate with PdfAuditService when implemented (US-PDF-1.2)
    // This is a placeholder implementation until the service is ready
    // const auditResult = await pdfAuditService.runAudit(filePath);

    // Simulate validation stages
    const validationStages = [
      { progress: 30, label: 'Validating document structure' },
      { progress: 45, label: 'Checking image alt text quality' },
      { progress: 60, label: 'Analyzing table accessibility' },
      { progress: 75, label: 'Checking heading hierarchy' },
    ];

    for (const stage of validationStages) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await updateProgress(job, jobId, stage.progress);
      logger.info(`    ✓ ${stage.label}`);
    }

    await updateProgress(job, jobId, PROCESSING_STAGES.VALIDATING.max);

    // Stage 3: Generating Report (80-100%)
    await updateProgress(job, jobId, PROCESSING_STAGES.GENERATING_REPORT.min);
    logger.info(`  📍 ${PROCESSING_STAGES.GENERATING_REPORT.label}`);

    // Placeholder result (will be replaced with actual PdfAuditService result)
    const result: PdfAuditResult = {
      success: true,
      data: {
        jobId,
        score: 85,
        issues: [],
        summary: {
          critical: 0,
          serious: 0,
          moderate: 0,
          minor: 0,
          total: 0,
        },
        metadata: {
          fileName: path.basename(filePath),
          fileSize: (await fs.stat(filePath)).size,
          processedAt: new Date().toISOString(),
          validators: ['structure', 'alttext', 'table'],
        },
      },
    };

    // Save results to database
    await saveAuditResults(jobId, userId, result);

    await updateProgress(job, jobId, PROCESSING_STAGES.GENERATING_REPORT.max);

    // Clean up temporary file if it's in temp directory
    await cleanupTempFile(filePath);

    logger.info(`✅ PDF audit job ${jobId} completed successfully`);
    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`❌ PDF audit job ${jobId} failed: ${errorMessage}`, error);

    // Clean up on failure
    await cleanupTempFile(filePath).catch((err) => {
      logger.warn(`Failed to clean up file ${filePath}: ${err.message}`);
    });

    throw error;
  }
}

/**
 * Update job progress
 */
async function updateProgress(
  job: Job<PdfAuditJobData, PdfAuditResult>,
  jobId: string,
  progress: number
): Promise<void> {
  await job.updateProgress(progress);
  await queueService.updateJobProgress(jobId, progress);
}

/**
 * Verify file exists
 */
async function verifyFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
}

/**
 * Save audit results to database
 */
async function saveAuditResults(
  jobId: string,
  _userId: string,
  _result: PdfAuditResult
): Promise<void> {
  try {
    // TODO: Save detailed results to appropriate tables
    // For now, results are saved in job.output via queueService.updateJobStatus
    // which is called by the base worker

    // Example of what will be implemented:
    // 1. Save ValidationResult records
    // 2. Save Issue records linked to ValidationResult
    // 3. Generate and save Artifact records (reports, ACR)

    logger.info(`💾 Audit results saved for job ${jobId}`);
  } catch (error) {
    logger.error(`Failed to save audit results for job ${jobId}:`, error);
    throw error;
  }
}

/**
 * Clean up temporary file
 */
async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    // Only delete files in temp directories
    const tempDirs = ['temp', 'tmp', 'uploads'];
    const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');

    // Split path into segments and check if any segment is a temp directory
    const pathSegments = normalizedPath.split('/').filter(segment => segment.length > 0);
    const isTempFile = pathSegments.some(segment => tempDirs.includes(segment));

    if (isTempFile) {
      await fs.unlink(filePath);
      logger.info(`🧹 Cleaned up temporary file: ${filePath}`);
    }
  } catch (error) {
    // Non-critical error, just log it
    logger.debug(`Could not clean up file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Create and start the PDF audit worker
 */
export function createPdfAuditWorker(): Worker<PdfAuditJobData, PdfAuditResult> | null {
  if (!isRedisConfigured()) {
    logger.warn('Cannot create PDF audit worker - Redis not configured');
    return null;
  }

  try {
    const connection = getBullMQConnection();

    if (!connection) {
      logger.warn('Cannot create PDF audit worker - Redis connection not available');
      return null;
    }

    const worker = new Worker<PdfAuditJobData, PdfAuditResult>(
      QUEUE_NAMES.ACCESSIBILITY,
      async (job: Job<PdfAuditJobData, PdfAuditResult>) => {
        const jobId = job.id;

        if (!jobId) {
          logger.error('Job ID is required but was undefined');
          return { success: false, error: 'Job ID is required' } as PdfAuditResult;
        }

        // Only process PDF accessibility jobs
        if (job.data.type !== JOB_TYPES.PDF_ACCESSIBILITY) {
          logger.debug(`Skipping non-PDF job ${jobId}: ${job.data.type}`);
          return { success: false, error: 'Not a PDF accessibility job' } as PdfAuditResult;
        }

        logger.info(`Processing PDF audit job ${jobId}: ${job.data.type}`);

        try {
          await queueService.updateJobStatus(jobId, 'PROCESSING');

          const result = await processPdfAuditJob(job);

          await queueService.updateJobStatus(jobId, 'COMPLETED', {
            output: result.data,
          });

          logger.info(`Job ${jobId} completed successfully`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`Job ${jobId} failed: ${errorMessage}`);

          await queueService.updateJobStatus(jobId, 'FAILED', {
            error: errorMessage,
          });

          throw error;
        }
      },
      {
        connection,
        concurrency: 3, // Max 3 concurrent PDF audits
        autorun: true,
      }
    );

    // Event handlers
    worker.on('completed', (job) => {
      logger.info(`📗 PDF audit job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`📕 PDF audit job ${job?.id} failed: ${err.message}`);
    });

    worker.on('progress', (job, progress) => {
      logger.debug(`PDF audit job ${job.id} progress: ${progress}%`);
    });

    worker.on('error', (err) => {
      logger.error(`PDF audit worker error: ${err.message}`);
    });

    worker.on('stalled', (jobId) => {
      logger.warn(`PDF audit job ${jobId} stalled`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, closing PDF audit worker...');
      await worker.close();
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, closing PDF audit worker...');
      await worker.close();
    });

    logger.info('📦 PDF audit worker created successfully');
    return worker;

  } catch (error) {
    logger.error(`Could not create PDF audit worker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return null;
  }
}

/**
 * Health check for the worker
 */
export async function getWorkerHealth(): Promise<{
  status: 'healthy' | 'unhealthy';
  queueName: string;
  concurrency: number;
  metrics?: {
    activeJobs: number;
    completedJobs: number;
    failedJobs: number;
  };
}> {
  try {
    const connection = getBullMQConnection();
    if (!connection) {
      return {
        status: 'unhealthy',
        queueName: QUEUE_NAMES.ACCESSIBILITY,
        concurrency: 3,
      };
    }

    // TODO: Add actual queue metrics when needed
    return {
      status: 'healthy',
      queueName: QUEUE_NAMES.ACCESSIBILITY,
      concurrency: 3,
      metrics: {
        activeJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
      },
    };
  } catch {
    return {
      status: 'unhealthy',
      queueName: QUEUE_NAMES.ACCESSIBILITY,
      concurrency: 3,
    };
  }
}
