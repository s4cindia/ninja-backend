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
 */

import { describe, it, expect } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

const CW = 50;
const CH = 45;

function makeWhiteCanvas(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(CW * CH * 4);
  data.fill(255);
  return data;
}

function paintRect(data: Uint8ClampedArray, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * CW + px) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
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
  const x = 5, top = 25, itemW = 20, itemH = 10;

  // "Directly above" candidate (top-5, 5px tall): half painted black,
  // simulating an adjacent line's glyph ink partially covering the strip.
  paintRect(data, x, top - 5, 10, 5, [0, 0, 0]);
  // right half of that same strip stays white (default) — high variance.

  return { data, x, top, itemW, itemH };
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

  it('reports high variance (uncertain territory) when every nearby candidate is itself contaminated', () => {
    const data = makeWhiteCanvas();
    const x = 5, top = 25, itemW = 20, itemH = 10;

    // Contaminate all three candidate regions this time.
    paintRect(data, x, top - 5, 10, 5, [0, 0, 0]);              // directly above
    paintRect(data, x, top - itemH - 5, 10, 5, [0, 0, 0]);      // further above
    paintRect(data, x + itemW + 4, top, 3, itemH, [0, 0, 0]);   // right of the run

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH);
    expect(robust).toBeTruthy();
    expect(robust!.variance).toBeGreaterThan(0.02); // FLAT_VARIANCE_THRESHOLD — no confidently flat candidate
  });

  it('returns null only when no candidate patch has any in-bounds pixels', () => {
    const data = makeWhiteCanvas();
    // Way off-canvas in every direction.
    const result = pdfContrastValidator.sampleBackgroundRobust(data, -1000, -1000, 20, 10, CW, CH);
    expect(result).toBeNull();
  });

  it('without a hint, picks the nearer flat candidate over a farther one even when both are equally flat', () => {
    const data = makeWhiteCanvas();
    const x = 5, top = 25, itemW = 20, itemH = 10;

    // Leave "directly above" contaminated (as in the first test) so it's
    // excluded, but make BOTH remaining candidates confidently flat with
    // different solid colors -- "to the right" (nearer/same-band) is dark,
    // "further above" (farther/riskier) is white.
    paintRect(data, x, top - 5, 10, 5, [0, 0, 0]);
    paintRect(data, x + itemW + 4, top, 6, itemH, [40, 40, 40]);       // right of run: flat, dark
    // "further above" left as the default white background: flat, white.

    const robust = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH);
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeCloseTo(40, 0); // the nearer (right-of-run) candidate wins, not the farther white one
  });

  it('with a hint, prefers the flat candidate matching it over a nearer-but-mismatched flat candidate', () => {
    const data = makeWhiteCanvas();
    const x = 5, top = 25, itemW = 20, itemH = 10;

    paintRect(data, x, top - 5, 10, 5, [0, 0, 0]);                     // directly above: contaminated, excluded
    paintRect(data, x + itemW + 4, top, 6, itemH, [40, 40, 40]);       // right of run: flat, dark (nearer)
    // "further above" stays flat, white (farther).

    // Hint says the true background should be white -- overrides the
    // position-priority default (which would otherwise pick the nearer,
    // dark, wrong-surface candidate — see the previous test).
    const robust = pdfContrastValidator.sampleBackgroundRobust(
      data, x, top, itemW, itemH, CW, CH, { r: 255, g: 255, b: 255 }
    );
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeGreaterThan(250);
  });

  it('with a hint matching the nearer candidate, still picks it (hint and position agree)', () => {
    const data = makeWhiteCanvas();
    const x = 5, top = 25, itemW = 20, itemH = 10;

    paintRect(data, x, top - 5, 10, 5, [0, 0, 0]);
    paintRect(data, x + itemW + 4, top, 6, itemH, [40, 40, 40]);

    const robust = pdfContrastValidator.sampleBackgroundRobust(
      data, x, top, itemW, itemH, CW, CH, { r: 40, g: 40, b: 40 }
    );
    expect(robust).toBeTruthy();
    expect(robust!.color.r).toBeCloseTo(40, 0);
  });
});
