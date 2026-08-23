import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { verifyContrastInRegion } from '../../../../src/services/pdf/color-contrast-verification';

async function buildPdf(color: number): Promise<Buffer> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font, color: rgb(color, color, color) });
  return Buffer.from(await src.save());
}

// Top-left-origin, unscaled PDF points — the same convention
// PdfContrastValidator.computeTextBoundingBox produces.
const BOUNDING_BOX = { x: 100, y: 150, width: 106, height: 14 };

describe('verifyContrastInRegion', () => {
  it('reproduces the same measurement PdfContrastValidator itself would make', async () => {
    const buffer = await buildPdf(0.6); // deliberately low contrast
    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(false);
    expect(result!.background).toBe('#ffffff');
  });

  it('reports passes:true for genuinely high-contrast text', async () => {
    const buffer = await buildPdf(0); // true black
    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(true);
    expect(result!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('returns null for an out-of-range page rather than throwing', async () => {
    const buffer = await buildPdf(0);
    const result = await verifyContrastInRegion(buffer, 99, BOUNDING_BOX, 4.5);
    expect(result).toBeNull();
  });

  it('respects the requiredRatio threshold passed in', async () => {
    const buffer = await buildPdf(0.6);
    // Same measured ratio, different thresholds — large-text (3:1) may pass
    // where normal-text (4.5:1) does not, for a genuinely borderline case.
    const strict = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);
    const lenient = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 1.0);
    expect(strict!.passes).toBe(false);
    expect(lenient!.passes).toBe(true);
    expect(strict!.ratio).toBe(lenient!.ratio); // same measurement, different bar
  });
});
