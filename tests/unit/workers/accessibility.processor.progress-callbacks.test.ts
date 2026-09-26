/**
 * Regression coverage for a real production incident: onProgress and
 * onValidatorComplete (passed into pdfAuditService.runAuditFromBuffer as
 * fire-and-forget `onProgress?.(...)` / `onValidatorComplete?.(...)` calls
 * from pdf-comprehensive-parser.service.ts and pdf-audit.service.ts -- never
 * awaited, never .catch()'d) are async functions that do real Prisma/Redis
 * I/O. Before this fix, if that I/O ever rejected (a connection pool blip,
 * a transient Redis error), the resulting unhandled promise rejection
 * crashed the ENTIRE Node process (no global unhandledRejection handler
 * existed), taking down the API and every other in-flight job, not just
 * this one progress update.
 *
 * Confirmed live: Math_Weir_PDF.pdf (377 pages -- proportionally far more
 * onProgress/onValidatorComplete invocations than anything tested before)
 * reliably reproduced a full container restart mid-audit, recorded by
 * src/workers/index.ts's startup cleanup as "Server restarted while job was
 * processing." These tests prove both callbacks now swallow a failing
 * dependency call and log a warning instead of ever rejecting.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { processAccessibilityJob } from '../../../src/workers/processors/accessibility.processor';
import { JOB_TYPES, JobData, JobResult } from '../../../src/queues';
import { queueService } from '../../../src/services/queue.service';
import { pdfAuditService } from '../../../src/services/pdf/pdf-audit.service';
import { pdfParserService } from '../../../src/services/pdf/pdf-parser.service';
import { seamCTagService } from '../../../src/services/pdf/seam-c-tag.service';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { logger } from '../../../src/lib/logger';
import prisma from '../../../src/lib/prisma';

vi.mock('../../../src/services/queue.service');
vi.mock('../../../src/services/pdf/pdf-audit.service');
vi.mock('../../../src/services/pdf/pdf-parser.service');
vi.mock('../../../src/services/pdf/adobe-autotag.service');
vi.mock('../../../src/services/pdf/seam-c-tag.service');
vi.mock('../../../src/services/pdf/ai-analysis.service');
vi.mock('../../../src/services/pdf/pdf-modifier.service');
vi.mock('../../../src/services/pdf/pdf-structure-writer.service');
vi.mock('../../../src/services/storage/file-storage.service');

vi.mock('../../../src/config/ai.config', () => ({
  aiConfig: { seamC: { enabled: true }, adobe: { enabled: false } },
}));

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn() },
    acrJob: { create: vi.fn() },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function buildUntaggedDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  return Buffer.from(await doc.save());
}

function makeJob(): Job<JobData, JobResult> {
  return {
    id: 'job-1',
    name: 'accessibility-job',
    data: {
      type: JOB_TYPES.PDF_ACCESSIBILITY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      fileId: 'file-1',
      options: { dbJobId: 'job-1', fileName: 'test.pdf' },
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<JobData, JobResult>;
}

/** Runs the processor once (audit itself mocked) and extracts the real onProgress/onValidatorComplete closures it built. */
async function captureCallbacks() {
  const originalBuffer = await buildUntaggedDoc();
  vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
  vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: false } } } as any);
  vi.mocked(seamCTagService.tagPdf).mockResolvedValue({
    taggedPdfBuffer: Buffer.from('tagged-pdf'),
    reportBuffer: null,
    wordBuffer: null,
    elementCounts: {},
    parsedFlags: {},
  } as any);

  await processAccessibilityJob(makeJob());

  const call = vi.mocked(pdfAuditService.runAuditFromBuffer).mock.calls[0];
  return {
    onProgress: call[5] as (currentPage: number, totalPages: number) => Promise<void>,
    onValidatorComplete: call[6] as (label: string, issuesFound: number, completed: number, total: number, startedAt: Date) => Promise<void>,
    onAltTextImageProgress: call[7] as (completed: number, total: number) => Promise<void>,
  };
}

describe('accessibility.processor progress callbacks — crash-safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {} } as any);
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);
    vi.mocked(prisma.acrJob.create).mockResolvedValue({} as any);
    vi.mocked(queueService.updateJobProgress).mockResolvedValue(undefined as any);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveFile).mockResolvedValue(undefined as any);
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({ issues: [] } as any);
  });

  it('onProgress resolves (never rejects) when prisma.job.findUnique fails', async () => {
    const { onProgress } = await captureCallbacks();

    vi.mocked(prisma.job.findUnique).mockRejectedValueOnce(new Error('connection pool exhausted'));

    await expect(onProgress(1, 10)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onProgress callback failed for job job-1'));
  });

  it('onProgress resolves (never rejects) when prisma.job.update fails', async () => {
    const { onProgress } = await captureCallbacks();

    vi.mocked(prisma.job.update).mockRejectedValueOnce(new Error('connection pool exhausted'));

    await expect(onProgress(1, 10)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onProgress callback failed for job job-1'));
  });

  // CodeRabbit + Codex review finding on this PR: an earlier draft set
  // totalPagesStored = true BEFORE the persistence write, so a transient
  // failure on the FIRST call left it permanently true -- every later call
  // silently skipped persisting totalPages for the rest of the audit, even
  // after the transient condition cleared.
  it('retries persisting totalPages on the next call after a transient failure, rather than giving up forever', async () => {
    const { onProgress } = await captureCallbacks();
    vi.mocked(prisma.job.update).mockClear(); // drop captureCallbacks' own setup-phase writes

    vi.mocked(prisma.job.update).mockRejectedValueOnce(new Error('connection pool exhausted'));
    await onProgress(0, 10);
    expect(prisma.job.update).toHaveBeenCalledTimes(1);

    await onProgress(1, 10);
    expect(prisma.job.update).toHaveBeenCalledTimes(2);
    expect(prisma.job.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ input: expect.objectContaining({ totalPages: 10 }) }) })
    );
  });

  it('onProgress resolves (never rejects) when queueService.updateJobProgress fails', async () => {
    const { onProgress } = await captureCallbacks();

    vi.mocked(queueService.updateJobProgress).mockRejectedValueOnce(new Error('redis connection reset'));

    // First call (currentPage=0) stores totalPages via prisma; second call exercises the queueService path.
    await onProgress(0, 10);
    await expect(onProgress(5, 10)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onProgress callback failed for job job-1'));
  });

  it('onValidatorComplete resolves (never rejects) when queueService.updateJobProgress fails', async () => {
    const { onValidatorComplete } = await captureCallbacks();

    vi.mocked(queueService.updateJobProgress).mockRejectedValueOnce(new Error('redis connection reset'));

    await expect(onValidatorComplete('Color Contrast', 5, 3, 8, new Date())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('onValidatorComplete callback failed for job job-1, validator "Color Contrast"')
    );
  });

  it('onValidatorComplete resolves (never rejects) when prisma.job.update fails', async () => {
    const { onValidatorComplete } = await captureCallbacks();

    vi.mocked(prisma.job.update).mockRejectedValueOnce(new Error('connection pool exhausted'));

    await expect(onValidatorComplete('Tables', 2, 4, 8, new Date())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('onValidatorComplete callback failed for job job-1, validator "Tables"')
    );
  });

  it('still records progress normally when nothing fails', async () => {
    const { onProgress, onValidatorComplete } = await captureCallbacks();

    await onProgress(5, 10);
    await onValidatorComplete('Alt Text', 3, 2, 8, new Date());

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('callback failed'));
  });

  // Real incident (2026-09-25): PDFAltTextValidator's internal per-image
  // loop (up to thousands of images on a large document) reported zero
  // progress to the caller for its entire duration -- only onValidatorComplete
  // above fires, and only once, after every image is done. A new stale-job
  // watchdog that fails anything with no DB update for 20+ minutes then
  // killed a genuinely still-working job as "orphaned." onAltTextImageProgress
  // exists to touch Job.updatedAt periodically during that long-running loop,
  // and needs the same crash-safety guarantee as the two callbacks above.
  it('onAltTextImageProgress resolves (never rejects) when queueService.updateJobProgress fails', async () => {
    const { onAltTextImageProgress } = await captureCallbacks();

    vi.mocked(queueService.updateJobProgress).mockRejectedValueOnce(new Error('redis connection reset'));

    await expect(onAltTextImageProgress(1200, 3843)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('onAltTextImageProgress callback failed for job job-1')
    );
  });

  it('onAltTextImageProgress resolves (never rejects) when prisma.job.update fails', async () => {
    const { onAltTextImageProgress } = await captureCallbacks();

    vi.mocked(prisma.job.update).mockRejectedValueOnce(new Error('connection pool exhausted'));

    await expect(onAltTextImageProgress(1200, 3843)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('onAltTextImageProgress callback failed for job job-1')
    );
  });

  it('onAltTextImageProgress records progress normally when nothing fails', async () => {
    const { onAltTextImageProgress } = await captureCallbacks();

    await onAltTextImageProgress(1200, 3843);

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('callback failed'));
    expect(queueService.updateJobProgress).toHaveBeenCalledWith('job-1', expect.any(Number));
  });
});
