/**
 * Regression coverage for detecting a text region with no distinguishable
 * ink at all, as opposed to genuinely low-contrast ink.
 *
 * Root-caused live: ~49 real COLOR-CONTRAST issues on a real 805-page
 * document were chapter-opener bylines/credits drawn in specific embedded
 * subset fonts that render as literal zero visible ink in this validator's
 * own rendering pipeline (@napi-rs/canvas + pdfjs-dist) -- confirmed by
 * rendering the page directly and sampling the exact bbox: only one uniform
 * color present (the background), even though adjacent text in a DIFFERENT
 * font subset on the same page rendered fine. sampleDark/sampleBackgroundRobust
 * were working correctly (there is no second color to find); the bug was
 * reporting a fabricated, misleadingly precise "ratio 1.00:1" COLOR-CONTRAST
 * failure for it instead of flagging the genuine ambiguity honestly (this
 * could be truly invisible authored text, a real defect, OR a font-rendering
 * gap unrelated to how the text renders elsewhere -- not a real defect).
 *
 * isRegionUniform (the pure-pixel detector) is tested directly with
 * synthetic buffers -- no PDF rendering or fonts involved, so (unlike
 * sampleDark's percentile tests -- see pdf-contrast-sampledark-inverted.
 * test.ts's doc comment) there's no platform/font-substitution risk. The
 * end-to-end integration test below reproduces one REAL, reachable cause of
 * zero detectable ink (white-on-white text) without needing to reproduce the
 * specific embedded-font rendering bug itself.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

// isRegionUniform is private; exercise via cast, same pattern used
// throughout this test suite for private helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validator = pdfContrastValidator as any;

const CW = 60, CH = 20;

function makeFlatCanvas(color: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255;
  }
  return data;
}

describe('PdfContrastValidator.isRegionUniform', () => {
  it('is true for a region that is a single flat color throughout', () => {
    const data = makeFlatCanvas([120, 130, 200]);
    expect(validator.isRegionUniform(data, 0, 0, CW, CH, CW, CH)).toBe(true);
  });

  it('tolerates negligible per-pixel noise without losing the uniform reading', () => {
    const data = makeFlatCanvas([120, 130, 200]);
    // Nudge individual channel bytes by 1-2 levels -- well within
    // ZERO_INK_COLOR_TOLERANCE, mimicking harmless rendering noise. Pixel
    // layout is [R,G,B,A] per pixel, so indices 0/1 are pixel 0's own R/G
    // and index 4 is the NEXT pixel's R (not pixel 0's G).
    data[0] = 121; // pixel 0's R: 120 -> 121
    data[1] = 132; // pixel 0's G: 130 -> 132
    data[4] = 122; // pixel 1's R: 120 -> 122
    expect(validator.isRegionUniform(data, 0, 0, CW, CH, CW, CH)).toBe(true);
  });

  it('is false the moment a real second color is present anywhere, even a small patch', () => {
    const data = makeFlatCanvas([255, 255, 255]);
    // A small dark patch -- e.g. actual (if faint) glyph ink.
    for (let py = 5; py < 10; py++) {
      for (let px = 5; px < 15; px++) {
        const i = (py * CW + px) * 4;
        data[i] = 40; data[i + 1] = 40; data[i + 2] = 40;
      }
    }
    expect(validator.isRegionUniform(data, 0, 0, CW, CH, CW, CH)).toBe(false);
  });

  // The KNOWN LIMITATION scenario (color-contrast-verification.test.ts): a
  // large flat fill fools both sampleDark's darkest-percentile default AND
  // sampleBackgroundRobust into picking the SAME wrong color, even though
  // real (if wrongly-sampled) low-contrast text ink genuinely exists too.
  // isRegionUniform must say false here -- a real second color IS present in
  // the box -- so this class stays on the existing, accepted ratio-based
  // path rather than being misclassified as "no ink at all."
  it('is false when a real but low-contrast second color exists, even if every summary statistic converges on the wrong one', () => {
    const data = makeFlatCanvas([26, 26, 26]); // the dominant, wrongly-sampled fill
    // Gray text ink genuinely present in a corner of the box.
    for (let py = 8; py < 14; py++) {
      for (let px = 20; px < 40; px++) {
        const i = (py * CW + px) * 4;
        data[i] = 153; data[i + 1] = 153; data[i + 2] = 153;
      }
    }
    expect(validator.isRegionUniform(data, 0, 0, CW, CH, CW, CH)).toBe(false);
  });
});

describe('PdfContrastValidator end-to-end: no detectable ink', () => {
  it('flags white-on-white text honestly, without a fabricated ratio or contrastData', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    // Genuinely invisible: white ink on the page's own (white) background --
    // a real, reachable zero-detectable-ink case, distinct from the specific
    // embedded-font rendering bug found live, but with the identical pixel
    // signature (the whole box renders as one uniform color).
    page.drawText('Invisible byline text', { x: 60, y: 450, size: 14, font, color: rgb(1, 1, 1) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'zero-ink-white-on-white', 'test.pdf', 'custom', ['contrast']);
    const issue = report.issues.find(i => i.code === 'COLOR-CONTRAST');

    expect(issue).toBeTruthy();
    expect(issue!.contrastData).toBeUndefined();
    expect(issue!.triage?.disposition).toBe('manual');
    expect(issue!.triage?.confidence).toBe(0);
    expect(issue!.message.toLowerCase()).toContain('no visually distinguishable ink');
  });

  it('still reports a normal measured ratio for genuinely low-contrast (but present) ink', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 60, y: 450, size: 14, font, color: rgb(0.85, 0.85, 0.85) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'zero-ink-control-lowcontrast', 'test.pdf', 'custom', ['contrast']);
    const issue = report.issues.find(i => i.code === 'COLOR-CONTRAST');

    expect(issue).toBeTruthy();
    expect(issue!.contrastData).toBeTruthy();
    expect(issue!.contrastData!.ratio).toBeGreaterThan(0);
  });
});
