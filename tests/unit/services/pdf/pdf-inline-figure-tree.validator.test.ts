/**
 * Regression coverage for pdf-inline-figure-tree.validator.ts: detects a
 * small inline /Figure struct element (e.g. an inline math/symbol glyph
 * embedded mid-caption) that's genuinely tagged in the content stream and
 * correctly cross-referenced in /ParentTree, but never linked into any
 * parent's /K array -- invisible to a top-down reader even though a
 * bottom-up MCID -> StructElem lookup resolves it fine. Confirmed real on
 * Math_Weir_PDF.pdf (round 7 PAC report): 8 such /Figure elements across
 * pages 73/136/137, each inside an already-correct, flat /fc caption's own
 * /K array with an exact one-slot gap at its own MCID position.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { pdfInlineFigureTreeValidator } from '../../../../src/services/pdf/validators/pdf-inline-figure-tree.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/**
 * Builds a document matching the confirmed live shape: a caption struct
 * element (/fc) whose own /K is a flat, left-to-right sequence of bare
 * MCID numbers, with an inline /Figure's own MCID either included as a
 * real ref (connected) or left as a gap (disconnected). /ParentTree always
 * cross-references every real MCID regardless of `connected` -- that's the
 * whole point: ParentTree resolution and tree reachability are genuinely
 * independent in the real bug this validator exists to catch.
 */
async function buildDoc(opts: { connected: boolean; hierarchicalParentTree?: boolean }): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1 }));

  const captionKids = opts.connected ? [0, figureRef, 2] : [0, 2];
  const captionRef = doc.context.register(doc.context.obj({ S: PDFName.of('fc'), Pg: page.ref, K: captionKids }));
  if (opts.connected) {
    doc.context.lookup(figureRef, PDFDict).set(PDFName.of('P'), captionRef);
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [captionRef] });
  const docRef = doc.context.register(docNode);
  doc.context.lookup(captionRef, PDFDict).set(PDFName.of('P'), docRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));

  // ParentTree page array: mcid 0 -> caption (bare, direct child), mcid 1
  // -> the /Figure (always cross-referenced, connected or not), mcid 2 ->
  // caption again.
  const pageArr = doc.context.obj([captionRef, figureRef, captionRef]);
  let parentTree;
  if (opts.hierarchicalParentTree) {
    const kid = doc.context.obj({ Limits: [0, 2], Nums: [0, pageArr] });
    const kidRef = doc.context.register(kid);
    parentTree = doc.context.obj({ Kids: [kidRef] });
  } else {
    parentTree = doc.context.obj({ Nums: [0, pageArr] });
  }
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

describe('PdfInlineFigureTreeValidator', () => {
  it('flags an inline /Figure whose MCID is correctly ParentTree-cross-referenced but never linked into any parent\'s /K array', async () => {
    const parsedPdf = await buildDoc({ connected: false });

    const result = await pdfInlineFigureTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalFigures: 1, disconnectedFigures: 1 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('INLINE-FIGURE-DISCONNECTED');
    expect(result.issues[0].matterhornCheckpoint).toBe('01-005');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('figure_p1_mc1');
  });

  it('does not flag an inline /Figure that IS reachable from the structure tree root', async () => {
    const parsedPdf = await buildDoc({ connected: true });

    const result = await pdfInlineFigureTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalFigures: 1, disconnectedFigures: 0 });
    expect(result.issues).toHaveLength(0);
  });

  it('detects the same disconnection through a hierarchical /Kids-based ParentTree, not just a flat /Nums array', async () => {
    const parsedPdf = await buildDoc({ connected: false, hierarchicalParentTree: true });

    const result = await pdfInlineFigureTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalFigures: 1, disconnectedFigures: 1 });
    expect(result.issues[0].element).toBe('figure_p1_mc1');
  });

  it('returns no issues when there is no StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfInlineFigureTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalFigures: 0, disconnectedFigures: 0 });
  });
});
