/**
 * PDF Contrast Validator
 *
 * Validates color contrast in PDFs for WCAG compliance.
 * Renders each page to canvas using pdfjs-dist + @napi-rs/canvas, then
 * samples foreground/background pixel colors from text bounding boxes to
 * calculate WCAG contrast ratios.
 *
 * WCAG 1.4.3 (Contrast Minimum) - Level AA: 4.5:1 normal text, 3:1 large text
 */

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { logger } from '../../../lib/logger';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';
import { pdfConfig } from '../../../config/pdf.config';

/**
 * RGB color representation
 */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}


// Render scale — 1.5x gives good resolution without excessive memory
const RENDER_SCALE = 1.5;
// Max issues emitted per page (spatial deduplication also applied)
const MAX_ISSUES_PER_PAGE = 20;
// Spatial grid cell size in canvas pixels (avoid duplicate issues for nearby text)
const GRID_CELL_PX = 80;
// Fraction of the text bounding box's pixels averaged to estimate ink color.
// The box spans the full font-size height (ascender to baseline), but actual
// glyph-ink coverage within it is typically far below that — measured at ~6%
// for regular-weight 14pt text. A wide percentile like the previous 0.3
// dilutes the average with background/anti-aliased pixels: true black 14pt
// text sampled as ~#a3a3a3 (2.5:1) instead of near-black (~21:1), a false
// positive severe enough to misflag ordinary body text as failing contrast.
// 0.05 stays consistently close to the true ink color across regular/bold
// and 9-28pt text tested, without introducing false negatives — genuinely
// low-contrast text (e.g. true #999999) still measures as failing either way.
const DARK_SAMPLE_PERCENTILE = 0.05;

// Used only by sampleBackgroundRobust (fix-verification path, not detection
// above). Above this luminance-variance value, no candidate patch looked
// confidently "flat" (background-like) — e.g. a 50/50 straddle of black
// (lum 0) and white (lum 1) pixels has variance 0.25; real background
// patches, even mildly textured ones, measured well under this in testing.
// Lets color-contrast-verification.ts distinguish "genuinely failed to
// verify" from "couldn't confidently measure the background here at all."
export const FLAT_VARIANCE_THRESHOLD = 0.02;

// sampleBackgroundRobust searches this many "tiers" of increasing distance
// before giving up. Tier 0 is the original tight candidates (~5-10px);
// each further tier steps out roughly one more text-line-height, up to a
// hard cap of 3 line-heights (tier 3) -- a few dozen px at typical body
// text sizes. Bounded deliberately: search far enough to escape a
// recurring page-template element (a running head, section-divider band)
// that's wider/taller than the original tight candidates, but not so far
// that a genuinely different region of the page (another paragraph, an
// image) gets sampled and mistaken for this text's own background.
const MAX_SEARCH_TIERS = 4;

// Cross-page recurrence detection (detection only -- see buildSignature and
// the backgroundSignatureCounts field). Position quantized to this many
// canvas px so minor per-occurrence jitter (different text lengths shifting
// a running head's own reference point slightly) still counts as the same
// recurring element.
const SIGNATURE_POSITION_GRID_PX = 40;
// Color quantized to buckets this wide (0-255 scale) so anti-aliasing/JPEG
// noise between occurrences of the same real element doesn't fragment the
// signature into many near-identical-but-technically-distinct entries.
const SIGNATURE_COLOR_BUCKET = 24;
// A signature must recur on at least this many DISTINCT EARLIER pages
// before a candidate carrying it is excluded as a suspected decorative/
// page-template element rather than genuine background. An absolute count,
// not a fraction of document length -- a genuine recurring template element
// appears at roughly the same rate regardless of how long the document is.
// Starting value, not empirically tuned against a real-document corpus yet.
const SUSPECT_PAGE_THRESHOLD = 3;

/**
 * PDF Contrast Validator
 *
 * Renders pages via pdfjs + @napi-rs/canvas and samples pixel colors to
 * detect text with insufficient contrast against its background.
 */
export class PdfContrastValidator {
  name = 'PdfContrastValidator';
  static readonly IS_IMPLEMENTED = true;

  private issueCounter = 0;
  // Cross-page recurrence tracking (see buildSignature/SUSPECT_PAGE_THRESHOLD
  // above) -- signature -> number of DISTINCT prior pages it's been seen on.
  // Reset per validate() call; incremented once per page (not per item) in
  // validatePageContrast, after that page's items are fully processed.
  private backgroundSignatureCounts = new Map<string, number>();

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    if (!parsed.parsedPdf) {
      logger.info('[PdfContrastValidator] No parsedPdf — skipping contrast check');
      return [];
    }

    logger.info('[PdfContrastValidator] Starting contrast validation...');
    this.issueCounter = 0;
    this.backgroundSignatureCounts = new Map();

    const issues: AuditIssue[] = [];
    const cap = pdfConfig.maxContrastPages;
    const pages = cap > 0 ? parsed.pages.slice(0, cap) : parsed.pages;

    if (cap > 0 && parsed.pages.length > cap) {
      logger.warn(`[PdfContrastValidator] MAX_CONTRAST_PAGES=${cap} — checking first ${cap} of ${parsed.pages.length} pages`);
    }

    for (const page of pages) {
      if (page.content.length === 0) continue;
      try {
        const pageIssues = await this.validatePageContrast(parsed.parsedPdf.pdfjsDoc, page);
        issues.push(...pageIssues);
      } catch (err) {
        logger.warn(
          `[PdfContrastValidator] Page ${page.pageNumber} failed (non-fatal): ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
    }

    logger.info(`[PdfContrastValidator] Found ${issues.length} contrast issue(s)`);
    return issues;
  }

  private async validatePageContrast(
    pdfjsDoc: pdfjsLib.PDFDocumentProxy,
    page: PdfParseResult['pages'][0]
  ): Promise<AuditIssue[]> {
    const pdfjsPage = await pdfjsDoc.getPage(page.pageNumber);
    const viewport = pdfjsPage.getViewport({ scale: RENDER_SCALE });

    // Render page to an @napi-rs/canvas
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pdfjsPage.render({ canvas: canvas as any, canvasContext: ctx as any, viewport }).promise;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imgData;
    const cw = canvas.width;
    const ch = canvas.height;

    // Get text items (position + dimensions in PDF space)
    const textContent = await pdfjsPage.getTextContent();
    const styles = textContent.styles as Record<string, { fontFamily?: string }> | undefined;
    const [va, vb, vc, vd, ve, vf] = viewport.transform;

    const issues: AuditIssue[] = [];
    const usedCells = new Set<string>();
    // Distinct background signatures actually seen on THIS page -- folded
    // into the cross-page backgroundSignatureCounts once, after this page's
    // items are done, so a signature repeated across multiple items on the
    // SAME page counts as one page-occurrence, not several.
    const signaturesSeenThisPage = new Set<string>();

    for (const rawItem of textContent.items) {
      if (issues.length >= MAX_ISSUES_PER_PAGE) break;

      // TextItem (not TextMarkedContent which has no str field)
      if (!('str' in rawItem)) continue;
      const item = rawItem as { str: string; transform: number[]; width?: number; height?: number; fontName?: string };

      const str = item.str ?? '';
      if (str.trim().length < 3) continue;

      // item.transform = [a, b, c, d, pdfX, pdfY]
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];
      const fontSize = Math.abs(item.transform[3]);

      // Convert PDF space to canvas space via viewport transform
      const canvasX = Math.round(va * pdfX + vc * pdfY + ve);
      const canvasY = Math.round(vb * pdfX + vd * pdfY + vf);

      const itemW = Math.max(10, Math.round((item.width ?? 40) * RENDER_SCALE));
      const itemH = Math.max(6, Math.round(fontSize * RENDER_SCALE));

      // Top of text bbox in canvas coords (pdfjs y=0 is top of canvas)
      const top = canvasY - itemH;
      if (top < 4 || canvasX < 0 || canvasX + itemW > cw || top + itemH > ch) continue;

      // Spatial deduplication
      const cellKey = `${Math.floor(canvasX / GRID_CELL_PX)},${Math.floor(top / GRID_CELL_PX)}`;
      if (usedCells.has(cellKey)) continue;
      usedCells.add(cellKey);

      // Background: same tiered/flat-variance search sampleBackgroundRobust
      // already does for fix-verification (PR #513/#514) -- a single fixed
      // 5px strip above the text lands squarely inside a solid-fill band on
      // a genuinely static background, corrupting this reading (cd.background)
      // at the source; no amount of improving the fix-time search can rescue
      // a hint that's already wrong. No expectedBackground hint here (this
      // *is* the first-ever reading; there's nothing prior to compare against).
      // backgroundSignatureCounts (cross-page recurrence so far, from EARLIER
      // pages only -- this page's own occurrences aren't folded in until
      // after its loop finishes below) lets this exclude a candidate that's
      // recurred at the same position/color on enough prior pages to look
      // like a page-template element rather than genuine background.
      const bgSample = this.sampleBackgroundRobust(data, canvasX, top, itemW, itemH, cw, ch, undefined, this.backgroundSignatureCounts);
      if (!bgSample) continue;
      const bgColor = bgSample.color;
      signaturesSeenThisPage.add(bgSample.signature);

      // Text color: darkest 30th-percentile pixels within the text bbox
      const textColor = this.sampleDark(data, canvasX, top, itemW, itemH, cw, ch);
      if (!textColor) continue;

      const isBold = this.detectBold(item.fontName ? styles?.[item.fontName]?.fontFamily : undefined);
      const isLarge = this.isLargeText(fontSize, isBold);
      const threshold = isLarge ? 3.0 : 4.5;
      const ratio = this.calculateContrastRatio(textColor, bgColor);

      if (ratio < threshold) {
        const severity: AuditIssue['severity'] = ratio < 3.0 ? 'critical' : 'serious';
        issues.push({
          id: `contrast-${++this.issueCounter}`,
          source: 'contrast-validator',
          severity,
          code: 'COLOR-CONTRAST',
          message: `Text has contrast ratio ${ratio.toFixed(2)}:1 (minimum ${threshold}:1 required for ${isLarge ? 'large' : 'normal'} text)`,
          wcagCriteria: ['1.4.3'],
          location: `Page ${page.pageNumber} at (${Math.round(pdfX)}, ${Math.round(pdfY)})`,
          category: 'contrast',
          suggestion:
            'Increase contrast between text and background. Use a color contrast checker to achieve ' +
            '≥4.5:1 for normal text or ≥3:1 for large text (18pt+ or 14pt+ bold).',
          context:
            `Text: "${str.substring(0, 50)}", ` +
            `fg=${this.rgbToHex(textColor)}, bg=${this.rgbToHex(bgColor)}, ratio=${ratio.toFixed(2)}:1`,
          pageNumber: page.pageNumber,
          // Use UNSCALED PDF-point coords (not the canvas/RENDER_SCALE values above)
          boundingBox: this.computeTextBoundingBox(
            pdfX, pdfY, item.width, fontSize, page.width, page.height
          ),
          contrastData: {
            foreground: this.rgbToHex(textColor),
            background: this.rgbToHex(bgColor),
            ratio: Math.round(ratio * 100) / 100,
            requiredRatio: threshold,
            isLargeText: isLarge,
          },
        });
      }
    }

    // Fold this page's distinct background signatures into the persistent,
    // cross-page count -- once per signature, regardless of how many items
    // on this page shared it. Deliberately after this page's own items are
    // fully processed (see the call site above): a signature only excludes
    // a candidate once it's recurred on prior pages, never the current one.
    for (const signature of signaturesSeenThisPage) {
      this.backgroundSignatureCounts.set(signature, (this.backgroundSignatureCounts.get(signature) ?? 0) + 1);
    }

    return issues;
  }

  /**
   * Quantizes a background candidate's canvas position and sampled color
   * into a coarse signature string, tolerant of minor rendering jitter
   * between different occurrences of the same real page element (see
   * SIGNATURE_POSITION_GRID_PX / SIGNATURE_COLOR_BUCKET above).
   */
  private buildSignature(x: number, y: number, color: RgbColor): string {
    const qx = Math.round(x / SIGNATURE_POSITION_GRID_PX);
    const qy = Math.round(y / SIGNATURE_POSITION_GRID_PX);
    const qr = Math.round(color.r / SIGNATURE_COLOR_BUCKET);
    const qg = Math.round(color.g / SIGNATURE_COLOR_BUCKET);
    const qb = Math.round(color.b / SIGNATURE_COLOR_BUCKET);
    return `${qx},${qy}|${qr},${qg},${qb}`;
  }

  // ─── Pixel sampling helpers (public — reused by color-contrast-verification.ts
  // to re-sample a region after a fix is applied, using the exact same
  // sampling this validator uses to detect issues in the first place) ────────

  sampleAverage(
    data: Uint8ClampedArray,
    x: number, y: number, w: number, h: number,
    cw: number, ch: number
  ): RgbColor | null {
    let r = 0, g = 0, b = 0, n = 0;
    for (let py = Math.max(0, y); py < Math.min(y + h, ch); py++) {
      for (let px = Math.max(0, x); px < Math.min(x + w, cw); px++) {
        const i = (py * cw + px) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        n++;
      }
    }
    return n > 0 ? { r: r / n, g: g / n, b: b / n } : null;
  }

  /** Returns the average color of the darkest DARK_SAMPLE_PERCENTILE of pixels (estimates text ink color). */
  sampleDark(
    data: Uint8ClampedArray,
    x: number, y: number, w: number, h: number,
    cw: number, ch: number
  ): RgbColor | null {
    const pixels: Array<{ lum: number; r: number; g: number; b: number }> = [];

    for (let py = Math.max(0, y); py < Math.min(y + h, ch); py++) {
      for (let px = Math.max(0, x); px < Math.min(x + w, cw); px++) {
        const i = (py * cw + px) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        pixels.push({ lum: this.getLuminance(r, g, b), r, g, b });
      }
    }

    if (pixels.length === 0) return null;
    pixels.sort((a, b) => a.lum - b.lum);
    const take = Math.max(1, Math.floor(pixels.length * DARK_SAMPLE_PERCENTILE));
    const subset = pixels.slice(0, take);
    return {
      r: subset.reduce((s, v) => s + v.r, 0) / take,
      g: subset.reduce((s, v) => s + v.g, 0) / take,
      b: subset.reduce((s, v) => s + v.b, 0) / take,
    };
  }

  /**
   * Background estimate used only by fix-verification (color-contrast-
   * verification.ts) — sampleAverage's single fixed strip ("5px directly
   * above the text bbox") assumes each line of text sits in isolation over
   * its background. For densely-packed lines (tables, stacked lists,
   * captions) that strip can land on a rule, cell fill, or the *previous*
   * line's ink instead of true background: itemH is derived purely from
   * font size, with no awareness of actual line spacing.
   *
   * Tries candidate patches near the text across MAX_SEARCH_TIERS tiers of
   * increasing distance. Tier 0 is "directly above" and "to the right",
   * both immediately adjacent to the text (typically the same table
   * cell/row) — unchanged from the original, well-reviewed design. Each
   * further tier steps out roughly one more line-height in three
   * directions (above, below, and right), since a *recurring page-template
   * element* (a running head, a section-divider band) can be wider or
   * taller than a single tight probe reaches — the live document this was
   * built against had a case exactly like that: contamination persisted on
   * dozens of pages, wide/tall enough that neither tier 0 candidate, hint
   * or not, ever found true background.
   *
   * From tier 1 on, "above"/"below" are tried BEFORE "right" within each
   * tier — deliberately, not incidentally. A horizontally wide
   * contaminating element keeps every "right" candidate flat no matter how
   * far right the search goes (moving sideways never exits something
   * that's wide throughout), while "above"/"below" can actually exit it by
   * crossing its usually-much-shorter height. Without this ordering, a
   * still-contaminated tier-1 "right" candidate would out-rank a
   * genuinely-clear tier-2 "above" one purely because tier-then-direction
   * iteration reached it first — a real bug this method shipped with
   * initially (found by testing against the actual recurring-band failure,
   * not just the synthetic fixture that motivated adding the extra tiers).
   *
   * Selection is variance-first (true background is comparatively flat;
   * a patch straddling glyph/rule/fill edges is not) but NOT variance-only
   * — an earlier version of this method picked whichever candidate was
   * flattest across all candidates regardless of position, which let a flat
   * *wrong* surface win (e.g. a uniformly-white previous table row beating
   * a uniformly-dark current cell fill, both variance ~0). When multiple
   * candidates are confidently flat, `expectedBackground` — the caller's
   * prior belief about what this text's background should be, typically
   * the ratio detector's own original reading — breaks the tie in favor of
   * whichever flat candidate actually matches it, rather than trusting
   * flatness alone. Without a hint, the nearest-in-priority flat candidate
   * wins (already the safer choice by position).
   *
   * KNOWN LIMITATION: `expectedBackground` only helps when it's actually
   * trustworthy. For a *static* page element (a permanent fill/rule, as
   * opposed to nearby text, which fixes recolor over the course of a
   * batch), the same narrow strip fools detection identically to fix-time
   * verification -- so the hint can itself already be the wrong (fill's)
   * color, and this method has no way to know that from local pixel data
   * alone. That specific case remains unresolved by this method; see the
   * "KNOWN LIMITATION" test in color-contrast-verification.test.ts. It
   * does not appear to be what the live document above actually hit,
   * though (a static fill fooling detection would bias the caller's
   * moderate/extreme color choice toward white, not black, which is what
   * every one of those real failures used) -- more likely an adjacent
   * line's own fix, applied earlier in the same batch, darkened what a
   * later issue's fix-time verification sees relative to what analysis
   * saw before that batch started. That case this method does handle:
   * text contamination is inherently sparse/high-variance, not flat, so
   * variance-based selection already routes around it, and the hint (a
   * pre-batch reading) additionally out-votes a same-batch drift when
   * multiple candidates do end up looking flat.
   *
   * Returns null only when no candidate patch has any in-bounds pixels.
   *
   * `pageRecurrenceCounts`, when supplied (detection only -- see
   * PdfContrastValidator.validatePageContrast/buildSignature; fix-
   * verification never passes this, so its behavior is entirely unchanged),
   * additionally excludes a flat candidate whose position+color signature
   * has already recurred on SUSPECT_PAGE_THRESHOLD+ earlier pages -- a
   * signal a single-page flatness/hint check can't see at all. Unlike
   * flatness or a position/hint match, recurrence across many pages can't
   * be produced by a legitimate one-off background (a table cell's own
   * fill, say) that just happens to be small and flat -- only a genuinely
   * repeating page element does that, which is exactly the KNOWN
   * LIMITATION case above this fixes.
   */
  sampleBackgroundRobust(
    data: Uint8ClampedArray,
    x: number, top: number, itemW: number, itemH: number,
    cw: number, ch: number,
    expectedBackground?: RgbColor,
    pageRecurrenceCounts?: Map<string, number>
  ): { color: RgbColor; variance: number; signature: string } | null {
    // Tier 0 keeps its original two-candidate order (above, then right) --
    // this is the well-reviewed PR #513 behavior for the common case and
    // stays unchanged. From tier 1 on, "above"/"below" are pushed BEFORE
    // "right": a horizontally wide contaminating element (the motivating
    // real case for tiers beyond 0) keeps every "right" candidate flat no
    // matter how far right the search goes, since moving sideways never
    // exits something that's wide throughout — only "above"/"below" can
    // actually exit a band by crossing its (usually much shorter) height.
    // Without this, a still-contaminated-but-flat tier-1 "right" candidate
    // would out-rank a genuinely-clear tier-2 "above" one on array order
    // alone, even though the latter is the correct answer.
    const candidates: Array<{ x: number; y: number; w: number; h: number }> = [
      { x, y: top - 5, w: itemW, h: 5 },             // tier 0 above
      { x: x + itemW + 4, y: top, w: 6, h: itemH },  // tier 0 right
    ];
    for (let tier = 1; tier < MAX_SEARCH_TIERS; tier++) {
      candidates.push({ x, y: top - tier * itemH - 5, w: itemW, h: 5 });                  // above
      candidates.push({ x, y: top + itemH + (tier - 1) * itemH + 5, w: itemW, h: 5 });    // below
      candidates.push({ x: x + itemW + 4 + tier * 10, y: top, w: 6, h: itemH });          // right of the run
    }

    const samples = candidates
      .map(c => {
        const s = this.sampleWithVariance(data, c.x, c.y, c.w, c.h, cw, ch);
        return s ? { ...s, signature: this.buildSignature(c.x, c.y, s.color) } : null;
      })
      .filter((s): s is { color: RgbColor; variance: number; signature: string } => s !== null);
    if (samples.length === 0) return null;

    const isSuspectRecurring = (signature: string): boolean =>
      (pageRecurrenceCounts?.get(signature) ?? 0) >= SUSPECT_PAGE_THRESHOLD;

    // Suspect-recurring candidates are excluded from consideration entirely
    // -- not just from the "confidently flat" bucket, but from the "least-
    // bad" fallback pool too. A flat-but-suspect candidate would otherwise
    // still win the least-bad reduce on its (low, but untrustworthy)
    // variance alone, silently defeating the whole exclusion. Only fall
    // back to considering suspect candidates when literally nothing else
    // was sampled at all (every candidate on every tier is suspect) --
    // and even then, force the result to read as uncertain (see below),
    // since we specifically know it isn't trustworthy.
    const nonSuspect = samples.filter(s => !isSuspectRecurring(s.signature));
    const everyCandidateSuspect = nonSuspect.length === 0;
    const consideredPool = everyCandidateSuspect ? samples : nonSuspect;

    const flat = consideredPool.filter(s => s.variance <= FLAT_VARIANCE_THRESHOLD);
    if (flat.length === 0) {
      // Nothing confidently flat (and not suspected-recurring, unless every
      // candidate is) anywhere nearby — return the least-bad reading; the
      // caller still flags this uncertain via the same variance threshold,
      // it just needs *a* color to report a ratio for.
      const leastBad = consideredPool.reduce((a, b) => (b.variance < a.variance ? b : a));
      if (everyCandidateSuspect && leastBad.variance <= FLAT_VARIANCE_THRESHOLD) {
        // Every candidate is suspect AND this one happens to look flat --
        // report it as uncertain regardless, rather than silently trusting
        // a reading we specifically know is likely a recurring page-template
        // element, not real background.
        return { ...leastBad, variance: FLAT_VARIANCE_THRESHOLD + 0.001 };
      }
      return leastBad;
    }
    if (!expectedBackground) return flat[0]; // priority order above already favors the safer/nearer candidate

    return flat.reduce((best, s) =>
      this.colorDistanceSq(s.color, expectedBackground) < this.colorDistanceSq(best.color, expectedBackground)
        ? s
        : best
    );
  }

  private colorDistanceSq(a: RgbColor, b: RgbColor): number {
    return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
  }

  /** Average color plus luminance variance for one rectangular patch. Null if the patch has no in-bounds pixels. */
  private sampleWithVariance(
    data: Uint8ClampedArray,
    x: number, y: number, w: number, h: number,
    cw: number, ch: number
  ): { color: RgbColor; variance: number } | null {
    const pixels: Array<{ lum: number; r: number; g: number; b: number }> = [];
    for (let py = Math.max(0, y); py < Math.min(y + h, ch); py++) {
      for (let px = Math.max(0, x); px < Math.min(x + w, cw); px++) {
        const i = (py * cw + px) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        pixels.push({ lum: this.getLuminance(r, g, b), r, g, b });
      }
    }
    if (pixels.length === 0) return null;

    const meanLum = pixels.reduce((s, p) => s + p.lum, 0) / pixels.length;
    const variance = pixels.reduce((s, p) => s + (p.lum - meanLum) ** 2, 0) / pixels.length;
    return {
      color: {
        r: pixels.reduce((s, p) => s + p.r, 0) / pixels.length,
        g: pixels.reduce((s, p) => s + p.g, 0) / pixels.length,
        b: pixels.reduce((s, p) => s + p.b, 0) / pixels.length,
      },
      variance,
    };
  }

  // ─── Public helpers (used by tests and AI analysis) ───────────────────────

  /**
   * Build a top-left-origin boundingBox (unscaled PDF points) for a text item.
   *
   * pdfjs text-item coordinates (transform[4]/[5]) are PDF user space with a
   * BOTTOM-LEFT origin, where transform[5] is the text baseline. The canonical
   * boundingBox uses a TOP-LEFT origin matching the text/structure extractors
   * (text-extractor.service.ts: y = pageHeight - transform[5], height = fontSize).
   * Deliberately uses PDF points — NOT the canvas/RENDER_SCALE values used for
   * pixel sampling.
   *
   * Returns undefined when the text width or page size is unknown, so the box is
   * only attached when every value is a real number.
   */
  computeTextBoundingBox(
    pdfX: number,
    pdfBaselineY: number,
    itemWidth: number | undefined,
    fontSize: number,
    pageWidth: number,
    pageHeight: number,
  ): AuditIssue['boundingBox'] | undefined {
    if (
      !(typeof itemWidth === 'number' && itemWidth > 0) ||
      !(fontSize > 0) ||
      !(pageWidth > 0) ||
      !(pageHeight > 0)
    ) {
      return undefined;
    }
    return {
      x: pdfX,
      y: pageHeight - pdfBaselineY,
      width: itemWidth,
      height: fontSize,
      pageWidth,
      pageHeight,
    };
  }

  calculateContrastRatio(color1: RgbColor, color2: RgbColor): number {
    const l1 = this.getLuminance(color1.r, color1.g, color1.b);
    const l2 = this.getLuminance(color2.r, color2.g, color2.b);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Heuristic: pdf.js derives fontFamily from the embedded font's actual PostScript
   * name when it can't map to a generic family, so a genuinely bold-named font often
   * surfaces "Bold" there. Not exhaustive (synthetic/visual bolding without a
   * bold-named font resource won't be caught), but real signal — not always false.
   */
  detectBold(fontFamily: string | undefined): boolean {
    return /bold/i.test(fontFamily ?? '');
  }

  getLuminance(r: number, g: number, b: number): number {
    const [rs, gs, bs] = [r, g, b].map(c => {
      const val = c / 255;
      return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  isLargeText(fontSize: number, isBold: boolean): boolean {
    return fontSize >= 18 || (fontSize >= 14 && isBold);
  }

  hexToRgb(hex: string): RgbColor {
    const clean = hex.replace(/^#/, '');
    return {
      r: parseInt(clean.substring(0, 2), 16),
      g: parseInt(clean.substring(2, 4), 16),
      b: parseInt(clean.substring(4, 6), 16),
    };
  }

  rgbToHex(rgb: RgbColor): string {
    const toHex = (n: number) => {
      const hex = Math.round(n).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  }
}

export const pdfContrastValidator = new PdfContrastValidator();
