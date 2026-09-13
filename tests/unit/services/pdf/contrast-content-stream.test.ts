import { describe, it, expect } from 'vitest';
import { locateTextRun } from '../../../../src/services/pdf/contrast-content-stream';

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
