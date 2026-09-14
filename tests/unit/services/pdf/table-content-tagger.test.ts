import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  mergeRanges,
  matchCellRanges,
  insertMarkedContentSpans,
  type ContentRange,
} from '../../../../src/services/pdf/table-content-tagger';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { locateTextRun } from '../../../../src/services/pdf/contrast-content-stream';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import type { TableCell, TextItem } from '../../../../src/services/pdf/structure-analyzer.service';

describe('mergeRanges', () => {
  it('merges overlapping ranges into their union', () => {
    expect(mergeRanges([{ start: 0, end: 10 }, { start: 5, end: 15 }])).toEqual([{ start: 0, end: 15 }]);
  });

  it('merges touching ranges (end === next start)', () => {
    expect(mergeRanges([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it('keeps well-separated ranges distinct, sorted by start', () => {
    expect(mergeRanges([{ start: 50, end: 60 }, { start: 0, end: 10 }])).toEqual([
      { start: 0, end: 10 },
      { start: 50, end: 60 },
    ]);
  });

  it('handles a single range and an empty array', () => {
    expect(mergeRanges([{ start: 5, end: 9 }])).toEqual([{ start: 5, end: 9 }]);
    expect(mergeRanges([])).toEqual([]);
  });
});

// Same shape as contrast-content-stream.test.ts's twoLineStream: two
// separate BT…ET text objects, well outside each other's ambiguity margin.
const twoLineStream = `q
BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 150 Tm
<48656C6C6F> Tj
T*
ET
Q
q
BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 120 Tm
<5365636F6E64> Tj
T*
ET
Q
`;

function buildItem(x: number, baselineY: number, text = 'x'): TextItem {
  return {
    text,
    pageNumber: 1,
    position: { x, y: 0, width: 10, height: 10 },
    font: { name: 'F1', size: 12, isBold: false, isItalic: false },
    transform: [1, 0, 0, 1, x, baselineY],
  };
}

function buildCell(sourceItems: TextItem[]): TableCell {
  return {
    row: 0,
    column: 0,
    text: sourceItems.map(i => i.text).join(' '),
    isHeader: false,
    rowSpan: 1,
    colSpan: 1,
    sourceItems,
  };
}

describe('matchCellRanges', () => {
  it('classifies a cell as fully resolved when every source item finds a high-confidence match, one range per distinct run', () => {
    const cell = buildCell([buildItem(50, 150, 'Hello'), buildItem(50, 120, 'Second')]);
    const result = matchCellRanges(twoLineStream, cell);

    expect(result.status).toBe('full');
    expect(result.matchedItemCount).toBe(2);
    expect(result.totalItemCount).toBe(2);
    expect(result.ranges).toHaveLength(2);
    expect(twoLineStream.slice(result.ranges[0].start, result.ranges[0].end)).toContain('48656C6C6F');
    expect(twoLineStream.slice(result.ranges[1].start, result.ranges[1].end)).toContain('5365636F6E64');
  });

  it('classifies a cell as partially resolved when only some items match', () => {
    const cell = buildCell([buildItem(50, 150, 'Hello'), buildItem(999, 999, 'Nowhere')]);
    const result = matchCellRanges(twoLineStream, cell);

    expect(result.status).toBe('partial');
    expect(result.matchedItemCount).toBe(1);
    expect(result.totalItemCount).toBe(2);
    expect(result.ranges).toHaveLength(1);
  });

  it('classifies a cell as unresolved when no items match', () => {
    const cell = buildCell([buildItem(999, 999, 'Nowhere')]);
    const result = matchCellRanges(twoLineStream, cell);

    expect(result.status).toBe('unresolved');
    expect(result.matchedItemCount).toBe(0);
    expect(result.ranges).toEqual([]);
  });

  it('classifies a cell with no source items as unresolved', () => {
    const cell: TableCell = { row: 0, column: 0, text: '', isHeader: false, rowSpan: 1, colSpan: 1 };
    const result = matchCellRanges(twoLineStream, cell);

    expect(result.status).toBe('unresolved');
    expect(result.totalItemCount).toBe(0);
    expect(result.ranges).toEqual([]);
  });
});

async function realPdfWithLines(lines: Array<{ text: string; x: number; y: number }>): Promise<PDFDocument> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 14, font });
  // save + reload so the draws are flushed into a real, loadable content stream
  return PDFDocument.load(await src.save());
}

/** Walks pdfjs's includeMarkedContent item stream, joining shown text under each MCID (format p{objId}_mc{mcid}). */
function extractTextByMcid(textContent: { items: unknown[] }): Map<number, string> {
  const byMcid = new Map<number, string>();
  const stack: number[] = [];
  for (const raw of textContent.items) {
    const item = raw as { type?: string; id?: string; str?: string };
    if (item.type) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        const m = (item.id ?? '').match(/_mc(\d+)$/);
        stack.push(m ? Number(m[1]) : -1);
      } else if (item.type === 'endMarkedContent') {
        stack.pop();
      }
      continue;
    }
    const activeMcid = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (activeMcid >= 0 && typeof item.str === 'string') {
      byMcid.set(activeMcid, (byMcid.get(activeMcid) ?? '') + item.str);
    }
  }
  return byMcid;
}

describe('insertMarkedContentSpans', () => {
  it('wraps a real content-stream run with a new BDC/EMC MCID span, verified via a real pdfjs re-parse', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }, { text: 'BarLine', x: 50, y: 470 }]);
    const content = decodePageContent(doc, 1)!;
    const match = locateTextRun(content, { x: 50, baselineY: 500 });
    expect(match).toBeTruthy();

    const spans = insertMarkedContentSpans(doc, 1, [
      { range: { start: match!.start, end: match!.lastShowEnd }, id: 'cell-a' },
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ mcid: 0, id: 'cell-a' });

    const newContent = decodePageContent(doc, 1)!;
    expect(newContent).toContain('/Span <</MCID 0>> BDC');
    expect(newContent).toContain('EMC');

    const savedBuffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(savedBuffer, 'tagged-single.pdf');
    try {
      const page = await parsedPdf.pdfjsDoc.getPage(1);
      const textContent = await page.getTextContent({ includeMarkedContent: true });
      const byMcid = extractTextByMcid(textContent as unknown as { items: unknown[] });

      expect(byMcid.get(0)).toBe('FooLine');
      // The second line was never touched -- still present in the page's
      // overall text, outside any MCID.
      const allText = (textContent.items as Array<{ str?: string }>).map(i => i.str ?? '').join('');
      expect(allText).toContain('BarLine');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  /**
   * The single most safety-critical property of this whole slice: every
   * new insertion shifts later byte offsets on the same page, so applying
   * two in one batch must not let the first insertion corrupt the second's
   * (already-resolved, pre-insertion) offset. Mirrors this codebase's
   * proven "collect all insertions, apply strictly right-to-left" pattern
   * (Seam-C's content-stream.ts, pdf-contrast-writer.service.ts).
   */
  it('inserts multiple spans on the same page in one batch without an earlier insertion corrupting a later offset', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }, { text: 'BarLine', x: 50, y: 470 }]);
    const content = decodePageContent(doc, 1)!;
    const matchFoo = locateTextRun(content, { x: 50, baselineY: 500 })!;
    const matchBar = locateTextRun(content, { x: 50, baselineY: 470 })!;
    expect(matchFoo).toBeTruthy();
    expect(matchBar).toBeTruthy();
    expect(matchFoo.start).toBeLessThan(matchBar.start);

    const spans = insertMarkedContentSpans(doc, 1, [
      { range: { start: matchFoo.start, end: matchFoo.lastShowEnd }, id: 'foo' },
      { range: { start: matchBar.start, end: matchBar.lastShowEnd }, id: 'bar' },
    ]);

    expect(spans).toHaveLength(2);
    const fooSpan = spans.find(s => s.id === 'foo')!;
    const barSpan = spans.find(s => s.id === 'bar')!;
    expect(fooSpan.mcid).toBe(0);
    expect(barSpan.mcid).toBe(1);

    const savedBuffer = Buffer.from(await doc.save());
    const parsedPdf = await pdfParserService.parseBuffer(savedBuffer, 'tagged-multi.pdf');
    try {
      const page = await parsedPdf.pdfjsDoc.getPage(1);
      const textContent = await page.getTextContent({ includeMarkedContent: true });
      const byMcid = extractTextByMcid(textContent as unknown as { items: unknown[] });

      expect(byMcid.get(0)).toBe('FooLine');
      expect(byMcid.get(1)).toBe('BarLine');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('allocates new MCIDs starting after the page\'s existing usage, not from 0', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }]);
    const original = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `${original}\n/P << /MCID 3 >> BDC\nq Q\nEMC\n`);

    const content = decodePageContent(doc, 1)!;
    const match = locateTextRun(content, { x: 50, baselineY: 500 })!;
    const spans = insertMarkedContentSpans(doc, 1, [{ range: { start: match.start, end: match.lastShowEnd } }]);

    expect(spans[0].mcid).toBe(4);
  });

  it('rejects two byte-identical ranges rather than silently double-wrapping or merging them', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }]);
    const range: ContentRange = { start: 10, end: 20 };

    expect(() => insertMarkedContentSpans(doc, 1, [{ range, id: 'a' }, { range: { ...range }, id: 'b' }])).toThrow();
  });

  it('returns an empty array for an empty request list without touching the page', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }]);
    const before = decodePageContent(doc, 1);

    expect(insertMarkedContentSpans(doc, 1, [])).toEqual([]);
    expect(decodePageContent(doc, 1)).toBe(before);
  });

  it('throws rather than silently no-oping for an out-of-range page', async () => {
    const doc = await realPdfWithLines([{ text: 'FooLine', x: 50, y: 500 }]);

    expect(() => insertMarkedContentSpans(doc, 99, [{ range: { start: 0, end: 1 } }])).toThrow();
  });
});
