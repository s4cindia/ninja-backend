/**
 * Regression coverage for PdfContrastValidator.sampleBackgroundRobust —
 * the background estimate used only by fix-verification
 * (color-contrast-verification.ts), not by detection.
 *
 * Discovered via a live auto-remediation trial: a batch of ~40 apply-to-pdf
 * color-contrast fixes on a real document failed verification at ratios as
 * low as 1.1:1 even after escalating to pure black text. Root cause: the
 * background estimate sampleAverage/sampleDark rely on is a fixed 5px strip
 * positioned exactly "itemH above the text bbox" — itemH is derived purely
 * from font size, with no awareness of actual line spacing, so for tightly
 * packed lines (tables, stacked lists, captions) that strip lands on the
 * *previous* line's ink instead of true background.
 *
 * sampleBackgroundRobust tries several candidate patches near the text and
 * picks whichever has the lowest pixel-luminance variance, since a genuine
 * background patch is comparatively flat while a patch straddling glyph
 * edges has high local contrast. This is a synthetic-pixel test (not a real
 * render) specifically so the contaminated-vs-flat geometry is exact and
 * reproducible, unlike the font-rendering-dependent real-PDF tests
 * elsewhere in this suite.
 *
 * Flatness alone isn't sufficient, though (a review finding on the first
 * version of this method): a flat candidate on a *different* surface than
 * the text's own (an adjacent table row/cell with its own fill) can beat a
 * contaminated-but-correct one just by having lower variance. The
 * `expectedBackground` hint parameter — the caller's prior belief about
 * this text's true background, typically the issue's own originally-
 * detected reading — disambiguates between multiple flat candidates.
 *
 * A second real-world gap (found by re-running a live document after the
 * hint fix shipped): the original 3 candidates are all within ~5-20px of
 * the text. A *recurring page-template element* (a running head, a
 * section-divider band) wider or taller than that contaminates every one
 * of them, on every occurrence, leaving nothing for even an accurate hint
 * to prefer. sampleBackgroundRobust now searches multiple tiers of
 * increasing distance (see MAX_SEARCH_TIERS in the source) before giving
 * up, specifically to escape that case.
 */

import { describe, it, expect } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

// Sized comfortably to fit every tier's candidates (up to ~35px above/below,
// ~65px to the right of a 20px-wide, 10px-tall text box at x=10/top=100)
// with margin, so no candidate clips against a canvas edge and gets
// silently excluded for reasons unrelated to what a test is checking.
const CW = 120;
const CH = 160;
const X = 10, TOP = 100, ITEM_W = 20, ITEM_H = 10;

function makeWhiteCanvas(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(CW * CH * 4);
  data.fill(255);
  return data;
}

function paintRect(data: Uint8ClampedArray, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= CW || py < 0 || py >= CH) continue;
      const i = (py * CW + px) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
}

/** Alternating-pixel checkerboard — guarantees high variance everywhere it's painted, without needing to mirror the source's exact per-tier candidate geometry. */
function paintNoise(data: Uint8ClampedArray, x: number, y: number, w: number, h: number): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= CW || py < 0 || py >= CH) continue;
      const i = (py * CW + px) * 4;
      const dark = (px + py) % 2 === 0;
      const v = dark ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
}

/**
 * Builds a scene reproducing the failure: a flagged text line whose
 * "directly above" strip is half-covered by an adjacent line's dark ink
 * (a realistic partial-glyph-coverage contamination, not a solid fill —
 * partial coverage is what actually produces high variance), while the
 * true page background is white and only visible further above, and to
 * the line's own right.
 */
function buildContaminatedScene() {
  const data = makeWhiteCanvas();

  // "Directly above" candidate (top-5, 5px tall): half painted black,
  // simulating an adjacent line's glyph ink partially covering the strip.
  paintRect(data, X, TOP - 5, 10, 5, [0, 0, 0]);
  // right half of that same strip stays white (default) — high variance.

  return { data, x: X, top: TOP, itemW: ITEM_W, itemH: ITEM_H };
}

describe('PdfContrastValidator.sampleBackgroundRobust', () => {
  it('avoids a contaminated "directly above" strip in favor of a flatter nearby patch', () => {
    const { data, x, top, itemW, itemH } = buildContaminatedScene();

    // The naive single-strip approach (still used by detection, unchanged)
    // reads a contaminated mid-gray average from the half-black/half-white strip.
    const naive = pdfContrastValidator.sampleAverage(data, x, top - 5, itemW, 5, CW, CH);
    expect(naive).toBeTruthy();
    expect(naive!.r).toBeGreaterThan(50);
    expect(naive!.r).toBeLessThan(200); // contaminated: neither white nor black

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH);
    expect(robust).toBeTruthy();
    // Picks the genuinely flat (all-white) candidate instead.
    expect(robust!.color.r).toBeGreaterThan(250);
    expect(robust!.color.g).toBeGreaterThan(250);
    expect(robust!.color.b).toBeGreaterThan(250);
    expect(robust!.variance).toBeLessThan(0.02); // FLAT_VARIANCE_THRESHOLD
  });

  it('reports high variance (uncertain territory) when EVERY candidate across every search tier is contaminated', () => {
    const data = makeWhiteCanvas();
    // Blanket the entire area any tier could possibly sample -- above,
    // below, and to the right, with generous margin -- in noise. Nothing
    // anywhere nearby is flat, at any distance this method will try.
    paintNoise(data, X - 10, TOP - 45, ITEM_W + 90, 100);

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, X, TOP, ITEM_W, ITEM_H, CW, CH);
    expect(robust).toBeTruthy();
    expect(robust!.variance).toBeGreaterThan(0.02); // FLAT_VARIANCE_THRESHOLD — no confidently flat candidate anywhere
  });

  it('escapes a recurring-element-sized contamination that saturates the near tiers, by finding true background at a farther tier', () => {
    // The real-world gap this widened search exists for: a page-template
    // element (a running head / section-divider band) that's wider/taller
    // than the original tight candidates, contaminating tier 0 AND tier 1
    // on every occurrence. True background is only reachable by searching
    // farther out than either of those.
    const data = makeWhiteCanvas();
    // Saturate every tier-0 and tier-1 candidate -- above, right, AND
    // below (so the escape can't come from the trivially-untouched "below"
    // direction; it has to actually reach tier 2). Tier 2+ stays untouched: true white.
    paintNoise(data, X, TOP - 15, ITEM_W, 15);           // above: tiers 0-1
    paintNoise(data, X + ITEM_W + 4, TOP, 16, ITEM_H);   // right: tiers 0-1
    paintNoise(data, X, TOP + 15, ITEM_W, 5);            // below: tier 1

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, X, TOP, ITEM_W, ITEM_H, CW, CH);
    expect(robust).toBeTruthy();
    expect(robust!.variance).toBeLessThan(0.02); // found a confidently flat candidate...
    expect(robust!.color.r).toBeGreaterThan(250); // ...and it's the true white, not a noisy near-tier reading
  });

  it('returns null only when no candidate patch has any in-bounds pixels', () => {
    const data = makeWhiteCanvas();
    // Way off-canvas in every direction.
    const result = pdfContrastValidator.sampleBackgroundRobust(data, -1000, -1000, 20, 10, CW, CH);
    expect(result).toBeNull();
  });

  it('without a hint, picks the nearer flat candidate over a farther one even when both are equally flat', () => {
    const data = makeWhiteCanvas();

    // Leave "directly above" contaminated (as in the first test) so it's
    // excluded, but make BOTH remaining candidates confidently flat with
    // different solid colors -- "to the right" (nearer/same-band) is dark,
    // "further above" (farther/riskier) is white.
    paintRect(data, X, TOP - 5, 10, 5, [0, 0, 0]);
    paintRect(data, X + ITEM_W + 4, TOP, 6, ITEM_H, [40, 40, 40]);       // right of run: flat, dark
    // "further above" (tier 1) left as the default white background: flat, white.

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, X, TOP, ITEM_W, ITEM_H, CW, CH);
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeCloseTo(40, 0); // the nearer (right-of-run) candidate wins, not the farther white one
  });

  it('with a hint, prefers the flat candidate matching it over a nearer-but-mismatched flat candidate', () => {
    const data = makeWhiteCanvas();

    paintRect(data, X, TOP - 5, 10, 5, [0, 0, 0]);                     // directly above: contaminated, excluded
    paintRect(data, X + ITEM_W + 4, TOP, 6, ITEM_H, [40, 40, 40]);     // right of run: flat, dark (nearer)
    // "further above" stays flat, white (farther).

    // Hint says the true background should be white -- overrides the
    // position-priority default (which would otherwise pick the nearer,
    // dark, wrong-surface candidate — see the previous test).
    const robust = pdfContrastValidator.sampleBackgroundRobust(
      data, X, TOP, ITEM_W, ITEM_H, CW, CH, { r: 255, g: 255, b: 255 }
    );
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeGreaterThan(250);
  });

  it('with a hint matching the nearer candidate, still picks it (hint and position agree)', () => {
    const data = makeWhiteCanvas();

    paintRect(data, X, TOP - 5, 10, 5, [0, 0, 0]);
    paintRect(data, X + ITEM_W + 4, TOP, 6, ITEM_H, [40, 40, 40]);

    const robust = pdfContrastValidator.sampleBackgroundRobust(
      data, X, TOP, ITEM_W, ITEM_H, CW, CH, { r: 40, g: 40, b: 40 }
    );
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeCloseTo(40, 0);
  });

  describe('cross-page recurrence (pageRecurrenceCounts)', () => {
    // Mirrors the source's own quantization exactly (SIGNATURE_POSITION_GRID_PX=40,
    // SIGNATURE_COLOR_BUCKET=24) -- buildSignature itself is private, so this
    // recomputes the same signature a given candidate would produce.
    function signatureFor(x: number, y: number, rgb: [number, number, number]): string {
      const qx = Math.round(x / 40);
      const qy = Math.round(y / 40);
      const [qr, qg, qb] = rgb.map(c => Math.round(c / 24));
      return `${qx},${qy}|${qr},${qg},${qb}`;
    }

    it('excludes a flat candidate whose signature has recurred on 3+ prior pages, even though it would otherwise win', () => {
      const data = makeWhiteCanvas();
      // Tier 0 "above" is flat and black -- would normally win outright
      // (checked first, no contest against the plain-white "right" candidate).
      // Painted at the candidate's FULL width (ITEM_W), not a partial
      // sliver -- a half-painted strip would be high-variance (contaminated,
      // like buildContaminatedScene() above), not flat, and would already
      // be excluded by the pre-existing variance filter regardless of this
      // test's actual point (recurrence-based exclusion of a GENUINELY flat candidate).
      paintRect(data, X, TOP - 5, ITEM_W, 5, [0, 0, 0]);

      const tier0AboveSignature = signatureFor(X, TOP - 5, [0, 0, 0]);
      const recurrenceCounts = new Map([[tier0AboveSignature, 3]]); // recurred on 3 distinct prior pages

      const robust = pdfContrastValidator.sampleBackgroundRobust(
        data, X, TOP, ITEM_W, ITEM_H, CW, CH, undefined, recurrenceCounts
      );
      expect(robust).toBeTruthy();
      // Falls through to the "right" candidate instead -- true (white) background.
      expect(robust!.color.r).toBeGreaterThan(250);
    });

    it('does not exclude a flat candidate whose signature has recurred on fewer than the threshold', () => {
      const data = makeWhiteCanvas();
      paintRect(data, X, TOP - 5, ITEM_W, 5, [0, 0, 0]);

      const tier0AboveSignature = signatureFor(X, TOP - 5, [0, 0, 0]);
      const recurrenceCounts = new Map([[tier0AboveSignature, 2]]); // below SUSPECT_PAGE_THRESHOLD (3)

      const robust = pdfContrastValidator.sampleBackgroundRobust(
        data, X, TOP, ITEM_W, ITEM_H, CW, CH, undefined, recurrenceCounts
      );
      expect(robust).toBeTruthy();
      // Still wins -- same as today's behavior, not yet excluded.
      expect(robust!.color.r).toBeCloseTo(0, 0);
    });

    it('with no pageRecurrenceCounts supplied at all, behaves exactly as before (fix-verification\'s call site)', () => {
      const data = makeWhiteCanvas();
      paintRect(data, X, TOP - 5, ITEM_W, 5, [0, 0, 0]);

      const robust = pdfContrastValidator.sampleBackgroundRobust(data, X, TOP, ITEM_W, ITEM_H, CW, CH);
      expect(robust).toBeTruthy();
      expect(robust!.color.r).toBeCloseTo(0, 0);
    });

    it('falls back to the least-bad reading (not null) when the only flat candidate is suspect-recurring and nothing else is flat', () => {
      const data = makeWhiteCanvas();
      // Blanket everything any tier could reach in noise (same technique as
      // the "every candidate contaminated" test above) so nothing else
      // qualifies as flat, then paint ONE genuinely flat patch inside that
      // noisy area and mark it suspect -- confirming exclusion still applies
      // even when it's the only flat-looking candidate, and the method
      // still returns a result rather than null.
      paintNoise(data, X - 10, TOP - 45, ITEM_W + 90, 100);
      paintRect(data, X, TOP - 5, ITEM_W, 5, [0, 0, 0]); // flat (full candidate width), overwriting the noise there

      const recurrenceCounts = new Map([[signatureFor(X, TOP - 5, [0, 0, 0]), 5]]);

      const robust = pdfContrastValidator.sampleBackgroundRobust(
        data, X, TOP, ITEM_W, ITEM_H, CW, CH, undefined, recurrenceCounts
      );
      // Still returns a result (the least-bad of the full sample set) rather
      // than null -- this method never claims "no answer", only "uncertain".
      expect(robust).toBeTruthy();
      expect(robust!.variance).toBeGreaterThan(0.02); // correctly reads as uncertain, not confidently the excluded flat patch
    });
  });
});
