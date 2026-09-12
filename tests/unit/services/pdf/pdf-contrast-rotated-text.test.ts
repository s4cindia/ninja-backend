/**
 * Regression coverage for two related geometry bugs found while investigating
 * why COLOR-CONTRAST issues clustered heavily on three consecutive pages of a
 * real 805-page document: those pages contain a 90-degree-rotated landscape
 * table. Visually the text renders crisp black-on-white, but the validator
 * reported light-gray-on-near-white (ratios as low as 1.87:1) for it.
 *
 * Root cause, confirmed via a real transform dump: rotated text items have a
 * transform like [0, 8, -8, 0, tx, ty] -- a genuine rotation matrix, not the
 * [scale, 0, 0, scale, tx, ty] shape unrotated text has.
 * `Math.abs(item.transform[3])` (the old fontSize formula) evaluates to 0
 * for this shape (the real font size, 8, lives in transform[1]/transform[2]
 * instead), collapsing the sampled box to its 6px floor. Separately, the
 * pixel-sampling box was always built as itemWidth-along-canvas-x by
 * fontSize-along-canvas-y, which is backwards for 90-degree-rotated text
 * (whose glyphs actually flow along canvas-y with fontSize as their
 * canvas-x thickness) -- so even with a correct font size, the sample
 * rectangle would barely overlap the real (vertically-flowing) glyphs,
 * picking up mostly diluted anti-aliased edge pixels and fabricating a low
 * ratio instead of the page's real high contrast.
 *
 * These are pure-geometry helpers with no pixel rendering involved, so
 * (unlike sampleDark's pixel-percentile tests -- see
 * pdf-contrast-sampledark-inverted.test.ts's doc comment) there's no
 * platform/font-substitution risk here; exact transform arrays are enough.
 */

import { describe, it, expect } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

// textItemFontSize / computeItemCanvasBox are private; exercise via cast,
// same pattern used throughout this test suite for private helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validator = pdfContrastValidator as any;

describe('PdfContrastValidator -- rotated-text geometry', () => {
  describe('textItemFontSize', () => {
    it('reads the font size from d for ordinary unrotated horizontal text', () => {
      expect(validator.textItemFontSize([12, 0, 0, 12, 100, 200])).toBeCloseTo(12);
    });

    it('recovers the real font size for 90-degree-rotated text, where d collapses to 0', () => {
      // The exact shape confirmed live: Math.abs(transform[3]) would give 0.
      expect(validator.textItemFontSize([0, 8, -8, 0, 100, 200])).toBeCloseTo(8);
    });

    it('recovers the real font size for 270-degree-rotated text', () => {
      expect(validator.textItemFontSize([0, -8, 8, 0, 100, 200])).toBeCloseTo(8);
    });

    it('is unaffected by horizontal scaling (Tz) applied to unrotated text', () => {
      // a scaled wider than d (horizontal stretch) must not change the
      // font-size reading, which lives purely in the (c, d) pair.
      expect(validator.textItemFontSize([20, 0, 0, 10, 100, 200])).toBeCloseTo(10);
    });
  });

  describe('computeItemCanvasBox', () => {
    // A typical pdf.js page viewport: y-flip (PDF y-up -> canvas y-down)
    // for a 600pt-tall page, no rotation, unit scale.
    const VIEWPORT: number[] = [1, 0, 0, -1, 0, 600];

    it('lays out itemWidth along canvas-x and fontSize along canvas-y for unrotated text (unchanged behavior)', () => {
      const box = validator.computeItemCanvasBox([12, 0, 0, 12, 100, 500], 40, 12, VIEWPORT);

      expect(box.x).toBe(100);
      expect(box.w).toBe(40);
      expect(box.h).toBe(12);
      // Ascent goes toward larger PDF y (up): baseline PDF y=500 -> canvas
      // y=100; ascent top PDF y=512 -> canvas y=88 (smaller canvas y is
      // toward the top of the page under this y-flip viewport).
      expect(box.y).toBe(88);
    });

    it('swaps width and height onto the correct canvas axes for 90-degree-rotated text', () => {
      // transform = [0, 16, -16, 0, tx, ty]: reading direction (a, b) =
      // (0, 16) points along +PDF-y (text flows upward, a vertically-reading
      // column), and ascent direction (c, d) = (-16, 0) points along -PDF-x.
      // fontSize (16) is kept above the 10px floor so the assertions below
      // demonstrate the axis swap, not the floor.
      const box = validator.computeItemCanvasBox([0, 16, -16, 0, 100, 500], 40, 16, VIEWPORT);

      // The naive (pre-fix) box would have been { w: 40, h: 16 } -- backwards.
      expect(box.w).toBe(16);
      expect(box.h).toBe(40);
      expect(box.x).toBe(84);
      expect(box.y).toBe(60);
    });

    it('swaps width and height for 270-degree-rotated text as well', () => {
      const box = validator.computeItemCanvasBox([0, -16, 16, 0, 100, 500], 40, 16, VIEWPORT);

      expect(box.w).toBe(16);
      expect(box.h).toBe(40);
    });

    it('applies the same minimum floors (10 wide, 6 tall) as the pre-fix implementation', () => {
      const box = validator.computeItemCanvasBox([1, 0, 0, 1, 100, 500], 2, 1, VIEWPORT);

      expect(box.w).toBeGreaterThanOrEqual(10);
      expect(box.h).toBeGreaterThanOrEqual(6);
    });
  });
});
