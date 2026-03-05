import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { JobData, JobResult, JOB_TYPES } from '../../queues';
import { queueService } from '../../services/queue.service';
import { pdfAuditService } from '../../services/pdf/pdf-audit.service';
import { fileStorageService } from '../../services/storage/file-storage.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export async function processAccessibilityJob(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { type, fileId } = job.data;
  const jobId = job.id || job.name;

  logger.info(`[Accessibility] Starting ${type} for file: ${fileId ?? 'n/a'}`);

  await job.updateProgress(10);
  await queueService.updateJobProgress(jobId, 10);

  switch (type) {
    case JOB_TYPES.PDF_ACCESSIBILITY:
      return await processPdfAccessibility(job);

    case JOB_TYPES.EPUB_ACCESSIBILITY:
      return await processEpubAccessibility(job);

    case JOB_TYPES.BATCH_VALIDATION:
      return await processBatchValidation(job);

    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

async function processPdfAccessibility(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const { options } = job.data;
  // dbJobId and BullMQ job.id are the same (we pass jobId when enqueueing)
  const dbJobId = (options?.dbJobId as string) || (job.id || job.name);
  const fileName = (options?.fileName as string) || 'document.pdf';

  // Mark job as PROCESSING
  await queueService.updateJobStatus(dbJobId, 'PROCESSING');
  await job.updateProgress(10);
  await queueService.updateJobProgress(dbJobId, 10);

  // Load file from permanent storage (retry-safe — no temp file dependency)
  logger.info(`[PDF Worker] Loading file for job ${dbJobId}`);
  const fileBuffer = await fileStorageService.getFile(dbJobId, fileName);
  if (!fileBuffer) {
    throw new Error(`PDF file not found in storage for job ${dbJobId}`);
  }

  await job.updateProgress(20);
  await queueService.updateJobProgress(dbJobId, 20);

  // Run the accessibility audit
  logger.info(`[PDF Worker] Running audit for job ${dbJobId}, file: ${fileName}`);
  const result = await pdfAuditService.runAuditFromBuffer(fileBuffer, dbJobId, fileName);
  logger.info(`[PDF Worker] Audit complete for job ${dbJobId}`);

  await job.updateProgress(90);
  await queueService.updateJobProgress(dbJobId, 90);

  // Update job to COMPLETED with full audit report
  await prisma.job.update({
    where: { id: dbJobId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      output: JSON.parse(JSON.stringify({
        fileName,
        auditReport: result,
        scanLevel: 'basic',
      })) as Prisma.InputJsonObject,
    },
  });

  // Create AcrJob record so this audit appears in the ACR workflow (non-fatal)
  try {
    const jobRecord = await prisma.job.findUnique({ where: { id: dbJobId } });
    if (jobRecord) {
      await prisma.acrJob.create({
        data: {
          jobId: dbJobId,
          tenantId: jobRecord.tenantId,
          userId: jobRecord.userId,
          edition: 'WCAG21-AA',
          documentTitle: fileName,
          documentType: 'PDF',
          status: 'draft',
        },
      });
    }
  } catch (acrErr) {
    logger.warn(`[PDF Worker] Failed to create AcrJob (non-fatal): ${acrErr instanceof Error ? acrErr.message : String(acrErr)}`);
  }

  await job.updateProgress(100);
  await queueService.updateJobProgress(dbJobId, 100);

  return {
    success: true,
    data: {
      type: 'PDF_ACCESSIBILITY',
      dbJobId,
      timestamp: new Date().toISOString(),
    },
  };
}

async function processEpubAccessibility(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  await simulateProcessing(job, jobId, [
    { progress: 20, message: 'Parsing EPUB structure' },
    { progress: 40, message: 'Validating EPUB 3 accessibility' },
    { progress: 60, message: 'Checking navigation elements' },
    { progress: 80, message: 'Analyzing media overlays' },
    { progress: 100, message: 'Generating report' },
  ]);

  return {
    success: true,
    data: {
      type: 'EPUB_ACCESSIBILITY',
      validationComplete: true,
      issuesFound: 0,
      passedChecks: 12,
      totalChecks: 12,
      score: 100,
      timestamp: new Date().toISOString(),
    },
  };
}

async function processBatchValidation(
  job: Job<JobData, JobResult>
): Promise<JobResult> {
  const jobId = job.id || job.name;

  await simulateProcessing(job, jobId, [
    { progress: 25, message: 'Processing batch items' },
    { progress: 50, message: 'Running validations' },
    { progress: 75, message: 'Aggregating results' },
    { progress: 100, message: 'Complete' },
  ]);

  return {
    success: true,
    data: {
      type: 'BATCH_VALIDATION',
      totalProcessed: 1,
      successful: 1,
      failed: 0,
      timestamp: new Date().toISOString(),
    },
  };
}

async function simulateProcessing(
  job: Job<JobData, JobResult>,
  jobId: string,
  stages: Array<{ progress: number; message: string }>
): Promise<void> {
  for (const stage of stages) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await job.updateProgress(stage.progress);
    await queueService.updateJobProgress(jobId, stage.progress);
    logger.info(`  [Worker] ${stage.message}`);
  }
}
