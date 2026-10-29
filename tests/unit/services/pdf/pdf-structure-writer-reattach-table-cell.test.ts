/**
 * Regression coverage for reattachTableCell (Matterhorn 01-005 fix): a /TD
 * or /TH table-cell struct element that's genuinely tagged in the content
 * stream and correctly cross-referenced in /ParentTree, but never linked
 * into its row's own /K array. See pdf-table-cell-tree.validator.ts's own
 * header comment for the real, confirmed shape on
 * Farrar_2E_Comp_188910.pdf: 5 real cases, each with a clean one-slot gap
 * at the disconnected cell's own MCID position.
 *
 * Unlike reattachInlineFigure (its closest sibling, whose own test file
 * this one's buildDoc() helper mirrors the shape of), a table cell owns
 * its OWN MCID -- adjacent cells in the same row are naturally DIFFERENT
 * struct elements, not a shared owner the way an /fc caption's flat /K
 * array of bare numbers is. So the container (the /TR) is derived by
 * following each neighbor CELL's own /P, not by requiring the neighbors
 * themselves to be identical.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueFor(elementId: string, pageNumber = 1): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-table-cell-tree',
    severity: 'serious',
    code: 'TABLE-CELL-DISCONNECTED',
    message: 'Table cell not reachable from the structure tree',
    wcagCriteria: ['1.3.1'],
    location: elementId,
    suggestion: 'Reattach the cell',
    category: 'structure',
    element: elementId,
    pageNumber,
  } as AuditIssue;
}

/**
 * Builds a single table row of `numColumns` /TD cells, each with its own
 * bare MCID [0..numColumns-1], under one /TR. `cellMcid`'s own cell is the
 * one under test -- included in the /TR's own /K (connected) or omitted
 * (disconnected), with its own /P set only when connected. The page's real
 * /ParentTree page array always cross-references every cell by its own
 * MCID regardless of `connected` -- matching the real, confirmed bug shape.
 */
async function buildDoc(opts: {
  connected: boolean;
  cellMcid?: number;
  numColumns?: number;
}): Promise<{ doc: PDFDocument; cellRef: PDFRef; trRef: PDFRef; cellRefs: PDFRef[] }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const numColumns = opts.numColumns ?? 3;
  const cellMcid = opts.cellMcid ?? 1;

  const cellRefs: PDFRef[] = [];
  for (let col = 0; col < numColumns; col++) {
    cellRefs.push(doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: col })));
  }

  const trK = cellRefs.filter((_, col) => opts.connected || col !== cellMcid);
  const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), Pg: page.ref, K: trK }));
  for (let col = 0; col < numColumns; col++) {
    if (opts.connected || col !== cellMcid) {
      doc.context.lookup(cellRefs[col], PDFDict).set(PDFName.of('P'), trRef);
    }
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [trRef] });
  const docRef = doc.context.register(docNode);
  doc.context.lookup(trRef, PDFDict).set(PDFName.of('P'), docRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));

  const pageArr = doc.context.obj(cellRefs.slice());
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, cellRef: cellRefs[cellMcid], trRef, cellRefs };
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

describe('PdfStructureWriterService.reattachTableCell', () => {
  it('splices a middle-column cell into its row\'s own /K array between its left and right siblings', async () => {
    const { doc, cellRef, trRef } = await buildDoc({ connected: false, cellMcid: 1, numColumns: 3 });

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, trRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === cellRef.objectNumber);
    expect(idx).toBe(1); // between column 0 and column 2

    const cellDict = doc.context.lookup(cellRef, PDFDict);
    expect(cellDict.get(PDFName.of('P'))?.toString()).toBe(trRef.toString());
  });

  it('inserts at the start of the row when the orphan is the first column (no left neighbor, right neighbor resolves to the /TR)', async () => {
    const { doc, cellRef, trRef } = await buildDoc({ connected: false, cellMcid: 0, numColumns: 3 });

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc0')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, trRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === cellRef.objectNumber);
    expect(idx).toBe(0);
  });

  it('inserts at the end of the row when the orphan is the last column (no right neighbor, left neighbor resolves to the /TR)', async () => {
    const { doc, cellRef, trRef } = await buildDoc({ connected: false, cellMcid: 2, numColumns: 3 });

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc2')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, trRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === cellRef.objectNumber);
    expect(idx).toBe(kids.length - 1);
  });

  it('is idempotent: a cell already correctly attached reports success without double-inserting', async () => {
    const { doc, cellRef, trRef } = await buildDoc({ connected: true, cellMcid: 1, numColumns: 3 });

    const before = kidsOf(doc, trRef).length;
    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('already attached');
    expect(kidsOf(doc, trRef).length).toBe(before);
    const occurrences = kidsOf(doc, trRef).filter(k => k instanceof PDFRef && k.objectNumber === cellRef.objectNumber).length;
    expect(occurrences).toBe(1);
  });

  it('declines when the left and right neighbor cells belong to different rows, rather than guessing', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    // Row A: cells at mcid 0 (its only column). Orphan at mcid 1 (not in
    // any row's /K yet). Row B: cell at mcid 2 (its only column). The
    // orphan's left neighbor (mcid 0) resolves to Row A's /TR; its right
    // neighbor (mcid 2) resolves to Row B's /TR -- genuinely ambiguous.
    const cellA = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 0 }));
    const orphan = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 1 }));
    const cellB = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 2 }));
    const trA = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), Pg: page.ref, K: [cellA] }));
    const trB = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), Pg: page.ref, K: [cellB] }));
    doc.context.lookup(cellA, PDFDict).set(PDFName.of('P'), trA);
    doc.context.lookup(cellB, PDFDict).set(PDFName.of('P'), trB);

    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [trA, trB] });
    const docRef = doc.context.register(docNode);
    doc.context.lookup(trA, PDFDict).set(PDFName.of('P'), docRef);
    doc.context.lookup(trB, PDFDict).set(PDFName.of('P'), docRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
    const pageArr = doc.context.obj([cellA, orphan, cellB]);
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('different rows');
  });

  it('declines when neither neighbor cell resolves to a /TR-parented sibling', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    // Three /TD cells with no /TR at all -- none has a /P naming a /TR.
    const cellA = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 0 }));
    const orphan = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 1 }));
    const cellB = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 2 }));

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    const pageArr = doc.context.obj([cellA, orphan, cellB]);
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Neither neighbor cell resolves to a /TR');
  });

  it('declines the idempotency short-circuit when the cell and its parent reference each other, but the parent itself is not reachable from the structure tree root', async () => {
    const { doc, cellRef } = await buildDoc({ connected: false, cellMcid: 1, numColumns: 3 });
    const orphanTrRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [cellRef] }));
    doc.context.lookup(cellRef, PDFDict).set(PDFName.of('P'), orphanTrRef);

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not reachable from the structure tree root');
  });

  it('declines when the row\'s existing cells\' own MCIDs are not in ascending order, rather than trusting a positional match blindly', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    // Out-of-order /K: column 0's cell owns MCID 2, column 1's cell owns
    // MCID 0 -- not ascending.
    const cellCol0 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 2 }));
    const cellCol1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 0 }));
    const orphan = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, K: 1 }));
    const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), Pg: page.ref, K: [cellCol0, cellCol1] }));
    doc.context.lookup(cellCol0, PDFDict).set(PDFName.of('P'), trRef);
    doc.context.lookup(cellCol1, PDFDict).set(PDFName.of('P'), trRef);

    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [trRef] });
    const docRef = doc.context.register(docNode);
    doc.context.lookup(trRef, PDFDict).set(PDFName.of('P'), docRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
    // mcid 0 -> cellCol1, mcid 1 -> orphan, mcid 2 -> cellCol0 (both neighbors resolve to the same /TR).
    const pageArr = doc.context.obj([cellCol1, orphan, cellCol0]);
    const parentTree = doc.context.obj({ Nums: [0, pageArr] });
    doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not have ascending MCIDs');
  });

  it('fails cleanly when the element id does not match the expected format', async () => {
    const { doc } = await buildDoc({ connected: false });

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('not-a-real-id')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Unrecognized element id');
  });

  it('fails cleanly when no struct element exists at the target MCID', async () => {
    const { doc } = await buildDoc({ connected: false, cellMcid: 1, numColumns: 3 });

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc99')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No struct element found');
  });

  it('fails cleanly when the struct element at the target MCID is not a /TD or /TH', async () => {
    const { doc, trRef } = await buildDoc({ connected: false, cellMcid: 1, numColumns: 3 });
    // Replace the ParentTree page array so mcid 1 resolves to the /TR
    // itself instead of a cell -- simulates a non-cell struct element there.
    const structRoot = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot')), PDFDict);
    const parentTree = doc.context.lookup(structRoot.get(PDFName.of('ParentTree')), PDFDict);
    const newPageArr = doc.context.obj([trRef, trRef, trRef]);
    parentTree.set(PDFName.of('Nums'), doc.context.obj([0, newPageArr]));

    const results = pdfStructureWriterService.reattachTableCell(doc, [issueFor('tablecell_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not /TD or /TH');
  });
});
