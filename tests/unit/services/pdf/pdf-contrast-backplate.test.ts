import { describe, it, expect } from 'vitest';
import { computeBackplateRect, spliceBackplate } from '../../../../src/services/pdf/pdf-contrast-backplate';
import { RENDER_SCALE } from '../../../../src/services/pdf/color-contrast-verification';

describe('computeBackplateRect', () => {
  it('converts a baseline-anchored, top-left-origin boundingBox to a bottom-left-origin re rect', () => {
    // Matches PdfContrastValidator.computeTextBoundingBox's convention:
    // y is the baseline (top-left terms), height is the font size the
    // glyph ascends by *above* that baseline.
    const rect = computeBackplateRect({ x: 100, y: 250, width: 80, height: 14, pageHeight: 700 });
    expect(rect.x).toBe(100);
    // Bottom-left y of the baseline = pageHeight - boundingBox.y, and stays
    // the rect's fixed bottom edge regardless of any height padding.
    expect(rect.y).toBe(700 - 250);
    expect(rect.width).toBe(80);
    expect(rect.height).toBe(14);
  });

  it('pads width/height up to the verification step\'s own canvas-space minimums, never down', () => {
    // A tiny glyph box (e.g. a single punctuation mark) would otherwise be
    // narrower/shorter than what color-contrast-verification.ts actually
    // samples (10x6 canvas px at RENDER_SCALE) -- undersizing the backplate
    // would leave contaminated edge pixels visible to the re-verify step.
    const rect = computeBackplateRect({ x: 0, y: 100, width: 1, height: 1, pageHeight: 200 });
    expect(rect.width).toBeCloseTo(10 / RENDER_SCALE);
    expect(rect.height).toBeCloseTo(6 / RENDER_SCALE);
  });

  it('leaves width/height unpadded when they already exceed the minimums', () => {
    const rect = computeBackplateRect({ x: 0, y: 100, width: 200, height: 20, pageHeight: 200 });
    expect(rect.width).toBe(200);
    expect(rect.height).toBe(20);
  });
});

describe('spliceBackplate', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it('inserts a q/cm/rg/re/f/Q sequence immediately before the enclosing BT', () => {
    const content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1]);

    expect(result).toBeTruthy();
    expect(result!.startsWith('BEFORE\n')).toBe(true);
    expect(result!.endsWith('BT\n<41> Tj\nET\nAFTER')).toBe(true);
    const inserted = result!.slice('BEFORE\n'.length, result!.indexOf('BT\n<41>'));
    expect(inserted).toContain('q');
    expect(inserted).toContain('1 0 0 1 0 0 cm'); // identity CTM -> identity inverse
    expect(inserted).toContain('1 1 1 rg');
    expect(inserted).toContain('10 20 30 40 re');
    expect(inserted).toContain('f');
    expect(inserted).toContain('Q');
    // q/cm/rg/re/f/Q must appear in that relative order.
    const order = ['q', 'cm', 'rg', 're', 'f', 'Q'].map(tok => inserted.indexOf(tok));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it('uses the inverse of a non-identity CTM so the rect ends up in absolute device-space coordinates', () => {
    const content = 'BT\n<41> Tj\nET';
    // A 2x-scaled, translated CTM ambient at the insertion point.
    const result = spliceBackplate(content, { btStart: 0, ctm: { a: 2, d: 4, e: 10, f: 20 } }, rect, [0, 0, 0]);
    expect(result).toContain(`${1 / 2} 0 0 ${1 / 4} ${-10 / 2} ${-20 / 4} cm`);
  });

  it('returns null for a collapsed (non-invertible) CTM rather than drawing something wrong', () => {
    const content = 'BT\n<41> Tj\nET';
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 0, d: 1, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 1, d: 0, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
  });

  it('does not modify content before the insertion point', () => {
    const content = 'PAGE_HEADER_CONTENT\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 0, 0]);
    expect(result!.startsWith('PAGE_HEADER_CONTENT\n')).toBe(true);
  });
});
