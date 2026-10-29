/**
 * Regression coverage for pdf-table-cell-tree.validator.ts: detects a /TD
 * or /TH table-cell struct element that's genuinely tagged in the content
 * stream and correctly cross-referenced in /ParentTree, but never linked
 * into its row's own /K array -- invisible to a top-down reader even
 * though a bottom-up MCID -> StructElem lookup resolves it fine. Same
 * disconnection shape as pdf-figure-caption-tree.validator.ts/
 * pdf-inline-figure-tree.validator.ts, confirmed real via direct
 * struct-tree inspection of Farrar_2E_Comp_188910.pdf: 5 such /TD elements
 * across 5 different pages/tables.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { pdfTableCellTreeValidator } from '../../../../src/services/pdf/validators/pdf-table-cell-tree.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/**
 * Builds a document matching the confirmed live shape: a /TR struct
 * element whose own /K holds TD struct-element refs (column order), with
 * one cell's own ref either included (connected) or left as a gap
 * (disconnected). /ParentTree always cross-references every real MCID
 * regardless of `connected`.
 */
async function buildDoc(opts: { connected: boolean; hierarchicalParentTree?: boolean }): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const cellCol0 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 0 }));
  const cellCol1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 1 }));
  const cellCol2 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 2 }));

  const trKids = opts.connected ? [cellCol0, cellCol1, cellCol2] : [cellCol0, cellCol2];
  const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), Pg: page.ref, K: trKids }));
  doc.context.lookup(cellCol0, PDFDict).set(PDFName.of('P'), trRef);
  doc.context.lookup(cellCol2, PDFDict).set(PDFName.of('P'), trRef);
  if (opts.connected) {
    doc.context.lookup(cellCol1, PDFDict).set(PDFName.of('P'), trRef);
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [trRef] });
  const docRef = doc.context.register(docNode);
  doc.context.lookup(trRef, PDFDict).set(PDFName.of('P'), docRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));

  // ParentTree page array: mcid 0/1/2 -> their own cell, always
  // cross-referenced regardless of `connected`.
  const pageArr = doc.context.obj([cellCol0, cellCol1, cellCol2]);
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

describe('PdfTableCellTreeValidator', () => {
  it('flags a /TD whose MCID is correctly ParentTree-cross-referenced but never linked into its row\'s own /K array', async () => {
    const parsedPdf = await buildDoc({ connected: false });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 1 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('TABLE-CELL-DISCONNECTED');
    expect(result.issues[0].matterhornCheckpoint).toBe('01-005');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('tablecell_p1_mc1');
  });

  it('does not flag a /TD that IS reachable from the structure tree root', async () => {
    const parsedPdf = await buildDoc({ connected: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 0 });
    expect(result.issues).toHaveLength(0);
  });

  it('detects the same disconnection through a hierarchical /Kids-based ParentTree, not just a flat /Nums array', async () => {
    const parsedPdf = await buildDoc({ connected: false, hierarchicalParentTree: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 1 });
    expect(result.issues[0].element).toBe('tablecell_p1_mc1');
  });

  it('returns no issues when there is no StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalCells: 0, disconnectedCells: 0 });
  });
});
