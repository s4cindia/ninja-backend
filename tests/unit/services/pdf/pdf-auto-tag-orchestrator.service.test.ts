/**
 * PdfAutoTagOrchestrator -- extracted from accessibility.processor.ts
 * (2026-10-18) so pdf-batch-orchestrator.service.ts can share the exact
 * same Seam C / Adobe AutoTag decision instead of silently skipping
 * tagging entirely. These tests cover the function directly; the full
 * strip-and-retag / already-tagged branch matrix is also exercised
 * indirectly (and unchanged) via accessibility.processor.test.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import { seamCTagService } from '../../../../src/services/pdf/seam-c-tag.service';
import { adobeAutoTagService } from '../../../../src/services/pdf/adobe-autotag.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { prepareDocumentForRetag } from '../../../../src/services/pdf/strip-marked-content';
import prisma from '../../../../src/lib/prisma';
import { autoTagIfNeeded } from '../../../../src/services/pdf/pdf-auto-tag-orchestrator.service';

vi.mock('../../../../src/services/pdf/seam-c-tag.service');
vi.mock('../../../../src/services/pdf/adobe-autotag.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');
vi.mock('../../../../src/services/storage/file-storage.service');
vi.mock('../../../../src/services/pdf/strip-marked-content');

vi.mock('../../../../src/config/ai.config', () => ({
  aiConfig: { seamC: { enabled: true }, adobe: { enabled: false } },
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalBuffer = Buffer.from('original-pdf-bytes');
const taggedBuffer = Buffer.from('tagged-pdf-bytes');

/**
 * Builds a minimal real pdf-lib document with a StructTreeRoot whose direct
 * children (under /Document) carry the given flat list of /S values, then
 * returns its saved bytes -- same fixture shape as
 * structure-tree-completeness.test.ts's own buildDocWithStructureTree, since
 * this file's new tests now actually exercise checkStructureTreeCompleteness
 * via a real PDFDocument.load, not just the mocked isTagged flag.
 */
async function buildTaggedPdfBytes(types: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const kidRefs: PDFRef[] = types.map((type) => {
    const dict = doc.context.obj({ S: PDFName.of(type), K: 0 });
    return doc.context.register(dict);
  });

  const documentDict = doc.context.obj({
    S: PDFName.of('Document'),
    K: doc.context.register(doc.context.obj(kidRefs)) as unknown as PDFArray,
  });
  const documentRef = doc.context.register(documentDict);

  const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
  const structTreeRootRef = doc.context.register(structTreeRootDict);

  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  return Buffer.from(await doc.save());
}

describe('autoTagIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {} } as any);
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveFile).mockResolvedValue(undefined as any);
  });

  it('tags an untagged PDF via Seam C and returns the tagged buffer', async () => {
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: false } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockResolvedValue({
      taggedPdfBuffer: taggedBuffer,
      reportBuffer: null,
      wordBuffer: null,
      elementCounts: { Figure: 2 },
      parsedFlags: {},
    } as any);

    const result = await autoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf');

    expect(seamCTagService.tagPdf).toHaveBeenCalledWith(originalBuffer, 'job-1');
    expect(adobeAutoTagService.tagPdf).not.toHaveBeenCalled();
    expect(result.auditBuffer).toBe(taggedBuffer);
    expect(result.isTagged).toBe(false);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'complete', taggerSource: 'seam-c' });
  });

  it('skips tagging and returns the original buffer unchanged when the PDF is already tagged', async () => {
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);

    const result = await autoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf');

    expect(seamCTagService.tagPdf).not.toHaveBeenCalled();
    expect(result.auditBuffer).toBe(originalBuffer);
    expect(result.isTagged).toBe(true);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged' });
  });

  it('re-tags an already-tagged PDF when forceAutoTag is set', async () => {
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockResolvedValue({
      taggedPdfBuffer: taggedBuffer,
      reportBuffer: null,
      wordBuffer: null,
      elementCounts: {},
      parsedFlags: {},
    } as any);

    const result = await autoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf', true);

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(1);
    expect(result.auditBuffer).toBe(taggedBuffer);
  });

  it('falls back to Adobe when Seam C fails for a reason other than SEAM_C_ALREADY_TAGGED, if Adobe is enabled', async () => {
    vi.doMock('../../../../src/config/ai.config', () => ({
      aiConfig: { seamC: { enabled: true }, adobe: { enabled: true } },
    }));
    vi.resetModules();
    const { autoTagIfNeeded: freshAutoTagIfNeeded } = await import('../../../../src/services/pdf/pdf-auto-tag-orchestrator.service');
    const { seamCTagService: freshSeamC } = await import('../../../../src/services/pdf/seam-c-tag.service');
    const { adobeAutoTagService: freshAdobe } = await import('../../../../src/services/pdf/adobe-autotag.service');
    const { pdfParserService: freshParser } = await import('../../../../src/services/pdf/pdf-parser.service');

    vi.mocked(freshParser.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: false } } } as any);
    vi.mocked(freshParser.close).mockResolvedValue(undefined as any);
    vi.mocked(freshSeamC.tagPdf).mockRejectedValue(new Error('Seam C service unreachable'));
    vi.mocked(freshAdobe.tagPdf).mockResolvedValue({
      taggedPdfBuffer: taggedBuffer,
      reportBuffer: null,
      wordBuffer: null,
      elementCounts: {},
      parsedFlags: {},
    } as any);

    const result = await freshAutoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf');

    expect(freshAdobe.tagPdf).toHaveBeenCalledTimes(1);
    expect(result.auditBuffer).toBe(taggedBuffer);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'complete', taggerSource: 'adobe' });

    vi.doUnmock('../../../../src/config/ai.config');
  });

  it("doesn't retry Seam C and proceeds with the existing structure when it refuses via SEAM_C_ALREADY_TAGGED", async () => {
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockRejectedValue(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'));

    const result = await autoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf', true);

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(1); // primary attempt only -- no retry
    expect(result.auditBuffer).toBe(originalBuffer);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged' });
  });

  /**
   * Real incident (Math_Olszewski_PDF.pdf, 2026-10-21): this document sets
   * /MarkInfo /Marked (isTagged=true) but its structure tree is a complete
   * empty shell -- 415 elements, 0 semantically typed (no Figure/P/H/Table).
   * Before this fix, that strip-and-retag path only ever ran for
   * forceAutoTag (Comparison Study trials) -- a regular upload like this one
   * never got real tagging on any production path. ~500 alt-text
   * suggestions failed with "no Figure elements" as a direct result.
   */
  it('strip-and-retags an isEmptyShell document even without forceAutoTag -- the regression this fix is for', async () => {
    const emptyShellBytes = await buildTaggedPdfBytes(['Div', 'Part']);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf)
      .mockRejectedValueOnce(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'))
      .mockResolvedValueOnce({
        taggedPdfBuffer: taggedBuffer,
        reportBuffer: null,
        wordBuffer: null,
        elementCounts: { Figure: 3 },
        parsedFlags: {},
      } as any);
    vi.mocked(prepareDocumentForRetag).mockReturnValue({ success: true, pagesStripped: 1, totalPages: 1, bailedOnPage: null });

    const result = await autoTagIfNeeded(emptyShellBytes, 'job-1', 'doc.pdf');

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(2); // primary attempt, then the strip-and-retag retry
    expect(result.auditBuffer).toBe(taggedBuffer);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'complete', taggerSource: 'seam-c', retagOutcome: 'success' });
  });

  /**
   * Scope decision: isHeadingShell (real content tags exist, just zero
   * heading tags) gets the SAME treatment as isEmptyShell -- both are safe
   * by construction via prepareDocumentForRetag's own all-or-nothing bail.
   */
  it('strip-and-retags an isHeadingShell document even without forceAutoTag', async () => {
    const headingShellBytes = await buildTaggedPdfBytes(['Figure', 'P']); // real content, zero headings
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf)
      .mockRejectedValueOnce(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'))
      .mockResolvedValueOnce({
        taggedPdfBuffer: taggedBuffer,
        reportBuffer: null,
        wordBuffer: null,
        elementCounts: { H1: 2 },
        parsedFlags: {},
      } as any);
    vi.mocked(prepareDocumentForRetag).mockReturnValue({ success: true, pagesStripped: 1, totalPages: 1, bailedOnPage: null });

    const result = await autoTagIfNeeded(headingShellBytes, 'job-1', 'doc.pdf');

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(2);
    expect(result.auditBuffer).toBe(taggedBuffer);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'complete', taggerSource: 'seam-c', retagOutcome: 'success' });
  });

  it('does NOT attempt tagging at all for a genuinely well-tagged document (real content types including a heading) -- no regression', async () => {
    // Unlike the isEmptyShell/isHeadingShell cases above, this document
    // clears both completeness bars upfront, so shouldAutoTag is false from
    // the start -- Seam C is never even attempted, let alone retried.
    const wellTaggedBytes = await buildTaggedPdfBytes(['Figure', 'P', 'H1']);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);

    const result = await autoTagIfNeeded(wellTaggedBytes, 'job-1', 'doc.pdf');

    expect(seamCTagService.tagPdf).not.toHaveBeenCalled();
    expect(prepareDocumentForRetag).not.toHaveBeenCalled();
    expect(result.auditBuffer).toBe(wellTaggedBytes);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'skipped', autoTagSkipReason: 'already-tagged' });
  });

  it('skips tagging with no-tagger-configured when neither Seam C nor Adobe is enabled', async () => {
    vi.doMock('../../../../src/config/ai.config', () => ({
      aiConfig: { seamC: { enabled: false }, adobe: { enabled: false } },
    }));
    vi.resetModules();
    const { autoTagIfNeeded: freshAutoTagIfNeeded } = await import('../../../../src/services/pdf/pdf-auto-tag-orchestrator.service');
    const { seamCTagService: freshSeamC } = await import('../../../../src/services/pdf/seam-c-tag.service');
    const { pdfParserService: freshParser } = await import('../../../../src/services/pdf/pdf-parser.service');

    vi.mocked(freshParser.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: false } } } as any);
    vi.mocked(freshParser.close).mockResolvedValue(undefined as any);

    const result = await freshAutoTagIfNeeded(originalBuffer, 'job-1', 'doc.pdf');

    expect(freshSeamC.tagPdf).not.toHaveBeenCalled();
    expect(result.auditBuffer).toBe(originalBuffer);
    expect(result.autoTagMeta).toMatchObject({ autoTagStatus: 'skipped', autoTagSkipReason: 'no-tagger-configured' });

    vi.doUnmock('../../../../src/config/ai.config');
  });
});
