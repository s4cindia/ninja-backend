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

  it('respects a custom tolerance', () => {
    // 8pt off — within the default 12pt tolerance but outside a tighter 5pt one.
    expect(locateTextRun(twoLineStream, { x: 50, baselineY: 142 })).toBeTruthy();
    expect(locateTextRun(twoLineStream, { x: 50, baselineY: 142 }, 5)).toBeNull();
  });
});
