/**
 * Full Auto Mode's automatic trigger -- right after the initial audit's own
 * AI analysis resolves (the existing 3s-delayed analyzeJob().then() block
 * that already fires the "Audit complete" notification), the processor now
 * also checks the effective fullAutoMode flag (Job.fullAutoMode override,
 * or the tenant's aiRemediation.fullAutoModeDefault) and, when true,
 * upserts a PdfAutoRemediationRun and calls the exact same
 * enqueueOrRunAutoLoop dispatch the manual "Start Auto Remediation" button
 * already uses -- skipping that one remaining manual click entirely.
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
import { getEffectiveAiRemediationConfig } from '../../../src/services/pdf/ai-remediation-tenant-config.service';
import { resolveFullAutoMode, enqueueOrRunAutoLoop, JobAutoRemediationDriver } from '../../../src/services/pdf/auto-remediation-loop.service';
import { notificationService } from '../../../src/services/notification/notification.service';
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
vi.mock('../../../src/services/notification/notification.service');
vi.mock('../../../src/services/pdf/ai-remediation-tenant-config.service');
vi.mock('../../../src/services/pdf/auto-remediation-loop.service');

vi.mock('../../../src/config/ai.config', () => ({
  aiConfig: { seamC: { enabled: true }, adobe: { enabled: false } },
}));

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    acrJob: { create: vi.fn().mockResolvedValue({}) },
    pdfAutoRemediationRun: { upsert: vi.fn() },
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

describe('accessibility.processor — Full Auto Mode trigger', () => {
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
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({ issues: [], score: 100 } as any);
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 5, skipped: 0, serviceDegraded: false } as any);
    vi.mocked(notificationService.createNotification).mockResolvedValue(undefined as any);

    // Satisfies both the existing aiAnalysisProgress merge (select: input)
    // and this trigger's own fullAutoMode lookup (select: fullAutoMode) --
    // the mock doesn't need to honor `select` the way the real DB would.
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {}, fullAutoMode: null } as any);
    vi.mocked(prisma.pdfAutoRemediationRun.upsert).mockResolvedValue({ id: 'run-1', jobId: 'job-1' } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndSettleAnalysis(job = makeJob()) {
    const jobPromise = processAccessibilityJob(job);
    // The AI-analysis step itself is a 3s-delayed setTimeout, deliberately
    // isolated from runAuditFromBuffer/the main job flow.
    await vi.advanceTimersByTimeAsync(5000);
    await jobPromise;
  }

  it('auto-starts the Auto Mode loop when the effective fullAutoMode flag is true (job override)', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {}, fullAutoMode: true } as any);
    vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: false } as any);
    vi.mocked(resolveFullAutoMode).mockImplementation((jobOverride, tenantDefault) => jobOverride ?? tenantDefault);

    await runAndSettleAnalysis();

    expect(prisma.pdfAutoRemediationRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobId: 'job-1' } })
    );
    expect(enqueueOrRunAutoLoop).toHaveBeenCalledWith('jobRun', 'run-1', expect.any(JobAutoRemediationDriver));
  });

  it('auto-starts when there is no job override but the tenant default is true', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {}, fullAutoMode: null } as any);
    vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true } as any);
    vi.mocked(resolveFullAutoMode).mockImplementation((jobOverride, tenantDefault) => jobOverride ?? tenantDefault);

    await runAndSettleAnalysis();

    expect(enqueueOrRunAutoLoop).toHaveBeenCalledWith('jobRun', 'run-1', expect.any(JobAutoRemediationDriver));
  });

  it('does nothing when the effective fullAutoMode flag is false', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {}, fullAutoMode: false } as any);
    vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true } as any);
    vi.mocked(resolveFullAutoMode).mockImplementation((jobOverride, tenantDefault) => jobOverride ?? tenantDefault);

    await runAndSettleAnalysis();

    expect(prisma.pdfAutoRemediationRun.upsert).not.toHaveBeenCalled();
    expect(enqueueOrRunAutoLoop).not.toHaveBeenCalled();
  });

  it('never triggers when the AI analysis service itself is degraded, regardless of the effective flag', async () => {
    vi.mocked(aiAnalysisService.analyzeJob).mockResolvedValue({ analyzed: 0, skipped: 0, serviceDegraded: true, serviceError: 'down' } as any);
    vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullAutoModeDefault: true } as any);
    vi.mocked(resolveFullAutoMode).mockReturnValue(true);

    await runAndSettleAnalysis();

    expect(getEffectiveAiRemediationConfig).not.toHaveBeenCalled();
    expect(enqueueOrRunAutoLoop).not.toHaveBeenCalled();
  });

  it('swallows a failure inside the trigger itself without throwing (the audit already completed normally)', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {}, fullAutoMode: true } as any);
    vi.mocked(getEffectiveAiRemediationConfig).mockRejectedValue(new Error('tenant config read failed'));
    vi.mocked(resolveFullAutoMode).mockReturnValue(true);

    await expect(runAndSettleAnalysis()).resolves.not.toThrow();
    expect(enqueueOrRunAutoLoop).not.toHaveBeenCalled();
  });
});
