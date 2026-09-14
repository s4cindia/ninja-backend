/**
 * Regression coverage for structureRowCount/structureCellCount/
 * isGenuinelyTabularDespiteTrivialMatch, added after a real Math_Kim
 * finding: EVERY /Table structure element matched in that document
 * (165/165) turned out to be a trivial single-cell decorative box (a
 * caption/label styling box), never a real multi-row grid. Two distinct
 * defects hide behind that same trivial match, and pdf-table.validator.ts
 * needs both signals to tell them apart -- see TableInfo.
 * isGenuinelyTabularDespiteTrivialMatch's own doc comment.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { structureAnalyzerService, TableInfo, TableCell } from '../../../../src/services/pdf/structure-analyzer.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const structureAnalyzerAny = structureAnalyzerService as any;

function cell(row: number, column: number, text: string): TableCell {
  return { row, column, text, isHeader: false, rowSpan: 1, colSpan: 1 };
}

function genuinelyTabularCells(): TableCell[] {
  const rows = [['Name', 'Age', 'City'], ['Alice', '30', 'NYC'], ['Bob', '25', 'LA'], ['Carol', '35', 'SF']];
  const cells: TableCell[] = [];
  rows.forEach((r, row) => r.forEach((text, column) => cells.push(cell(row, column, text))));
  return cells;
}

function notGenuinelyTabularCells(): TableCell[] {
  // Same shape isGenuinelyTabular's own test suite uses for the false case:
  // one dominant column, others only hit by rare incidental spillover.
  const cells: TableCell[] = [];
  for (let row = 0; row < 10; row++) cells.push(cell(row, 0, `line ${row} of ordinary paragraph text`));
  cells.push(cell(2, 1, 'stray'));
  return cells;
}

function makeTableInfo(id: string, pageNumber: number, cells: TableCell[], rowCount: number, columnCount: number): TableInfo {
  return {
    id, pageNumber,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount, columnCount,
    hasHeaderRow: false, hasHeaderColumn: false, hasSummary: false,
    cells, issues: [], isAccessible: false,
  };
}

describe('structureAnalyzerService: trivial single-cell struct match detection', () => {
  it('flags structureRowCount=1/structureCellCount=1 and isGenuinelyTabularDespiteTrivialMatch=true for a trivial match paired with genuinely tabular layout content', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const tdDict = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [tdDict] }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.structureMatched).toBe(true);
    expect(tableInfo.structureRowCount).toBe(1);
    expect(tableInfo.structureCellCount).toBe(1);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBe(true);
  });

  it('flags isGenuinelyTabularDespiteTrivialMatch=false for a trivial match paired with genuinely non-tabular layout content', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const tdDict = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [tdDict] }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, notGenuinelyTabularCells(), 10, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.structureMatched).toBe(true);
    expect(tableInfo.structureRowCount).toBe(1);
    expect(tableInfo.structureCellCount).toBe(1);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBe(false);
  });

  it('does not compute isGenuinelyTabularDespiteTrivialMatch for a genuine multi-row/multi-cell struct match, and counts rows/cells correctly', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const buildRow = (texts: string[]) => {
      const cells = texts.map(() => doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef })));
      return doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: cells }));
    };
    const tr1 = buildRow(['a', 'b']);
    const tr2 = buildRow(['c', 'd']);
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [tr1, tr2] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.structureMatched).toBe(true);
    expect(tableInfo.structureRowCount).toBe(2);
    expect(tableInfo.structureCellCount).toBe(4);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBeUndefined();
  });

  it('still correctly detects hasHeaderRow via a /TH cell after removing checkRowForHeaders\' early return', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const th = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
    const td = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const tr1 = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [th, td] }));
    const tr2 = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [td, td] }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [tr1, tr2] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.hasHeaderRow).toBe(true);
    expect(tableInfo.structureRowCount).toBe(2);
    // th + td in row 1, td + td in row 2 = 4 total cells.
    expect(tableInfo.structureCellCount).toBe(4);
  });
});
