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
vi.mock('../../../../src/services/pdf/image-extractor.service');
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
    // A Figure already resolves for this image -- ensureFigureForImages's
    // buildFigureFromImage prerequisite is a no-op, not exercised by this test.
    vi.mocked(pdfModifierService.resolveFigureForImage).mockReturnValue({} as any);
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
    vi.mocked(pdfModifierService.resolveFigureForImage).mockReturnValue({} as any);
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
    // resolveTableTargets isn't mocked with an explicit return value in this
    // test (it's not what this test is about -- see the mixed-same-page
    // test below for that), so the auto-mock returns undefined; asserted
    // explicitly here so this test still documents the real 3-argument call
    // shape rather than silently passing on an unchecked extra argument.
    expect(pdfStructureWriterService.markTableAsArtifact).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ id: 'table-artifact-1' }),
        expect.objectContaining({ id: 'table-artifact-2' }),
      ]),
      undefined
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
    // See the mixed-same-page test below for the actual preResolvedTargets
    // behavior -- this test isn't about that, so resolveTableTargets is left
    // on its auto-mock default (undefined), asserted explicitly rather than
    // silently passing on an unchecked extra argument.
    expect(pdfStructureWriterService.buildTableFromLayout).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ issue: expect.objectContaining({ id: 'table-layout-1' }), table: table1 }),
        expect.objectContaining({ issue: expect.objectContaining({ id: 'table-layout-2' }), table: table2 }),
      ]),
      undefined
    );
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });

  /**
   * Regression for a real cross-batch finding on PR #554: markTableAsArtifact
   * and buildTableFromLayout each independently rename some /Table element to
   * /Artifact as part of their own operation. Both batches used to resolve
   * their own targets via their own internal findTargetTable call, at
   * whatever moment each batch ran -- so a page with BOTH suggestion types
   * would have its table-from-layout-fix entries resolved against a tree
   * table-artifact-fix's own batch had already shifted (or vice versa, since
   * both writers eventually rename something -- reordering doesn't fix it).
   * Fixed by resolving both batches' targets together, in ONE
   * resolveTableTargets call, before either writer runs, then passing that
   * SAME resolved map into both.
   */
  it('resolves table-artifact-fix and table-from-layout-fix targets together, from the same pre-mutation tree, before either writer runs', async () => {
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'table-artifact-1', code: 'MATTERHORN-15-005', element: 'table_p1_0' },
            { id: 'table-layout-1', code: 'MATTERHORN-15-001', element: 'table_p1_1' },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'table-artifact-1', suggestionType: 'table-artifact-fix' },
      { issueId: 'table-layout-1', suggestionType: 'table-from-layout-fix' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');
    const { pdfComprehensiveParserService } = await import('../../../../src/services/pdf/pdf-comprehensive-parser.service');
    const table1 = { id: 'table_p1_1', pageNumber: 1, cells: [] } as any;
    vi.mocked(pdfComprehensiveParserService.parseBuffer).mockResolvedValue({
      pages: [{ tables: [table1] }],
      parsedPdf: undefined,
    } as any);

    const preResolved = new Map([
      ['table-artifact-1', { dict: 'artifact-target-dict', ref: 'artifact-target-ref' }],
      ['table-layout-1', { dict: 'layout-target-dict', ref: 'layout-target-ref' }],
    ]) as any;
    vi.mocked(pdfStructureWriterService.resolveTableTargets).mockReturnValue(preResolved);
    vi.mocked(pdfStructureWriterService.markTableAsArtifact).mockReturnValue([
      { issueId: 'table-artifact-1', success: true, before: 'Table', after: 'Retagged as Artifact' },
    ]);
    vi.mocked(pdfStructureWriterService.buildTableFromLayout).mockReturnValue([
      { issueId: 'table-layout-1', success: true, before: 'Untagged', after: 'Built Table' },
    ]);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    // resolveTableTargets got BOTH issues, combined, in one call.
    expect(pdfStructureWriterService.resolveTableTargets).toHaveBeenCalledTimes(1);
    expect(pdfStructureWriterService.resolveTableTargets).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ id: 'table-artifact-1' }),
        expect.objectContaining({ id: 'table-layout-1' }),
      ])
    );

    // Both writers received the SAME pre-resolved map as their third arg.
    expect(pdfStructureWriterService.markTableAsArtifact).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([expect.objectContaining({ id: 'table-artifact-1' })]),
      preResolved
    );
    expect(pdfStructureWriterService.buildTableFromLayout).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([expect.objectContaining({ issue: expect.objectContaining({ id: 'table-layout-1' }) })]),
      preResolved
    );

    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('includes table-header-fix and table-header-fix-column issues in the SAME pre-resolution pass as table-artifact-fix/table-from-layout-fix', async () => {
    // CodeRabbit finding on PR #560, confirmed real: the two new
    // suggestion types this PR adds also resolve their target /Table
    // positionally (findTargetTable), so they're exposed to the identical
    // cross-batch drift risk PR #554 already fixed for the artifact/layout
    // pair -- they must be resolved from the SAME pre-mutation tree too.
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'table-artifact-1', code: 'MATTERHORN-15-005', element: 'table_p1_0' },
            { id: 'table-header-1', code: 'MATTERHORN-15-002', element: 'table_p1_1' },
            { id: 'table-header-col-1', code: 'MATTERHORN-15-002', element: 'table_p1_2' },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'table-artifact-1', suggestionType: 'table-artifact-fix' },
      { issueId: 'table-header-1', suggestionType: 'table-header-fix' },
      { issueId: 'table-header-col-1', suggestionType: 'table-header-fix-column' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');

    const preResolved = new Map([
      ['table-artifact-1', { dict: 'artifact-target-dict', ref: 'artifact-target-ref' }],
      ['table-header-1', { dict: 'header-target-dict', ref: 'header-target-ref' }],
      ['table-header-col-1', { dict: 'header-col-target-dict', ref: 'header-col-target-ref' }],
    ]) as any;
    vi.mocked(pdfStructureWriterService.resolveTableTargets).mockReturnValue(preResolved);
    vi.mocked(pdfStructureWriterService.markTableAsArtifact).mockReturnValue([
      { issueId: 'table-artifact-1', success: true, before: 'Table', after: 'Retagged as Artifact' },
    ]);
    vi.mocked(pdfStructureWriterService.fixSimpleTableHeaders).mockReturnValue([
      { issueId: 'table-header-1', success: true, before: 'TD', after: 'Promoted to TH' },
    ]);
    vi.mocked(pdfStructureWriterService.fixSimpleTableColumnHeaders).mockReturnValue([
      { issueId: 'table-header-col-1', success: true, before: 'TD', after: 'Promoted to TH' },
    ]);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    // resolveTableTargets got ALL THREE issues, combined, in one call.
    expect(pdfStructureWriterService.resolveTableTargets).toHaveBeenCalledTimes(1);
    expect(pdfStructureWriterService.resolveTableTargets).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ id: 'table-artifact-1' }),
        expect.objectContaining({ id: 'table-header-1' }),
        expect.objectContaining({ id: 'table-header-col-1' }),
      ])
    );

    // Both new writers received the SAME pre-resolved map as their third arg.
    expect(pdfStructureWriterService.fixSimpleTableHeaders).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([expect.objectContaining({ id: 'table-header-1' })]),
      preResolved
    );
    expect(pdfStructureWriterService.fixSimpleTableColumnHeaders).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([expect.objectContaining({ id: 'table-header-col-1' })]),
      preResolved
    );

    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);
  });

  // CodeRabbit finding on PR #563, confirmed real: resolveColorContrastTargets's
  // ordinal-pairing mechanism needs to see every issue mapped to a shared
  // run/line-cluster, not just the ones a user happened to approve in this
  // run -- rebuilding the batch from only "approved" issues means approving
  // one half of a two-issue cluster leaves the resolver seeing 1 target
  // against 2 real slots, a genuine count mismatch that silently fails an
  // approval the suggestion step already confirmed was eligible.
  it('resolves color-contrast-fix using ALL sibling contrast issues from the audit report, not just the approved subset', async () => {
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'contrast-1', code: 'COLOR-CONTRAST', pageNumber: 1, contrastData: { foreground: '#ff0000', background: '#ffffff', ratio: 3.7, requiredRatio: 4.5, isLargeText: false } },
            { id: 'contrast-2', code: 'COLOR-CONTRAST', pageNumber: 1, contrastData: { foreground: '#000000', background: '#ffffff', ratio: 2.1, requiredRatio: 4.5, isLargeText: false } },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    // Only contrast-1 is approved -- contrast-2 is its sibling on the same
    // page/cluster but was never approved in this run.
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'contrast-1', suggestionType: 'color-contrast-fix', value: '#cc0000' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfContrastWriterService, resolveColorContrastTargets } = await import('../../../../src/services/pdf/pdf-contrast-writer.service');
    vi.mocked(resolveColorContrastTargets).mockReturnValue(new Map());
    vi.mocked(pdfContrastWriterService.fixColorContrast).mockResolvedValue({ issueId: 'contrast-1', success: true, before: 'a', after: 'b' });

    await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(resolveColorContrastTargets).toHaveBeenCalledWith(
      {},
      expect.arrayContaining([
        expect.objectContaining({ id: 'contrast-1' }),
        expect.objectContaining({ id: 'contrast-2' }),
      ])
    );
  });

  // CodeRabbit finding on PR #563, confirmed real: a successful contrast fix
  // rewrites the page's content stream (spliceColorFix inserts/replaces
  // bytes, commonly changing length), silently invalidating every OTHER
  // same-page match's precomputed byte offsets for the rest of the batch.
  it('re-resolves color-contrast matches after a successful same-page fix, instead of reusing stale offsets for the next one', async () => {
    const jobWithIssues = {
      id: 'job-1',
      output: {
        fileName: 'doc.pdf',
        auditReport: {
          issues: [
            { id: 'contrast-1', code: 'COLOR-CONTRAST', pageNumber: 1, contrastData: { foreground: '#ff0000', background: '#ffffff', ratio: 3.7, requiredRatio: 4.5, isLargeText: false } },
            { id: 'contrast-2', code: 'COLOR-CONTRAST', pageNumber: 1, contrastData: { foreground: '#000000', background: '#ffffff', ratio: 2.1, requiredRatio: 4.5, isLargeText: false } },
          ],
        },
      },
    };
    vi.mocked(prisma.job.findUnique).mockResolvedValue(jobWithIssues as any);
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'contrast-1', suggestionType: 'color-contrast-fix', value: '#cc0000' },
      { issueId: 'contrast-2', suggestionType: 'color-contrast-fix', value: '#111111' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfContrastWriterService, resolveColorContrastTargets } = await import('../../../../src/services/pdf/pdf-contrast-writer.service');
    vi.mocked(resolveColorContrastTargets).mockReturnValue(new Map());
    vi.mocked(pdfContrastWriterService.fixColorContrast)
      .mockResolvedValueOnce({ issueId: 'contrast-1', success: true, before: 'a', after: 'b' })
      .mockResolvedValueOnce({ issueId: 'contrast-2', success: true, before: 'c', after: 'd' });

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    // Once upfront, then again before the SECOND same-page fix (which comes
    // after the first one already succeeded) -- never reusing offsets
    // computed against a page that's since been rewritten.
    expect(resolveColorContrastTargets).toHaveBeenCalledTimes(2);
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('does not call pdfComprehensiveParserService when no table-from-layout-fix suggestions are in the batch', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.resolveFigureForImage).mockReturnValue({} as any);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfComprehensiveParserService } = await import('../../../../src/services/pdf/pdf-comprehensive-parser.service');

    await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfComprehensiveParserService.parseBuffer).not.toHaveBeenCalled();
  });

  /**
   * Part 2 of the alt-text correlation/dispatch fix: a genuinely-untagged
   * image has no /Figure for setAltText to target at all. Before this,
   * setAltText would just fail honestly ("No Figure element..."), leaving
   * the suggestion permanently inapplicable. Now buildFigureFromImage runs
   * FIRST (batched, via ensureFigureForImages), building the missing Figure
   * so setAltText's own existing resolution can find it.
   */
  it('builds a missing Figure via buildFigureFromImage before applying an alt-text suggestion whose image has none', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    // No Figure resolves for this image yet -- must trigger the prerequisite build.
    vi.mocked(pdfModifierService.resolveFigureForImage).mockReturnValue(null);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfParserService } = await import('../../../../src/services/pdf/pdf-parser.service');
    const { imageExtractorService } = await import('../../../../src/services/pdf/image-extractor.service');
    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');
    const parsedPdf = { fake: 'parsed-pdf' } as any;
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue(parsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined as any);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue({
      pages: [{
        pageNumber: 1,
        totalImages: 1,
        images: [{ id: 'issue-1', pageNumber: 1, index: 0, position: { x: 10, y: 20, width: 30, height: 40 } } as any],
      }],
      totalImages: 1,
      imageFormats: {},
      imagesWithAltText: 0,
      imagesWithoutAltText: 1,
      decorativeImages: 0,
    } as any);
    vi.mocked(pdfStructureWriterService.buildFigureFromImage).mockResolvedValue([
      { issueId: 'issue-1', success: true, before: 'Untagged', after: 'Built Figure' },
    ]);

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfParserService.parseBuffer).toHaveBeenCalledTimes(1);
    expect(imageExtractorService.extractImages).toHaveBeenCalledWith(parsedPdf, expect.objectContaining({ minWidth: 1, minHeight: 1 }));
    expect(pdfStructureWriterService.buildFigureFromImage).toHaveBeenCalledTimes(1);
    expect(pdfStructureWriterService.buildFigureFromImage).toHaveBeenCalledWith(
      {},
      parsedPdf,
      [{ imageId: 'issue-1', pageNumber: 1, position: { x: 10, y: 20, width: 30, height: 40 } }]
    );
    expect(pdfParserService.close).toHaveBeenCalledWith(parsedPdf);
    // buildFigureFromImage ran BEFORE setAltText, and setAltText still went ahead.
    expect(pdfModifierService.setAltText).toHaveBeenCalledWith({}, 'issue-1', 'A red apple');
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('does not call buildFigureFromImage when the alt-text suggestion\'s image already has a resolvable Figure', async () => {
    vi.mocked(prisma.aiAnalysis.findMany).mockResolvedValue([
      { issueId: 'issue-1', suggestionType: 'alt-text', value: 'A red apple' },
    ] as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(pdfModifierService.loadPDF).mockResolvedValue({} as any);
    vi.mocked(pdfModifierService.resolveFigureForImage).mockReturnValue({ fake: 'figure-dict' } as any);
    vi.mocked(pdfModifierService.setAltText).mockResolvedValue({ success: true, description: 'set' } as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('modified-pdf'));
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('s3://remediated/doc.pdf');

    const { pdfParserService } = await import('../../../../src/services/pdf/pdf-parser.service');
    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');

    const result = await aiAnalysisService.applyApprovedSuggestions('job-1', 1, 'user-1', 'apply_all');

    expect(pdfParserService.parseBuffer).not.toHaveBeenCalled();
    expect(pdfStructureWriterService.buildFigureFromImage).not.toHaveBeenCalled();
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('throws when the job does not exist', async () => {
    vi.mocked(prisma.job.findUnique).mockResolvedValue(null as any);

    await expect(aiAnalysisService.applyApprovedSuggestions('missing-job', 1, 'user-1', 'apply_all'))
      .rejects.toThrow('Job not found');
  });
});
