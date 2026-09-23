import { describe, it, expect } from 'vitest';
import { computeBackplateRect, spliceBackplate } from '../../../../src/services/pdf/pdf-contrast-backplate';
import { RENDER_SCALE } from '../../../../src/services/pdf/color-contrast-verification';

describe('computeBackplateRect', () => {
  it('converts a baseline-anchored, top-left-origin boundingBox to a bottom-left-origin re rect, padded for tier-0 probe coverage and descenders', () => {
    // Matches PdfContrastValidator.computeTextBoundingBox's convention:
    // y is the baseline (top-left terms), height is the font size the
    // glyph ascends by *above* that baseline.
    const rect = computeBackplateRect({ x: 100, y: 250, width: 80, height: 14, pageHeight: 700 });
    expect(rect.x).toBe(100);
    // Bottom-left y of the baseline = pageHeight - boundingBox.y, minus a
    // descender pad (30% of height) so the rect's bottom edge extends
    // below the baseline rather than sitting exactly on it.
    expect(rect.y).toBeCloseTo(700 - 250 - 14 * 0.3);
    // Width grows by the tier-0 right-probe's own gap+width (4+6 canvas px).
    expect(rect.width).toBeCloseTo(80 + 10 / RENDER_SCALE);
    // Height grows by the tier-0 above-probe (5 canvas px) plus the descender pad.
    expect(rect.height).toBeCloseTo(14 + 5 / RENDER_SCALE + 14 * 0.3);
  });

  it("pads width/height up to the verification step's own canvas-space minimums plus tier-0 probe coverage, never down", () => {
    // A tiny glyph box (e.g. a single punctuation mark) would otherwise be
    // narrower/shorter than what color-contrast-verification.ts actually
    // samples (10x6 canvas px at RENDER_SCALE) -- undersizing the backplate
    // would leave contaminated edge pixels visible to the re-verify step.
    const rect = computeBackplateRect({ x: 0, y: 100, width: 1, height: 1, pageHeight: 200 });
    const flooredHeight = 6 / RENDER_SCALE;
    expect(rect.width).toBeCloseTo((10 + 10) / RENDER_SCALE);
    expect(rect.height).toBeCloseTo(flooredHeight + 5 / RENDER_SCALE + flooredHeight * 0.3);
  });

  it('still adds tier-0 probe coverage and descender padding when width/height already exceed the minimums', () => {
    const rect = computeBackplateRect({ x: 0, y: 100, width: 200, height: 20, pageHeight: 200 });
    expect(rect.width).toBeCloseTo(200 + 10 / RENDER_SCALE);
    expect(rect.height).toBeCloseTo(20 + 5 / RENDER_SCALE + 20 * 0.3);
  });
});

describe('spliceBackplate', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it('inserts an rg/re/f/rg sequence immediately before the enclosing BT, with NO q/Q', () => {
    // Regression test for a real, live-confirmed bug on Math_Weir_PDF.pdf:
    // a q/Q-bracketed rectangle insertion here reliably made the text run
    // immediately after the inserted Q render completely invisible in
    // pdfjs-dist's canvas backend (bisected to the q/Q pair itself, not
    // the color, CTM math, or path-construction operator choice). See this
    // function's own doc comment.
    const content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1]);

    expect(result).toBeTruthy();
    expect(result!.startsWith('BEFORE\n')).toBe(true);
    expect(result!.endsWith('BT\n<41> Tj\nET\nAFTER')).toBe(true);
    const inserted = result!.slice('BEFORE\n'.length, result!.indexOf('BT\n<41>'));

    // No graphics-state save/restore at all.
    expect(/(^|\s)q(\s|$)/.test(inserted)).toBe(false);
    expect(/(^|\s)Q(\s|$)/.test(inserted)).toBe(false);
    // Identity CTM -> no cm op needed at all (not even a no-op one).
    expect(inserted).not.toContain('cm');

    expect(inserted).toContain('1 1 1 rg');
    expect(inserted).toContain('10 20 30 40 re');
    expect(inserted).toContain('f');
    // Explicit restore back to the genuinely ambient color (nothing
    // precedes the insertion point here, so findPrecedingColor's own
    // "unset" fallback is pure black).
    expect(inserted).toContain('0 0 0 rg');

    // rg/re/f must appear in that relative order, with the restore rg
    // strictly after the fill.
    const fillRgIdx = inserted.indexOf('1 1 1 rg');
    const reIdx = inserted.indexOf('10 20 30 40 re');
    const fIdx = inserted.indexOf('f', reIdx);
    const restoreRgIdx = inserted.indexOf('0 0 0 rg');
    expect(reIdx).toBeGreaterThan(fillRgIdx);
    expect(fIdx).toBeGreaterThan(reIdx);
    expect(restoreRgIdx).toBeGreaterThan(fIdx);
  });

  it('brackets a non-identity CTM with cm/inverse-cm (no q/Q) so the rect draws in absolute device-space coordinates and the ambient transform is restored afterward', () => {
    const content = 'BT\n<41> Tj\nET';
    // A 2x-scaled, translated CTM ambient at the insertion point.
    const result = spliceBackplate(content, { btStart: 0, ctm: { a: 2, d: 4, e: 10, f: 20 } }, rect, [0, 0, 0]);
    expect(result).toBeTruthy();
    const cancelIdx = result!.indexOf(`${1 / 2} 0 0 ${1 / 4} ${-10 / 2} ${-20 / 4} cm`);
    const restoreIdx = result!.indexOf('2 0 0 4 10 20 cm');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(cancelIdx);
    expect(/(^|\s)q(\s|$)/.test(result!)).toBe(false);
    expect(/(^|\s)Q(\s|$)/.test(result!)).toBe(false);
  });

  it('returns null for a collapsed (non-invertible) CTM rather than drawing something wrong', () => {
    const content = 'BT\n<41> Tj\nET';
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 0, d: 1, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 1, d: 0, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
  });

  it('returns null rather than guessing when the ambient restore color is set via an untracked sc/scn colorspace op', () => {
    // Matches findPrecedingColor's own documented "bail rather than guess"
    // contract for its null case.
    const content = '/CS0 cs\n0.5 0.2 0.1 0.9 scn\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    expect(spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1])).toBeNull();
  });

  it('restores whatever fill color was genuinely ambient at the insertion point, not pure black unconditionally', () => {
    const content = '0.4 0.4 0.5 rg\nBEFORE\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1]);
    expect(result).toBeTruthy();
    const inserted = result!.slice(0, result!.indexOf('BT\n<41>'));
    expect(inserted).toContain('0.4 0.4 0.5 rg');
  });

  it('does not modify content before the insertion point', () => {
    const content = 'PAGE_HEADER_CONTENT\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 0, 0]);
    expect(result!.startsWith('PAGE_HEADER_CONTENT\n')).toBe(true);
  });
});
