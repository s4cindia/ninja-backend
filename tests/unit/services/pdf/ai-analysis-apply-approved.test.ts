/**
 * aiAnalysisService.applyApprovedSuggestions
 *
 * Extracted from pdf-ai-analysis.controller.ts's applyAll so the
 * auto-remediation loop can drive the same apply logic without going
 * through that endpoint's own lock acquisition. These tests cover the
 * extraction itself (eligibility filtering, includePending, success/failure
 * bookkeeping, history logging) -- not a full re-derivation of every
 * suggestionType branch, since that switch is a faithful, unmodified port.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn() },
    aiAnalysis: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../../src/services/storage/file-storage.service');
vi.mock('../../../../src/services/pdf/pdf-modifier.service');
vi.mock('../../../../src/services/pdf/pdf-structure-writer.service');
vi.mock('../../../../src/services/pdf/pdf-contrast-writer.service');
vi.mock('../../../../src/services/pdf/remediation-cycle-history.service');
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { remediationCycleHistoryService } from '../../../../src/services/pdf/remediation-cycle-history.service';

const jobRow = { id: 'job-1', output: { fileName: 'doc.pdf', auditReport: { issues: [] } } };

describe('aiAnalysisService.applyApprovedSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobRow as any);
  });

  it('returns applied:0/failed:0 with no PDF load and no history log when nothing is eligible', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([] as any);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 5, 'user-1', 'apply_all');

    expect(result).toEqual({ applied: 0, failed: 0, errors: [] });
    expect(fileStorageService.getRemediatedFile).not.toHaveBeenCalled();
    expect(remediationCycleHistoryService.logEvent).not.toHaveBeenCalled();
  });

  it('applies an eligible alt-text suggestion, saves the PDF, and logs a completed history event under the given source', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 5, 'user-1', 'apply_all');

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.modifiedBuffer).toEqual(Buffer.from('modified-pdf'));
    expect(result.fileName).toBe('doc.pdf');
    expect(prisma.aiAnalysis.update).toHaveBeenCalledWith({
      where: { jobId_issueId: { jobId: 'job-1', issueId: 'issue-1' } },
      data: { status: 'applied', updatedAt: expect.any(Date) },
    });
    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', cycleNumber: 5, action: 'apply_fixes', source: 'apply_all', status: 'completed', appliedCount: 1, failedCount: 0 })
    );
  });

  it('queries only approved rows by default, and both approved+pending when includePending is set', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([] as any);

    await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');
    expect(prisma.aiAnalysis.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'approved', applyMode: 'apply-to-pdf' }) })
    );

    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([] as any);
    await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'auto_loop', { includePending: true });
    expect(prisma.aiAnalysis.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['approved', 'pending'] } }) })
    );
  });

  it('reports failed and logs a failed history event when every eligible suggestion fails to apply, without saving a PDF', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: false, error: 'element not found' } as any);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 5, 'user-1', 'apply_all');

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.modifiedBuffer).toBeUndefined();
    expect(pdfModifierService.savePDF).not.toHaveBeenCalled();
    expect(remediationCycleHistoryService.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', appliedCount: 0, failedCount: 1 })
    );
  });

  it('throws when the job does not exist', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);

    await expect(aiAnalysisService.applyApprovedSuggestions('missing-job', 1, 'user-1', 'apply_all'))
      .rejects.toThrow('Job not found');
  });
});
