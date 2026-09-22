/**
 * Regression coverage for pdf-figure-caption-tree.validator.ts: detects a
 * figure caption (/fc, an InDesign "figure caption" paragraph style,
 * wrapped in its own /Story container) that's genuinely tagged in the
 * content stream and correctly cross-referenced in /ParentTree, but never
 * linked into any parent's /K array -- invisible to a top-down reader (a
 * screen reader, or a compliance checker) even though a bottom-up
 * MCID -> StructElem lookup resolves it fine. Confirmed real on
 * Math_Weir_PDF.pdf: 66 of 75 real captions were exactly this shape.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { pdfFigureCaptionTreeValidator } from '../../../../src/services/pdf/validators/pdf-figure-caption-tree.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/**
 * Builds a minimal but real document matching the confirmed live shape:
 *   StructTreeRoot -> Document (K: array)
 *     -> Sect (K: bare, single child) -> Figure (mcid 0)
 *     -> [only when `connected`] Story (K: bare) -> fc (mcid 1)
 * /ParentTree always cross-references BOTH mcid 0 (Figure) and mcid 1 (fc)
 * regardless of `connected` -- that's the whole point: ParentTree
 * resolution and tree reachability are genuinely independent in the real
 * bug this validator exists to catch.
 */
async function buildDoc(opts: { connected: boolean; hierarchicalParentTree?: boolean }): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 0 }));
  const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: figureRef }));

  const fcRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: 1 }));
  const storyRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: fcRef }));

  const docKids = opts.connected ? [sectRef, storyRef] : [sectRef];
  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: docKids });
  const docRef = doc.context.register(docNode);
  // Both Sect and (when connected) Story need a real /P back to Document,
  // matching what a real producer's tagged output always carries.
  doc.context.lookup(sectRef, PDFDict).set(PDFName.of('P'), docRef);
  if (opts.connected) {
    doc.context.lookup(storyRef, PDFDict).set(PDFName.of('P'), docRef);
  }
  doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), sectRef);
  doc.context.lookup(fcRef, PDFDict).set(PDFName.of('P'), storyRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));

  const pageArr = doc.context.obj([figureRef, fcRef]);
  let parentTree;
  if (opts.hierarchicalParentTree) {
    const kid = doc.context.obj({ Limits: [0, 0], Nums: [0, pageArr] });
    const kidRef = doc.context.register(kid);
    parentTree = doc.context.obj({ Kids: [kidRef] });
  } else {
    parentTree = doc.context.obj({ Nums: [0, pageArr] });
  }
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

describe('PdfFigureCaptionTreeValidator', () => {
  it('flags a caption whose /Story is correctly ParentTree-cross-referenced but never linked into the structure tree', async () => {
    const parsedPdf = await buildDoc({ connected: false });

    const result = await pdfFigureCaptionTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCaptions: 1, disconnectedCaptions: 1 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('FIGURE-CAPTION-DISCONNECTED');
    expect(result.issues[0].matterhornCheckpoint).toBe('01-005');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('caption_p1_mc1');
  });

  it('does not flag a caption whose /Story IS reachable from the structure tree root', async () => {
    const parsedPdf = await buildDoc({ connected: true });

    const result = await pdfFigureCaptionTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCaptions: 1, disconnectedCaptions: 0 });
    expect(result.issues).toHaveLength(0);
  });

  it('detects the same disconnection through a hierarchical /Kids-based ParentTree, not just a flat /Nums array', async () => {
    const parsedPdf = await buildDoc({ connected: false, hierarchicalParentTree: true });

    const result = await pdfFigureCaptionTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCaptions: 1, disconnectedCaptions: 1 });
    expect(result.issues[0].element).toBe('caption_p1_mc1');
  });

  it('returns no issues when there is no StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfFigureCaptionTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalCaptions: 0, disconnectedCaptions: 0 });
  });
});
