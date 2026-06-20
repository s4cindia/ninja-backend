/**
 * Tests for PDF Contrast Validator boundingBox geometry.
 *
 * The full contrast pass renders pages to a canvas (pdfjs + @napi-rs/canvas),
 * which is not exercisable in a unit test, so the coordinate conversion that
 * feeds issue.boundingBox is isolated in computeTextBoundingBox() and verified
 * directly here. The conversion mirrors text-extractor.service.ts so highlights
 * line up with the alt-text/table/link convention (top-left origin, PDF points).
 */

import { describe, it, expect } from 'vitest';
import { PdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

describe('PdfContrastValidator.computeTextBoundingBox', () => {
  const validator = new PdfContrastValidator();

  it('converts a pdfjs text item to a top-left-origin PDF-point box', () => {
    // pdfjs baseline y (transform[5]) is bottom-left origin; flip to top-left.
    const box = validator.computeTextBoundingBox(100, 700, 80, 12, 612, 792);

    expect(box).toEqual({
      x: 100,
      y: 92, // pageHeight - baselineY = 792 - 700
      width: 80,
      height: 12, // fontSize
      pageWidth: 612,
      pageHeight: 792,
    });
  });

  it('uses PDF points, not canvas/RENDER_SCALE values', () => {
    const box = validator.computeTextBoundingBox(0, 0, 50, 18, 612, 792);
    expect(box?.width).toBe(50);
    expect(box?.height).toBe(18);
  });

  it('returns undefined when the text width is unknown', () => {
    expect(validator.computeTextBoundingBox(100, 700, undefined, 12, 612, 792)).toBeUndefined();
  });

  it('returns undefined when the page size is unknown', () => {
    expect(validator.computeTextBoundingBox(100, 700, 80, 12, 0, 0)).toBeUndefined();
  });
});
