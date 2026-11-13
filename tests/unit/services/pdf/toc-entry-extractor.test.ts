import { describe, it, expect } from 'vitest';
import { extractTocSpans, extractTocRowCandidates } from '../../../../src/services/pdf/toc-entry-extractor';

// Real, live-confirmed shapes from Karsaklian_189165_9781606497623.pdf's own
// page 7 ("Contents") content stream, captured via direct pdf-lib inspection
// (2026-11-13) -- an already-tagged InDesign export with zero TOC/TOCI
// structure and zero Link annotations anywhere in the document (S4 Carlisle
// manual QC, Round 2, item #4). Each row is three flat sibling /P spans
// (title, dot-leader, label), each with its own bare MCID.
const PAGE7_EXCERPT = `
/P <</Lang (en-US)/MCID 35 >>BDC
BT
0 0 0 1 k
/GS1 gs
/T1_0 1 Tf
24 0 0 24 185.0046 555.1201 Tm
(Contents)Tj
ET
EMC
/P <</Lang (en-US)/MCID 36 >>BDC
BT
/T1_1 1 Tf
10.5 0 0 10.5 84 513.1201 Tm
[(L)12 (ist of F)12 (igur)20 (es and )48 (T)130 (ables)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 37 >>BDC
BT
/T1_2 1 Tf
-0.02 Tw /Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 181.3334 513.1201 Tm
( )Tj
EMC
(.......................................................................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 38 >>BDC
BT
0 Tw 10.5 0 0 10.5 370.7657 513.1201 Tm
(ix)Tj
ET
EMC
/P <</Lang (en-US)/MCID 39 >>BDC
BT
/T1_1 1 Tf
10.5 0 0 10.5 84 498.1201 Tm
[(D)6 (escription)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 40 >>BDC
BT
/T1_2 1 Tf
-0.215 Tw /Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 128.2569 498.1201 Tm
( )Tj
EMC
(........................................................................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 41 >>BDC
BT
0 Tw 10.5 0 0 10.5 370.7657 498.1201 Tm
(xi)Tj
ET
EMC
/P <</Lang (en-US)/MCID 45 >>BDC
BT
0 Tc 0 Tw 10.5 0 0 10.5 84 459.1201 Tm
(Chapter 1)Tj
/Span<</ActualText<FEFF0009>>> BDC
( )Tj
EMC
5.19 0 Td
[(I)18 (s M)12 (ar)6 (keting All A)12 (bout Cost E)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 46 >>BDC
BT
-0.082 Tw /Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 300.114 459.1201 Tm
( )Tj
EMC
(...............................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 47 >>BDC
BT
0 Tw 10.5 0 0 10.5 370.7657 459.1201 Tm
(1)Tj
ET
EMC
`;

// Real shape from page 9 ("List of Figures and Tables"): a two-physical-line
// wrapped title ("Figure 5.1" + tab-gap trick + continuation text), still
// followed by one dot-leader span and one bare-label span.
const PAGE9_EXCERPT = `
/P <</Lang (en-US)/MCID 89 >>BDC
BT
/T1_0 1 Tf
24 0 0 24 101.6656 555.1201 Tm
[(List of Figures and T)111.1 (ables)]TJ
ET
EMC
/P <</Lang (en-US)/MCID 91 >>BDC
BT
/T1_1 1 Tf
10.5 0 0 10.5 84 491.1201 Tm
[(F)34 (igur)10 (e 5.1)]TJ
/Span<</ActualText<FEFF0009>>> BDC
( )Tj
EMC
5.048 0 Td
(the negotiators five dilemmas)Tj
ET
EMC
/P <</Lang (en-US)/MCID 92 >>BDC
BT
-0.216 Tw /Span<</ActualText<FEFF002E>>> BDC
10.5 0 0 10.5 259.5226 491.1201 Tm
( )Tj
EMC
(.........................................)Tj
ET
EMC
/P <</Lang (en-US)/MCID 93 >>BDC
BT
0 Tw 10.5 0 0 10.5 367.5 491.1201 Tm
(52)Tj
ET
EMC
`;

describe('extractTocSpans', () => {
  it('decodes each bare-MCID span\'s own visible text, in content-stream order', () => {
    const spans = extractTocSpans(PAGE7_EXCERPT);
    const byMcid = new Map(spans.map(s => [s.mcid, s.text]));
    expect(byMcid.get(35)).toBe('Contents');
    expect(byMcid.get(38)?.trim()).toBe('ix');
    expect(byMcid.get(41)?.trim()).toBe('xi');
    expect(byMcid.get(47)?.trim()).toBe('1');
  });

  it('does not let a nested untagged /Span (the tab-gap ActualText trick) end the outer span early', () => {
    const spans = extractTocSpans(PAGE7_EXCERPT);
    const titleSpan = spans.find(s => s.mcid === 45);
    expect(titleSpan).toBeDefined();
    // Both "Chapter 1" (before the nested Span) and the TJ array after it
    // must land in the SAME span's own text.
    expect(titleSpan!.text).toContain('Chapter 1');
    expect(titleSpan!.text).toContain('Is Marketing All About Cost E');
  });

  it('decodes a dot-leader span as a long run of literal periods', () => {
    const spans = extractTocSpans(PAGE7_EXCERPT);
    const dotSpan = spans.find(s => s.mcid === 37);
    expect(dotSpan).toBeDefined();
    expect(dotSpan!.text.trim()).toMatch(/^\.+$/);
  });
});

describe('extractTocRowCandidates', () => {
  it('groups page 7\'s real TOC rows into {titleText, label, labelMcid}', () => {
    const rows = extractTocRowCandidates(PAGE7_EXCERPT);
    const labels = rows.map(r => r.label);
    expect(labels).toEqual(['ix', 'xi', '1']);

    const ixRow = rows.find(r => r.label === 'ix');
    expect(ixRow!.labelMcid).toBe(38);
    expect(ixRow!.titleText).toContain('List of Figures and Tables');
    // Real Tm for MCID 38: "0 Tw 10.5 0 0 10.5 370.7657 513.1201 Tm"
    expect(ixRow!.labelOriginX).toBeCloseTo(370.7657, 2);
    expect(ixRow!.labelOriginY).toBeCloseTo(513.1201, 2);
    expect(ixRow!.labelFontSize).toBeCloseTo(10.5, 2);

    const chapterRow = rows.find(r => r.label === '1');
    expect(chapterRow!.labelMcid).toBe(47);
    expect(chapterRow!.titleText).toContain('Chapter 1');
  });

  it('handles page 9\'s wrapped Figure-caption title the same way', () => {
    const rows = extractTocRowCandidates(PAGE9_EXCERPT);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('52');
    expect(rows[0].labelMcid).toBe(93);
    expect(rows[0].titleText).toContain('Figure 5.1');
    expect(rows[0].titleText).toContain('the negotiators five dilemmas');
  });

  it('never classifies a pure dot-leader span as a label or a title', () => {
    const rows = extractTocRowCandidates(PAGE7_EXCERPT);
    for (const row of rows) {
      expect(row.titleText).not.toMatch(/^\.+$/);
    }
  });

  it('returns an empty list for a page with no bare-MCID spans at all', () => {
    expect(extractTocRowCandidates('q /GS0 gs Q')).toEqual([]);
  });
});
