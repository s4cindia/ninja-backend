/**
 * Regression coverage for pdf-table-header-scope.validator.ts: a direct
 * struct-tree walk for /Table elements whose EXISTING /TH cells carry no
 * /Scope attribute (Matterhorn 15-003). Confirmed live against a real
 * 377-page document (Math_Weir_PDF via the real PAC/axesPAC desktop tool):
 * "Table header cell has no associated subcells" -- 708 failed, 0 passed --
 * an exact match to a direct struct-tree count: all 105 real /Table
 * elements already have correctly-tagged TH cells (no promotion needed),
 * and every one of their 708 TH cells has zero /Scope.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { pdfTableHeaderScopeValidator } from '../../../../src/services/pdf/validators/pdf-table-header-scope.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

function cell(doc: PDFDocument, tag: 'TD' | 'TH', pageRef: PDFRef, scope?: 'Row' | 'Column' | 'Both'): PDFRef {
  const dict: Record<string, unknown> = { S: PDFName.of(tag), Pg: pageRef };
  if (scope) {
    const attrRef = doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Scope: PDFName.of(scope) }));
    dict.A = [attrRef];
  }
  return doc.context.register(doc.context.obj(dict));
}

function row(doc: PDFDocument, cellRefs: PDFRef[]): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: cellRefs }));
}

describe('PdfTableHeaderScopeValidator', () => {
  it('flags a table whose header-row TH cells have no /Scope', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th1 = cell(doc, 'TH', page.ref);
    const th2 = cell(doc, 'TH', page.ref);
    const td1 = cell(doc, 'TD', page.ref);
    const td2 = cell(doc, 'TD', page.ref);
    const headerRow = row(doc, [th1, th2]);
    const dataRow = row(doc, [td1, td2]);
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [headerRow, dataRow] }));

    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] });
    const docRef = doc.context.register(docNode);
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('TABLE-HEADER-MISSING-SCOPE');
    expect(result.issues[0].matterhornCheckpoint).toBe('15-003');
    expect(result.issues[0].matterhornHow).toBe('M');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('table_p1_0');
    expect(result.metadata).toEqual({ totalTables: 1, tablesWithMissingScope: 1, totalThCells: 2, thCellsMissingScope: 2 });
  });

  it('does not flag a table whose TH cells already have /Scope', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th1 = cell(doc, 'TH', page.ref, 'Column');
    const th2 = cell(doc, 'TH', page.ref, 'Column');
    const headerRow = row(doc, [th1, th2]);
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [headerRow] }));

    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.thCellsMissingScope).toBe(0);
  });

  it('does not flag a table with no TH cells at all (a different issue -- MATTERHORN-15-002 territory)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const td1 = cell(doc, 'TD', page.ref);
    const td2 = cell(doc, 'TD', page.ref);
    const headerRow = row(doc, [td1, td2]);
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [headerRow] }));

    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalThCells).toBe(0);
  });

  it('reproduces the real Math_Weir_PDF.pdf shape: a 27-row, 2-column table with a TH header row and TD data rows, all TH missing /Scope', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const rows: PDFRef[] = [];
    rows.push(row(doc, [cell(doc, 'TH', page.ref), cell(doc, 'TH', page.ref)]));
    for (let i = 0; i < 26; i++) {
      rows.push(row(doc, [cell(doc, 'TD', page.ref), cell(doc, 'TD', page.ref)]));
    }
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: rows }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.metadata.totalThCells).toBe(2);
    expect(result.metadata.thCellsMissingScope).toBe(2);
  });

  it('recurses through THead/TBody wrapper rows, not only direct TR children', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th = cell(doc, 'TH', page.ref);
    const headerRow = row(doc, [th]);
    const theadRef = doc.context.register(doc.context.obj({ S: PDFName.of('THead'), K: [headerRow] }));
    const td = cell(doc, 'TD', page.ref);
    const dataRow = row(doc, [td]);
    const tbodyRef = doc.context.register(doc.context.obj({ S: PDFName.of('TBody'), K: [dataRow] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [theadRef, tbodyRef] }));

    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.metadata.totalThCells).toBe(1);
  });

  it('assigns per-page table indices matching table_p{page}_{index} (findTargetTable\'s own convention) when multiple tables share a page', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const table1Row = row(doc, [cell(doc, 'TH', page.ref)]);
    const table1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [table1Row] }));
    const table2Row = row(doc, [cell(doc, 'TH', page.ref)]);
    const table2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [table2Row] }));

    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [table1Ref, table2Ref] }));
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(2);
    expect(result.issues.map(i => i.element)).toEqual(['table_p1_0', 'table_p1_1']);
  });

  it('returns no issues when the document has no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalTables).toBe(0);
  });

  it('resolves a /Table\'s real page via a descendant\'s /Pg when neither the /Table nor any ancestor has one (real Seam-C-tagging gap, matches findTargetTable\'s own resolveElementPageRef)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const page2 = doc.addPage([612, 792]);

    // TH cells carry the only /Pg in this subtree -- on page 2, not page 1.
    const th1 = cell(doc, 'TH', page2.ref);
    const th2 = cell(doc, 'TH', page2.ref);
    const headerRow = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [th1, th2] }));
    // The /Table itself has NO /Pg (unlike every other test above).
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [headerRow] }));
    // Nor does any ancestor up to /Document.
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(2); // NOT page 1 -- a real regression this fix closes
    expect(result.issues[0].element).toBe('table_p2_0');
  });

  it('skips a /Table whose only resolvable page comes from an ancestor (not its own /Pg or subtree) rather than emit an id findTargetTable could never resolve', async () => {
    // CodeRabbit finding on PR #582, confirmed real: findTargetTable (which
    // later resolves this validator's own table_p{page}_{index} ids back to
    // a real element) has no ancestor-fallback at all -- only a table's own
    // or subtree /Pg. An ancestor-inherited page would emit an
    // unresolvable id AND shift perPageTableIndex for every OTHER real
    // table on the same page out of sync with findTargetTable's own count.
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([612, 792]);

    const th = doc.context.register(doc.context.obj({ S: PDFName.of('TH') })); // no /Pg at all
    const headerRow = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [th] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [headerRow] })); // no /Pg
    // The Document ancestor DOES carry a /Pg -- but it must NOT be consulted.
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), Pg: page1.ref, K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalTables).toBe(0);
  });

  it('skips a /Table with no resolvable page anywhere rather than fabricating page 1', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const th = doc.context.register(doc.context.obj({ S: PDFName.of('TH') })); // no /Pg
    const headerRow = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [th] }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [headerRow] })); // no /Pg
    // No ancestor has a /Pg either.
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalTables).toBe(0); // not fabricated onto page 1
  });

  it('produces a unique message per table even when two tables on the same page share an identical missing-count', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const buildTwoThTable = () => {
      const t1 = cell(doc, 'TH', page.ref);
      const t2 = cell(doc, 'TH', page.ref);
      const r = row(doc, [t1, t2]);
      return doc.context.register(doc.context.obj({ S: PDFName.of('Table'), Pg: page.ref, K: [r] }));
    };
    const table1Ref = buildTwoThTable();
    const table2Ref = buildTwoThTable();
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [table1Ref, table2Ref] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].message).not.toBe(result.issues[1].message);
  });

  it('exempts a table already organized with Headers/IDs from the Scope requirement, per Matterhorn 15-003\'s own condition text', async () => {
    // CodeRabbit finding on PR #582, confirmed real: 15-003 only applies to
    // a table "NOT organized with Headers attributes and IDs" -- a table
    // that associates data cells to header cells via /Headers is exempt
    // even though its TH cells carry no /Scope.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const th1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: page.ref, ID: doc.context.obj('h1') }));
    const th2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: page.ref, ID: doc.context.obj('h2') }));
    // /Headers is a TABLE ATTRIBUTE (ISO 32000-1 Table 337) -- lives inside
    // /A under the /Table owner, exactly like /Scope/ColSpan/RowSpan, never
    // as a direct entry on the cell dict itself (a real bug this test used
    // to encode and pass against, until fixTableHeaderScope's own
    // retagMultiLevelTableHeaders writer -- built correctly per spec --
    // proved live that this exemption never actually fired for real
    // Headers/IDs-tagged cells; see hasHeadersAttribute's own doc comment).
    const attr1Ref = doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: [doc.context.obj('h1')] }));
    const attr2Ref = doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: [doc.context.obj('h2')] }));
    const td1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, A: [attr1Ref] }));
    const td2Ref = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: page.ref, A: [attr2Ref] }));
    const tableRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Table'), Pg: page.ref,
      K: [row(doc, [th1Ref, th2Ref]), row(doc, [td1Ref, td2Ref])],
    }));
    const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [tableRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] })));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfTableHeaderScopeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalThCells).toBe(0);
    expect(result.metadata.thCellsMissingScope).toBe(0);
  });
});
