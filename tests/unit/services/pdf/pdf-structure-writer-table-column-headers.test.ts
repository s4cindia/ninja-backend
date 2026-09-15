/**
 * Coverage for fixSimpleTableColumnHeaders -- the column-oriented counterpart
 * to fixSimpleTableHeaders, added alongside classifyTableHeaderOrientation
 * (structure-analyzer.service.ts) to fix a real gap found on Math_Kim
 * production data: 0/101 real MATTERHORN-15-002 tables ever passed the old
 * row-only rule-based auto-fix gate, and 58/101 are exactly 2 columns -- the
 * classic key-value (label|value) shape, where the real header is the FIRST
 * COLUMN, not the first row.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFArray, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

/** Builds a /Table -> /TR(xN) -> /TD(x2 per row) key-value-shaped structure. */
function buildKeyValueTable(doc: PDFDocument, pageRef: PDFRef, rowCount: number): PDFRef {
  const trRefs: PDFRef[] = [];
  for (let i = 0; i < rowCount; i++) {
    const labelRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const valueRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    trRefs.push(doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [labelRef, valueRef] })));
  }
  return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: trRefs }));
}

function firstCellTagsOf(doc: PDFDocument, tableRef: PDFRef): string[] {
  const table = doc.context.lookup(tableRef) as PDFDict;
  const trRefArr = table.get(PDFName.of('K')) as PDFArray;
  return trRefArr.asArray().map(trRef => {
    const tr = doc.context.lookup(trRef as PDFRef) as PDFDict;
    const cellRefs = (tr.get(PDFName.of('K')) as PDFArray).asArray();
    const firstCell = doc.context.lookup(cellRefs[0] as PDFRef) as PDFDict;
    return firstCell.get(PDFName.of('S'))!.toString();
  });
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
    suggestion: 'Add header column using TH tags',
    category: 'table-headers',
    element: elementId,
  } as AuditIssue;
}

async function buildDocWithTable(rowCount: number): Promise<{ doc: PDFDocument; tableRef: PDFRef }> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  const [pageRef] = doc.getPages().map(p => p.ref);
  const tableRef = buildKeyValueTable(doc, pageRef, rowCount);
  const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  return { doc, tableRef };
}

describe('PdfStructureWriterService.fixSimpleTableColumnHeaders', () => {
  it('promotes the first cell of every row to TH with scope="Row"', async () => {
    const { doc, tableRef } = await buildDocWithTable(5);

    const results = pdfStructureWriterService.fixSimpleTableColumnHeaders(doc, [issueFor('table_p1_0')]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Promoted 5 TD cell(s)');

    const table = doc.context.lookup(tableRef) as PDFDict;
    const trRefArr = (table.get(PDFName.of('K')) as PDFArray).asArray();
    for (const trRef of trRefArr) {
      const tr = doc.context.lookup(trRef as PDFRef) as PDFDict;
      const cellRefs = (tr.get(PDFName.of('K')) as PDFArray).asArray();
      const firstCell = doc.context.lookup(cellRefs[0] as PDFRef) as PDFDict;
      const secondCell = doc.context.lookup(cellRefs[1] as PDFRef) as PDFDict;
      expect(firstCell.get(PDFName.of('S'))!.toString()).toBe('/TH');
      expect(secondCell.get(PDFName.of('S'))!.toString()).toBe('/TD');

      const attrArr = firstCell.get(PDFName.of('A')) as PDFArray;
      const attrDict = doc.context.lookup(attrArr.get(0) as PDFRef) as PDFDict;
      expect(attrDict.get(PDFName.of('Scope'))!.toString()).toBe('/Row');
    }
  });

  it('fixes only the table the issue is about, leaving other tables untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    doc.addPage([400, 600]);
    const [page1Ref, page2Ref] = doc.getPages().map(p => p.ref);

    const tableOnPage1Ref = buildKeyValueTable(doc, page1Ref, 3);
    const tableOnPage2Ref = buildKeyValueTable(doc, page2Ref, 3);
    const documentRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Document'), K: [tableOnPage1Ref, tableOnPage2Ref] })
    );
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.fixSimpleTableColumnHeaders(doc, [issueFor('table_p2_0')]);
    expect(results[0].success).toBe(true);

    expect(firstCellTagsOf(doc, tableOnPage2Ref)).toEqual(['/TH', '/TH', '/TH']);
    expect(firstCellTagsOf(doc, tableOnPage1Ref)).toEqual(['/TD', '/TD', '/TD']);
  });

  it('handles a table with rows nested under /TBody', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);

    const label1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const value1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const tr1 = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [label1, value1] }));
    const tbody = doc.context.register(doc.context.obj({ S: PDFName.of('TBody'), K: [tr1] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [tbody] }));
    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.fixSimpleTableColumnHeaders(doc, [issueFor('table_p1_0')]);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Promoted 1 TD cell(s)');

    const labelCell = doc.context.lookup(label1) as PDFDict;
    expect(labelCell.get(PDFName.of('S'))!.toString()).toBe('/TH');
  });

  it('reports success with no changes when headers are already present', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const [pageRef] = doc.getPages().map(p => p.ref);

    const thRef = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
    const tdRef = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const trRef = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [thRef, tdRef] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trRef] }));
    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const results = pdfStructureWriterService.fixSimpleTableColumnHeaders(doc, [issueFor('table_p1_0')]);
    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('already present');
  });

  it('fails rather than guessing when the issue has no resolvable element id', async () => {
    const { doc } = await buildDocWithTable(2);

    const results = pdfStructureWriterService.fixSimpleTableColumnHeaders(doc, [issueFor('not-a-table-id')]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/No Table element found/);
  });
});
