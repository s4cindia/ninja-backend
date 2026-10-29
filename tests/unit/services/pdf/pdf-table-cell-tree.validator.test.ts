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
 *
 * `orphanRow`, when true, matches the OTHER confirmed-real shape (the one
 * reattachTableRow exists to fix): every /TD cell is correctly linked
 * into its /TR's own /K (so TD detection reports nothing), but the /TR
 * itself is left out of its own would-be parent's /K entirely, and has no
 * /P of its own -- a /TR has no MCID, so unlike a disconnected /TD it is
 * invisible to /ParentTree and can only be found by direct enumeration.
 */
async function buildDoc(opts: { connected: boolean; hierarchicalParentTree?: boolean; orphanRow?: boolean }): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const cellCol0 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 0 }));
  const cellCol1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 1 }));
  const cellCol2 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 2 }));

  const trKids = opts.orphanRow || opts.connected ? [cellCol0, cellCol1, cellCol2] : [cellCol0, cellCol2];
  // /Type /StructElem matches the confirmed real-document shape (every
  // StructElem dict in Farrar_2E_Comp_188910.pdf's remediated output sets
  // it) -- the /TR enumeration pass requires it, the same safety filter
  // that keeps it from matching unrelated dicts elsewhere in the file.
  const trRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR'), K: trKids }));
  doc.context.lookup(cellCol0, PDFDict).set(PDFName.of('P'), trRef);
  doc.context.lookup(cellCol2, PDFDict).set(PDFName.of('P'), trRef);
  if (opts.connected || opts.orphanRow) {
    doc.context.lookup(cellCol1, PDFDict).set(PDFName.of('P'), trRef);
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: opts.orphanRow ? [] : [trRef] });
  const docRef = doc.context.register(docNode);
  if (!opts.orphanRow) {
    doc.context.lookup(trRef, PDFDict).set(PDFName.of('P'), docRef);
  }

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

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 1, totalRows: 1, disconnectedRows: 0 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('TABLE-CELL-DISCONNECTED');
    expect(result.issues[0].matterhornCheckpoint).toBe('01-005');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('tablecell_p1_mc1');
  });

  it('does not flag a /TD that IS reachable from the structure tree root', async () => {
    const parsedPdf = await buildDoc({ connected: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 0, totalRows: 1, disconnectedRows: 0 });
    expect(result.issues).toHaveLength(0);
  });

  it('detects the same disconnection through a hierarchical /Kids-based ParentTree, not just a flat /Nums array', async () => {
    const parsedPdf = await buildDoc({ connected: false, hierarchicalParentTree: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 1, totalRows: 1, disconnectedRows: 0 });
    expect(result.issues[0].element).toBe('tablecell_p1_mc1');
  });

  it('returns no issues when there is no StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalCells: 0, disconnectedCells: 0, totalRows: 0, disconnectedRows: 0 });
  });

  it('flags a /TR whose cells are all correctly linked to it, but which is itself missing from its parent\'s own /K array', async () => {
    const parsedPdf = await buildDoc({ connected: true, orphanRow: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    // Reachability is transitive: an orphaned /TR's own TD children are
    // ALSO genuinely unreachable from root (their only path to it is
    // through the orphaned /TR), so the existing /TD /TH pass correctly
    // flags all 3 too -- matching the confirmed real shape where each
    // orphaned row happens to have exactly one TD child, so its own TD
    // and TR issues always come in a 1:1 pair.
    expect(result.metadata).toEqual({ totalCells: 3, disconnectedCells: 3, totalRows: 1, disconnectedRows: 1 });
    const rowIssues = result.issues.filter(i => i.code === 'TABLE-ROW-DISCONNECTED');
    expect(rowIssues).toHaveLength(1);
    expect(rowIssues[0].matterhornCheckpoint).toBe('01-005');
    expect(rowIssues[0].pageNumber).toBe(1);
    // Derived from the row's own first (lowest-MCID) cell, mc0.
    expect(rowIssues[0].element).toBe('tablerow_p1_mc0');
  });

  it('does not flag a /TR that IS reachable from the structure tree root', async () => {
    const parsedPdf = await buildDoc({ connected: true });

    const result = await pdfTableCellTreeValidator.validate(parsedPdf);

    expect(result.issues.filter(i => i.code === 'TABLE-ROW-DISCONNECTED')).toHaveLength(0);
  });
});
