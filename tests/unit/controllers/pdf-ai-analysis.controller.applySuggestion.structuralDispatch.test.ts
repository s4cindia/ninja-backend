/**
 * PdfAiAnalysisController.applySuggestion -- regression coverage for a gap
 * found live: every suggestionType dispatched in applyApprovedSuggestions'
 * own bulk-apply path in ai-analysis.service.ts (used for "apply all") must
 * also be dispatched here (used for a single per-suggestion "Apply" click),
 * or clicking Apply on that suggestion type falls through to the final
 * value-based branch and throws "This suggestion has no value to apply" --
 * exactly what happened for TOC-STRUCTURE-MISSING's 'toc-structure-fix'
 * suggestion on a real Karsaklian re-run. A comm(1) diff of every
 * `suggestionType === '...'` literal between the two files found the
 * single-apply controller was missing: index-structure-fix, toc-structure-fix
 * (the reported case), plus structure-parent-mismatch-fix,
 * span-illegal-nesting-fix, duplicate-figure-tiles-fix,
 * hyphenated-line-break-fix, rolemap-target-fix, footnote-structure-fix,
 * table-cell-reattach-fix, table-row-reattach-fix,
 * tagged-content-artifact-split-fix, artifact-unwrap-fix,
 * artifact-unwrap-complex-fix, artifact-actualtext-fix,
 * actualtext-missing-mcid-fix, link-missing-annotation-fix,
 * cross-reference-link-fix, toc-link-fix, citation-link-fix,
 * placedpdf-retag-fix, bookmark-title-regenerate, heading-promote-fix, and
 * alt-text-strip-prefix -- all added to the bulk path over time and never
 * mirrored here. This file locks in that every one of them now dispatches
 * to its real fixer instead of hitting the value-required guard.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    aiAnalysis: { findUnique: vi.fn(), update: vi.fn() },
    job: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/pdf/remediation-cycle-lock.service', () => ({
  remediationCycleLockService: {
    acquireLock: vi.fn().mockResolvedValue({ acquired: true, cycleNumber: 1 }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    getRemediatedFile: vi.fn().mockRejectedValue(new Error('no remediated file')),
    getFile: vi.fn().mockResolvedValue(Buffer.from('fake-pdf-bytes')),
    saveRemediatedFile: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/pdf-modifier.service', () => ({
  pdfModifierService: {
    loadPDF: vi.fn().mockResolvedValue({} as any),
    savePDF: vi.fn(),
    setAltText: vi.fn().mockResolvedValue({ success: true, before: 'old alt', after: 'new alt' }),
  },
}));
vi.mock('../../../src/services/pdf/pdf-parser.service', () => ({
  pdfParserService: {
    parseBuffer: vi.fn().mockResolvedValue({ parsedPdf: {} }),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../src/services/pdf/ai-analysis.service', () => ({
  aiAnalysisService: {
    recordApplyFailure: vi.fn().mockResolvedValue(undefined),
  },
  CONTRAST_CODES: new Set(),
}));

const { structResult } = vi.hoisted(() => ({
  structResult: { success: true, before: 'before', after: 'after' },
}));

vi.mock('../../../src/services/pdf/pdf-structure-writer.service', () => ({
  pdfStructureWriterService: {
    fixStructureElementWrongParent: vi.fn().mockReturnValue(structResult),
    fixSpanIllegalNesting: vi.fn().mockReturnValue(structResult),
    fixDuplicateFigureTiles: vi.fn().mockReturnValue(structResult),
    fixHyphenatedLineBreak: vi.fn().mockReturnValue(structResult),
    fixDegenerateRoleMapEntry: vi.fn().mockReturnValue(structResult),
    fixIndexStructure: vi.fn().mockReturnValue(structResult),
    fixTocStructure: vi.fn().mockReturnValue(structResult),
    fixFootnoteStructure: vi.fn().mockReturnValue(structResult),
    fixArtifactSwallowsContentComplex: vi.fn().mockReturnValue(structResult),
    fixArtifactActualTextSibling: vi.fn().mockReturnValue(structResult),
    fixActualTextMissingMcid: vi.fn().mockReturnValue(structResult),
    fixLinkMissingAnnotation: vi.fn().mockReturnValue(structResult),
    fixTocEntryLink: vi.fn().mockReturnValue(structResult),
    fixCitationLink: vi.fn().mockReturnValue(structResult),
    retagPlacedPdfAsFigure: vi.fn().mockReturnValue(structResult),
    reattachTableCell: vi.fn().mockReturnValue([structResult]),
    reattachTableRow: vi.fn().mockReturnValue([structResult]),
    fixTaggedContentInsideArtifact: vi.fn().mockReturnValue([structResult]),
    fixArtifactSwallowsContent: vi.fn().mockReturnValue(structResult),
    fixCrossReferenceLink: vi.fn().mockResolvedValue(structResult),
    fixHeadingPromoteFix: vi.fn().mockReturnValue(structResult),
    regenerateGenericBookmarkTitles: vi.fn().mockResolvedValue({ updated: 1 }),
  },
}));

import prisma from '../../../src/lib/prisma';
import { pdfStructureWriterService } from '../../../src/services/pdf/pdf-structure-writer.service';
import { pdfModifierService } from '../../../src/services/pdf/pdf-modifier.service';
import { pdfAiAnalysisController } from '../../../src/controllers/pdf-ai-analysis.controller';

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(body: Record<string, unknown> = {}): Request {
  return {
    params: { issueId: 'issue-1' },
    body,
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1', output: {} },
  } as unknown as Request;
}

async function run(suggestionType: string, value: string | null = null, body: Record<string, unknown> = {}) {
  vi.mocked(prisma.aiAnalysis.findUnique).mockResolvedValue({
    jobId: 'job-1',
    issueId: 'issue-1',
    suggestionType,
    applyMode: 'apply-to-pdf',
    status: 'pending',
    failedAttempts: 0,
    value,
  } as any);
  vi.mocked(prisma.aiAnalysis.update).mockResolvedValue({ status: 'applied' } as any);
  vi.mocked(prisma.job.findUnique).mockResolvedValue({ id: 'job-1', output: {} } as any);

  const res = makeRes();
  const next = vi.fn() as NextFunction;
  await pdfAiAnalysisController.applySuggestion(makeReq(body), res, next);
  return { res, next };
}

describe('PdfAiAnalysisController.applySuggestion -- structural suggestionType dispatch parity with bulk apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['structure-parent-mismatch-fix', 'fixStructureElementWrongParent'],
    ['span-illegal-nesting-fix', 'fixSpanIllegalNesting'],
    ['duplicate-figure-tiles-fix', 'fixDuplicateFigureTiles'],
    ['hyphenated-line-break-fix', 'fixHyphenatedLineBreak'],
    ['rolemap-target-fix', 'fixDegenerateRoleMapEntry'],
    ['index-structure-fix', 'fixIndexStructure'],
    ['toc-structure-fix', 'fixTocStructure'],
    ['footnote-structure-fix', 'fixFootnoteStructure'],
    ['artifact-unwrap-complex-fix', 'fixArtifactSwallowsContentComplex'],
    ['artifact-actualtext-fix', 'fixArtifactActualTextSibling'],
    ['actualtext-missing-mcid-fix', 'fixActualTextMissingMcid'],
    ['link-missing-annotation-fix', 'fixLinkMissingAnnotation'],
    ['toc-link-fix', 'fixTocEntryLink'],
    ['citation-link-fix', 'fixCitationLink'],
    ['placedpdf-retag-fix', 'retagPlacedPdfAsFigure'],
  ] as const)('dispatches %s to pdfStructureWriterService.%s with no value required', async (suggestionType, method) => {
    const { res, next } = await run(suggestionType, null);

    expect(next).not.toHaveBeenCalled();
    expect((pdfStructureWriterService as any)[method]).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ modification: { success: true, description: 'after', error: undefined } }),
      })
    );
  });

  it.each([
    ['table-cell-reattach-fix', 'reattachTableCell'],
    ['table-row-reattach-fix', 'reattachTableRow'],
    ['tagged-content-artifact-split-fix', 'fixTaggedContentInsideArtifact'],
  ] as const)('dispatches %s to pdfStructureWriterService.%s([originalIssue]) with no value required', async (suggestionType, method) => {
    const { res, next } = await run(suggestionType, null);

    expect(next).not.toHaveBeenCalled();
    expect((pdfStructureWriterService as any)[method]).toHaveBeenCalledTimes(1);
    expect((pdfStructureWriterService as any)[method].mock.calls[0][1]).toEqual([expect.objectContaining({ id: 'issue-1' })]);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ modification: { success: true, description: 'after', error: undefined } }),
      })
    );
  });

  it('dispatches artifact-unwrap-fix with the (possibly undefined) value, not the no-value guard', async () => {
    const { res, next } = await run('artifact-unwrap-fix', null);

    expect(next).not.toHaveBeenCalled();
    expect(pdfStructureWriterService.fixArtifactSwallowsContent).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalled();
  });

  it('dispatches cross-reference-link-fix via an on-demand parse, closing it afterward', async () => {
    const { pdfParserService } = await import('../../../src/services/pdf/pdf-parser.service');
    const { res, next } = await run('cross-reference-link-fix', null);

    expect(next).not.toHaveBeenCalled();
    expect(pdfStructureWriterService.fixCrossReferenceLink).toHaveBeenCalledTimes(1);
    expect(pdfParserService.close).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalled();
  });

  it('dispatches bookmark-title-regenerate document-wide via an on-demand parse', async () => {
    const { res, next } = await run('bookmark-title-regenerate', null);

    expect(next).not.toHaveBeenCalled();
    expect(pdfStructureWriterService.regenerateGenericBookmarkTitles).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalled();
  });

  it('dispatches heading-promote-fix with the AI-inferred level parsed from value', async () => {
    const { res, next } = await run('heading-promote-fix', '2');

    expect(next).not.toHaveBeenCalled();
    expect(pdfStructureWriterService.fixHeadingPromoteFix).toHaveBeenCalledWith(expect.anything(), expect.anything(), 2);
    expect(res.json).toHaveBeenCalled();
  });

  it('dispatches alt-text-strip-prefix straight to setAltText without rebuilding the Figure', async () => {
    const { res, next } = await run('alt-text-strip-prefix', 'stripped alt text');

    expect(next).not.toHaveBeenCalled();
    expect(pdfModifierService.setAltText).toHaveBeenCalledWith(expect.anything(), 'issue-1', 'stripped alt text');
    expect(res.json).toHaveBeenCalled();
  });

  it('still rejects a genuinely unmapped suggestionType with the value-required guard', async () => {
    const { res, next } = await run('some-made-up-type-with-no-fixer', null);

    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as any).mock.calls[0][0].message).toContain('no value to apply');
  });
});
