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
import { pdfContrastValidator, RgbColor, FLAT_VARIANCE_THRESHOLD } from './validators/pdf-contrast.validator';

// Must match PdfContrastValidator's own render scale — the sampled region
// only lines up with the original detection if both render at the same scale.
// Exported so a caller needing to reproduce this module's exact sampled
// footprint in PDF-point space (e.g. sizing a backplate rectangle to fully
// cover it) uses this single source of truth rather than a second, driftable
// copy of the same number.
export const RENDER_SCALE = 1.5;

export interface ContrastVerificationResult {
  ratio: number;
  passes: boolean;
  foreground: string;
  background: string;
  // True when no candidate background patch near the text looked confidently
  // flat (see sampleBackgroundRobust) — the ratio/passes above are still the
  // best available estimate, but callers should treat a failing result as
  // "couldn't reliably measure" rather than "genuinely fails contrast."
  uncertain: boolean;
  // The luminance variance behind `uncertain` (bgSample.variance) — exposed
  // so a caller can distinguish "mildly non-flat" from "wildly non-flat"
  // rather than only the boolean threshold crossing. See BUSY_VARIANCE_THRESHOLD
  // in pdf-contrast.validator.ts for how pdf-contrast-writer.service.ts uses this.
  variance: number;
}

/**
 * Re-renders `pageNumber` of `buffer` and measures the real contrast ratio
 * within `boundingBox` (top-left-origin, unscaled PDF points — the same
 * convention PdfContrastValidator attaches to AuditIssue.boundingBox).
 * Returns null if the page/region can't be rendered or sampled.
 *
 * `expectedBackgroundHex`, when passed (typically the issue's own
 * originally-detected `contrastData.background`), disambiguates which of
 * several equally-flat nearby candidates is the text's actual background —
 * see sampleBackgroundRobust for why flatness alone isn't sufficient.
 */
export async function verifyContrastInRegion(
  buffer: Buffer,
  pageNumber: number,
  boundingBox: { x: number; y: number; width: number; height: number },
  requiredRatio: number,
  expectedBackgroundHex?: string
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

    // Every OTHER text item's own canvas-space box on this page, so
    // sampleBackgroundRobust can exclude a candidate that lands on a
    // neighboring line's own glyphs instead of true background -- the same
    // exclusion PdfContrastValidator's own detection pass uses (see that
    // method's otherTextBoxes doc comment), required here too since this
    // module's whole purpose is sampling "the exact same way" detection
    // does. Without it, two same-colored adjacent lines can contaminate
    // each other's background reading forever, regardless of what color a
    // fix escalates the flagged line's text to.
    const [va, vb, vc, vd, ve, vf] = viewport.transform;
    const otherTextBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    try {
      const textContent = await page.getTextContent();
      for (const rawItem of textContent.items) {
        if (!('str' in rawItem)) continue;
        const it = rawItem as { transform: number[]; width?: number };
        const ix = Math.round(va * it.transform[4] + vc * it.transform[5] + ve);
        const iy = Math.round(vb * it.transform[4] + vd * it.transform[5] + vf);
        const iw = Math.max(10, Math.round((it.width ?? 40) * RENDER_SCALE));
        const ih = Math.max(6, Math.round(Math.abs(it.transform[3]) * RENDER_SCALE));
        const ibox = { x: ix, y: iy - ih, w: iw, h: ih };
        // Skip the flagged item's own box (approximate match against the
        // region being verified) so a candidate correctly positioned just
        // outside it is never self-disqualified.
        if (Math.abs(ibox.x - canvasX) < 2 && Math.abs((ibox.y + ibox.h) - canvasY) < 2) continue;
        otherTextBoxes.push(ibox);
      }
    } catch {
      // Non-fatal -- falls back to the pre-existing behavior (no exclusion)
      // if text content can't be extracted for this page.
    }

    const expectedBackground = expectedBackgroundHex ? pdfContrastValidator.hexToRgb(expectedBackgroundHex) : undefined;
    const bgSample = pdfContrastValidator.sampleBackgroundRobust(data, canvasX, top, itemW, itemH, cw, ch, expectedBackground, undefined, otherTextBoxes);
    if (!bgSample) return null;
    // Background must be known before sampling ink, not just before
    // returning -- sampleDark's adaptive path (see its doc comment) needs
    // it to tell sparse ink (dot leaders, thin punctuation) apart from the
    // background/anti-aliasing pixels a flat percentile would otherwise
    // dilute the reading with.
    const fgColor: RgbColor | null = pdfContrastValidator.sampleDark(
      data, canvasX, top, itemW, itemH, cw, ch,
      bgSample.color
    );
    if (!fgColor) return null;

    const ratio = pdfContrastValidator.calculateContrastRatio(fgColor, bgSample.color);
    return {
      ratio: Math.round(ratio * 100) / 100,
      passes: ratio >= requiredRatio,
      foreground: pdfContrastValidator.rgbToHex(fgColor),
      background: pdfContrastValidator.rgbToHex(bgSample.color),
      uncertain: bgSample.variance > FLAT_VARIANCE_THRESHOLD,
      variance: bgSample.variance,
    };
  } catch {
    return null;
  } finally {
    if (pdfjsDoc) await pdfjsDoc.destroy();
  }
}

/**
 * Verifies a BACKPLATE fix specifically -- never use verifyContrastInRegion
 * for this. Codex P1 finding on PR #575, confirmed live on Math_Weir_PDF.pdf:
 * verifyContrastInRegion's expectedBackgroundHex is only a soft hint for
 * sampleBackgroundRobust's candidate SEARCH, not an authoritative value --
 * after a backplate write, the ORIGINAL background (the hint pdf-contrast-
 * writer.service.ts was passing) no longer exists anywhere in the sampled
 * region at all (the backplate rect is deliberately padded to fully cover
 * it), so the search would either latch onto some other, uncovered nearby
 * patch, or land on the backplate itself but get treated as the wrong role.
 * Concretely reproduced: verifying a real black backplate behind original
 * light text (#f0f0f0) returned foreground:#000000 (the backplate's OWN
 * fill, misread as "ink") against some unrelated nearby patch as
 * "background" -- a coincidental, meaningless ratio that never actually
 * measured whether the original text is visible against the new backplate.
 *
 * The fix: we already know the backplate's exact color with certainty (we
 * just wrote it) -- there is nothing to search for. Skip
 * sampleBackgroundRobust entirely and feed sampleDark the known backplate
 * RGB directly as `background`. sampleDark's own light/dark-candidate-swap
 * logic (see its doc comment's "inverted box" handling) then correctly
 * identifies the real text ink regardless of whether it's lighter or
 * darker than the backplate, since it now has the TRUE background instead
 * of a stale or wrong one to compare candidates against.
 */
export async function verifyBackplateContrast(
  buffer: Buffer,
  pageNumber: number,
  boundingBox: { x: number; y: number; width: number; height: number },
  requiredRatio: number,
  backplateColorHex: string
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

    const canvasX = Math.round(boundingBox.x * RENDER_SCALE);
    const canvasY = Math.round(boundingBox.y * RENDER_SCALE);
    const itemW = Math.max(10, Math.round(boundingBox.width * RENDER_SCALE));
    const itemH = Math.max(6, Math.round(boundingBox.height * RENDER_SCALE));
    const top = canvasY - itemH;

    const backplateRgb = pdfContrastValidator.hexToRgb(backplateColorHex);
    const fgColor: RgbColor | null = pdfContrastValidator.sampleDark(
      data, canvasX, top, itemW, itemH, cw, ch,
      backplateRgb
    );
    if (!fgColor) return null;

    const ratio = pdfContrastValidator.calculateContrastRatio(fgColor, backplateRgb);
    return {
      ratio: Math.round(ratio * 100) / 100,
      passes: ratio >= requiredRatio,
      foreground: pdfContrastValidator.rgbToHex(fgColor),
      background: backplateColorHex,
      // The background here is a known, exact, just-written value, not a
      // sampled guess -- there is no "uncertain background" concept to
      // report for it (unlike verifyContrastInRegion's bgSample.variance).
      uncertain: false,
      variance: 0,
    };
  } catch {
    return null;
  } finally {
    if (pdfjsDoc) await pdfjsDoc.destroy();
  }
}
