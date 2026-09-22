/**
 * Regression coverage for fixTableHeaderScope (Matterhorn 15-003 fix):
 * writes /Scope to an EXISTING TH cell inferred from its row/column
 * position, never promoting a TD to TH. See
 * pdf-table-header-scope.validator.ts's own header comment for the real
 * gap this closes on a live document: 708 TH cells across 105 real tables,
 * zero with any /Scope.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFHexString } from 'pdf-lib';
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

function cellWithColSpan(doc: PDFDocument, tag: 'TD' | 'TH', pageRef: PDFRef, colSpan: number): PDFRef {
  const attrRef = doc.context.register(doc.context.obj({ O: PDFName.of('Table'), ColSpan: colSpan }));
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), Pg: pageRef, A: [attrRef] }));
}

function idOf(doc: PDFDocument, ref: PDFRef): string | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const id = dict.get(PDFName.of('ID'));
  return id ? id.toString() : undefined;
}

function headersOf(doc: PDFDocument, ref: PDFRef): string[] | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const aRaw = dict.get(PDFName.of('A'));
  const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
  const items = a instanceof PDFArray ? a.asArray() : a ? [a] : [];
  for (const item of items) {
    const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (resolved instanceof PDFDict) {
      const headers = resolved.get(PDFName.of('Headers'));
      if (headers instanceof PDFArray) return headers.asArray().map(h => h.toString());
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

  it('writes scope="Column" to a repeated header row mid-table (same TH shape as row 0), matching the real Math_Weir_PDF.pdf long-table pattern', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const headerRow0 = [cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref)];
    const dataRow1 = [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)];
    // The repeated header row's own column-0 cell already gets Scope="Row"
    // from the plain isHeaderCol rule (any column-0 TH, any row) -- only
    // its non-col0 cells (repeatedCol1, repeatedCol2) are the genuinely
    // new case under test here.
    const repeatedHeaderCol0 = cell(doc, 'TH', page.ref);
    const repeatedCol1 = cell(doc, 'TH', page.ref);
    const repeatedCol2 = cell(doc, 'TH', page.ref);
    const dataRow2 = [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)];

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, headerRow0),
        row(doc, dataRow1),
        row(doc, [repeatedHeaderCol0, repeatedCol1, repeatedCol2]),
        row(doc, dataRow2),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).not.toContain('outside row 0/column 0 left unscoped');
    expect(scopeOf(doc, headerRow0[1])).toBe('Column');
    expect(scopeOf(doc, repeatedCol1)).toBe('Column');
    expect(scopeOf(doc, repeatedCol2)).toBe('Column');
    expect(scopeOf(doc, repeatedHeaderCol0)).toBe('Row');
  });

  it('does NOT treat a row with the same cell count as row 0 but only PARTIAL TH coverage as a repeated header row', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const headerRow0 = [cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref)];
    // Same cell count as row 0, but the middle cell is TD, not TH -- a
    // genuine data row that happens to be table-width, not a repeated
    // header. Only col 0 (a real TH) should get scope, via the ordinary
    // isHeaderCol rule -- the OTHER TH here (col 2) must be left unscoped
    // since this row doesn't qualify as a repeat of row 0.
    const notARepeatCol0 = cell(doc, 'TH', page.ref);
    const notARepeatCol1 = cell(doc, 'TD', page.ref);
    const notARepeatCol2 = cell(doc, 'TH', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, headerRow0),
        row(doc, [notARepeatCol0, notARepeatCol1, notARepeatCol2]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].after).toContain('outside row 0/column 0 left unscoped');
    expect(scopeOf(doc, notARepeatCol0)).toBe('Row');
    expect(scopeOf(doc, notARepeatCol2)).toBeUndefined();
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

describe('PdfStructureWriterService.fixTableHeaderScope -- multi-level header Headers/IDs retagging', () => {
  it('Headers/IDs-tags a genuine two-level header block (corner+group row, row-label+sub-headers row), matching the real Math_Weir_PDF.pdf shape', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group = cell(doc, 'TH', page.ref);
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const sub3 = cell(doc, 'TH', page.ref);
    const dataRowLabel1 = cell(doc, 'TD', page.ref);
    const data1a = cell(doc, 'TD', page.ref);
    const data1b = cell(doc, 'TD', page.ref);
    const data1c = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group]),
        row(doc, [rowLabel, sub1, sub2, sub3]),
        row(doc, [dataRowLabel1, data1a, data1b, data1c]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('data cell(s) now have /Headers');

    // Corner + row-label still get plain Scope from the existing position-based pass.
    expect(scopeOf(doc, corner)).toBe('Both');
    expect(scopeOf(doc, rowLabel)).toBe('Row');

    // The group and sub-headers now carry their own unique /ID.
    const groupId = idOf(doc, group);
    const sub1Id = idOf(doc, sub1);
    const sub2Id = idOf(doc, sub2);
    const sub3Id = idOf(doc, sub3);
    const rowLabelId = idOf(doc, rowLabel);
    expect([groupId, sub1Id, sub2Id, sub3Id, rowLabelId].every(id => !!id)).toBe(true);
    expect(new Set([groupId, sub1Id, sub2Id, sub3Id, rowLabelId]).size).toBe(5); // all unique

    // Column-0 data cell references only the row-label header.
    expect(headersOf(doc, dataRowLabel1)).toEqual([rowLabelId]);
    // Other data cells reference row-label + group + their own specific sub-column header.
    expect(headersOf(doc, data1a)).toEqual([rowLabelId, groupId, sub1Id]);
    expect(headersOf(doc, data1b)).toEqual([rowLabelId, groupId, sub2Id]);
    expect(headersOf(doc, data1c)).toEqual([rowLabelId, groupId, sub3Id]);
  });

  it('retags multiple repeated header blocks within the SAME table, matching the real 110-row Math_Weir_PDF.pdf table (3 blocks, 32 cells)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    function buildBlock() {
      const corner = cell(doc, 'TH', page.ref);
      const group = cell(doc, 'TH', page.ref);
      const rowLabel = cell(doc, 'TH', page.ref);
      const subs = [cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref)];
      const dataRows = [
        row(doc, [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)]),
        row(doc, [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)]),
      ];
      return {
        headerRows: [row(doc, [corner, group]), row(doc, [rowLabel, ...subs])],
        dataRows,
        rowLabel, subs,
      };
    }

    const block1 = buildBlock();
    const block2 = buildBlock();
    const block3 = buildBlock();

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        ...block1.headerRows, ...block1.dataRows,
        ...block2.headerRows, ...block2.dataRows,
        ...block3.headerRows, ...block3.dataRows,
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    // Each block's own row-label + 2 subs get a real /ID, independent of the others.
    for (const block of [block1, block2, block3]) {
      expect(idOf(doc, block.rowLabel)).toBeTruthy();
      for (const sub of block.subs) expect(idOf(doc, sub)).toBeTruthy();
    }
    // IDs are unique ACROSS blocks too (not accidentally shared/reused).
    const allIds = [block1, block2, block3].flatMap(b => [idOf(doc, b.rowLabel), ...b.subs.map(s => idOf(doc, s))]);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('maps sub-columns to multiple group headers using explicit, matching /ColSpan', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cellWithColSpan(doc, 'TH', page.ref, 2);
    const group2 = cellWithColSpan(doc, 'TH', page.ref, 2);
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const sub3 = cell(doc, 'TH', page.ref);
    const sub4 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);
    const d3 = cell(doc, 'TD', page.ref);
    const d4 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2]),
        row(doc, [rowLabel, sub1, sub2, sub3, sub4]),
        row(doc, [dataLabel, d1, d2, d3, d4]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    const group1Id = idOf(doc, group1);
    const group2Id = idOf(doc, group2);
    const rowLabelId = idOf(doc, rowLabel);
    const sub1Id = idOf(doc, sub1);
    const sub2Id = idOf(doc, sub2);
    const sub3Id = idOf(doc, sub3);
    const sub4Id = idOf(doc, sub4);

    expect(headersOf(doc, d1)).toEqual([rowLabelId, group1Id, sub1Id]);
    expect(headersOf(doc, d2)).toEqual([rowLabelId, group1Id, sub2Id]);
    expect(headersOf(doc, d3)).toEqual([rowLabelId, group2Id, sub3Id]);
    expect(headersOf(doc, d4)).toEqual([rowLabelId, group2Id, sub4Id]);
  });

  it('maps sub-columns to multiple group headers via an even left-to-right split when NO group cell carries /ColSpan at all, matching the real Math_Weir_PDF.pdf table_p269_0 shape (3 groups, 6 sub-columns)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cell(doc, 'TH', page.ref); // "Good" -- no ColSpan
    const group2 = cell(doc, 'TH', page.ref); // "Average" -- no ColSpan
    const group3 = cell(doc, 'TH', page.ref); // "Poor" -- no ColSpan
    const rowLabel = cell(doc, 'TH', page.ref);
    const subs = [cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref)]; // Observed/Expected x3
    const dataLabel = cell(doc, 'TD', page.ref);
    const data = [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)];

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2, group3]),
        row(doc, [rowLabel, ...subs]),
        row(doc, [dataLabel, ...data]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(results[0].success).toBe(true);
    const group1Id = idOf(doc, group1);
    const group2Id = idOf(doc, group2);
    const group3Id = idOf(doc, group3);
    const rowLabelId = idOf(doc, rowLabel);
    const subIds = subs.map(s => idOf(doc, s));

    // First pair (Observed/Expected) -> group1 ("Good").
    expect(headersOf(doc, data[0])).toEqual([rowLabelId, group1Id, subIds[0]]);
    expect(headersOf(doc, data[1])).toEqual([rowLabelId, group1Id, subIds[1]]);
    // Second pair -> group2 ("Average").
    expect(headersOf(doc, data[2])).toEqual([rowLabelId, group2Id, subIds[2]]);
    expect(headersOf(doc, data[3])).toEqual([rowLabelId, group2Id, subIds[3]]);
    // Third pair -> group3 ("Poor").
    expect(headersOf(doc, data[4])).toEqual([rowLabelId, group3Id, subIds[4]]);
    expect(headersOf(doc, data[5])).toEqual([rowLabelId, group3Id, subIds[5]]);
  });

  it('declines the even-split fallback when the sub-column count does NOT divide evenly across the groups', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cell(doc, 'TH', page.ref); // no ColSpan
    const group2 = cell(doc, 'TH', page.ref); // no ColSpan
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const sub3 = cell(doc, 'TH', page.ref); // 3 sub-columns / 2 groups -- doesn't divide evenly
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);
    const d3 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2]),
        row(doc, [rowLabel, sub1, sub2, sub3]),
        row(doc, [dataLabel, d1, d2, d3]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(idOf(doc, sub1)).toBeUndefined();
    expect(headersOf(doc, d1)).toBeUndefined();
  });

  it('declines the even-split fallback when only SOME group cells carry /ColSpan (a partial mix), rather than guessing which rule applies', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cellWithColSpan(doc, 'TH', page.ref, 2); // has ColSpan
    const group2 = cell(doc, 'TH', page.ref); // no ColSpan
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const sub3 = cell(doc, 'TH', page.ref);
    const sub4 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);
    const d3 = cell(doc, 'TD', page.ref);
    const d4 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2]),
        row(doc, [rowLabel, sub1, sub2, sub3, sub4]),
        row(doc, [dataLabel, d1, d2, d3, d4]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(idOf(doc, sub1)).toBeUndefined();
    expect(headersOf(doc, d1)).toBeUndefined();
  });

  it('leaves a multi-group block untouched (no /Headers, no /ID) when ColSpan is missing or ambiguous, rather than guessing a split', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cell(doc, 'TH', page.ref); // no ColSpan
    const group2 = cell(doc, 'TH', page.ref); // no ColSpan
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const sub3 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);
    const d3 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2]),
        row(doc, [rowLabel, sub1, sub2, sub3]),
        row(doc, [dataLabel, d1, d2, d3]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const results = pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    // Corner + row-label still get plain Scope (unaffected by the ambiguous group).
    expect(scopeOf(doc, corner)).toBe('Both');
    expect(scopeOf(doc, rowLabel)).toBe('Row');
    // But no Headers/IDs anywhere -- correctly bailed rather than guessed.
    expect(idOf(doc, sub1)).toBeUndefined();
    expect(headersOf(doc, d1)).toBeUndefined();
    expect(results[0].after).toContain('outside row 0/column 0 left unscoped');
  });

  it('does not classify a row pair with equal group/sub-header counts as a multi-level block (not a real hierarchy)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group1 = cell(doc, 'TH', page.ref);
    const group2 = cell(doc, 'TH', page.ref);
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group1, group2]), // 2 real groups
        row(doc, [rowLabel, sub1, sub2]), // 2 real sub-headers -- EQUAL count, not a real hierarchy
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(idOf(doc, group1)).toBeUndefined();
    expect(idOf(doc, sub1)).toBeUndefined();
  });

  it('is idempotent: calling fixTableHeaderScope twice does not double-tag or corrupt an already-retagged block', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group = cell(doc, 'TH', page.ref);
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [
        row(doc, [corner, group]),
        row(doc, [rowLabel, sub1, sub2]),
        row(doc, [dataLabel, d1, d2]),
      ],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);
    const idAfterFirst = idOf(doc, sub1);
    const headersAfterFirst = headersOf(doc, d1);

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    expect(idOf(doc, sub1)).toBe(idAfterFirst); // unchanged, not reassigned
    expect(headersOf(doc, d1)).toEqual(headersAfterFirst); // unchanged, not duplicated
  });

  it('preserves an existing direct /A dict\'s own attributes (e.g. /RowSpan) when adding /Headers, rather than replacing /A outright', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group = cell(doc, 'TH', page.ref);
    const rowLabel = cell(doc, 'TH', page.ref);
    const sub1 = cell(doc, 'TH', page.ref);
    const sub2 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    // d1's /A is a DIRECT dict (not wrapped in an array, not an indirect
    // ref) that already carries a real /RowSpan -- a legal singleton /A
    // value per spec, and the exact shape that used to get silently
    // discarded.
    const existingAttrs = doc.context.obj({ O: PDFName.of('Table'), RowSpan: 2 });
    const d1 = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, A: existingAttrs }));
    const d2 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [corner, group]), row(doc, [rowLabel, sub1, sub2]), row(doc, [dataLabel, d1, d2])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    // /Headers got added...
    expect(headersOf(doc, d1)).toBeDefined();
    // ...but the pre-existing /RowSpan on the SAME direct dict must survive.
    const d1Dict = doc.context.lookup(d1, PDFDict);
    const aRaw = d1Dict.get(PDFName.of('A'));
    const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
    const items = a instanceof PDFArray ? a.asArray() : a ? [a] : [];
    const rowSpanSurvived = items.some(item => {
      const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
      return resolved instanceof PDFDict && resolved.get(PDFName.of('RowSpan'))?.toString() === '2';
    });
    expect(rowSpanSurvived).toBe(true);
  });

  it('reuses a header cell\'s own PRE-EXISTING /ID (from before this fix ran) rather than generating a dangling reference nothing on that cell actually carries', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const corner = cell(doc, 'TH', page.ref);
    const group = cell(doc, 'TH', page.ref);
    const rowLabel = cell(doc, 'TH', page.ref);
    // sub1 ALREADY has a real /ID from some other, earlier mechanism --
    // this fix must reference THAT id, not fabricate and reference a new
    // one that would never actually appear on sub1's own dict. /ID is a
    // byte string per ISO 32000-1 §14.7.2 (matching writeIdAttributeForFix's
    // own PDFHexString encoding), not a name -- doc.context.obj(aJsString)
    // would build a /Name instead, an unrealistic shape no real PDF's own
    // /ID ever actually has.
    const preExistingId = 'preexisting-id-123';
    const sub1 = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: page.ref, ID: PDFHexString.fromText(preExistingId) }));
    const sub2 = cell(doc, 'TH', page.ref);
    const dataLabel = cell(doc, 'TD', page.ref);
    const d1 = cell(doc, 'TD', page.ref);
    const d2 = cell(doc, 'TD', page.ref);

    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [corner, group]), row(doc, [rowLabel, sub1, sub2]), row(doc, [dataLabel, d1, d2])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    pdfStructureWriterService.fixTableHeaderScope(doc, [issueFor('table_p1_0')]);

    const actualSub1Id = idOf(doc, sub1);
    expect(actualSub1Id).toBeDefined();
    // The id on sub1's own dict never changed...
    expect(idOf(doc, sub1)).toBe(actualSub1Id);
    // ...and d1's /Headers reference must point at THAT real value, not a
    // freshly fabricated one that doesn't exist anywhere on sub1.
    expect(headersOf(doc, d1)).toContain(actualSub1Id);
  });
});
