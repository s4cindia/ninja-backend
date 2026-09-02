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

  it('correctly verifies true-black text with a table-style fill just above it, instead of sampling the fill as "background"', async () => {
    // Reproduces a real failure from a live auto-remediation trial: a
    // batch of ~40 apply-to-pdf color-contrast fixes measured as low as
    // 1.1-1.9:1 even after escalating to pure black text. Root cause: the
    // background sample is a fixed 5px strip positioned exactly "itemH
    // above the text bbox" with no awareness of what's actually there —
    // confirmed here by reproducing the exact failing magnitude (ratio
    // ~1.2:1, comfortably failing 4.5:1) with a dark fill positioned where
    // a table cell's shading or border commonly sits, directly above a row
    // of cell text. Same failure mode with a horizontal rule line instead
    // of a fill (a table row divider) — not exercised as a second test
    // here since the mechanism and fix are identical.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 95, y: 460, width: 200, height: 10, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0, 0, 0) }); // true black
    const buffer = Buffer.from(await src.save());

    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);

    expect(result).toBeTruthy();
    expect(result!.uncertain).toBe(false);
    expect(result!.passes).toBe(true);
    expect(result!.ratio).toBeGreaterThan(15); // true black on true white, not contaminated by the fill above
  });
});
