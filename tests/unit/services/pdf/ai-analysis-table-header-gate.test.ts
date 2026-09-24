import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo, TableCell } from '../../../../src/services/pdf/structure-analyzer.service';
import type { TextItem } from '../../../../src/services/pdf/text-extractor.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

function boldItem(text: string): TextItem {
  return {
    text,
    pageNumber: 1,
    position: { x: 0, y: 0, width: 10, height: 10 },
    font: { name: 'Helvetica-Bold', size: 10, isBold: true, isItalic: false },
    transform: [1, 0, 0, 1, 0, 0],
  };
}

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-formula.test.ts / ai-analysis-contrast.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const CONFIG: AiRemediationConfig = {
  tableFixMode: 'summaries-to-pdf-headers-as-guidance',
  altTextMode: 'apply-to-pdf',
  listMode: 'auto-resolve-decorative',
  languageMode: 'apply-to-pdf',
  colorContrastMode: 'guidance-only',
  linkTextMode: 'guidance-only',
  formFieldMode: 'guidance-only',
  bookmarkMode: 'guidance-only',
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

// Mirrors buildTableCells (structure-analyzer.service.ts): a fully regular
// row 0 has exactly one cell per column. headerRowCellCount lets a test
// simulate a merged/irregular header row -- fewer cells than columnCount,
// exactly what buildTableCells produces when a column bucket got no text.
// No cell carries a bold sourceItems entry by default -- classifyTableHeaderOrientation
// (structure-analyzer.service.ts) returns null for a table with no bold signal at
// all, matching real "genuinely ambiguous, no evidence either way" data.
function buildTable(columnCount: number, headerRowCellCount = columnCount): TableInfo {
  const cells: TableCell[] = [];
  for (let col = 0; col < headerRowCellCount; col++) {
    cells.push({ row: 0, column: col, text: `h${col}`, isHeader: false, rowSpan: 1, colSpan: 1 });
  }
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 3,
    columnCount,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells,
    issues: ['Table has no header cells (TH). Add row or column headers.'],
    isAccessible: false,
  };
}

/** A table whose row 0 carries real bold sourceItems -- classifyTableHeaderOrientation returns 'row'. */
function buildRowHeaderedTable(columnCount: number): TableInfo {
  const table = buildTable(columnCount);
  for (const cell of table.cells) cell.sourceItems = [boldItem(cell.text)];
  return table;
}

/**
 * A table whose row 0 is a caption/title merged into a single cell (fewer
 * cells than columnCount, matching the real Math_Kim shape found live: e.g.
 * "Table 3.1.1. Math Navigation Chart..." occupying only one column
 * bucket), and whose row 1 is the genuine, fully-populated header row.
 */
function buildTableWithLeadingCaptionRow(columnCount: number): TableInfo {
  const cells: TableCell[] = [{ row: 0, column: 0, text: 'Table 1.1. Caption', isHeader: false, rowSpan: 1, colSpan: 1 }];
  for (let col = 0; col < columnCount; col++) {
    cells.push({ row: 1, column: col, text: `h${col}`, isHeader: false, rowSpan: 1, colSpan: 1 });
  }
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 3,
    columnCount,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells,
    issues: ['Table has no header cells (TH). Add row or column headers.'],
    isAccessible: false,
  };
}

/** A 2-column, N-row table whose column 0 carries real bold sourceItems on every row -- classifyTableHeaderOrientation returns 'column' (the key-value/label-value shape). */
function buildColumnHeaderedTable(rowCount: number): TableInfo {
  const cells: TableCell[] = [];
  for (let row = 0; row < rowCount; row++) {
    cells.push({ row, column: 0, text: `label${row}`, isHeader: false, rowSpan: 1, colSpan: 1, sourceItems: [boldItem(`label${row}`)] });
    cells.push({ row, column: 1, text: `value${row}`, isHeader: false, rowSpan: 1, colSpan: 1 });
  }
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount,
    columnCount: 2,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells,
    issues: ['Table has no header cells (TH). Add row or column headers.'],
    isAccessible: false,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'serious',
  code: 'MATTERHORN-15-002',
  message: 'Data table on page 1 has no headers',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: table-header-fix rule-based column-count gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the row-oriented rule-based fix for a tagged, bold-row-headered table right at the SIMPLE_TABLE_MAX_COLUMNS boundary (6 columns)', async () => {
    const tableById = new Map([['table_p1_0', buildRowHeaderedTable(6)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix');
    expect(res.model).toBe('rule-based');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('applies the column-oriented rule-based fix for a tagged, bold-column-headered key-value table (2 columns)', async () => {
    const tableById = new Map([['table_p1_0', buildColumnHeaderedTable(5)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix-column');
    expect(res.model).toBe('rule-based');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('falls through to AI review for a genuine corner-header table (both row AND column bold signals) instead of applying a row-only fix', async () => {
    // CodeRabbit finding on PR #560, confirmed real: classifyTableHeaderOrientation
    // returns 'ambiguous' (not null) when both signals fire -- the dispatch
    // gate must bail entirely here rather than falling through to
    // findRegularHeaderRowIndex, which has no bold requirement and would
    // otherwise confidently apply a row-only fix to a table that also needs
    // its column tagged.
    const cells: TableCell[] = [
      { row: 0, column: 0, text: 'h0', isHeader: false, rowSpan: 1, colSpan: 1, sourceItems: [boldItem('h0')] },
      { row: 0, column: 1, text: 'h1', isHeader: false, rowSpan: 1, colSpan: 1, sourceItems: [boldItem('h1')] },
      { row: 1, column: 0, text: 'r1', isHeader: false, rowSpan: 1, colSpan: 1, sourceItems: [boldItem('r1')] },
      { row: 1, column: 1, text: 'v1', isHeader: false, rowSpan: 1, colSpan: 1 },
      { row: 2, column: 0, text: 'r2', isHeader: false, rowSpan: 1, colSpan: 1, sourceItems: [boldItem('r2')] },
      { row: 2, column: 1, text: 'v2', isHeader: false, rowSpan: 1, colSpan: 1 },
    ];
    const table: TableInfo = {
      id: 'table_p1_0', pageNumber: 1, position: { x: 0, y: 0, width: 100, height: 100 },
      rowCount: 3, columnCount: 2, hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
      cells, issues: [], isAccessible: false,
    };
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue(null);

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('downgrades both header suggestion types to guidance-only when tableFixMode is guidance-only', async () => {
    // CodeRabbit finding on PR #560, confirmed real: both branches used to
    // hardcode applyMode: 'apply-to-pdf' regardless of config, so an
    // operator who configured guidance-only headers could still have one
    // silently applied on approval.
    const guidanceConfig: AiRemediationConfig = { ...CONFIG, tableFixMode: 'guidance-only' };

    const rowTableById = new Map([['table_p1_0', buildRowHeaderedTable(6)]]);
    const rowRes = await svc.dispatchIssue(ISSUE, { isTagged: true, pages: [] }, guidanceConfig, new Map(), rowTableById, new Map());
    expect(rowRes.suggestionType).toBe('table-header-fix');
    expect(rowRes.applyMode).toBe('guidance-only');

    const columnTableById = new Map([['table_p1_0', buildColumnHeaderedTable(5)]]);
    const columnRes = await svc.dispatchIssue(ISSUE, { isTagged: true, pages: [] }, guidanceConfig, new Map(), columnTableById, new Map());
    expect(columnRes.suggestionType).toBe('table-header-fix-column');
    expect(columnRes.applyMode).toBe('guidance-only');
  });

  it('applies the row-oriented fix for a regular row-0 table with NO bold signal at all -- findRegularHeaderRowIndex needs no typographic evidence', async () => {
    // This is the key behavioral difference from the bold-only design: a
    // table whose row 0 is already fully-populated (matching columnCount)
    // is real, structural evidence on its own, independent of bold
    // formatting -- real Math_Kim data has zero bold cells anywhere, so
    // requiring bold here would make this whole path dead on real data.
    const tableById = new Map([['table_p1_0', buildTable(2)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('applies the row-oriented fix for a table whose real header is at row 1, not row 0 (the real Math_Kim shape: a leading caption row)', async () => {
    const tableById = new Map([['table_p1_0', buildTableWithLeadingCaptionRow(2)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('falls through to AI review for a tagged table just past the boundary (7 columns)', async () => {
    const tableById = new Map([['table_p1_0', buildTable(7)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue({
      suggestionType: 'table-header-fix',
      guidance: 'AI-drafted',
      confidence: 0.6,
      rationale: 'complex table, needs review',
      model: 'gemini',
      applyMode: 'guidance-only',
    });

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, tableById.get('table_p1_0'));
    expect(res.model).toBe('gemini');
  });

  it('still gates untagged PDFs to AI review regardless of column count', async () => {
    const tableById = new Map([['table_p1_0', buildTable(2)]]);
    const parsed = { isTagged: false, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue(null);

    await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalled();
  });

  it('falls through to AI review for a tagged 4-6-column table with an irregular header row and no bold signal', async () => {
    // 5 columns, header row only produced 3 cells (buildTableCells' real
    // signature for "a column bucket got no text this row", e.g. a merged/
    // spanning header cell) AND no bold sourceItems anywhere, AND no OTHER
    // row exists to find instead -- neither classifyTableHeaderOrientation
    // (no bold) nor findRegularHeaderRowIndex (no row within the table has
    // columnCount cells, row 0's irregular 3 included) finds real evidence,
    // so this correctly falls through rather than guessing.
    const tableById = new Map([['table_p1_0', buildTable(5, 3)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue({
      suggestionType: 'table-header-fix',
      guidance: 'AI-drafted',
      confidence: 0.6,
      rationale: 'possibly-merged header row, needs review',
      model: 'gemini',
      applyMode: 'guidance-only',
    });

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, tableById.get('table_p1_0'));
    expect(res.model).toBe('gemini');
  });

  it('falls through to AI review for TABLE-HEADERS-INCOMPLETE even within the size/regularity gate (table already has ONE header type; fixSimpleTableHeaders cannot add the other)', async () => {
    // pdf-table.validator.ts only emits TABLE-HEADERS-INCOMPLETE when the
    // table already has a header row OR column (not neither) -- promoting
    // an already-all-TH first row is a no-op that reports false "success"
    // without ever adding what's actually missing (the header column).
    const table = buildTable(5);
    table.hasHeaderRow = true;
    table.hasHeaderColumn = false;
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue({
      suggestionType: 'table-header-fix',
      guidance: 'AI-drafted',
      confidence: 0.6,
      rationale: 'complex table, only has row headers',
      model: 'gemini',
      applyMode: 'guidance-only',
    });

    const incompleteIssue = { ...ISSUE, code: 'TABLE-HEADERS-INCOMPLETE' };
    const res = await svc.dispatchIssue(incompleteIssue, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(incompleteIssue, table);
    expect(res.model).toBe('gemini');
  });

  // Real incident, Math_Nikitopoulos_PDF.pdf (2026-09-25): 2 of 3 real
  // MATTERHORN-15-002 tables were wrongly routed to AI-guidance-only
  // because findRegularHeaderRowIndex (TableInfo's own pdfjs/layout-derived
  // cell counts) disagreed with the real struct tree fixSimpleTableHeaders
  // actually mutates -- the writer, called directly, successfully found and
  // fixed a clean regular header row that findRegularHeaderRowIndex missed.
  it('REGRESSION: falls back to the real struct tree (canFixSimpleTableHeaders) and still applies when TableInfo\'s own layout-derived cell counts disagree with it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);

    const buildRow = (cellCount: number) => {
      const cellRefs = [];
      for (let i = 0; i < cellCount; i++) {
        cellRefs.push(doc.context.register(doc.context.obj({ S: PDFName.of('TD'), K: i })));
      }
      return doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: doc.context.obj(cellRefs) }));
    };
    // The REAL struct tree has a clean, regular 5-cell header row (row 0)
    // followed by a matching 5-cell data row -- canFixSimpleTableHeaders
    // must find this.
    const headerRowRef = buildRow(5);
    const dataRowRef = buildRow(5);
    const tableDict = doc.context.obj({
      S: PDFName.of('Table'),
      Pg: page.ref,
      K: doc.context.obj([headerRowRef, dataRowRef]),
    });
    const tableRef = doc.context.register(tableDict);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: tableRef });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    // Same irregular-row-0, no-bold TableInfo as the "falls through" test
    // above (5 columns, only 3 cells matched at row 0, no other regular
    // row) -- findRegularHeaderRowIndex returns null on this alone.
    const tableById = new Map([['table_p1_0', buildTable(5, 3)]]);
    const parsed = { isTagged: true, pages: [], parsedPdf: { pdfLibDoc: doc } as ParsedPDF } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix');
    expect(res.model).toBe('rule-based');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('falls through to AI review for MATTERHORN-15-004 (missing scope attribute on already-existing headers)', async () => {
    const table = buildTable(2);
    table.hasHeaderRow = true;
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue(null);

    const scopeIssue = { ...ISSUE, code: 'MATTERHORN-15-004' };
    await svc.dispatchIssue(scopeIssue, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(scopeIssue, table);
  });
});
