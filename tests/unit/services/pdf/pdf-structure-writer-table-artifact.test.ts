/**
 * Regression coverage for markTableAsArtifact (MATTERHORN-15-005 mechanical
 * fix, added alongside the trivial-struct-match reclassification in PR #546,
 * refined on PR #547 after real CodeRabbit/Codex findings against live
 * Math_Kim data): retags the specific /Table struct element each issue's id
 * refers to as /Artifact, targeting via findTargetTable (same as
 * fixSimpleTableHeaders) -- deliberately NOT a whole-document sweep for "any
 * structurally trivial /Table" (an earlier version of this fix tried that
 * and it was wrong: it also converted the trivial boxes underlying
 * MATTERHORN-15-001 issues, which pdf-table.validator.ts's tagged-PDF
 * matching then silently discards as an unmatched text-detector false
 * positive -- hiding, not fixing, that separate finding). Only the specific
 * element a confirmed MATTERHORN-15-005 issue names may be touched.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFString } from 'pdf-lib';
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

describe('PdfStructureWriterService.markTableAsArtifact', () => {
  it('retags only the table the issue is about, leaving other tables untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1
    doc.addPage([400, 600]); // page 2
    const [page1Ref, page2Ref] = doc.getPages().map(p => p.ref);

    const tableOnPage1Ref = buildTrivialTable(doc, page1Ref);
    const tableOnPage2Ref = buildTrivialTable(doc, page2Ref);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [tableOnPage1Ref, tableOnPage2Ref] })
    );
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p2_0')]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Artifact');

    // The table the issue named was retagged...
    expect(tagOf(doc, tableOnPage2Ref)).toBe('/Artifact');
    // ...and the OTHER table (a completely separate, unrelated finding --
    // e.g. it could be the trivial box underlying a MATTERHORN-15-001
    // issue) was not touched.
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
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_1')]);
    expect(results[0].success).toBe(true);

    expect(tagOf(doc, secondTableRef)).toBe('/Artifact');
    expect(tagOf(doc, firstTableRef)).toBe('/Table');
  });

  /**
   * Regression for the real bug found live against Math_Kim (6 of 49 real
   * cases failed before this fix): findTargetTable re-derives "the Nth
   * /Table on this page" fresh on every call by filtering for
   * `sTag === 'Table'`. Unlike fixSimpleTableHeaders (which never changes a
   * /Table's own /S), this method DOES rename the /Table itself -- so
   * renaming table_p1_0 eagerly, before processing table_p1_1 in the same
   * batch, would make the later lookup's fresh re-walk see only 1 remaining
   * /Table on the page (the one already renamed no longer matches), shifting
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

    expect(tagOf(doc, firstTableRef)).toBe('/Artifact');
    expect(tagOf(doc, secondTableRef)).toBe('/Artifact');
  });

  it('binds converted elements to the PDF 2.0 structure namespace, reusing the same namespace entry across calls', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.addPage([400, 600]);
    const [page1Ref, page2Ref] = doc.getPages().map(p => p.ref);
    const table1Ref = buildTrivialTable(doc, page1Ref);
    const table2Ref = buildTrivialTable(doc, page2Ref);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [table1Ref, table2Ref] })
    );
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);

    const structTreeRoot = doc.context.lookup(structTreeRootRef) as PDFDict;
    const namespaces = structTreeRoot.get(PDFName.of('Namespaces'));
    expect(namespaces).toBeInstanceOf(PDFArray);
    const nsArray = (namespaces as PDFArray).asArray();
    expect(nsArray).toHaveLength(1);

    const nsDict = doc.context.lookup(nsArray[0] as PDFRef) as PDFDict;
    expect((nsDict.get(PDFName.of('NS')) as PDFString).decodeText()).toBe('http://iso.org/pdf2/ssn');

    const table1Dict = doc.context.lookup(table1Ref) as PDFDict;
    expect(table1Dict.get(PDFName.of('NS'))).toEqual(nsArray[0]);

    // A second table, fixed in a LATER call, must reuse the SAME namespace
    // entry rather than creating a duplicate.
    pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p2_0')]);
    const namespacesAfter = (structTreeRoot.get(PDFName.of('Namespaces')) as PDFArray).asArray();
    expect(namespacesAfter).toHaveLength(1);
    const table2Dict = doc.context.lookup(table2Ref) as PDFDict;
    expect(table2Dict.get(PDFName.of('NS'))).toEqual(nsArray[0]);
  });

  it('clears TR/TD children on a converted Table, since they no longer make structural sense under Artifact', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTrivialTable(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    pdfStructureWriterService.markTableAsArtifact(doc, [issueFor('table_p1_0')]);

    const tableDict = doc.context.lookup(tableRef) as PDFDict;
    expect(tableDict.get(PDFName.of('K'))).toBeUndefined();
  });

  it('does not create a namespace entry when nothing could be fixed', async () => {
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

    const structTreeRoot = doc.context.lookup(structTreeRootRef) as PDFDict;
    expect(structTreeRoot.get(PDFName.of('Namespaces'))).toBeUndefined();
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
});
