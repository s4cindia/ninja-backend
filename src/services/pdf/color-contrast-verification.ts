/**
 * Color Contrast Verification
 *
 * Ground truth for "does a contrast fix actually work" — re-renders a page
 * and re-samples a region using the exact same pixel-sampling
 * PdfContrastValidator uses to detect issues in the first place, rather
 * than trusting color-contrast-correction.ts's theoretical WCAG math alone.
 *
 * Why this exists: a real audit→apply→re-audit round trip showed that for
 * small/thin text, the validator's "darkest 30% of pixels" sampling is
 * dominated by anti-aliased edge pixels and reads noticeably lighter than
 * the true fill color — enough that a mathematically-correct correction can
 * still measure as failing. Pure black/white reliably measures correctly
 * regardless of font size. pdf-contrast-writer.service.ts uses this module
 * to verify its own work and escalate to an extreme color when a moderate
 * correction doesn't actually verify, instead of reporting success on
 * something that doesn't.
 */

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfContrastValidator, RgbColor } from './validators/pdf-contrast.validator';

// Must match PdfContrastValidator's own render scale — the sampled region
// only lines up with the original detection if both render at the same scale.
const RENDER_SCALE = 1.5;

export interface ContrastVerificationResult {
  ratio: number;
  passes: boolean;
  foreground: string;
  background: string;
}

/**
 * Re-renders `pageNumber` of `buffer` and measures the real contrast ratio
 * within `boundingBox` (top-left-origin, unscaled PDF points — the same
 * convention PdfContrastValidator attaches to AuditIssue.boundingBox).
 * Returns null if the page/region can't be rendered or sampled.
 */
export async function verifyContrastInRegion(
  buffer: Buffer,
  pageNumber: number,
  boundingBox: { x: number; y: number; width: number; height: number },
  requiredRatio: number
): Promise<ContrastVerificationResult | null> {
  let pdfjsDoc: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    pdfjsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const page = await pdfjsDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imgData;
    const cw = canvas.width;
    const ch = canvas.height;

    // Reverses PdfContrastValidator.computeTextBoundingBox's top-left flip:
    // canvasY = RENDER_SCALE * boundingBox.y exactly reproduces the
    // original detection's canvas-space anchor for an axis-aligned page.
    const canvasX = Math.round(boundingBox.x * RENDER_SCALE);
    const canvasY = Math.round(boundingBox.y * RENDER_SCALE);
    const itemW = Math.max(10, Math.round(boundingBox.width * RENDER_SCALE));
    const itemH = Math.max(6, Math.round(boundingBox.height * RENDER_SCALE));
    const top = canvasY - itemH;

    const bgColor: RgbColor | null = pdfContrastValidator.sampleAverage(data, canvasX, top - 5, itemW, 5, cw, ch);
    const fgColor: RgbColor | null = pdfContrastValidator.sampleDark(data, canvasX, top, itemW, itemH, cw, ch);
    if (!bgColor || !fgColor) return null;

    const ratio = pdfContrastValidator.calculateContrastRatio(fgColor, bgColor);
    return {
      ratio: Math.round(ratio * 100) / 100,
      passes: ratio >= requiredRatio,
      foreground: pdfContrastValidator.rgbToHex(fgColor),
      background: pdfContrastValidator.rgbToHex(bgColor),
    };
  } catch {
    return null;
  } finally {
    if (pdfjsDoc) await pdfjsDoc.destroy();
  }
}
