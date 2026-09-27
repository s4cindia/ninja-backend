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

  it('stops refreshing updatedAt past the max heartbeat lifetime, so a genuinely hung job can still be caught (CodeRabbit P1)', async () => {
    // An unbounded heartbeat would mask a TRULY hung job (a deadlocked
    // validator or DB call, not just a slow one) forever, since
    // cleanupStalePdfJobs (src/workers/index.ts) would never see a stale
    // updatedAt again. The cap lets the normal 20-min watchdog resume
    // authority once a run has gone on far longer than any legitimate one.
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockReturnValue(new Promise(() => {})); // never resolves

    processAccessibilityJob(makeJob());
    await vi.advanceTimersByTimeAsync(0);

    // Advance to just under the 6h cap -- heartbeat still ticking.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 60 * 1000);
    const callsNearCap = vi.mocked(queueService.updateJobProgress).mock.calls.length;
    expect(callsNearCap).toBeGreaterThan(0);

    // Advance well past the cap -- no further heartbeat calls should land.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const callsPastCap = vi.mocked(queueService.updateJobProgress).mock.calls.length;

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 * 5);
    expect(vi.mocked(queueService.updateJobProgress).mock.calls.length).toBe(callsPastCap);
  });

  it('awaits an in-flight heartbeat write before letting the function continue, so it can never land after the final progress write (CodeRabbit Major)', async () => {
    // clearInterval only stops FUTURE ticks -- without awaiting the very
    // last in-flight write, it could otherwise resolve after progress is
    // set to 100/COMPLETED, regressing it back to a stale lastKnownPct with
    // a misleadingly later updatedAt.
    let resolveAudit!: (value: any) => void;
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockReturnValue(
      new Promise((resolve) => { resolveAudit = resolve; })
    );

    const job = makeJob();
    const jobPromise = processAccessibilityJob(job);

    // Let the processor run up to (but not through) runAuditFromBuffer --
    // every updateJobProgress call up to this point (10%, auditStartPct,
    // etc.) must resolve normally, whatever the exact count turns out to be.
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeHeartbeat = vi.mocked(queueService.updateJobProgress).mock.calls.length;

    // From here on, intercept exactly the NEXT call (the first heartbeat
    // tick, since runAuditFromBuffer is mocked and never itself invokes
    // onProgress/onValidatorComplete) and hold it pending indefinitely.
    let resolveHeartbeatWrite!: () => void;
    let heartbeatWriteStarted = false;
    let callsSoFar = callsBeforeHeartbeat;
    vi.mocked(queueService.updateJobProgress).mockImplementation(() => {
      callsSoFar++;
      if (callsSoFar === callsBeforeHeartbeat + 1) {
        heartbeatWriteStarted = true;
        return new Promise((resolve) => { resolveHeartbeatWrite = resolve; });
      }
      return Promise.resolve();
    });

    // Fire exactly one heartbeat tick -- its write is now in flight and
    // deliberately never resolved yet.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(heartbeatWriteStarted).toBe(true);

    // Resolve the audit itself while that heartbeat write is still pending,
    // and let plenty of fake time pass -- long enough for every OTHER
    // intervening step (AcrJob creation, etc.) to fully settle on its own.
    resolveAudit({ issues: [], score: 100 });
    await vi.advanceTimersByTimeAsync(10_000);

    // The function must NOT have reached job.updateProgress(100) yet -- it's
    // still awaiting the in-flight heartbeat write in the finally block.
    expect(job.updateProgress).not.toHaveBeenCalledWith(100);

    // Now let the in-flight heartbeat write resolve -- only then can the
    // function proceed to its own final progress write.
    resolveHeartbeatWrite();
    await vi.advanceTimersByTimeAsync(0);
    await jobPromise;

    expect(job.updateProgress).toHaveBeenCalledWith(100);
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
