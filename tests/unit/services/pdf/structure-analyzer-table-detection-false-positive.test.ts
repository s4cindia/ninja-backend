/**
 * Regression coverage for detectTabularContent misclassifying ordinary body
 * text as a data table.
 *
 * Root-caused live on a real math-workbook-style document: detectColumnPositions
 * only requires TWO x-positions to each recur in >=50% of a text block's
 * lines -- satisfied trivially by ordinary prose, since the left margin
 * alone is one such position for any paragraph, and a second, rarer
 * recurring indent (a hanging continuation line, a bullet/number column, an
 * inline citation) is enough to trip columnPositions.length >= 2. This
 * misclassified chapter headings, TOC entries, and numbered-problem
 * instructions as "tables" -- confirmed directly against the real document:
 * 135 of 136 flagged tables had a first-row cell count of 1 against a
 * claimed columnCount of 2-5, with row-0 text like "CHAPTER 1 Introduction:
 * Preventing Exclusion..." and "Read the problems carefully and solve as
 * many as you can." -- prose, not headers. The existing merge-safety gate
 * (PR #529) already refused to auto-fix these (correctly), but the audit
 * still counted every one as a real, open MATTERHORN-15-002/TABLE-MISSING-
 * SUMMARY/TABLE-ACCESSIBILITY issue -- pure noise inflating the issue count
 * with nothing an operator could actually act on.
 *
 * isGenuinelyTabular distinguishes the two by checking column POPULATION,
 * not just position recurrence: real tabular data has multiple columns each
 * consistently populated across rows; misdetected prose funnels almost all
 * of a line's text into whichever detected column is nearest -- one
 * dominant column, with the others populated by rare accidental spillover
 * only.
 *
 * Two real CodeRabbit review findings on this fix changed WHERE and HOW
 * isGenuinelyTabular applies (see isGenuinelyTabular's own doc comment for
 * the full detail): it now only filters the untagged-document branch of
 * analyzeTables (detectTabularContent itself keeps every candidate, so a
 * tagged PDF's structure-tree matching is never starved of a real
 * candidate), and its marker-column check matches marker SYNTAX rather than
 * relying on value dominance (which false-positived on a repeated
 * categorical column and false-negatived on a real ordered list).
 */

import { describe, it, expect } from 'vitest';
import { structureAnalyzerService, TableCell, TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { TextBlock, TextLine, TextItem, DocumentText } from '../../../../src/services/pdf/text-extractor.service';

// isGenuinelyTabular / detectTabularContent are private; exercise via cast,
// same pattern used throughout this test suite for private helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const v = structureAnalyzerService as any;

function cell(row: number, column: number, text: string): TableCell {
  return { row, column, text, isHeader: false, rowSpan: 1, colSpan: 1 };
}

describe('StructureAnalyzerService.isGenuinelyTabular', () => {
  it('rejects a grid where only one column is ever populated (the real misdetected-prose signature)', () => {
    // 10 rows, 3 "columns" -- column 0 populated every row (the actual body
    // text), columns 1 and 2 only hit by rare, isolated spillover (well
    // under any reasonable population bar).
    const cells: TableCell[] = [];
    for (let row = 0; row < 10; row++) {
      cells.push(cell(row, 0, `line ${row} of ordinary paragraph text`));
    }
    cells.push(cell(2, 1, 'stray'));
    cells.push(cell(5, 2, 'stray'));

    expect(v.isGenuinelyTabular(cells, 10, 3)).toBe(false);
  });

  it('accepts a genuine table where at least two columns are consistently populated', () => {
    const cells: TableCell[] = [];
    const rows = [['Name', 'Age', 'City'], ['Alice', '30', 'NYC'], ['Bob', '25', 'LA'], ['Carol', '35', 'SF']];
    rows.forEach((r, row) => r.forEach((text, column) => cells.push(cell(row, column, text))));

    expect(v.isGenuinelyTabular(cells, 4, 3)).toBe(true);
  });

  it('accepts a real table even with one genuinely sparse column (an occasional blank "notes" cell)', () => {
    const cells: TableCell[] = [];
    for (let row = 0; row < 10; row++) {
      cells.push(cell(row, 0, `Item ${row}`));
      cells.push(cell(row, 1, `${row * 2}`));
    }
    // "Notes" column populated in only 2 of 10 rows -- legitimately sparse,
    // but columns 0 and 1 alone already clear the >=2-columns bar.
    cells.push(cell(1, 2, 'see appendix'));
    cells.push(cell(7, 2, 'flagged'));

    expect(v.isGenuinelyTabular(cells, 10, 3)).toBe(true);
  });

  it('rejects an empty grid (no populated cells at all)', () => {
    expect(v.isGenuinelyTabular([], 5, 2)).toBe(false);
  });

  // Root-caused live, distinct from the row-0-only-prose signature above:
  // a bulleted list's marker column and text column are BOTH populated in
  // nearly every row (unlike misdetected prose), so the population check
  // alone accepts it -- e.g. a real sample: column 0 = "•" in every row,
  // column 1 = the actual (long, varied) item text.
  it('rejects a bulleted list where one column is dominated by a single short repeated marker', () => {
    const cells: TableCell[] = [];
    for (let row = 0; row < 8; row++) {
      cells.push(cell(row, 0, '•'));
      cells.push(cell(row, 1, `Understand the difference between concept ${row} and its application`));
    }

    expect(v.isGenuinelyTabular(cells, 8, 2)).toBe(false);
  });

  it('does not treat a short-but-highly-varied data column (e.g. TOC-style page numbers) as a marker column', () => {
    const cells: TableCell[] = [];
    for (let row = 0; row < 8; row++) {
      // Short like a real marker, but a BARE digit with no trailing
      // delimiter never matches LIST_MARKER_PATTERN -- real varied short
      // data, not a marker column.
      cells.push(cell(row, 0, `${row + 1}`));
      cells.push(cell(row, 1, `Section title for chapter ${row}, a longer heading`));
    }

    expect(v.isGenuinelyTabular(cells, 8, 2)).toBe(true);
  });

  // Real CodeRabbit review finding on this fix's first version: a dominance-
  // based marker check ("does one value cover most of the column?") wrongly
  // rejects a genuine, repeated CATEGORICAL data column -- e.g. a real
  // Feature/Available table with values "Available, Yes, Yes, No" hits the
  // dominance bar (2 of 4 = 50%) purely because there are only two possible
  // answers, not because it's a list marker.
  it('does not treat a repeated categorical data column (e.g. Yes/No) as a marker column', () => {
    const cells: TableCell[] = [];
    const values = ['Available', 'Yes', 'Yes', 'No'];
    values.forEach((value, row) => {
      cells.push(cell(row, 0, `Feature ${row}`));
      cells.push(cell(row, 1, value));
    });

    expect(v.isGenuinelyTabular(cells, values.length, 2)).toBe(true);
  });

  // The other half of the same CodeRabbit finding: dominance alone MISSES a
  // real ordered list, since every marker ("1.", "2.", "3.") is a distinct
  // value -- none of them "dominates." Matching marker SYNTAX instead
  // catches this correctly.
  it('rejects an ordered list where every row has a distinct numbered marker', () => {
    const cells: TableCell[] = [];
    for (let row = 0; row < 6; row++) {
      cells.push(cell(row, 0, `${row + 1}.`));
      cells.push(cell(row, 1, `Complete exercise ${row} before moving to the next section`));
    }

    expect(v.isGenuinelyTabular(cells, 6, 2)).toBe(false);
  });
});

describe('StructureAnalyzerService end-to-end false-positive guard', () => {
  function makeItem(text: string, x: number): TextItem {
    return {
      text,
      pageNumber: 1,
      position: { x, y: 0, width: 50, height: 12 },
      font: { name: 'Helvetica', size: 12, isBold: false, isItalic: false },
      transform: [12, 0, 0, 12, x, 0],
    };
  }

  function makeLine(items: TextItem[]): TextLine {
    return {
      text: items.map(i => i.text).join(' '),
      pageNumber: 1,
      items,
      boundingBox: { x: 0, y: 0, width: 400, height: 12 },
      isHeading: false,
    };
  }

  function documentTextFor(block: TextBlock): DocumentText {
    return {
      pages: [{
        pageNumber: 1, width: 400, height: 600, text: block.text,
        items: block.lines.flatMap(l => l.items), lines: block.lines, blocks: [block],
        wordCount: 0, characterCount: 0,
      }],
      fullText: block.text, totalWords: 0, totalCharacters: 0, totalPages: 1,
      languages: [], readingOrder: 'left-to-right',
    };
  }

  // detectTabularContent itself keeps EVERY layout candidate unconditionally
  // now (a real CodeRabbit review finding on this fix: filtering here, before
  // enhanceTablesFromTags's positional matching runs, doesn't remove the
  // real /Table struct element a rejected candidate would have paired with
  // in a tagged PDF -- it just leaves that element to be force-paired with a
  // DIFFERENT, unrelated candidate via consumeNextTable's global-queue
  // fallback, corrupting that pairing instead). isGenuinelyTabular only
  // filters the FINAL result of the untagged-document branch in
  // analyzeTables, below, where no struct tree exists to corrupt.
  it('detectTabularContent itself no longer filters -- every layout candidate is kept for structure-tree matching to consider', () => {
    const lines: TextLine[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(makeLine([
        makeItem('•', 0),
        makeItem(`Understand concept ${i} and how it applies to the lesson`, 20),
      ]));
    }
    const block: TextBlock = {
      text: lines.map(l => l.text).join('\n'),
      pageNumber: 1,
      lines,
      boundingBox: { x: 0, y: 0, width: 400, height: 96 },
      type: 'list',
    };

    const tables: TableInfo[] = v.detectTabularContent([block], 1);

    expect(tables.length).toBe(1);
  });

  it('an untagged document does not report a table for ordinary prose whose raw x-position recurrence trips the column filter without genuine multi-row population', async () => {
    // 10 lines of body text, every line anchored at x=0 (the paragraph's
    // left margin -- recurs in 100% of lines, a real column). Only 2 of the
    // 10 lines ALSO carry a cluster of 3 short items near x=300 (e.g. a
    // stacked numeric citation/footnote marker) -- detectColumnPositions
    // counts raw ITEM occurrences, not distinct lines, so 2 lines x 3 items
    // = 6 occurrences clears its >=5 (10*0.5) threshold and gets treated as
    // a second "column" -- but buildTableCells collapses same-line items
    // into one cell per (row, column), so the resulting population is only
    // 2 of 10 rows (20%) -- well under a genuine table's column population,
    // and the exact mismatch (raw recurrence high, real row population low)
    // this guard exists to catch.
    const lines: TextLine[] = [];
    for (let i = 0; i < 10; i++) {
      const items = [makeItem(`Paragraph text continues on line ${i} of the chapter`, 0)];
      if (i === 2 || i === 6) {
        items.push(makeItem('1', 300), makeItem('2', 300), makeItem('3', 300));
      }
      lines.push(makeLine(items));
    }
    const block: TextBlock = {
      text: lines.map(l => l.text).join('\n'),
      pageNumber: 1,
      lines,
      boundingBox: { x: 0, y: 0, width: 400, height: 120 },
      type: 'paragraph',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables: TableInfo[] = await v.analyzeTables({} as any, documentTextFor(block), false);

    expect(tables).toEqual([]);
  });

  it('an untagged document does not report a table for a bulleted list, where both the marker and text columns are populated every row', async () => {
    // 8 list items: every line has a bullet glyph at x=0 (recurs in 100% of
    // lines) and the item's real text at x=20 (also 100%) -- both columns
    // fully populated every row, which the population guard alone accepts.
    // A real live sample had exactly this shape: column 0 = "•" in
    // every row, column 1 = the actual (long, varied) item text.
    const lines: TextLine[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(makeLine([
        makeItem('•', 0),
        makeItem(`Understand concept ${i} and how it applies to the lesson`, 20),
      ]));
    }
    const block: TextBlock = {
      text: lines.map(l => l.text).join('\n'),
      pageNumber: 1,
      lines,
      boundingBox: { x: 0, y: 0, width: 400, height: 96 },
      type: 'list',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables: TableInfo[] = await v.analyzeTables({} as any, documentTextFor(block), false);

    expect(tables).toEqual([]);
  });
});
