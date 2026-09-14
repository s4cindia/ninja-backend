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

  /**
   * Regression for a real CodeRabbit/Codex finding on PR #546: /THead sets
   * hasHeaderRow but previously never recursed into its own /TR children
   * (unlike /TBody, which did), so a genuinely well-tagged table with a
   * multi-cell header row under /THead plus a trivial one-row /TBody was
   * undercounted to structureRowCount=1/structureCellCount=1 -- wrongly
   * tripping the trivial-table rule on a correctly-tagged table.
   */
  it('recurses into /THead the same as /TBody, so a real multi-cell header row is not miscounted as trivial', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const th1 = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
    const th2 = doc.context.register(doc.context.obj({ S: PDFName.of('TH'), Pg: pageRef }));
    const headerTr = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [th1, th2] }));
    const thead = doc.context.register(doc.context.obj({ S: PDFName.of('THead'), K: [headerTr] }));
    const td = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    const bodyTr = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [td] }));
    const tbody = doc.context.register(doc.context.obj({ S: PDFName.of('TBody'), K: [bodyTr] }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [thead, tbody] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.hasHeaderRow).toBe(true);
    // 1 header row + 1 body row = 2 rows; 2 TH + 1 TD = 3 cells -- not the
    // trivial (<=1, <=1) shape, so isGenuinelyTabularDespiteTrivialMatch
    // must never even be computed for this correctly-tagged table.
    expect(tableInfo.structureRowCount).toBe(2);
    expect(tableInfo.structureCellCount).toBe(3);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBeUndefined();
  });

  /**
   * Regression for a real Codex finding on PR #546: a valid PDF32000
   * single-child /K representation (a lone dict/ref instead of a
   * one-element array) previously made both walkers' `kids instanceof
   * PDFArray` guard skip the node entirely, leaving hasHeaderRow/
   * structureRowCount/structureCellCount all unset -- silently defeating
   * the exact one-row/one-cell decorative box this whole feature targets.
   */
  it('handles a singleton (non-array) /K on both the Table and its TR, not just the array form', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const pageRef = doc.getPages()[0].ref;
    const td = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRef }));
    // TR.K is a lone ref, not [ref] -- and so is Table.K below.
    const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: td }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: trDict }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    const tableInfo = makeTableInfo('table_p1_0', 1, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.structureRowCount).toBe(1);
    expect(tableInfo.structureCellCount).toBe(1);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBe(true);
  });

  /**
   * Regression for a real Codex finding on PR #546: consumeNextTable's
   * cross-page fallback (pageReassigned) leaves cells/rowCount/columnCount
   * describing the candidate's ORIGINAL (different) page, not the real
   * struct element's page -- classifying them with isGenuinelyTabular would
   * judge unrelated content and could emit a critical "not tagged" finding
   * with a bounding box copied from another page entirely.
   */
  it('does not compute isGenuinelyTabularDespiteTrivialMatch for a pageReassigned (cross-page-fallback) match', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]); // page 1 -- has the only real /Table (trivial)
    doc.addPage([400, 600]); // page 2 -- no real /Table at all
    const pageRefs = doc.getPages().map(p => p.ref);

    const td = doc.context.register(doc.context.obj({ S: PDFName.of('TD'), Pg: pageRefs[0] }));
    const trDict = doc.context.register(doc.context.obj({ S: PDFName.of('TR'), K: [td] }));
    const tableDict = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: [trDict] }));
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: [tableDict] });
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [documentDict] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRootDict));

    // Layout-detected on page 2 (which has no real /Table of its own), so it
    // can only be consumed via the global-queue fallback onto page 1's table
    // -- exactly the pageReassigned path.
    const tableInfo = makeTableInfo('table_p2_0', 2, genuinelyTabularCells(), 4, 3);
    await structureAnalyzerAny.enhanceTablesFromTags({ pdfLibDoc: doc }, [tableInfo]);

    expect(tableInfo.structureMatched).toBe(true);
    expect(tableInfo.pageReassigned).toBe(true);
    expect(tableInfo.structureRowCount).toBe(1);
    expect(tableInfo.structureCellCount).toBe(1);
    expect(tableInfo.isGenuinelyTabularDespiteTrivialMatch).toBeUndefined();
  });
});
