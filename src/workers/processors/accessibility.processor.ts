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
  const { options, tenantId, userId } = job.data;
  // dbJobId and BullMQ job.id are the same (we pass jobId when enqueueing)
  const dbJobId = (options?.dbJobId as string) || (job.id || job.name);
  const fileName = (options?.fileName as string) || 'document.pdf';

  // Note: base.worker already called queueService.updateJobStatus(PROCESSING) and
  // job.updateProgress(10) before invoking this processor. No need to repeat here.

  // Load file from permanent storage (retry-safe — no temp file dependency)
  logger.info(`[PDF Worker] Loading file for job ${dbJobId}`);
  const fileBuffer = await fileStorageService.getFile(dbJobId, fileName);
  if (!fileBuffer) {
    throw new Error(`PDF file not found in storage for job ${dbJobId}`);
  }

  await job.updateProgress(20);
  await queueService.updateJobProgress(dbJobId, 20);

  // Progress callback: maps page progress to the 20–88% range.
  // First call (currentPage=0) stores totalPages in job.input for the frontend.
  let totalPagesStored = false;
  const onProgress = async (currentPage: number, totalPages: number) => {
    if (!totalPagesStored && totalPages > 0) {
      totalPagesStored = true;
      // Merge totalPages into job.input so the polling endpoint exposes it
      const existingJob = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
      const existingInput = (existingJob?.input && typeof existingJob.input === 'object' && !Array.isArray(existingJob.input))
        ? existingJob.input as Record<string, unknown>
        : {};
      await prisma.job.update({
        where: { id: dbJobId },
        data: { input: { ...existingInput, totalPages } as Prisma.InputJsonObject },
      });
      logger.info(`[PDF Worker] Job ${dbJobId}: ${totalPages} pages to audit`);
    }
    if (totalPages > 0) {
      const pct = 20 + Math.round((currentPage / totalPages) * 68); // 20–88%
      await job.updateProgress(pct);
      await queueService.updateJobProgress(dbJobId, pct);
    }
  };

  // Validator progress callback: updates job.input.validatorProgress and advances 88–95%
  const validatorProgress: Array<{ label: string; issuesFound: number; startedAt: string; completedAt: string }> = [];
  const onValidatorComplete = async (label: string, issuesFound: number, completed: number, total: number, startedAt: Date) => {
    validatorProgress.push({ label, issuesFound, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() });
    logger.info(`[PDF Worker] Validator "${label}" done: ${issuesFound} issues (${completed}/${total})`);
    // Advance progress 88–95% across validators
    const pct = 88 + Math.round((completed / total) * 7); // 88–95%
    await job.updateProgress(pct);
    await queueService.updateJobProgress(dbJobId, pct);
    // Persist validator stats into job.input for the polling endpoint
    const existingJob2 = await prisma.job.findUnique({ where: { id: dbJobId }, select: { input: true } });
    const existingInput2 = (existingJob2?.input && typeof existingJob2.input === 'object' && !Array.isArray(existingJob2.input))
      ? existingJob2.input as Record<string, unknown>
      : {};
    await prisma.job.update({
      where: { id: dbJobId },
      data: { input: { ...existingInput2, validatorProgress: [...validatorProgress] } as Prisma.InputJsonObject },
    });
  };

  // Run the accessibility audit
  logger.info(`[PDF Worker] Running audit for job ${dbJobId}, file: ${fileName}`);
  const auditReport = await pdfAuditService.runAuditFromBuffer(fileBuffer, dbJobId, fileName, 'basic', undefined, onProgress, onValidatorComplete);
  logger.info(`[PDF Worker] Audit complete for job ${dbJobId}`);

  // Create AcrJob record so this audit appears in the ACR workflow (non-fatal).
  // Use tenantId/userId from BullMQ job data — avoids an extra DB query.
  try {
    await prisma.acrJob.create({
      data: {
        jobId: dbJobId,
        tenantId,
        userId,
        edition: 'WCAG21-AA',
        documentTitle: fileName,
        documentType: 'PDF',
        status: 'draft',
      },
    });
  } catch (acrErr) {
    logger.warn(`[PDF Worker] Failed to create AcrJob (non-fatal): ${acrErr instanceof Error ? acrErr.message : String(acrErr)}`);
  }

  await job.updateProgress(100);
  await queueService.updateJobProgress(dbJobId, 100);

  // Return the full audit report in result.data so the base.worker wrapper
  // can persist it as job.output. Do NOT call prisma.job.update here —
  // base.worker handles the COMPLETED status + output write to avoid overwriting.
  return {
    success: true,
    data: {
      fileName,
      auditReport: auditReport as unknown as Record<string, unknown>,
      scanLevel: 'basic',
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
