/**
 * Regression coverage for PdfContrastValidator.sampleDark's light-on-dark
 * branch -- light/white text on a solid colored callout box (an inverted
 * color scheme, e.g. a "TABLE 19-4" section label).
 *
 * sampleDark always assumed the ink is the DARKER of the two colors present
 * in a text box, which is backwards here: the darkest pixels in the box are
 * the surrounding box color itself (present via inter-glyph gaps), so the
 * old code sampled the BOX as "text," landing on foreground===background
 * and a false 1:1 ratio -- confirmed live in production as a doomed retry
 * loop (escalating to white, already the real color, then re-measuring 1:1
 * forever, every round).
 *
 * A real-font version of this test (drawing actual PDF text via pdf-lib +
 * StandardFonts) passed locally but failed in CI: pdf-lib's standard-14
 * fonts aren't embedded, so pdfjs-dist substitutes a LOCAL system font to
 * render them, and Windows vs. CI's Linux container pick different
 * substitutes with different glyph coverage/anti-aliasing -- enough to
 * shift sampleDark's EXPLAINED_FRACTION_THRESHOLD measurement across the
 * 0.9 boundary. A synthetic pixel buffer (like sampleBackgroundRobust's own
 * sibling test file, pdf-contrast-background-robust.test.ts) sidesteps this
 * entirely: the pixel layout is exact and platform-independent, calling
 * sampleDark directly rather than routing through real font rendering.
 */

import { describe, it, expect } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

const CW = 60, CH = 30;
const BOX_COLOR: [number, number, number] = [119, 92, 164];

function makeBoxCanvas(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BOX_COLOR[0]; data[i + 1] = BOX_COLOR[1]; data[i + 2] = BOX_COLOR[2]; data[i + 3] = 255;
  }
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

describe('PdfContrastValidator.sampleDark -- light-on-dark-box branch', () => {
  it('picks the white ink, not the surrounding box color, when the box IS the sampled background', () => {
    const data = makeBoxCanvas();
    // Three separate white blocks within the text bbox, well spread across
    // its width -- mimicking distinct glyph strokes ("B", "O", "X") rather
    // than one solid patch, and comfortably clearing ~20% ink coverage so
    // the box's own darkest-percentile pixels stay a clean, unmixed box
    // color (only two exact colors present anywhere in the bbox -> a
    // maximal, unambiguous EXPLAINED_FRACTION_THRESHOLD reading).
    paintRect(data, 4, 5, 8, 20, [255, 255, 255]);
    paintRect(data, 26, 5, 8, 20, [255, 255, 255]);
    paintRect(data, 48, 5, 8, 20, [255, 255, 255]);

    const result = pdfContrastValidator.sampleDark(data, 0, 0, CW, CH, CW, CH, { r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });

    expect(result).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('falls back to the darkest-pixel default when no background is supplied (pre-existing behavior, unaffected)', () => {
    const data = makeBoxCanvas();
    paintRect(data, 4, 5, 8, 20, [255, 255, 255]);

    const result = pdfContrastValidator.sampleDark(data, 0, 0, CW, CH, CW, CH);

    // No background hint -> always the darkest percentile, i.e. the box
    // color itself (the light-text branch requires a background to compare
    // against and never runs at all here).
    expect(result).toEqual({ r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });
  });

  it('does not flip to the light candidate when the box is uniform (no real ink present)', () => {
    const data = makeBoxCanvas(); // no white painted at all -- a genuinely flat, textless region

    const result = pdfContrastValidator.sampleDark(data, 0, 0, CW, CH, CW, CH, { r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });

    expect(result).toEqual({ r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });
  });

  // Root-caused from a live document, after the fix above shipped: it only
  // ever unlocked the CLEANEST ~30 of ~440 real cases. Real same-surface
  // candidates pulled from a live document measured explainedFraction as
  // low as 0.66 -- comfortably under EXPLAINED_FRACTION_THRESHOLD (0.9) --
  // leaving the vast majority (149 of 203 checked) permanently stuck in the
  // same "escalate then re-measure 1:1 forever" loop the original fix was
  // meant to end. A third, unrelated-noise color scattered through the box
  // (simulating real-world anti-aliasing/compression noise, not present in
  // the first test above) drags explainedFraction down to ~0.85 here --
  // still well under 0.9 -- while the white ink stays spread across the
  // same rows as the box color (real interleaved glyph structure), which
  // is exactly the case EXPLAINED_FRACTION_FLOOR + MIXED_ROW_FRACTION_THRESHOLD
  // (guard 2's second path) exists to recover.
  it('picks the white ink via the row-mixing path when overall purity alone falls short of the strict threshold', () => {
    const data = makeBoxCanvas();
    paintRect(data, 4, 5, 8, 20, [255, 255, 255]);
    paintRect(data, 26, 5, 8, 20, [255, 255, 255]);
    paintRect(data, 48, 5, 8, 20, [255, 255, 255]);
    // Scattered third-color noise (neither the box color nor white),
    // avoiding the white blocks themselves, spread across every row so it
    // dilutes overall purity without ever fully clearing box-color pixels
    // out of any single row (row-mixing stays intact).
    const NOISE: [number, number, number] = [150, 150, 150];
    for (let py = 0; py < CH; py++) {
      for (let px = 0; px < CW; px++) {
        const inWhiteBlock = (px >= 4 && px < 12) || (px >= 26 && px < 34) || (px >= 48 && px < 56);
        if (inWhiteBlock) continue;
        if ((px + py) % 3 === 0) {
          const i = (py * CW + px) * 4;
          data[i] = NOISE[0]; data[i + 1] = NOISE[1]; data[i + 2] = NOISE[2]; data[i + 3] = 255;
        }
      }
    }

    const result = pdfContrastValidator.sampleDark(data, 0, 0, CW, CH, CW, CH, { r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });

    expect(result).toEqual({ r: 255, g: 255, b: 255 });
  });

  // CodeRabbit review finding on this PR's second commit: mixedRowFraction
  // is a fraction over however many rows were classified light-explained --
  // with very FEW such rows, a single coincidental overlap drives the
  // fraction straight to 1.0 on essentially no real evidence. Constructed
  // here directly: a wide, short canvas where only ONE row is light-
  // explained (well under a genuine multi-row glyph's spread), and that
  // single row happens to also contain a few box-colored pixels (a
  // realistic sub-pixel/anti-aliasing edge, not deliberately adversarial)
  // -- a trivial "100% of 1" mixedRowFraction with no real interleaved
  // structure behind it. Scattered noise elsewhere keeps explainedFraction
  // in the same ~0.8 range the row-mixing path is meant to operate in
  // (ruling out Path A, the strict 0.9 threshold, as what's actually being
  // tested here).
  it('does NOT flip to the light candidate when mixedRowFraction is spuriously perfect from too few rows', () => {
    const WIDE = 200, SHORT = 10;
    const data = new Uint8ClampedArray(WIDE * SHORT * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = BOX_COLOR[0]; data[i + 1] = BOX_COLOR[1]; data[i + 2] = BOX_COLOR[2]; data[i + 3] = 255;
    }
    // Row 0: mostly white (150 of 200px, comfortably above the ~5%-of-2000
    // percentile take, so the light-percentile average is genuinely white),
    // with a handful of box-colored pixels left in place -- the row that
    // manufactures the coincidental overlap.
    for (let px = 0; px < 150; px++) {
      const i = (0 * WIDE + px) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }
    // Scattered third-color noise across the remaining (purely box-colored)
    // rows, diluting explainedFraction into the ~0.8 range without ever
    // creating a second light-explained row.
    const NOISE: [number, number, number] = [150, 150, 150];
    for (let py = 1; py < SHORT; py++) {
      for (let px = 0; px < WIDE; px++) {
        if ((px + py) % 3 === 0) {
          const i = (py * WIDE + px) * 4;
          data[i] = NOISE[0]; data[i + 1] = NOISE[1]; data[i + 2] = NOISE[2]; data[i + 3] = 255;
        }
      }
    }

    const result = pdfContrastValidator.sampleDark(data, 0, 0, WIDE, SHORT, WIDE, SHORT, { r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });

    expect(result).toEqual({ r: BOX_COLOR[0], g: BOX_COLOR[1], b: BOX_COLOR[2] });
  });
});
