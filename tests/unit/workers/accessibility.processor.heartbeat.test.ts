/**
 * Real incident (2026-09-26): PdfFormulaValidator and PdfFigureStructTreeValidator
 * -- pdf-audit.service.ts's "bonus sub-check" validators, deliberately excluded
 * from onValidatorComplete's progress total -- ran for 18+ minutes between Alt
 * Text and Color Contrast with zero signal to the job. The stale-job watchdog
 * (cleanupStalePdfJobs) killed the job 36 SECONDS before Color Contrast finished
 * and would have reported in on its own; the underlying work kept running
 * regardless (a DB write can't cancel the in-flight promise chain) and
 * eventually completed successfully, silently flipping status from FAILED back
 * to COMPLETED minutes later.
 *
 * Rather than keep individually instrumenting every current and future slow,
 * unmonitored sub-step (the way Alt Text's per-image progress was), a fixed-
 * interval heartbeat now touches Job.updatedAt for the ENTIRE
 * runAuditFromBuffer call, regardless of which validator (named or "bonus")
 * is currently executing. These tests prove it fires periodically while the
 * audit is pending, stops once it resolves, and stops even if it throws.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { processAccessibilityJob } from '../../../src/workers/processors/accessibility.processor';
import { JOB_TYPES, JobData, JobResult } from '../../../src/queues';
import { queueService } from '../../../src/services/queue.service';
import { pdfAuditService } from '../../../src/services/pdf/pdf-audit.service';
import { pdfParserService } from '../../../src/services/pdf/pdf-parser.service';
import { seamCTagService } from '../../../src/services/pdf/seam-c-tag.service';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { aiAnalysisService } from '../../../src/services/pdf/ai-analysis.service';

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
    job: { findUnique: vi.fn().mockResolvedValue({ input: {} }), update: vi.fn().mockResolvedValue({}) },
    acrJob: { create: vi.fn().mockResolvedValue({}) },
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

describe('accessibility.processor — audit heartbeat', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

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
    vi.mocked(queueService.updateJobProgress).mockResolvedValue(undefined as any);
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 0, skipped: 0 } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches the job periodically while runAuditFromBuffer is still pending, and stops once it resolves', async () => {
    let resolveAudit!: (value: any) => void;
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockReturnValue(
      new Promise((resolve) => { resolveAudit = resolve; })
    );

    const jobPromise = processAccessibilityJob(makeJob());

    // Let the processor run up to the point of calling runAuditFromBuffer.
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeHeartbeat = vi.mocked(queueService.updateJobProgress).mock.calls.length;

    // Advance past three heartbeat intervals (2 min each) while the audit is
    // still "running" (its promise hasn't resolved).
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 * 3);
    const callsDuringHeartbeat = vi.mocked(queueService.updateJobProgress).mock.calls.length;
    expect(callsDuringHeartbeat).toBeGreaterThanOrEqual(callsBeforeHeartbeat + 3);

    // Resolve the audit and let the processor finish.
    resolveAudit({ issues: [], score: 100 });
    await vi.advanceTimersByTimeAsync(0);
    await jobPromise;

    const callsAfterCompletion = vi.mocked(queueService.updateJobProgress).mock.calls.length;

    // No further heartbeat calls fire once the audit (and the job) is done.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 * 3);
    expect(vi.mocked(queueService.updateJobProgress).mock.calls.length).toBe(callsAfterCompletion);
  });

  it('stops the heartbeat even when runAuditFromBuffer throws', async () => {
    let rejectAudit!: (err: Error) => void;
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockReturnValue(
      new Promise((_resolve, reject) => { rejectAudit = reject; })
    );

    const jobPromise = processAccessibilityJob(makeJob()).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);

    rejectAudit(new Error('audit blew up'));
    await vi.advanceTimersByTimeAsync(0);
    const result = await jobPromise;
    expect(result).toBeInstanceOf(Error);

    const callsAfterFailure = vi.mocked(queueService.updateJobProgress).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 * 3);
    expect(vi.mocked(queueService.updateJobProgress).mock.calls.length).toBe(callsAfterFailure);
  });
});
