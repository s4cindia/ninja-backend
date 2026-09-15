/**
 * Unit coverage for classifyTableHeaderOrientation in isolation (see
 * ai-analysis-table-header-gate.test.ts for its integration into
 * dispatchIssue's rule-based table-header-fix gate).
 *
 * Built to fix a real gap: MATTERHORN-15-002's old rule-based auto-fix gate
 * (row-0 cell-count regularity) never passed on any of 101 real Math_Kim
 * tables, and 58/101 are exactly 2 columns -- the classic key-value
 * (label|value) shape, where the real header is the first COLUMN. This
 * classifier reuses the same bold-formatting signal (cell.sourceItems[].font.isBold)
 * detectTabularContent's own untagged-PDF heuristic already uses for the
 * identical purpose.
 */

import { describe, it, expect } from 'vitest';
import { classifyTableHeaderOrientation } from '../../../../src/services/pdf/structure-analyzer.service';
import type { TableInfo, TableCell } from '../../../../src/services/pdf/structure-analyzer.service';
import type { TextItem } from '../../../../src/services/pdf/text-extractor.service';

function boldItem(text: string): TextItem {
  return {
    text,
    pageNumber: 1,
    position: { x: 0, y: 0, width: 10, height: 10 },
    font: { name: 'Helvetica-Bold', size: 10, isBold: true, isItalic: false },
    transform: [1, 0, 0, 1, 0, 0],
  };
}

function plainItem(text: string): TextItem {
  return {
    text,
    pageNumber: 1,
    position: { x: 0, y: 0, width: 10, height: 10 },
    font: { name: 'Helvetica', size: 10, isBold: false, isItalic: false },
    transform: [1, 0, 0, 1, 0, 0],
  };
}

function baseTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 1,
    columnCount: 1,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [],
    issues: [],
    isAccessible: false,
    ...overrides,
  };
}

function cell(row: number, column: number, bold: boolean): TableCell {
  return {
    row, column, text: `r${row}c${column}`, isHeader: false, rowSpan: 1, colSpan: 1,
    sourceItems: bold ? [boldItem(`r${row}c${column}`)] : [plainItem(`r${row}c${column}`)],
  };
}

describe('classifyTableHeaderOrientation', () => {
  it('returns "row" when row 0 has a bold cell outside the corner and column 0 is not consistently bold', () => {
    const table = baseTable({
      columnCount: 3, rowCount: 2,
      cells: [
        cell(0, 0, false), cell(0, 1, true), cell(0, 2, false),
        cell(1, 0, false), cell(1, 1, false), cell(1, 2, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBe('row');
  });

  it('returns "column" for a genuine 2-column key-value table (every row\'s first cell bold)', () => {
    const table = baseTable({
      columnCount: 2, rowCount: 4,
      cells: [
        cell(0, 0, true), cell(0, 1, false),
        cell(1, 0, true), cell(1, 1, false),
        cell(2, 0, true), cell(2, 1, false),
        cell(3, 0, true), cell(3, 1, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBe('column');
  });

  it('returns "column" even when ONLY the corner cell is bold in row 0 (corner-bleed regression)', () => {
    // Regression: an earlier version of this classifier used row0.some(isBold)
    // without excluding the corner cell, so a genuine column-headered table
    // (only column 0 bold) also satisfied the row signal purely because the
    // corner cell (row 0, col 0) is a member of both groups -- both signals
    // firing meant this fell through to null instead of the correct 'column'.
    const table = baseTable({
      columnCount: 2, rowCount: 3,
      cells: [
        cell(0, 0, true), cell(0, 1, false),
        cell(1, 0, true), cell(1, 1, false),
        cell(2, 0, true), cell(2, 1, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBe('column');
  });

  it('does NOT return "column" for a sparse table where column 0 is bold but missing from some rows', () => {
    // CodeRabbit finding on PR #560, confirmed real: a table with 5 real
    // rows where only 2 have a column-0 cell (the other 3 rows' real first
    // cell sits in column 1, e.g. because column 0 is empty for them) must
    // NOT qualify just because the 2 that exist happen to be bold --
    // fixSimpleTableColumnHeaders promotes whichever cell is first in
    // EVERY row, so this would otherwise wrongly promote a real column-1
    // value cell to TH on the 3 rows with no column-0 cell.
    const table = baseTable({
      columnCount: 2, rowCount: 5,
      cells: [
        cell(0, 0, true), cell(0, 1, false),
        cell(1, 1, false), // no column-0 cell on this row
        cell(2, 0, true), cell(2, 1, false),
        cell(3, 1, false), // no column-0 cell on this row
        cell(4, 1, false), // no column-0 cell on this row
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBeNull();
  });

  it('returns null when neither row nor column shows a bold signal (genuinely ambiguous)', () => {
    const table = baseTable({
      columnCount: 2, rowCount: 3,
      cells: [
        cell(0, 0, false), cell(0, 1, false),
        cell(1, 0, false), cell(1, 1, false),
        cell(2, 0, false), cell(2, 1, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBeNull();
  });

  it('returns "ambiguous" (not null, not a guess) when both a real row header and a real column header signal are present (genuine corner-header table)', () => {
    // Distinct from null -- this is real evidence for BOTH orientations at
    // once, not "no evidence either way". The caller (ai-analysis.service.ts)
    // must bail entirely rather than falling through to
    // findRegularHeaderRowIndex, which has no bold requirement and would
    // otherwise confidently apply a row-only fix to a table that also needs
    // its column tagged (CodeRabbit finding on PR #560, confirmed real).
    const table = baseTable({
      columnCount: 3, rowCount: 3,
      cells: [
        cell(0, 0, true), cell(0, 1, true), cell(0, 2, true),
        cell(1, 0, true), cell(1, 1, false), cell(1, 2, false),
        cell(2, 0, true), cell(2, 1, false), cell(2, 2, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBe('ambiguous');
  });

  it('requires more than one row for a column-header signal (a single row is insufficient evidence)', () => {
    const table = baseTable({
      columnCount: 2, rowCount: 1,
      cells: [cell(0, 0, true), cell(0, 1, false)],
    });
    // Row 0's only non-corner cell (column 1) isn't bold, and column 0 has
    // just one row of evidence -- neither signal clears its bar.
    expect(classifyTableHeaderOrientation(table)).toBeNull();
  });

  it('returns null for a pageReassigned table without inspecting cells at all', () => {
    // cells/sourceItems describe a DIFFERENT page's content for a
    // pageReassigned table -- a bold signal read from them isn't evidence
    // about THIS table's real headers, even though the cells here look
    // like an unambiguous column-header shape.
    const table = baseTable({
      columnCount: 2, rowCount: 3,
      pageReassigned: true,
      cells: [
        cell(0, 0, true), cell(0, 1, false),
        cell(1, 0, true), cell(1, 1, false),
        cell(2, 0, true), cell(2, 1, false),
      ],
    });
    expect(classifyTableHeaderOrientation(table)).toBeNull();
  });
});
