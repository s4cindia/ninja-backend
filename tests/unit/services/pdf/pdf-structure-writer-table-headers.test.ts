/**
 * Regression coverage for fixSimpleTableHeaders targeting the specific table
 * an issue is about.
 *
 * Previously, fixSimpleTableHeaders(doc, [issue]) never read issue.element --
 * it walked the whole structure tree from the root and fixed (or idempotently
 * no-op'd on) the first /Table it reached, then stopped. Called once per
 * issue against the same mutating doc (as applyApprovedSuggestions does),
 * this meant only the very first table in document order across an entire
 * batch ever received a real fix; every other issue re-found that same
 * already-fixed table and reported a false "success" without ever touching
 * the table it was actually about.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

/**
 * Builds a /Table -> /TR -> /TD(x2) structure element, registered as real
 * indirect objects (fixSimpleTableHeaders' helpers only follow PDFRef
 * children, not inline dicts). /Pg lives only on the first /TD, matching
 * Seam C's real tagging convention (no /Pg on /Table or /TR).
 */
function buildTableWithTdRow(doc: PDFDocument, pageRef: PDFRef): PDFRef {
  const td1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
  const td2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
  const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [td1Ref, td2Ref] }));
  return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trRef] }));
}

function issueFor(elementId: string): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-table',
    severity: 'serious',
    code: 'MATTERHORN-15-002',
    message: 'Data table has no headers',
    wcagCriteria: ['1.3.1'],
    location: elementId,
    suggestion: 'Add header row using TH tags',
    category: 'table-headers',
    element: elementId,
  } as AuditIssue;
}

describe('PdfStructureWriterService.fixSimpleTableHeaders targeting', () => {
  it('fixes only the table the issue is about, leaving other tables untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1
    doc.addPage([400, 600]); // page 2
    const [page1Ref, page2Ref] = doc.getPages().map(p => p.ref);

    const tableOnPage1Ref = buildTableWithTdRow(doc, page1Ref);
    const tableOnPage2Ref = buildTableWithTdRow(doc, page2Ref);

    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [tableOnPage1Ref, tableOnPage2Ref] })
    );
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    // Target ONLY the table on page 2 -- the table detector's per-page index
    // for a single table on a page is always 0, matching structureElementIndex.
    const results = pdfStructureWriterService.fixSimpleTableHeaders(doc, [issueFor('table_p2_0')]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Promoted');

    const tableOnPage1 = doc.context.lookup(tableOnPage1Ref);
    const tableOnPage2 = doc.context.lookup(tableOnPage2Ref);
    expect(tableOnPage1).toBeDefined();
    expect(tableOnPage2).toBeDefined();

    const firstTagOf = (tableDict: unknown): string[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trRefArr = (tableDict as any).get(PDFName.of('K')) as PDFArray;
      const tr = doc.context.lookup(trRefArr.get(0) as PDFRef);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cellRefs = (tr as any).get(PDFName.of('K')) as PDFArray;
      return cellRefs.asArray().map(ref => {
        const cell = doc.context.lookup(ref as PDFRef);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (cell as any).get(PDFName.of('S')).toString();
      });
    };

    // The table the issue named was fixed...
    expect(firstTagOf(tableOnPage2)).toEqual(['/TH', '/TH']);
    // ...and the OTHER table (not named by any issue in this call) was not.
    expect(firstTagOf(tableOnPage1)).toEqual(['/TD', '/TD']);
  });

  it('fails rather than guessing when the issue has no resolvable element id', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);
    const tableRef = buildTableWithTdRow(doc, pageRef);

    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    // A malformed id must fail cleanly rather than guess at some table --
    // even though a real, fixable table exists in the tree.
    const results = pdfStructureWriterService.fixSimpleTableHeaders(doc, [issueFor('not-a-table-id')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/No Table element found/);
  });
});
