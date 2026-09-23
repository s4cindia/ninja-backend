import { describe, it, expect } from 'vitest';
import { locateTextRun, locateTextRunsForPage, locateEnclosingTextObject, findPrecedingColor } from '../../../../src/services/pdf/contrast-content-stream';

// Same shape as content-stream.test.ts's twoLineStream (verified pdf-lib output
// shape: q BT … Tm … Tj … ET Q). Line 1 anchor (50,150), line 2 anchor (50,120).
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

describe('locateTextRun', () => {
  it('matches an exact anchor with the highest confidence tier', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.confidence).toBe(0.95);
    expect(match!.ambiguous).toBe(false);
    expect(twoLineStream.slice(match!.start, match!.end)).toContain('<48656C6C6F> Tj');
    expect(twoLineStream.slice(match!.start, match!.end)).not.toContain('Second');
  });

  it('matches the correct (nearer) line when two are on the page', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 120 });
    expect(twoLineStream.slice(match!.start, match!.end)).toContain('<5365636F6E64> Tj');
  });

  it('returns a lower confidence tier for a moderately-off target', () => {
    // 8pt off line 1's baseline (150) — within the 12pt tolerance, past the 6pt tier.
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 142 });
    expect(match).toBeTruthy();
    expect(match!.confidence).toBe(0.60);
    expect(twoLineStream.slice(match!.start, match!.end)).toContain('<48656C6C6F> Tj');
  });

  it('returns null when nothing is within tolerance', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 200 });
    expect(match).toBeNull();
  });

  it('flags ambiguous when a runner-up is nearly as close as the best match', () => {
    // Two lines 2pt apart — well within the 4pt ambiguity margin.
    const closeLines = `q BT 1 0 0 1 50 150 Tm <41> Tj ET Q
q BT 1 0 0 1 50 148 Tm <42> Tj ET Q
`;
    const match = locateTextRun(closeLines, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.ambiguous).toBe(true);
    expect(match!.confidence).toBeCloseTo(0.75); // 0.95 tier - 0.2 ambiguity penalty
  });

  // Real incident, confirmed live on Math_Weir_PDF.pdf: statistical notation
  // like "H0 true" (H with a subscript 0) renders the subscript as its own
  // tiny run positioned just before the following word -- close enough to
  // trigger the plain proximity-ambiguity check above even though the
  // subscript is never a plausible alternate target for a contrast issue
  // about "true". The subscript's own scale (5.83 of a 10pt run, matching
  // the real document exactly) is far enough below the main run's own scale
  // to be recognized and exempted.
  it('does not flag ambiguous when a close runner-up is a much-smaller subscript-scale glyph', () => {
    // Subscript "0" at (47,148), scale 5.83; main run "true" at (50,150),
    // scale 10 -- 3.6pt apart, within the 4pt margin.
    const content = `BT
5.83 0 0 5.83 47 148 Tm
<30> Tj
ET
BT
10 0 0 10 50 150 Tm
<74727565> Tj
ET
`;
    const match = locateTextRun(content, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.ambiguous).toBe(false);
    expect(match!.confidence).toBe(0.95);
  });

  // Counter-example: two candidates at genuinely different scales but NOT a
  // subscript pattern (both comfortably above SUBSCRIPT_SCALE_RATIO_THRESHOLD)
  // must still be flagged ambiguous -- the exemption is narrow, not "any
  // scale difference at all suppresses ambiguity".
  it('still flags ambiguous when a close runner-up is only slightly smaller (not subscript-scale)', () => {
    const content = `BT
9 0 0 9 47 148 Tm
<41> Tj
ET
BT
10 0 0 10 50 150 Tm
<42> Tj
ET
`;
    const match = locateTextRun(content, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.ambiguous).toBe(true);
  });

  it('does not flag ambiguous when candidates are well separated', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    expect(match!.ambiguous).toBe(false);
  });

  it('rejects a unit that changes fill color more than once internally', () => {
    // One BT…ET block sets color, shows text, changes color, shows more text.
    const mixedColorStream = `q BT 0 0 0 rg 1 0 0 1 50 150 Tm <41> Tj 1 0 0 rg <42> Tj ET Q\n`;
    const match = locateTextRun(mixedColorStream, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.ambiguous).toBe(true);
    expect(match!.confidence).toBe(0);
  });

  it('accepts a unit with exactly one internal color operator (the normal case)', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    expect(match!.confidence).toBeGreaterThan(0);
  });

  it('reports the internal fill-color operator span when exactly one exists', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    expect(match!.internalFillColorOp).toBeTruthy();
    const { start, end } = match!.internalFillColorOp!;
    expect(twoLineStream.slice(start, end)).toBe('0 0 0 rg');
  });

  it('leaves internalFillColorOp undefined when there is no internal fill color at all', () => {
    // Color set entirely outside BT…ET — nothing inside to conflict with a wrap.
    const outerColorStream = `0.2 0.3 0.4 rg\nq BT 1 0 0 1 50 150 Tm <41> Tj ET Q\n`;
    const match = locateTextRun(outerColorStream, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(match!.internalFillColorOp).toBeUndefined();
  });

  it('leaves internalFillColorOp undefined when the unit is ambiguous (mixed color)', () => {
    const mixedColorStream = `q BT 0 0 0 rg 1 0 0 1 50 150 Tm <41> Tj 1 0 0 rg <42> Tj ET Q\n`;
    const match = locateTextRun(mixedColorStream, { x: 50, baselineY: 150 });
    expect(match!.internalFillColorOp).toBeUndefined();
  });

  it('ignores stroke-color operators (RG) — only fill color (rg) affects Tj rendering', () => {
    // Sets stroke color (RG) but no fill color at all — should behave like
    // the zero-internal-fill-op case, not be mistaken for a fill-color op.
    const strokeOnlyStream = `q BT 0 0 0 RG 1 0 0 1 50 150 Tm <41> Tj ET Q\n`;
    const match = locateTextRun(strokeOnlyStream, { x: 50, baselineY: 150 });
    expect(match!.internalFillColorOp).toBeUndefined();
  });

  it('respects a custom tolerance', () => {
    // 8pt off — within the default 12pt tolerance but outside a tighter 5pt one.
    expect(locateTextRun(twoLineStream, { x: 50, baselineY: 142 })).toBeTruthy();
    expect(locateTextRun(twoLineStream, { x: 50, baselineY: 142 }, 5)).toBeNull();
  });

  // Real-world regression: a genuine pilot PDF put multiple lines of a
  // paragraph in one BT…ET block (one Tm + repeated T* moves), sharing a
  // single color op right after BT. Correlating against the whole block —
  // which is what shipped originally — only ever finds the first line;
  // every contrast issue on a later line in the block silently fails to
  // correlate. This is the fixture that would have caught it.
  const multiLineBlock = `BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 700 Tm
<4C696E6531> Tj
T*
<4C696E6532> Tj
T*
<4C696E6533> Tj
ET
`;

  it('correlates to the second line of a multi-line BT block, not just the first', () => {
    const match = locateTextRun(multiLineBlock, { x: 50, baselineY: 676 });
    expect(match).toBeTruthy();
    expect(match!.ambiguous).toBe(false);
    const span = multiLineBlock.slice(match!.start, match!.end);
    expect(span).toContain('<4C696E6532> Tj');
    expect(span).not.toContain('<4C696E6531> Tj');
    expect(span).not.toContain('<4C696E6533> Tj');
  });

  it('correlates to the third line of a multi-line BT block', () => {
    const match = locateTextRun(multiLineBlock, { x: 50, baselineY: 652 });
    expect(match).toBeTruthy();
    const span = multiLineBlock.slice(match!.start, match!.end);
    expect(span).toContain('<4C696E6533> Tj');
    expect(span).not.toContain('<4C696E6531> Tj');
    expect(span).not.toContain('<4C696E6532> Tj');
  });

  it('attributes the block-level color op only to the first line — later lines correctly show no internal op of their own', () => {
    const first = locateTextRun(multiLineBlock, { x: 50, baselineY: 700 });
    const second = locateTextRun(multiLineBlock, { x: 50, baselineY: 676 });
    const third = locateTextRun(multiLineBlock, { x: 50, baselineY: 652 });

    expect(first!.internalFillColorOp).toBeTruthy();
    expect(multiLineBlock.slice(first!.internalFillColorOp!.start, first!.internalFillColorOp!.end)).toBe('0 0 0 rg');
    expect(second!.internalFillColorOp).toBeUndefined();
    expect(third!.internalFillColorOp).toBeUndefined();
  });

  // Real-world regression, confirmed live on a real Math_Kim page: a run
  // positioned via a relative Td (not T*, which multiLineBlock above uses
  // for its continuation lines and never exercises this) must begin AFTER
  // the Td -- not at Td's own start, which sits between Td's two operands
  // and the "Td" keyword itself. pdf-contrast-writer.service.ts's
  // spliceColorFix inserts a new color op at run.start whenever the run
  // has no color op of its own (the common case for text inheriting color
  // from before the run) -- inserting there when run.start pointed at Td's
  // own start corrupted the positioning call (orphaned its operands from
  // the operator), silently discarding the position move; text then
  // rendered at the PREVIOUS line's position instead of its own, so a
  // fix-and-verify loop kept re-measuring a location with no relationship
  // to the flagged text, with the recolor having no measurable effect no
  // matter how many times it escalated. This is the fixture that would
  // have caught it.
  const tdPositionedBlock = `BT
1 0 0 1 50 700 Tm
(Figure 4.1.1.) Tj
0 0.68 0.97 0 k
-20 -3 Td
(Table 4.1.2.) Tj
ET
`;

  it('begins a Td-positioned run strictly after the Td, not at its own start', () => {
    const match = locateTextRun(tdPositionedBlock, { x: 30, baselineY: 697 }, 15);
    expect(match).toBeTruthy();
    // The two numeric operands immediately preceding "Td" must be OUTSIDE
    // the run's span -- otherwise an insertion at match.start lands between
    // them and their own operator.
    expect(tdPositionedBlock.slice(match!.start - 9, match!.start)).toBe('-20 -3 Td');
    expect(tdPositionedBlock.slice(match!.start, match!.end)).toContain('Table 4.1.2.');
    expect(tdPositionedBlock.slice(match!.start, match!.end)).not.toContain('Td');
  });

  // Companion to the test above, on the CLOSING boundary: a run's `end`
  // must land before the NEXT run's own Td operands too, not just after
  // its keyword -- pdf-contrast-writer.service.ts's spliceColorFix always
  // inserts a restore-color op at run.end, so the same corruption that
  // affected run.start (splicing between an operator's operands and the
  // operator itself) applies symmetrically here, just landing in the
  // FOLLOWING run's positioning call instead of this one's.
  const followedByTdBlock = `BT
1 0 0 1 50 700 Tm
(Table 4.1.2.) Tj
5.453 0 Td
(Math Navigation Chart) Tj
ET
`;

  it('ends a run strictly before the NEXT run\'s Td operands, not at the Td keyword', () => {
    const match = locateTextRun(followedByTdBlock, { x: 50, baselineY: 700 }, 15);
    expect(match).toBeTruthy();
    expect(followedByTdBlock.slice(match!.start, match!.end)).toContain('Table 4.1.2.');
    expect(followedByTdBlock.slice(match!.end, match!.end + 12)).toBe('5.453 0 Td\n(');
  });

  // Real-world regression, confirmed live on a real Math_Kim page: a color-
  // setting op that comes AFTER a run's only (or last) show op -- but
  // before the run's `end` boundary, since a run only closes on a
  // positioning op, not on "no more shows follow" -- paints nothing within
  // THIS run. It's graphics-state setup for whatever the NEXT run shows.
  // Treating it as this run's own "internal" color op (the pre-existing
  // behavior) told spliceColorFix to overwrite it in place: the flagged
  // text ("Table 4.1.2.", genuinely colored by the orange `k` BEFORE this
  // run, inherited) never actually changed color, while the unrelated next
  // run's ("Math Navigation...") intended color got silently corrupted.
  const trailingColorBlock = `BT
1 0 0 1 50 700 Tm
(Figure 4.1.1.) Tj
0 0 0 1 k
5.86 0 Td
(Integer number lines) Tj
0 0.68 0.97 0 k
1 0 0 1 30 685 Tm
(Table 4.1.2.) Tj
0 0 0 1 k
5.453 0 Td
(Math Navigation Chart) Tj
ET
`;

  it('does not treat a color op after the run\'s last show as its own internal color', () => {
    const match = locateTextRun(trailingColorBlock, { x: 30, baselineY: 685 }, 12);
    expect(match).toBeTruthy();
    expect(trailingColorBlock.slice(match!.start, match!.end)).toContain('Table 4.1.2.');
    // The real color (the orange "k" before this run, inherited) is outside
    // the run's span -- the trailing "0 0 0 1 k" after the show must NOT be
    // picked up as if it were this run's own dedicated color op.
    expect(match!.internalFillColorOp).toBeUndefined();
    expect(match!.ambiguous).toBe(false);
  });

  // CodeRabbit finding on PR #544: lastShowEnd must be exposed distinctly
  // from `end` (not just used internally to gate the mixedColor check) so
  // a caller restoring color after a fix (pdf-contrast-writer.service.ts
  // always does) can insert the restore there instead of at `end` --
  // otherwise the restore fires AFTER the trailing color op meant for the
  // NEXT run and silently overrides it. See the matching spliceColorFix
  // test in pdf-contrast-writer.test.ts for the full round trip.
  it('reports lastShowEnd distinctly from end when trailing content follows the last show', () => {
    const match = locateTextRun(trailingColorBlock, { x: 30, baselineY: 685 }, 12)!;
    expect(match).toBeTruthy();
    expect(match.lastShowEnd).toBeLessThan(match.end);
    expect(trailingColorBlock.slice(match.start, match.lastShowEnd)).toBe('\n(Table 4.1.2.) Tj');
  });

  // CodeRabbit finding on PR #544: `'`/`"` fuse a positioning move (the
  // same tmF shift T* does) with a show op in one operator -- treating
  // them as "just another show in the current run" (the original code)
  // kept whatever anchor an earlier Tj already set, even though the quote
  // moves to and shows an entirely different line. A target near the
  // quoted line then either matched the WRONG (earlier) line's span or
  // missed the tolerance window entirely.
  const quoteLineBlock = `BT
1 0 0 1 50 700 Tm
(First line) Tj
24 TL
(Second line) '
ET
`;

  it('starts a new run at a quote operator (\') rather than reusing the prior show\'s anchor', () => {
    const firstMatch = locateTextRun(quoteLineBlock, { x: 50, baselineY: 700 }, 5);
    expect(firstMatch).toBeTruthy();
    expect(quoteLineBlock.slice(firstMatch!.start, firstMatch!.end)).toContain('First line');
    expect(quoteLineBlock.slice(firstMatch!.start, firstMatch!.end)).not.toContain('Second line');

    // T*'s own line-height shift (24 TL, applied by ') moves the anchor to
    // baselineY 676 (700 - 24) -- a target there must resolve to the
    // quoted line specifically, not the first line's untouched anchor.
    const secondMatch = locateTextRun(quoteLineBlock, { x: 50, baselineY: 676 }, 5);
    expect(secondMatch).toBeTruthy();
    expect(quoteLineBlock.slice(secondMatch!.start, secondMatch!.end)).toContain('Second line');
    expect(quoteLineBlock.slice(secondMatch!.start, secondMatch!.end)).not.toContain('First line');
  });

  it('excludes a quote operator\'s own string operand from the PRECEDING run\'s span', () => {
    const match = locateTextRun(quoteLineBlock, { x: 50, baselineY: 700 }, 5)!;
    expect(match).toBeTruthy();
    // The first run must end before "(Second line)" -- the quote's own
    // operand -- not swallow it the way the pre-fix single-case handling did.
    expect(quoteLineBlock.slice(match.start, match.end)).not.toContain('Second line');
  });

  // Live-confirmed bug (real 805-page document): Td/TD/T* offsets are in
  // text space and must be scaled by the current text matrix's own a/d
  // before folding into the running device-space position. Every fixture
  // above uses an identity-scale Tm (`1 0 0 1 e f Tm`), which never
  // exercised this — the bug was invisible to all of them. A real TOC page
  // in the pilot document used a ~19x Tm scale with plain Td continuations
  // for every entry; 116 of 120 text units were Td-positioned, and every
  // one missed the 12pt tolerance, with the miss distance growing linearly
  // down the page (100+pt by the 11th line) because the unscaled error
  // compounds with each further Td.
  describe('non-identity text matrix scale (Td/TD/T* offset scaling)', () => {
    it('scales a Td offset by the text matrix\'s own scale, not the raw text-space number', () => {
      // Tm sets a 10x scale at device (50, 700). A Td of (0, -2) is 2 text-
      // space units — at 10x scale, that is a 20pt device-space move, so the
      // second line's true baseline is 680, not 698 (which unscaled Td would
      // have produced).
      const stream = `BT
0 0 0 rg
10 0 0 10 50 700 Tm
<41> Tj
0 -2 Td
<42> Tj
ET
`;
      // The old bug's (wrong, unscaled) prediction for the second line was
      // 700 - 2 = 698 -- close enough to the FIRST line's own anchor (700)
      // that it matches line 1, not line 2, at that position: proof the old
      // code could never have correctly located a scaled continuation line.
      const wrongUnscaledMatch = locateTextRun(stream, { x: 50, baselineY: 698 });
      expect(wrongUnscaledMatch).toBeTruthy();
      expect(stream.slice(wrongUnscaledMatch!.start, wrongUnscaledMatch!.end)).toContain('<41> Tj');

      const correctMatch = locateTextRun(stream, { x: 50, baselineY: 680 });
      expect(correctMatch).toBeTruthy();
      expect(correctMatch!.ambiguous).toBe(false);
      const span = stream.slice(correctMatch!.start, correctMatch!.end);
      expect(span).toContain('<42> Tj');
      expect(span).not.toContain('<41> Tj');
    });

    it('scales TD the same way, and its implicit TL update stays in text-space units', () => {
      const stream = `BT
0 0 0 rg
10 0 0 10 50 700 Tm
<41> Tj
0 -2 TD
<42> Tj
T*
<43> Tj
ET
`;
      // TD's ty (-2) becomes both the Td-equivalent move AND the new TL
      // (2, in text-space units) -- so the following T* must ALSO scale by
      // the current 10x Tm, landing another 20pt down, not 2pt.
      const line2 = locateTextRun(stream, { x: 50, baselineY: 680 });
      expect(line2).toBeTruthy();
      expect(stream.slice(line2!.start, line2!.end)).toContain('<42> Tj');

      const line3 = locateTextRun(stream, { x: 50, baselineY: 660 });
      expect(line3).toBeTruthy();
      expect(stream.slice(line3!.start, line3!.end)).toContain('<43> Tj');
    });

    it('resets the tracked scale to identity on BT, so a later unscaled text object is unaffected by an earlier scaled one', () => {
      const stream = `q BT 10 0 0 10 50 700 Tm <41> Tj ET Q
q BT 1 0 0 1 50 600 Tm <42> Tj 0 -24 Td <43> Tj ET Q
`;
      // Second block is identity-scale (matches every other fixture in this
      // file) -- its own Td should behave exactly as before this fix.
      const match = locateTextRun(stream, { x: 50, baselineY: 576 });
      expect(match).toBeTruthy();
      expect(stream.slice(match!.start, match!.end)).toContain('<43> Tj');
    });

    it('tracks a scale change mid-object when Tm fires again (not just once at BT)', () => {
      // First line at 10x scale, Tm resets to 5x scale, then a Td continues
      // at the NEW scale -- the tracked a/d must follow the latest Tm, not
      // whatever was set once at the start of the text object.
      const stream = `BT
0 0 0 rg
10 0 0 10 50 700 Tm
<41> Tj
5 0 0 5 50 650 Tm
<42> Tj
0 -2 Td
<43> Tj
ET
`;
      const match = locateTextRun(stream, { x: 50, baselineY: 640 }); // 650 - (2 * 5)
      expect(match).toBeTruthy();
      expect(stream.slice(match!.start, match!.end)).toContain('<43> Tj');
    });

    it('preserves a literal zero scale component from Tm instead of defaulting it to 1', () => {
      // Tm's "a" is 0 here (an out-of-scope rotated/degenerate matrix this
      // module can't represent -- it only tracks the diagonal, never b/c).
      // A Td's tx must then contribute nothing to the x position, not be
      // treated as if unscaled -- CodeRabbit correctly flagged an earlier
      // `|| 1` fallback here as silently inventing a scale the matrix
      // doesn't have.
      const stream = `BT
0 0 0 rg
0 1 -1 0 50 700 Tm
<41> Tj
20 0 Td
<42> Tj
ET
`;
      // Both show ops land at the exact same anchor (700) since tx's
      // contribution is scaled by a=0 -- a same-point collision, which is
      // exactly what locateTextRun's own ambiguity check exists to flag.
      const match = locateTextRun(stream, { x: 50, baselineY: 700 });
      expect(match).toBeTruthy();
      expect(match!.ambiguous).toBe(true);

      // No unit should ever land at x=70 (50 + unscaled tx=20) -- that
      // would mean the old `|| 1` fallback treated the offset as unscaled.
      expect(locateTextRun(stream, { x: 70, baselineY: 700 })).toBeNull();
    });
  });
});

describe('locateTextRunsForPage', () => {
  // Built to fix a real gap: locateTextRun correctly REFUSES a run that
  // changes its own fill color more than once internally (mixedColor ->
  // confidence 0) since it has no way to tell which color belongs to which
  // target. Confirmed live on Math_Kim's real remaining COLOR-CONTRAST
  // issues: this is exactly the shape of a colored word embedded in
  // otherwise plain-colored text (e.g. "The answer is <red>one</red>.").
  // locateTextRunsForPage resolves this WITHOUT font metrics by relying on
  // a structural fact instead of a position estimate: PDF text within one
  // run renders in byte order (= reading order), so when the number of
  // issues mapped to a run's line EXACTLY matches its internal-color-
  // delimited segment count, they can be paired ordinally with confidence.
  const threeSegmentRun = `BT
1 0 0 1 50 150 Tm
(black text ) Tj
1 0 0 rg
(RED WORD) Tj
0 0 0 rg
(more black) Tj
ET
`;

  it('pairs all 3 segments of a multi-color run ordinally when exactly 3 issues map to it', () => {
    const targets = [
      { id: 'seg0', x: 50, baselineY: 150 },
      { id: 'seg1', x: 80, baselineY: 150 },
      { id: 'seg2', x: 120, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(threeSegmentRun, targets);

    const seg0 = result.get('seg0');
    const seg1 = result.get('seg1');
    const seg2 = result.get('seg2');

    expect(seg0).toBeTruthy();
    expect(seg1).toBeTruthy();
    expect(seg2).toBeTruthy();
    expect(seg0!.ambiguous).toBe(false);
    expect(seg1!.ambiguous).toBe(false);
    expect(seg2!.ambiguous).toBe(false);

    // Segment 0 (before the first internal op) has no op of its own to
    // rewrite in place -- the writer must insert a new one at run.start,
    // exactly like today's no-internal-op whole-run case.
    expect(seg0!.internalFillColorOp).toBeUndefined();
    // Segment 1 is governed by the FIRST internal op (the red one).
    expect(threeSegmentRun.slice(seg1!.internalFillColorOp!.start, seg1!.internalFillColorOp!.end)).toBe('1 0 0 rg');
    // Segment 2 (the run's own last segment) is governed by the LAST internal op.
    expect(threeSegmentRun.slice(seg2!.internalFillColorOp!.start, seg2!.internalFillColorOp!.end)).toBe('0 0 0 rg');
  });

  it('gives every segment of that run the SAME restore-color-override -- the run\'s true final color, not each segment\'s own', () => {
    const targets = [
      { id: 'seg0', x: 50, baselineY: 150 },
      { id: 'seg1', x: 80, baselineY: 150 },
      { id: 'seg2', x: 120, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(threeSegmentRun, targets);

    // The run's LAST internal op is "0 0 0 rg" (black) -- fixing segment 1
    // (currently red) must restore to BLACK after the run ends, not to
    // red (segment 1's own original color): op 2 (untouched, already
    // black) already handles segment 2's own color correctly, but nothing
    // downstream of the run relies on segment 1's original color at all,
    // and using it here would leave the wrong color active for whatever
    // renders after this run.
    expect(result.get('seg0')!.restoreColorOverride).toEqual([0, 0, 0]);
    expect(result.get('seg1')!.restoreColorOverride).toEqual([0, 0, 0]);
    expect(result.get('seg2')!.restoreColorOverride).toEqual([0, 0, 0]);
  });

  it('declines (no confident match) when the issue count does NOT match the run\'s segment count -- refuses to guess', () => {
    // Only 2 targets for a 3-segment run -- a real structural mismatch.
    const targets = [
      { id: 'a', x: 50, baselineY: 150 },
      { id: 'b', x: 80, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(threeSegmentRun, targets);
    expect(result.get('a')).toBeNull();
    expect(result.get('b')).toBeNull();
  });

  it('resolves two separate single-color runs sitting close together via ordinal pairing, when each individually would be proximity-ambiguous', () => {
    // 3pt apart -- well within locateTextRun's own 4pt AMBIGUITY_MARGIN, so
    // targeting either run's own exact anchor individually would flag
    // ambiguous under the plain single-target algorithm (confirmed by the
    // plain locateTextRun assertions below).
    const twoCloseRuns = `BT 1 0 0 1 50 150 Tm (A) Tj ET
BT 1 0 0 1 53 150 Tm (B) Tj ET
`;
    expect(locateTextRun(twoCloseRuns, { x: 50, baselineY: 150 })!.ambiguous).toBe(true);
    expect(locateTextRun(twoCloseRuns, { x: 53, baselineY: 150 })!.ambiguous).toBe(true);

    const targets = [
      { id: 'first', x: 50, baselineY: 150 },
      { id: 'second', x: 53, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(twoCloseRuns, targets);

    const first = result.get('first');
    const second = result.get('second');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first!.ambiguous).toBe(false);
    expect(second!.ambiguous).toBe(false);
    expect(twoCloseRuns.slice(first!.start, first!.end)).toContain('(A) Tj');
    expect(twoCloseRuns.slice(second!.start, second!.end)).toContain('(B) Tj');
    // Neither run has its own internal color op -- no restore override needed.
    expect(first!.restoreColorOverride).toBeUndefined();
    expect(second!.restoreColorOverride).toBeUndefined();
  });

  it('declines when a THIRD nearby run makes the count exceed the number of targets in that line-band', () => {
    const threeCloseRuns = `BT 1 0 0 1 50 150 Tm (A) Tj ET
BT 1 0 0 1 53 150 Tm (B) Tj ET
BT 1 0 0 1 56 150 Tm (C) Tj ET
`;
    const targets = [
      { id: 'first', x: 50, baselineY: 150 },
      { id: 'second', x: 53, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(threeCloseRuns, targets);
    expect(result.get('first')).toBeNull();
    expect(result.get('second')).toBeNull();
  });

  it('declines a multi-color run whose last internal op is sc/scn -- cannot safely determine the restore color', () => {
    const scnRun = `BT
0 0 0 rg
1 0 0 1 50 150 Tm
(black ) Tj
1 0 0 1 scn
(red) Tj
ET
`;
    const targets = [
      { id: 'seg0', x: 50, baselineY: 150 },
      { id: 'seg1', x: 80, baselineY: 150 },
    ];
    const result = locateTextRunsForPage(scnRun, targets);
    expect(result.get('seg0')).toBeNull();
    expect(result.get('seg1')).toBeNull();
  });

  it('leaves an already-confidently-resolved target completely untouched (zero behavior change for the cases that already worked)', () => {
    const targets = [{ id: 'line1', x: 50, baselineY: 150 }];
    const viaPage = locateTextRunsForPage(twoLineStream, targets).get('line1');
    const viaPlain = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });

    expect(viaPage).toEqual(viaPlain);
  });

  it('does not cross-pair targets on genuinely different lines', () => {
    // Two single-color runs, but far enough apart in Y that they must never
    // be treated as the same line-band even though there are exactly 2 of
    // them and exactly 2 targets overall.
    const twoDifferentLines = `BT 1 0 0 1 50 150 Tm (A) Tj ET
BT 1 0 0 1 50 400 Tm (B) Tj ET
`;
    // Individually ambiguous-free and unmatched -- pick positions that miss
    // the plain 12pt tolerance so both fall through to page-level pairing.
    const targets = [
      { id: 'near-a', x: 65, baselineY: 150 },
      { id: 'near-b', x: 65, baselineY: 400 },
    ];
    const result = locateTextRunsForPage(twoDifferentLines, targets, 20);
    expect(twoDifferentLines.slice(result.get('near-a')!.start, result.get('near-a')!.end)).toContain('(A) Tj');
    expect(twoDifferentLines.slice(result.get('near-b')!.start, result.get('near-b')!.end)).toContain('(B) Tj');
  });
});

describe('locateEnclosingTextObject', () => {
  it('finds the BT of the run\'s own text object, not a different one on the page', () => {
    const firstMatch = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    const secondMatch = locateTextRun(twoLineStream, { x: 50, baselineY: 120 });

    const firstBtIndex = twoLineStream.indexOf('BT');
    const secondBtIndex = twoLineStream.indexOf('BT', firstBtIndex + 1);
    expect(firstBtIndex).not.toBe(secondBtIndex);

    expect(locateEnclosingTextObject(twoLineStream, firstMatch!.start)!.btStart).toBe(firstBtIndex);
    expect(locateEnclosingTextObject(twoLineStream, secondMatch!.start)!.btStart).toBe(secondBtIndex);
  });

  it('finds the same shared BT for every run inside one multi-line text object', () => {
    const multiLineBlock = `BT
0 0 0 rg
/F1 12 Tf
24 TL
1 0 0 1 50 700 Tm
<4C696E6531> Tj
T*
<4C696E6532> Tj
T*
<4C696E6533> Tj
ET
`;
    const btIndex = multiLineBlock.indexOf('BT');
    const first = locateTextRun(multiLineBlock, { x: 50, baselineY: 700 });
    const second = locateTextRun(multiLineBlock, { x: 50, baselineY: 676 });
    const third = locateTextRun(multiLineBlock, { x: 50, baselineY: 652 });

    expect(locateEnclosingTextObject(multiLineBlock, first!.start)!.btStart).toBe(btIndex);
    expect(locateEnclosingTextObject(multiLineBlock, second!.start)!.btStart).toBe(btIndex);
    expect(locateEnclosingTextObject(multiLineBlock, third!.start)!.btStart).toBe(btIndex);
  });

  it('returns the identity CTM when nothing transforms it beforehand', () => {
    const match = locateTextRun(twoLineStream, { x: 50, baselineY: 150 });
    const enclosing = locateEnclosingTextObject(twoLineStream, match!.start);
    expect(enclosing).toBeTruthy();
    expect(enclosing!.ctm).toEqual({ a: 1, d: 1, e: 0, f: 0, sheared: false });
  });

  it('tracks a cm concatenated before the text object', () => {
    const stream = `q
2 0 0 3 10 20 cm
BT
1 0 0 1 50 150 Tm
<41> Tj
ET
Q
`;
    const match = locateTextRun(stream, { x: 120, baselineY: 470 }); // (50*2+10, 150*3+20)
    expect(match).toBeTruthy();
    const enclosing = locateEnclosingTextObject(stream, match!.start);
    expect(enclosing!.ctm).toEqual({ a: 2, d: 3, e: 10, f: 20, sheared: false });
  });

  it('accounts for a q/Q pair closed and reopened before the text object', () => {
    // The first q/cm/Q is fully closed (popped) before the second q/cm
    // that actually governs the text object -- a naive "last cm seen"
    // walk would wrongly pick up the first, already-reverted transform.
    const stream = `q
5 0 0 5 0 0 cm
Q
q
2 0 0 2 0 0 cm
BT
1 0 0 1 10 10 Tm
<41> Tj
ET
Q
`;
    const match = locateTextRun(stream, { x: 20, baselineY: 20 }); // (10*2, 10*2)
    expect(match).toBeTruthy();
    const enclosing = locateEnclosingTextObject(stream, match!.start);
    expect(enclosing!.ctm).toEqual({ a: 2, d: 2, e: 0, f: 0, sheared: false });
  });

  it('returns null when the given offset is not inside any BT…ET block', () => {
    const betweenBlocks = twoLineStream.indexOf('Q\nq') + 2; // between the two text objects
    expect(locateEnclosingTextObject(twoLineStream, betweenBlocks)).toBeNull();
  });

  it('returns null when a shear/rotation cm is in effect at the text object (would misplace an inverted backplate)', () => {
    const stream = `q
1 0.1 0 1 0 0 cm
BT
1 0 0 1 50 150 Tm
<41> Tj
ET
Q
`;
    // locateTextRun's own anchor matching only uses a/d/e/f (this file's
    // axis-aligned-only convention), so it still finds the run at (50,150)
    // even though the CTM is sheared -- only locateEnclosingTextObject cares.
    const match = locateTextRun(stream, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(locateEnclosingTextObject(stream, match!.start)).toBeNull();
  });

  it('still resolves a CTM when a shear was applied and fully reverted (q/cm[shear]/Q) before the text object', () => {
    const stream = `q
1 0.1 0 1 0 0 cm
Q
q
2 0 0 2 0 0 cm
BT
1 0 0 1 10 10 Tm
<41> Tj
ET
Q
`;
    const match = locateTextRun(stream, { x: 20, baselineY: 20 }); // (10*2, 10*2)
    expect(match).toBeTruthy();
    const enclosing = locateEnclosingTextObject(stream, match!.start);
    expect(enclosing!.ctm).toEqual({ a: 2, d: 2, e: 0, f: 0, sheared: false });
  });

  it('rejects a shear applied via c (not just b) on the cm operator', () => {
    const stream = `q
1 0 0.1 1 0 0 cm
BT
1 0 0 1 50 150 Tm
<41> Tj
ET
Q
`;
    const match = locateTextRun(stream, { x: 50, baselineY: 150 });
    expect(match).toBeTruthy();
    expect(locateEnclosingTextObject(stream, match!.start)).toBeNull();
  });
});

describe('findPrecedingColor', () => {
  it('finds the nearest preceding fill-color op when nothing is scoped', () => {
    const stream = `BT
0.5 0.5 0.5 rg
<41> Tj
ET
`;
    const pos = stream.indexOf('ET');
    expect(findPrecedingColor(stream, pos)).toEqual([0.5, 0.5, 0.5]);
  });

  it('defaults to black when no fill-color op precedes the position at all', () => {
    const stream = `BT
<41> Tj
ET
`;
    expect(findPrecedingColor(stream, stream.indexOf('ET'))).toEqual([0, 0, 0]);
  });

  it('does NOT treat a color set inside an already-closed q...Q as still ambient', () => {
    // Regression test for a real bug found live on Math_Weir_PDF.pdf: a
    // naive linear "nearest preceding rg" scan picks up a color set inside
    // a q...Q block that has already been popped by the queried position --
    // exactly what pdf-contrast-backplate.ts's spliceBackplate does
    // (wraps its rectangle's `1 1 1 rg` fill in its own q...Q specifically
    // so it can't affect anything outside the rectangle). A later run's
    // restore-after-fix computation must see the color from BEFORE that
    // q, not the rectangle's own scoped white.
    const stream = `0.2 0.2 0.2 rg
q
1 1 1 rg
10 10 20 20 re
f
Q
BT
<41> Tj
ET
`;
    const pos = stream.indexOf('ET');
    expect(findPrecedingColor(stream, pos)).toEqual([0.2, 0.2, 0.2]);
  });

  it('still finds a color set inside a q...Q that has NOT closed yet by the queried position', () => {
    const stream = `q
0.3 0.4 0.5 rg
BT
<41> Tj
ET
`;
    // No matching Q before this position -- the color genuinely is still
    // in effect (the q hasn't been popped), so it must be found normally.
    const pos = stream.indexOf('ET');
    expect(findPrecedingColor(stream, pos)).toEqual([0.3, 0.4, 0.5]);
  });

  it('handles nested q/Q, only reverting to the color active before the OUTER q once both close', () => {
    const stream = `0.1 0.1 0.1 rg
q
0.9 0.9 0.9 rg
q
1 1 1 rg
10 10 20 20 re
f
Q
20 20 20 20 re
f
Q
BT
<41> Tj
ET
`;
    const pos = stream.indexOf('ET');
    expect(findPrecedingColor(stream, pos)).toEqual([0.1, 0.1, 0.1]);
  });

  it('declines (returns null) when the color in effect was last set by scn (colorspace-dependent, unparseable)', () => {
    const stream = `BT
1 0.5 0.2 scn
<41> Tj
ET
`;
    expect(findPrecedingColor(stream, stream.indexOf('ET'))).toBeNull();
  });

  it('parses g (grayscale) and k (CMYK) fill ops, not just rg', () => {
    const grayStream = `0.75 g
BT
<41> Tj
ET
`;
    expect(findPrecedingColor(grayStream, grayStream.indexOf('ET'))).toEqual([0.75, 0.75, 0.75]);

    const cmykStream = `0 0 0 0.2 k
BT
<41> Tj
ET
`;
    const result = findPrecedingColor(cmykStream, cmykStream.indexOf('ET'))!;
    expect(result[0]).toBeCloseTo(0.8);
    expect(result[1]).toBeCloseTo(0.8);
    expect(result[2]).toBeCloseTo(0.8);
  });

  it('reproduces the real Math_Weir_PDF.pdf regression: a backplate immediately before a later cell must not leak white into that cell\'s restore', () => {
    // Simplified real-shape excerpt of page 343's content stream: a genuine
    // ambient text color set once, well upstream (matching this real
    // document's convention where the overwhelming majority of runs carry
    // no color op of their own and instead inherit it), then a backplate
    // (scoped white) drawn for one table cell, then an ambient-only cell
    // (no color op of its own), then the cell whose restore-after-fix
    // computation this test targets -- about to get its OWN internal color
    // op spliced in (not yet present, matching the real call-site: this is
    // queried at match.start, before the fix's own insertion).
    const stream = `0.184 0.192 0.220 rg
/P <</MCID 1 >>BDC
q
1 0 0 1 0 0 cm
1 1 1 rg
193.6 660.4 29.2 15.0 re
f
Q
BT
9 0 0 9 193.6 663.1 Tm
(5.248)Tj
ET
EMC
/P <</MCID 2 >>BDC
BT
9 0 0 9 233.6 663.1 Tm
(4.377)Tj
ET
EMC
`;
    // The position a real fix would query is the SECOND cell's run.start --
    // right after its own "BT", before splicing in its own fix.
    const secondRunStart = stream.lastIndexOf('BT') + 'BT\n'.length;
    // Must find the real ambient color from before the backplate's own q,
    // NOT the backplate rectangle's scoped white -- the old naive linear
    // scan (this function's original implementation) returned [1, 1, 1]
    // here, which is exactly the bug that corrupted a 19-cell cluster on
    // the real document.
    expect(findPrecedingColor(stream, secondRunStart)).toEqual([0.184, 0.192, 0.22]);
  });
});
