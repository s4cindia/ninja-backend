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
vi.mock('../../../../src/services/pdf/pdf-comprehensive-parser.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');
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

  it('dispatches the three Tier 1 manual-fix suggestion types to their writer methods with the (possibly operator-edited) value', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'link-1', suggestionType: 'link-text', value: 'Download the 2024 annual report' },
      { issueId: 'form-1', suggestionType: 'form-field-label', value: 'Enter your email address' },
      { issueId: 'bookmark-1', suggestionType: 'bookmark-title', value: 'Introduction to Market Structure' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.setLinkAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.setFormFieldTooltip).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.renameBookmark).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);
    expect(pdfModifierService.setLinkAltText).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'link-1' }),
      'Download the 2024 annual report'
    );
    expect(pdfModifierService.setFormFieldTooltip).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'form-1' }),
      'Enter your email address'
    );
    expect(pdfModifierService.renameBookmark).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'bookmark-1' }),
      'Introduction to Market Structure'
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

  /**
   * Regression for a real bug found live against Math_Kim: markTableAsArtifact
   * renames the /Table struct element itself, which findTargetTable's
   * positional "Nth /Table on this page" indexing depends on staying stable
   * across the whole batch. Calling it once PER ISSUE (as every other
   * structure-writer suggestion type here does) let an earlier same-page fix
   * silently shift the index every later same-page lookup resolved against
   * -- 6 of 49 real cases failed this way. Fixed by collecting every
   * table-artifact-fix issue in this approval run and calling
   * markTableAsArtifact exactly ONCE with all of them, before the main
   * per-suggestion loop processes anything.
   */
  it('batches every table-artifact-fix suggestion into a single markTableAsArtifact call, not one per issue', async () => {
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'table-artifact-1', code: 'MATTERHORN-15-005', element: 'table_p1_0' },
            { id: 'table-artifact-2', code: 'MATTERHORN-15-005', element: 'table_p1_1' },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'table-artifact-1', suggestionType: 'table-artifact-fix' },
      { issueId: 'table-artifact-2', suggestionType: 'table-artifact-fix' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');
    vi.mocked(pdfStructureWriterService.markTableAsArtifact).mockReturnValue([
      { issueId: 'table-artifact-1', success: true, before: 'Table', after: 'Retagged as Artifact' },
      { issueId: 'table-artifact-2', success: true, before: 'Table', after: 'Retagged as Artifact' },
    ]);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfStructureWriterService.markTableAsArtifact).toHaveBeenCalledTimes(1);
    expect(pdfStructureWriterService.markTableAsArtifact).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ id: 'table-artifact-1' }),
        expect.objectContaining({ id: 'table-artifact-2' }),
      ])
    );
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });

  /**
   * Regression for the analogous batching requirement buildTableFromLayout
   * has (Slice 2d, PR #552): calling it once per issue would violate its
   * own single-combined-/ParentTree-commit contract, not just risk index
   * drift the way markTableAsArtifact's did. Also covers the real
   * architectural difference from table-artifact-fix: this batching needs
   * each issue's TableInfo, freshly re-parsed via
   * pdfComprehensiveParserService (not already available from the stored
   * audit report), matched by table.id === issue.element.
   */
  it('batches every table-from-layout-fix suggestion into a single buildTableFromLayout call, not one per issue', async () => {
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'table-layout-1', code: 'MATTERHORN-15-001', element: 'table_p1_0' },
            { id: 'table-layout-2', code: 'MATTERHORN-15-001', element: 'table_p1_1' },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'table-layout-1', suggestionType: 'table-from-layout-fix' },
      { issueId: 'table-layout-2', suggestionType: 'table-from-layout-fix' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');
    const { pdfComprehensiveParserService } = await import('../../../../src/services/pdf/pdf-comprehensive-parser.service');
    const table1 = { id: 'table_p1_0', pageNumber: 1, cells: [] } as any;
    const table2 = { id: 'table_p1_1', pageNumber: 1, cells: [] } as any;
    vi.mocked(pdfComprehensiveParserService.parseBuffer).mockResolvedValue({
      pages: [{ tables: [table1, table2] }],
      parsedPdf: undefined,
    } as any);
    vi.mocked(pdfStructureWriterService.buildTableFromLayout).mockReturnValue([
      { issueId: 'table-layout-1', success: true, before: 'Untagged', after: 'Built Table' },
      { issueId: 'table-layout-2', success: true, before: 'Untagged', after: 'Built Table' },
    ]);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfStructureWriterService.buildTableFromLayout).toHaveBeenCalledTimes(1);
    expect(pdfStructureWriterService.buildTableFromLayout).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ issue: expect.objectContaining({ id: 'table-layout-1' }), table: table1 }),
        expect.objectContaining({ issue: expect.objectContaining({ id: 'table-layout-2' }), table: table2 }),
      ])
    );
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('does not call pdfComprehensiveParserService when no table-from-layout-fix suggestions are in the batch', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfComprehensiveParserService } = await import('../../../../src/services/pdf/pdf-comprehensive-parser.service');

    await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfComprehensiveParserService.parseBuffer).not.toHaveBeenCalled();
  });

  it('throws when the job does not exist', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);

    await expect(aiAnalysisService.applyApprovedSuggestions('missing-job', 1, 'user-1', 'apply_all'))
      .rejects.toThrow('Job not found');
  });
});
