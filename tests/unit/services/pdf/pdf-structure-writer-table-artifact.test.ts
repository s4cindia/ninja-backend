/**
 * Regression coverage for markTableAsArtifact (MATTERHORN-15-005 mechanical
 * fix, added alongside the trivial-struct-match reclassification in PR #546,
 * refined on PR #547 after real CodeRabbit/Codex findings against live
 * Math_Kim data): removes the specific /Table struct element each issue's id
 * refers to from the structure tree entirely, targeting via findTargetTable
 * (same as fixSimpleTableHeaders) -- deliberately NOT a whole-document sweep
 * for "any structurally trivial /Table" (an earlier version of this fix
 * tried that and it was wrong: it also converted the trivial boxes
 * underlying MATTERHORN-15-001 issues, which pdf-table.validator.ts's
 * tagged-PDF matching then silently discards as an unmatched text-detector
 * false positive -- hiding, not fixing, that separate finding). Only the
 * specific element a confirmed MATTERHORN-15-005 issue names may be touched.
 *
 * Originally retagged the element to /S /Artifact instead (bound to the PDF
 * 2.0 structure namespace so the non-standard type would stay spec-valid).
 * Switched to outright deletion after a real PAC/axesPAC report against a
 * remediated Farrar 2E PDF found PAC 26.1.0.0 doesn't recognize PDF 2.0
 * namespace-scoped structure types at all, regardless of how correctly
 * they're bound -- every live target this fix has ever touched has a
 * /K-less TD (no MCID, no painted content), so there's no content-stream
 * region that ever needed an Artifact tag of its own; removing the element
 * is both simpler and the only variant actually proven to satisfy a real
 * external validator. See markTableAsArtifact's own doc comment.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

/** A trivial one-row/one-cell /Table -- the decorative-box shape this fix targets. */
function buildTrivialTable(doc: PDFDocument, pageRef: PDFRef): PDFRef {
  const tdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
  const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [tdRef] }));
  return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trRef] }));
}

function issueFor(elementId: string): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-table',
    severity: 'moderate',
    code: 'MATTERHORN-15-005',
    message: 'Layout table should be marked as artifact',
    wcagCriteria: ['1.3.1', '1.3.2'],
    location: elementId,
    suggestion: 'Mark layout table as artifact',
    category: 'layout-table',
    element: elementId,
  } as AuditIssue;
}

function tagOf(doc: PDFDocument, ref: PDFRef): string | undefined {
  const dict = doc.context.lookup(ref);
  return dict instanceof PDFDict ? dict.get(PDFName.of('S'))?.toString() : undefined;
}

/**
 * deleteElement (which markTableAsArtifact now uses) finds the parent to
 * remove a target from via that target's own /P -- buildTrivialTable never
 * sets it (renameElement, the fix's former mechanism, never needed it), so
 * every test below sets it explicitly once the real parent ref is known.
 */
function setParent(doc: PDFDocument, childRef: PDFRef, parentRef: PDFRef): void {
  (doc.context.lookup(childRef) as PDFDict).set(PDFName.of('P'), parentRef);
}

/** True if childRef still appears in parentRef's own /K array. */
function isChildOf(doc: PDFDocument, parentRef: PDFRef, childRef: PDFRef): boolean {
  const parent = doc.context.lookup(parentRef);
  if (!(parent instanceof PDFDict)) return false;
  const k = parent.get(PDFName.of('K'));
  if (!(k instanceof PDFArray)) return k instanceof PDFRef ? k.toString() === childRef.toString() : false;
  return k.asArray().some(r => r instanceof PDFRef && r.toString() === childRef.toString());
}

describe('PdfStructureWriterService.markTableAsArtifact', () => {
  it('removes only the table the issue is about, leaving other tables untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1
    doc.addPage([400, 600]); // page 2
    const [page1Ref, page2Ref] = doc.getPages().map(p => p.ref);

    const tableOnPage1Ref = buildTrivialTable(doc, page1Ref);
    const tableOnPage2Ref = buildTrivialTable(doc, page2Ref);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [tableOnPage1Ref, tableOnPage2Ref] })
    );
    setParent(doc, tableOnPage1Ref, documentRef);
    setParent(doc, tableOnPage2Ref, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p2_0')]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Removed');

    // The table the issue named was removed from the tree...
    expect(isChildOf(doc, documentRef, tableOnPage2Ref)).toBe(false);
    // ...and the OTHER table (a completely separate, unrelated finding --
    // e.g. it could be the trivial box underlying a MATTERHORN-15-001
    // issue) was not touched.
    expect(isChildOf(doc, documentRef, tableOnPage1Ref)).toBe(true);
    expect(tagOf(doc, tableOnPage1Ref)).toBe('/Table');
  });

  it('picks the right table by index among multiple tables on the same page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);

    const firstTableRef = buildTrivialTable(doc, pageRef);
    const secondTableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [firstTableRef, secondTableRef] })
    );
    setParent(doc, firstTableRef, documentRef);
    setParent(doc, secondTableRef, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_1')]);
    expect(results[0].success).toBe(true);

    expect(isChildOf(doc, documentRef, secondTableRef)).toBe(false);
    expect(isChildOf(doc, documentRef, firstTableRef)).toBe(true);
    expect(tagOf(doc, firstTableRef)).toBe('/Table');
  });

  /**
   * Regression for the real bug found live against Math_Kim (6 of 49 real
   * cases failed before this fix): findTargetTable re-derives "the Nth
   * /Table on this page" fresh on every call by filtering for
   * `sTag === 'Table'`. Unlike fixSimpleTableHeaders (which never changes a
   * /Table's own /S), this method DOES remove the /Table itself -- so
   * removing table_p1_0 eagerly, before processing table_p1_1 in the same
   * batch, would make the later lookup's fresh re-walk see only 1 remaining
   * /Table on the page (the one already removed no longer matches), shifting
   * what index 1 means and spuriously failing to find a real, valid table.
   */
  it('fixes multiple tables on the same page in one batch without an earlier fix shifting a later lookup\'s index', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);

    const firstTableRef = buildTrivialTable(doc, pageRef);
    const secondTableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [firstTableRef, secondTableRef] })
    );
    setParent(doc, firstTableRef, documentRef);
    setParent(doc, secondTableRef, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    // Both tables on the same page, flagged in the same batch call --
    // table_p1_0 is resolved and processed first.
    const results = pdfStructureWriterService.markTableAsArtifact(doc, [
      issueFor('table_p1_0'),
      issueFor('table_p1_1'),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);

    expect(isChildOf(doc, documentRef, firstTableRef)).toBe(false);
    expect(isChildOf(doc, documentRef, secondTableRef)).toBe(false);
  });

  it('does not create a PDF 2.0 namespace entry or bump the catalog Version -- removing the element needs neither', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    setParent(doc, tableRef, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    expect(doc.catalog.get(PDFName.of('Version'))).toBeUndefined();

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);
    expect(results[0].success).toBe(true);

    const structTreeRoot = doc.context.lookup(structTreeRootRef) as PDFDict;
    expect(structTreeRoot.get(PDFName.of('Namespaces'))).toBeUndefined();
    expect(doc.catalog.get(PDFName.of('Version'))).toBeUndefined();
  });

  it('clears a removed table\'s own /K, same "descendants become unreachable" semantics deleteElement documents', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    setParent(doc, tableRef, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);

    const tableDict = doc.context.lookup(tableRef) as PDFDict;
    expect(tableDict.get(PDFName.of('K'))).toBeUndefined();
    expect(tableDict.get(PDFName.of('P'))).toBeUndefined();
    expect(isChildOf(doc, documentRef, tableRef)).toBe(false);
  });

  it('does not touch the tree when nothing could be fixed', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('not-a-table-id')]);
    expect(results[0].success).toBe(false);

    expect(isChildOf(doc, documentRef, tableRef)).toBe(true);
    expect(tagOf(doc, tableRef)).toBe('/Table');
  });

  it('fails rather than guessing when the issue has no resolvable element id', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('not-a-table-id')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/No Table element found/);
  });

  it('reports failure honestly when there is no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/structure tree/i);
  });

  // Real incident this guards against: Math_Olszewski_PDF.pdf's remediated
  // output had a surviving struct element's /P pointing at an object that
  // had been dropped from the file entirely -- a genuine dangling reference.
  // deleteElement clears the removed table's own /K (so a TR child, even
  // though it still exists as a registered object, is no longer reachable
  // through it) but only clears the TABLE's own /P, not a deeper
  // grandchild's -- the TD's /P still correctly points at the
  // still-existing (merely unreachable) TR, matching deleteElement's own
  // "descendants remain in the PDF context but are unreachable" semantics.
  it('removes the table from the tree without corrupting its former children\'s own /P pointers', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);

    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table') }));
    const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), P: tableRef }));
    const tdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), P: trRef, Pg: pageRef }));
    (doc.context.lookup(trRef) as PDFDict).set(PDFName.of('K'), doc.context.obj([tdRef]));
    (doc.context.lookup(tableRef) as PDFDict).set(PDFName.of('K'), doc.context.obj([trRef]));

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    setParent(doc, tableRef, documentRef);
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);
    expect(results[0].success).toBe(true);
    expect(isChildOf(doc, documentRef, tableRef)).toBe(false);

    const tableDict = doc.context.lookup(tableRef) as PDFDict;
    expect(tableDict.get(PDFName.of('P'))).toBeUndefined();
    expect(tableDict.get(PDFName.of('K'))).toBeUndefined();

    // TR and TD still exist as registered objects (deleteElement never
    // literally deletes anything), and the TD's /P still correctly points
    // at the still-existing TR -- only the table's own /P/K were touched.
    const trDict = doc.context.lookup(trRef) as PDFDict;
    expect(trDict.get(PDFName.of('S'))).toEqual(PDFName.of('TR'));
    const tdDict = doc.context.lookup(tdRef) as PDFDict;
    expect(tdDict.get(PDFName.of('P'))).toEqual(trRef);
  });
});
