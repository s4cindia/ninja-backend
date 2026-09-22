/**
 * Regression coverage for reattachInlineFigure (Matterhorn 01-005 fix): a
 * small inline /Figure struct element (e.g. an inline math/symbol glyph
 * embedded mid-caption) that's genuinely tagged in the content stream and
 * correctly cross-referenced in /ParentTree, but never linked into any
 * parent's /K array. See pdf-inline-figure-tree.validator.ts's own header
 * comment for the real, confirmed shape on Math_Weir_PDF.pdf: 8 real cases,
 * each sitting inside an already-correct, flat /fc caption /K array with an
 * exact one-slot gap at the disconnected Figure's own MCID position, where
 * the MCID immediately before and immediately after the gap both resolve
 * to the SAME containing struct element.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueFor(elementId: string, pageNumber = 1): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-inline-figure-tree',
    severity: 'serious',
    code: 'INLINE-FIGURE-DISCONNECTED',
    message: 'Inline figure not reachable from the structure tree',
    wcagCriteria: ['1.3.1'],
    location: elementId,
    suggestion: 'Reattach the figure',
    category: 'structure',
    element: elementId,
    pageNumber,
  } as AuditIssue;
}

/**
 * Builds a document with a caption (/fc) struct element whose own /K is a
 * flat sequence of bare MCID numbers [0, 1, 2, 3, 4], and a /Figure struct
 * element at MCID 2 -- included in the caption's own /K (connected) or
 * left as a gap (disconnected). The page's real /ParentTree page array
 * always cross-references every real MCID including the Figure's own,
 * regardless of `connected` -- matching the real, confirmed bug shape.
 */
async function buildDoc(opts: {
  connected: boolean;
  figureMcid?: number;
  differentRightContainer?: boolean;
}): Promise<{ doc: PDFDocument; figureRef: PDFRef; captionRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const figureMcid = opts.figureMcid ?? 2;
  const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: figureMcid }));

  const mcidSlots = [0, 1, 2, 3, 4];
  const captionK: Array<number | PDFRef> = mcidSlots
    .filter(m => opts.connected || m !== figureMcid)
    .map(m => (opts.connected && m === figureMcid ? figureRef : m));
  const captionRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: captionK }));
  if (opts.connected) {
    doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), captionRef);
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [captionRef] });
  const docRef = doc.context.register(docNode);
  doc.context.lookup(captionRef, PDFDict).set(PDFName.of('P'), docRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));

  // Real ParentTree page array: index = mcid, value = the real struct
  // element ref. The disconnected Figure is still fully cross-referenced
  // here regardless of `connected` -- that's the whole point of the bug.
  const pageArrEntries: PDFRef[] = mcidSlots.map(m => (m === figureMcid ? figureRef : captionRef));
  if (opts.differentRightContainer) {
    // A second, unrelated container -- simulates the "left/right neighbors
    // belong to different containers" decline case.
    const otherRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: [3, 4] }));
    pageArrEntries[figureMcid + 1] = otherRef;
  }
  const pageArr = doc.context.obj(pageArrEntries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, figureRef, captionRef };
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

describe('PdfStructureWriterService.reattachInlineFigure', () => {
  it('splices the figure into its enclosing caption\'s own /K array immediately after the left-neighbor MCID', async () => {
    const { doc, figureRef, captionRef } = await buildDoc({ connected: false, figureMcid: 2 });

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc2')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('immediately after MCID 1');

    const kids = kidsOf(doc, captionRef);
    // Expected order: [0, 1, figureRef, 2, 3, 4]
    const figureIdx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === figureRef.objectNumber);
    expect(figureIdx).toBe(2);

    const figureDict = doc.context.lookup(figureRef, PDFDict);
    expect(figureDict.get(PDFName.of('P'))?.toString()).toBe(captionRef.toString());
  });

  it('is idempotent: a figure already correctly attached reports success without double-inserting', async () => {
    const { doc, figureRef, captionRef } = await buildDoc({ connected: true, figureMcid: 2 });

    const before = kidsOf(doc, captionRef).length;
    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc2')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('already attached');
    expect(kidsOf(doc, captionRef).length).toBe(before);
    const occurrences = kidsOf(doc, captionRef).filter(k => k instanceof PDFRef && k.objectNumber === figureRef.objectNumber).length;
    expect(occurrences).toBe(1);
  });

  it('declines when the figure already has a /P but that parent does not reference it back', async () => {
    const { doc, figureRef, captionRef } = await buildDoc({ connected: false, figureMcid: 2 });
    // Simulate an unexpected state: /P set, but never actually added to that parent's /K.
    doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), captionRef);

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc2')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('does not reference it back');
  });

  it('declines when there is no left MCID neighbor to anchor reattachment', async () => {
    const { doc } = await buildDoc({ connected: false, figureMcid: 0 });

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc0')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No left and/or right MCID neighbor');
  });

  it('declines when the left and right MCID neighbors belong to different containers, rather than guessing', async () => {
    const { doc } = await buildDoc({ connected: false, figureMcid: 2, differentRightContainer: true });

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc2')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('different containers');
  });

  it('fails cleanly when the element id does not match the expected format', async () => {
    const { doc } = await buildDoc({ connected: false });

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('not-a-real-id')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Unrecognized element id');
  });

  it('fails cleanly when no struct element exists at the target MCID', async () => {
    const { doc } = await buildDoc({ connected: false, figureMcid: 2 });

    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc99')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No struct element found');
  });

  it('fails cleanly when the struct element at the target MCID is not a /Figure', async () => {
    const { doc } = await buildDoc({ connected: false, figureMcid: 2 });
    // MCID 1 resolves to the /fc caption itself, not a /Figure (MCID 0
    // has no left neighbor, which would fail for a different reason).
    const results = pdfStructureWriterService.reattachInlineFigure(doc, [issueFor('figure_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not /Figure');
  });
});
