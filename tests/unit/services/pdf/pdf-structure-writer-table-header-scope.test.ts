/**
 * Regression coverage for fixTableHeaderScope (Matterhorn 15-003 fix):
 * writes /Scope to an EXISTING TH cell inferred from its row/column
 * position, never promoting a TD to TH. See
 * pdf-table-header-scope.validator.ts's own header comment for the real
 * gap this closes on a live document: 708 TH cells across 105 real tables,
 * zero with any /Scope.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function cell(doc: PDFDocument, tag: 'TD' | 'TH', pageRef: PDFRef): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), Pg: pageRef }));
}

function row(doc: PDFDocument, cellRefs: PDFRef[]): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: cellRefs }));
}

function scopeOf(doc: PDFDocument, ref: PDFRef): string | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const aRaw = dict.get(PDFName.of('A'));
  const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
  const items = a instanceof PDFArray ? a.asArray() : a ? [a] : [];
  for (const item of items) {
    const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (resolved instanceof PDFDict) {
      const scope = resolved.get(PDFName.of('Scope'));
      if (scope) return scope.toString().replace(/^\//, '');
    }
  }
  return undefined;
}

function issueFor(elementId: string): AuditIssue {
  return {
    id: `issue-${elementId}`,
    source: 'pdf-table-header-scope',
    severity: 'serious',
    code: 'TABLE-HEADER-MISSING-SCOPE',
    message: 'Table header cell(s) with no /Scope attribute',
    wcagCriteria: ['1.3.1'],
    location: elementId,
    suggestion: 'Add a Scope attribute',
    category: 'table',
    element: elementId,
  } as AuditIssue;
}

describe('PdfStructureWriterService.fixTableHeaderScope', () => {
  it('writes scope="Column" to header-ROW TH cells (row index 0)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th1 = cell(doc, 'TH', page.ref);
    const th2 = cell(doc, 'TH', page.ref);
    const td1 = cell(doc, 'TD', page.ref);
    const td2 = cell(doc, 'TD', page.ref);
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [th1, th2]), row(doc, [td1, td2])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('2 TH cell(s) now have /Scope');
    expect(scopeOf(doc, th1)).toBe('Column');
    expect(scopeOf(doc, th2)).toBe('Column');
  });

  it('writes scope="Row" to header-COLUMN TH cells (column index 0)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th1 = cell(doc, 'TH', page.ref);
    const td1 = cell(doc, 'TD', page.ref);
    const th2 = cell(doc, 'TH', page.ref);
    const td2 = cell(doc, 'TD', page.ref);
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [th1, td1]), row(doc, [th2, td2])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(scopeOf(doc, th1)).toBe('Row');
    expect(scopeOf(doc, th2)).toBe('Row');
  });

  it('writes scope="Both" to the row-0/column-0 corner cell in a table with headers on both axes', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref); // row 0, col 0
    const colHeader = cell(doc, 'TH', page.ref); // row 0, col 1
    const rowHeader = cell(doc, 'TH', page.ref); // row 1, col 0
    const data = cell(doc, 'TD', page.ref); // row 1, col 1
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [corner, colHeader]), row(doc, [rowHeader, data])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(scopeOf(doc, corner)).toBe('Both');
    expect(scopeOf(doc, colHeader)).toBe('Column');
    expect(scopeOf(doc, rowHeader)).toBe('Row');
  });

  it('leaves a TH outside row 0/column 0 unscoped rather than guessing, but still reports success for the ones it could fix', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const headerRowTh = cell(doc, 'TH', page.ref); // row 0, col 0 -- fixable
    const middleTh = cell(doc, 'TH', page.ref); // row 1, col 1 -- NOT row 0 or col 0
    const td = cell(doc, 'TD', page.ref);
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [headerRowTh, td]), row(doc, [td, middleTh])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('1 TH cell(s) now have /Scope');
    expect(results[0].after).toContain('1 outside row 0/column 0 left unscoped');
    expect(scopeOf(doc, headerRowTh)).toBe('Column');
    expect(scopeOf(doc, middleTh)).toBeUndefined();
  });

  it('skips a TH that already has /Scope, touching only cells missing one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const alreadyScoped = doc.context.register(doc.context.obj({
      S: PDFName.of('TH'), Pg: page.ref,
      A: [doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Scope: PDFName.of('Column') }))],
    }));
    const needsScope = cell(doc, 'TH', page.ref);
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [alreadyScoped, needsScope])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('1 TH cell(s) now have /Scope');
    expect(scopeOf(doc, alreadyScoped)).toBe('Column'); // untouched, still correct
    expect(scopeOf(doc, needsScope)).toBe('Column');
  });

  it('fails cleanly when no Table element matches the issue', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('No Table element found');
  });

  it('fails cleanly when the target table has no rows at all', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [] }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('no TR row');
  });

  it('targets only the table the issue is about, leaving other tables on the same page untouched', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const table1Th = cell(doc, 'TH', page.ref);
    const table1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [row(doc, [table1Th])] }));
    const table2Th = cell(doc, 'TH', page.ref);
    const table2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [row(doc, [table2Th])] }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [table1Ref, table2Ref] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_1')]);

    expect(results[0].success).toBe(true);
    expect(scopeOf(doc, table2Th)).toBe('Column');
    expect(scopeOf(doc, table1Th)).toBeUndefined(); // untouched
  });
});
