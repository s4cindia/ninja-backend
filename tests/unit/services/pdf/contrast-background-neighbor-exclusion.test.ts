/**
 * Regression coverage for sampleBackgroundRobust's otherTextBoxes exclusion.
 *
 * Found via a real 805-page trial document: two lines of a wrapped title,
 * only ~23pt apart and sharing one (low-contrast) color, each measured its
 * "background" as the *other* line's own ink -- contrastData.foreground ===
 * contrastData.background exactly, for both. 171 of 957 real remaining
 * contrast issues on that document showed this exact degenerate pattern.
 * It's permanently unfixable by color-escalation-and-reverify: whatever
 * color the flagged line's text is escalated to, re-verification samples
 * the *same* narrow strip, which is still occupied by the neighboring
 * line's own (unescalated, still-flagged) ink -- so the measured ratio
 * stays ~1:1 forever, regardless of what was actually written.
 *
 * An earlier round of work on this file explicitly reasoned that text
 * contamination "is inherently sparse/high-variance... already handled by
 * variance-based candidate selection without needing the hint to be
 * perfectly accurate" (see the KNOWN LIMITATION tests in
 * color-contrast-verification.test.ts, which only cover a *solid fill*
 * contaminating the strip). That assumption doesn't hold for a narrow
 * enough strip landing on a solid/bold stroke portion of dense text: within
 * a thin enough slice, text can read as locally flat too. otherTextBoxes
 * closes this gap by excluding a candidate that geometrically overlaps
 * another *known* text item's own box, rather than relying on flatness
 * alone to tell "true background" from "another line's ink" apart.
 *
 * Uses a hand-built pixel buffer (not real PDF rendering) for full,
 * deterministic control over exactly where the contamination sits relative
 * to the search candidates -- reproducing the real document's rendering
 * output precisely via pdf-lib text layout proved unreliable across runs.
 */

import { describe, it, expect } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';

const CW = 200;
const CH = 200;

function buildCanvas(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; // white
  }
  return data;
}

function fillRect(data: Uint8ClampedArray, x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * CW + px) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
}

describe('sampleBackgroundRobust otherTextBoxes exclusion', () => {
  // The flagged text's own box: x=50, top=100, itemW=100, itemH=20.
  const x = 50, top = 100, itemW = 100, itemH = 20;

  it('without otherTextBoxes, a same-colored neighboring line directly above reads as the background (the bug)', () => {
    const data = buildCanvas();
    // A neighboring text line's own solid-colored ink, occupying the exact
    // area the tier-0 "above" candidate (top-5 to top) samples.
    fillRect(data, x, top - 10, itemW, 10, [140, 140, 140]);

    const result = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH);
    expect(result).toBeTruthy();
    // Contaminated: reads the neighboring line's own ink color as "background".
    expect(result!.color.r).toBeCloseTo(140, 0);
  });

  it('with otherTextBoxes marking the neighboring line, correctly skips past it to the true white background', () => {
    const data = buildCanvas();
    fillRect(data, x, top - 10, itemW, 10, [140, 140, 140]);

    const neighborBox = { x, y: top - 10, w: itemW, h: 10 };
    const result = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH, undefined, undefined, [neighborBox]);

    expect(result).toBeTruthy();
    expect(result!.color.r).toBeCloseTo(255, 0);
    expect(result!.color.g).toBeCloseTo(255, 0);
    expect(result!.color.b).toBeCloseTo(255, 0);
  });

  it('does not exclude a candidate that does not actually overlap any otherTextBoxes entry', () => {
    const data = buildCanvas();
    // True background everywhere -- no contamination at all.
    const farAwayBox = { x: 0, y: 0, w: 5, h: 5 }; // nowhere near any candidate
    const result = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH, undefined, undefined, [farAwayBox]);

    expect(result).toBeTruthy();
    expect(result!.color.r).toBeCloseTo(255, 0);
  });

  it('falls back to considering an occupied candidate when every candidate on every tier overlaps other text (never returns null just because everything is excluded)', () => {
    const data = buildCanvas();
    // Contaminate the entire searchable area (not just tier 0) so every
    // candidate at every tier overlaps a "known text" box.
    fillRect(data, 0, 0, CW, CH, [140, 140, 140]);
    const wholeCanvasBox = { x: 0, y: 0, w: CW, h: CH };

    const result = pdfContrastValidator.sampleBackgroundRobust(data, x, top, itemW, itemH, CW, CH, undefined, undefined, [wholeCanvasBox]);
    // Must still return *something* (the "everyCandidateSuspect"-style
    // fallback) rather than null -- a real page always has candidates to
    // report on, even when none of them are trustworthy.
    expect(result).toBeTruthy();
  });
});
