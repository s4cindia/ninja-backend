/**
 * Regression coverage for reattachTableRow (Matterhorn 01-005 fix): a /TR
 * table-row struct element whose own TD/TH children are ALL correctly
 * linked to it, but which is itself missing from its containing /Table's
 * own /K array -- one level up from reattachTableCell's own /TD-into-/TR
 * case, for the SAME underlying Farrar_2E_Comp_188910.pdf defect:
 * reattachTableCell finds nothing to fix on these 5 rows (each disconnected
 * /TD is already correctly linked to its own /TR), but the /TR itself was
 * never linked into its /Table.
 *
 * Unlike reattachTableCell (which locates its orphan via /ParentTree, since
 * a /TD owns its own MCID), a /TR has no own MCID -- this writer re-derives
 * each row's (page, MCID) identity from its own TD/TH children the same
 * way pdf-table-cell-tree.validator.ts's own /TR detection pass built the
 * issue's `element` id in the first place, and matches it against every
 * real /TR in the file (reachable or not), not just currently-orphaned
 * ones.
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
    code: 'TABLE-ROW-DISCONNECTED',
    message: 'Table row not reachable from the structure tree',
    wcagCriteria: ['1.3.1'],
    location: elementId,
    suggestion: 'Reattach the row',
    category: 'structure',
    element: elementId,
    pageNumber,
  } as AuditIssue;
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

/** A flat /Nums-based /ParentTree on `structTreeRootRef`, one page array
 * (StructParents key 0) listing `entries` by MCID position -- the shape
 * the document-flow fallback's own neighbor lookup reads from. */
function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/** One /TD cell (own bare MCID) wrapped in its own /TR, both /Type /StructElem. */
function makeRow(doc: PDFDocument, pageRef: PDFRef, mcid: number): { trRef: PDFRef; cellRef: PDFRef } {
  const cellRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TD'), Pg: pageRef, K: mcid }),
  );
  const trRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('TR'), K: [cellRef] }),
  );
  doc.context.lookup(cellRef, PDFDict).set(PDFName.of('P'), trRef);
  return { trRef, cellRef };
}

/**
 * Builds one /Table with `siblingMcids` existing (connected) rows plus one
 * orphaned row at `orphanMcid` -- matching the confirmed real shape: the
 * orphan's own /TD is correctly linked to its own /TR (so reattachTableCell
 * finds nothing), but that /TR is left out of the /Table's own /K.
 */
async function buildDoc(opts: {
  siblingMcids: number[];
  orphanMcid: number;
  orphanConnected?: boolean;
}): Promise<{ doc: PDFDocument; tableRef: PDFRef; orphanTrRef: PDFRef; siblingTrRefs: PDFRef[] }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

  const siblings = opts.siblingMcids.map(mcid => makeRow(doc, page.ref, mcid));
  const orphan = makeRow(doc, page.ref, opts.orphanMcid);

  const tableK = opts.orphanConnected
    ? [...siblings.map(s => s.trRef), orphan.trRef]
    : siblings.map(s => s.trRef);
  const tableRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Table'), K: tableK }),
  );
  for (const s of siblings) doc.context.lookup(s.trRef, PDFDict).set(PDFName.of('P'), tableRef);
  if (opts.orphanConnected) {
    doc.context.lookup(orphan.trRef, PDFDict).set(PDFName.of('P'), tableRef);
  }

  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] });
  const docRef = doc.context.register(docNode);
  doc.context.lookup(tableRef, PDFDict).set(PDFName.of('P'), docRef);

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, tableRef, orphanTrRef: orphan.trRef, siblingTrRefs: siblings.map(s => s.trRef) };
}

describe('PdfStructureWriterService.reattachTableRow', () => {
  it('inserts the orphan at the start of the table when its MCID is lower than every existing row (the confirmed real Farrar shape)', async () => {
    const { doc, tableRef, orphanTrRef } = await buildDoc({ siblingMcids: [2, 3, 5], orphanMcid: 1 });

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, tableRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === orphanTrRef.objectNumber);
    expect(idx).toBe(0);

    const trDict = doc.context.lookup(orphanTrRef, PDFDict);
    expect(trDict.get(PDFName.of('P'))?.toString()).toBe(tableRef.toString());
  });

  it('inserts the orphan between its neighbors when its MCID falls in the middle of existing rows', async () => {
    const { doc, tableRef, orphanTrRef } = await buildDoc({ siblingMcids: [0, 1, 5, 6], orphanMcid: 3 });

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc3')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, tableRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === orphanTrRef.objectNumber);
    expect(idx).toBe(2); // after the two rows with mcid 0, 1
  });

  it('inserts the orphan at the end when its MCID is higher than every existing row', async () => {
    const { doc, tableRef, orphanTrRef } = await buildDoc({ siblingMcids: [0, 1, 2], orphanMcid: 9 });

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc9')]);

    expect(results[0].success).toBe(true);
    const kids = kidsOf(doc, tableRef);
    const idx = kids.findIndex(k => k instanceof PDFRef && k.objectNumber === orphanTrRef.objectNumber);
    expect(idx).toBe(kids.length - 1);
  });

  it('is idempotent: a row already correctly attached reports success without double-inserting', async () => {
    const { doc, tableRef, orphanTrRef } = await buildDoc({ siblingMcids: [0, 1], orphanMcid: 2, orphanConnected: true });

    const before = kidsOf(doc, tableRef).length;
    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc2')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('already attached');
    expect(kidsOf(doc, tableRef).length).toBe(before);
    const occurrences = kidsOf(doc, tableRef).filter(k => k instanceof PDFRef && k.objectNumber === orphanTrRef.objectNumber).length;
    expect(occurrences).toBe(1);
  });

  it('declines when no reachable /Table has any content on the orphan\'s page, rather than guessing (the confirmed real page-15 Farrar case)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
    const orphan = makeRow(doc, page.ref, 1);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No reachable /Table found');
    // The orphan itself must still exist, untouched -- not silently dropped.
    expect(doc.context.lookup(orphan.trRef, PDFDict)).toBeDefined();
  });

  /** Finds the one kid of `parentRef` tagged /Table, for locating a newly-created wrapper. */
  function findTableKid(doc: PDFDocument, parentRef: PDFRef): PDFRef {
    const found = kidsOf(doc, parentRef).find(k => {
      if (!(k instanceof PDFRef)) return false;
      const d = doc.context.lookup(k, PDFDict);
      return d.get(PDFName.of('S'))?.toString() === '/Table';
    });
    if (!(found instanceof PDFRef)) throw new Error('No /Table kid found');
    return found;
  }

  // Document-flow fallback (page-15 Farrar follow-up): confirmed real
  // shape for the one orphaned /TR PR #740 declined -- a single-cell
  // "table" (content-stream tagged /Table but never wrapped in a
  // dedicated /Table struct element) sitting directly in the document's
  // own flow, between an /H6 and a /P that share one common parent, with
  // an /Artifact (no own MCID) genuinely sitting between the /H6 and the
  // gap in the real file's own /K array.
  //
  // The /TR itself is never spliced directly into that document-flow
  // parent (a real PAC report caught exactly that as "Invalid use of a TR
  // structure element" -- a /TR must always sit inside a /Table-family
  // ancestor, never bare in document flow): a new single-row /Table
  // wrapper is created AT that position instead, with the orphaned /TR
  // reattached as its sole child.
  it('falls back to the shared document-flow parent of its left/right MCID neighbors when no /Table claims the page at all (the confirmed real page-15 Farrar shape)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('H6'), Pg: page.ref, K: 0 }));
    const orphan = makeRow(doc, page.ref, 1);
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 2 }));
    const artifactRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Artifact'), Pg: page.ref }));

    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, artifactRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, orphan.cellRef, rightRef]);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('new single-row /Table wrapper');
    // The wrapper /Table (not the bare /TR) must land immediately before
    // the RIGHT neighbor (after the artifact), not naively right after the
    // left neighbor -- that would wrongly place it before the artifact
    // instead of after it.
    const wrapperRef = findTableKid(doc, flowParentRef);
    const kidRefs = kidsOf(doc, flowParentRef).map(k => (k instanceof PDFRef ? k.objectNumber : null));
    expect(kidRefs).toEqual([leftRef.objectNumber, artifactRef.objectNumber, wrapperRef.objectNumber, rightRef.objectNumber]);

    // The /TR itself is nested one level deeper, inside the wrapper.
    expect(kidsOf(doc, wrapperRef)).toEqual([orphan.trRef]);
    const trDict = doc.context.lookup(orphan.trRef, PDFDict);
    expect(trDict.get(PDFName.of('P'))?.toString()).toBe(wrapperRef.toString());
    expect(doc.context.lookup(wrapperRef, PDFDict).get(PDFName.of('S'))?.toString()).toBe('/Table');
  });

  it('uses the right neighbor\'s parent alone when the orphan is first on the page (no left neighbor)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const orphan = makeRow(doc, page.ref, 0);
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 1 }));

    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [rightRef] }),
    );
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [orphan.cellRef, rightRef]);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc0')]);

    expect(results[0].success).toBe(true);
    const wrapperRef = findTableKid(doc, flowParentRef);
    const kidRefs = kidsOf(doc, flowParentRef).map(k => (k instanceof PDFRef ? k.objectNumber : null));
    expect(kidRefs).toEqual([wrapperRef.objectNumber, rightRef.objectNumber]);
    expect(kidsOf(doc, wrapperRef)).toEqual([orphan.trRef]);
  });

  it('uses the left neighbor\'s parent alone when the orphan is last on the page (no right neighbor)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('H6'), Pg: page.ref, K: 0 }));
    const orphan = makeRow(doc, page.ref, 1);

    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, orphan.cellRef]);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(true);
    const wrapperRef = findTableKid(doc, flowParentRef);
    const kidRefs = kidsOf(doc, flowParentRef).map(k => (k instanceof PDFRef ? k.objectNumber : null));
    expect(kidRefs).toEqual([leftRef.objectNumber, wrapperRef.objectNumber]);
    expect(kidsOf(doc, wrapperRef)).toEqual([orphan.trRef]);
  });

  it('declines the document-flow fallback when left and right MCID neighbors resolve to DIFFERENT parents, rather than guessing which one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('H6'), Pg: page.ref, K: 0 }));
    const orphan = makeRow(doc, page.ref, 1);
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 2 }));

    const parentA = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef] }));
    const parentB = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [rightRef] }));
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), parentA);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), parentB);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [parentA, parentB] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, orphan.cellRef, rightRef]);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('different document-flow parents');
  });

  it('declines the document-flow fallback when the row already has a /P from a previous attempt, rather than trusting or guessing at it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const leftRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('H6'), Pg: page.ref, K: 0 }));
    const orphan = makeRow(doc, page.ref, 1);
    const rightRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page.ref, K: 2 }));

    const flowParentRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [leftRef, rightRef] }),
    );
    doc.context.lookup(leftRef, PDFDict).set(PDFName.of('P'), flowParentRef);
    doc.context.lookup(rightRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    // Even a /P that DOES match the determined flow parent (e.g. a leftover
    // link from this fix's own earlier, since-corrected bare-/TR-in-flow
    // design) is never trusted here -- a /TR's only ever-valid /P is a
    // /Table-family ancestor, so any pre-existing /P is either a genuine
    // first attempt (shouldn't exist yet) or a known-bad shape.
    doc.context.lookup(orphan.trRef, PDFDict).set(PDFName.of('P'), flowParentRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [flowParentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    setFlatParentTree(doc, structTreeRootRef, [leftRef, orphan.cellRef, rightRef]);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc1')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Row already has a /P from a previous attempt');
  });

  it('declines when more than one reachable /Table has content on the orphan\'s page, rather than guessing which one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('StructParents'), doc.context.obj(0));

    const rowA = makeRow(doc, page.ref, 0);
    const tableA = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Table'), K: [rowA.trRef] }));
    doc.context.lookup(rowA.trRef, PDFDict).set(PDFName.of('P'), tableA);

    const rowB = makeRow(doc, page.ref, 5);
    const tableB = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Table'), K: [rowB.trRef] }));
    doc.context.lookup(rowB.trRef, PDFDict).set(PDFName.of('P'), tableB);

    const orphan = makeRow(doc, page.ref, 2);

    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [tableA, tableB] });
    const docRef = doc.context.register(docNode);
    doc.context.lookup(tableA, PDFDict).set(PDFName.of('P'), docRef);
    doc.context.lookup(tableB, PDFDict).set(PDFName.of('P'), docRef);

    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc2')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('ambiguous');
    expect(doc.context.lookup(orphan.trRef, PDFDict)).toBeDefined();
  });

  it('declines when the table\'s existing rows do not have ascending MCIDs, rather than trusting a positional match blindly', async () => {
    const { doc } = await buildDoc({ siblingMcids: [5, 0], orphanMcid: 2 }); // out of order: 5 then 0

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc2')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('not have ascending MCIDs');
  });

  it('declines when the row already has a /P that does not match its own natural reattachment point', async () => {
    const { doc, orphanTrRef } = await buildDoc({ siblingMcids: [0, 1], orphanMcid: 3 });
    const wrongParent = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), K: [] }));
    doc.context.lookup(orphanTrRef, PDFDict).set(PDFName.of('P'), wrongParent);

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc3')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('does not match this row\'s own natural reattachment point');
  });

  it('fails cleanly when the element id does not match the expected format', async () => {
    const { doc } = await buildDoc({ siblingMcids: [0, 1], orphanMcid: 2 });

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('not-a-real-id')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Unrecognized element id');
  });

  it('fails cleanly when no /TR exists at the requested page/MCID -- document may have changed since the issue was generated', async () => {
    const { doc } = await buildDoc({ siblingMcids: [0, 1], orphanMcid: 2 });

    const results = pdfStructureWriterService.reattachTableRow(doc, [issueFor('tablerow_p1_mc99')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('document may have changed');
  });
});
