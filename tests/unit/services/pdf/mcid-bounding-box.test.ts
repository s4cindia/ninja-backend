/**
 * Regression coverage for mcid-bounding-box.ts: computes a device-space
 * bounding box for an arbitrary marked-content span's own drawn geometry.
 * Every scenario here mirrors a real shape found live on Math_Weir_PDF.pdf
 * while investigating why struct-tree-only Figure alt-text issues weren't
 * converging under Auto Mode (see this module's own header comment).
 */
import { describe, it, expect } from 'vitest';
import { locateMcidBoundingBoxes } from '../../../../src/services/pdf/mcid-bounding-box';

describe('locateMcidBoundingBoxes', () => {
  it('computes a bbox from a leader line (m/l/S) plus a text run, translated by the active CTM', () => {
    // Mirrors the real page-218 shape: a short horizontal stroke, then a
    // clipped text label.
    const content =
      '<</MCID 5>>BDC ' +
      'q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q ' +
      'BT 9 0 0 9 105 503 Tm (MS)Tj ET ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([5]));

    const box = result.get(5);
    expect(box).toBeDefined();
    // Line runs from (100,500) to (170,500) in device space (CTM translate
    // only, a=d=1). Text anchor at (105,503) is inside that X range and
    // above the line's Y.
    expect(box!.minX).toBe(100);
    expect(box!.maxX).toBe(170);
    expect(box!.minY).toBe(500);
    expect(box!.maxY).toBe(503);
  });

  it('includes a `re W n` clip rectangle\'s four corners even though it never paints (real free-coverage case)', () => {
    const content =
      '<</MCID 7>>BDC ' +
      '200 400 50 20 re W n ' +
      'BT 9 0 0 9 205 405 Tm (X)Tj ET ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([7]));

    const box = result.get(7);
    expect(box).toEqual({ minX: 200, minY: 400, maxX: 250, maxY: 420 });
  });

  it('does not end the target span early when a nested, unrelated named-properties BDC/EMC (e.g. an InDesign PlacedGraphic marker) opens and closes inside it', () => {
    const content =
      '<</MCID 9>>BDC ' +
      '/PlacedGraphic /MC0 BDC EMC ' + // nested, irrelevant marker -- no MCID of its own
      'q 1 0 0 1 300 300 cm 0 0 m 40 0 l S Q ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([9]));

    const box = result.get(9);
    expect(box).toEqual({ minX: 300, minY: 300, maxX: 340, maxY: 300 });
  });

  it('tracks CTM continuously across sibling marked-content spans -- a q pushed in one span and popped in the next must not corrupt either box', () => {
    // Mirrors a real, confirmed q/Q imbalance across sibling Figures on
    // Math_Weir_PDF.pdf's own page 218: one Figure's span opens with a bare
    // Q popping a q pushed by an EARLIER sibling's span.
    const content =
      '<</MCID 1>>BDC ' +
      'q 1 0 0 1 10 10 cm 0 0 m 5 0 l S ' + // q pushed here, no matching Q in THIS span
      'EMC ' +
      '<</MCID 2>>BDC ' +
      'Q ' + // pops the q from MCID 1's span -- CTM must correctly revert to identity
      'q 1 0 0 1 90 90 cm 0 0 m 5 0 l S Q ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([1, 2]));

    // MCID 1: line from (10,10) to (15,10)
    expect(result.get(1)).toEqual({ minX: 10, minY: 10, maxX: 15, maxY: 10 });
    // MCID 2: after Q reverts to identity CTM, then a fresh q/cm to (90,90)
    expect(result.get(2)).toEqual({ minX: 90, minY: 90, maxX: 95, maxY: 90 });
  });

  it('computes a bbox from a Do (image XObject) invocation as the unit square transformed by the CTM', () => {
    const content =
      '<</MCID 3>>BDC ' +
      'q 500 0 0 300 60 400 cm /Im0 Do Q ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([3]));

    expect(result.get(3)).toEqual({ minX: 60, minY: 400, maxX: 560, maxY: 700 });
  });

  it('includes all three points of a Bezier curve (c) toward the box', () => {
    const content =
      '<</MCID 4>>BDC ' +
      'q 1 0 0 1 0 0 cm 10 10 m 20 50 30 -20 40 10 c S Q ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([4]));

    const box = result.get(4);
    // Points seen: (10,10) start via m, then curve control/end points
    // (20,50), (30,-20), (40,10).
    expect(box!.minX).toBe(10);
    expect(box!.maxX).toBe(40);
    expect(box!.minY).toBe(-20);
    expect(box!.maxY).toBe(50);
  });

  it('computes independent boxes for multiple target MCIDs in a single pass', () => {
    const content =
      '<</MCID 10>>BDC q 1 0 0 1 0 0 cm 0 0 m 10 0 l S Q EMC ' +
      '<</MCID 11>>BDC q 1 0 0 1 200 200 cm 0 0 m 10 0 l S Q EMC';

    const result = locateMcidBoundingBoxes(content, new Set([10, 11]));

    expect(result.get(10)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0 });
    expect(result.get(11)).toEqual({ minX: 200, minY: 200, maxX: 210, maxY: 200 });
  });

  it('returns no entry for a target MCID that never appears in the content stream', () => {
    const content = '<</MCID 1>>BDC q 1 0 0 1 0 0 cm 0 0 m 10 0 l S Q EMC';

    const result = locateMcidBoundingBoxes(content, new Set([999]));

    expect(result.has(999)).toBe(false);
  });

  it('returns no entry for a target MCID whose span produced no geometry at all', () => {
    const content = '<</MCID 2>>BDC /PlacedGraphic /MC0 BDC EMC EMC'; // empty nested marker only

    const result = locateMcidBoundingBoxes(content, new Set([2]));

    expect(result.has(2)).toBe(false);
  });

  it('never mistakes an unrelated dict (e.g. one closed for a DP marked-content point) for a later named-properties BDC\'s own MCID', () => {
    // A DP with its own inline dict closes right before an UNRELATED BDC
    // that uses named (not inline-dict) properties -- the named BDC must
    // not inherit the DP's dict just because a dict closed "recently".
    const content =
      '<</MCID 999>>DP ' + // unrelated marked-content point, not a target
      '/Span /P1 BDC ' + // named-properties form -- no inline MCID at all
      'q 1 0 0 1 50 50 cm 0 0 m 5 0 l S Q ' +
      'EMC';

    const result = locateMcidBoundingBoxes(content, new Set([999]));

    // MCID 999 was never opened via a real BDC (only a DP, which has no
    // EMC and isn't tracked as a span at all) -- must not be found.
    expect(result.has(999)).toBe(false);
  });

  it('correctly transforms points under a rotated (non-axis-aligned) cm matrix, not just translation', () => {
    // CodeRabbit finding on PR #583, confirmed real: an a/d-only CTM model
    // collapses every point under a 90-degree rotation (`0 1 -1 0 e f cm`)
    // to the single coordinate (e, f). A point at local (10, 0) under this
    // matrix must land at device (100, 210): X = a*x+c*y+e = 0*10+(-1)*0+100,
    // Y = b*x+d*y+f = 1*10+0*0+200.
    const content = '<</MCID 1>>BDC q 0 1 -1 0 100 200 cm 0 0 m 10 0 l S Q EMC';

    const box = locateMcidBoundingBoxes(content, new Set([1])).get(1);

    expect(box).toEqual({ minX: 100, minY: 200, maxX: 100, maxY: 210 });
  });

  it('composes a rotation and a translation correctly across two successive cm operators', () => {
    const content =
      '<</MCID 1>>BDC ' +
      'q 1 0 0 1 100 200 cm ' + // translate first
      '0 1 -1 0 0 0 cm ' + // then rotate 90 degrees in the NEW local space
      '0 0 m 10 0 l S Q EMC';

    const box = locateMcidBoundingBoxes(content, new Set([1])).get(1);

    // Composed CTM: rotate-then-translate in device space -> local (10,0)
    // maps to device (100, 210), local (0,0) maps to device (100, 200).
    expect(box).toEqual({ minX: 100, minY: 200, maxX: 100, maxY: 210 });
  });

  it('does not return a box for a Figure whose only content is a single text anchor with no accompanying path geometry (a true degenerate point)', () => {
    // CodeRabbit finding on PR #583, confirmed real: a single-point box
    // (zero extent in BOTH axes) would otherwise get padded into a tiny,
    // useless few-pixel crop by ai-analysis.service.ts's cropBase64Region
    // instead of falling back to the full page.
    const content = '<</MCID 1>>BDC q 1 0 0 1 100 200 cm BT 9 0 0 9 0 0 Tm (x)Tj ET Q EMC';

    const box = locateMcidBoundingBoxes(content, new Set([1])).get(1);

    expect(box).toBeUndefined();
  });

  it('still returns a box for a genuine flat line (zero height, real width) -- not the same as a true degenerate point', () => {
    const content = '<</MCID 1>>BDC q 1 0 0 1 0 0 cm 0 0 m 50 0 l S Q EMC';

    const box = locateMcidBoundingBoxes(content, new Set([1])).get(1);

    expect(box).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 0 });
  });
});
