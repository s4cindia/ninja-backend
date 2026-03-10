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

/**
 * RGB color representation
 */
interface RgbColor {
  r: number;
  g: number;
  b: number;
}


// Render scale — 1.5x gives good resolution without excessive memory
const RENDER_SCALE = 1.5;
// Max pages to contrast-check per document (comprehensive scan only)
const MAX_PAGES_CONTRAST = 50;
// Max issues emitted per page (spatial deduplication also applied)
const MAX_ISSUES_PER_PAGE = 20;
// Spatial grid cell size in canvas pixels (avoid duplicate issues for nearby text)
const GRID_CELL_PX = 80;

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

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    if (!parsed.parsedPdf) {
      logger.info('[PdfContrastValidator] No parsedPdf — skipping contrast check');
      return [];
    }

    logger.info('[PdfContrastValidator] Starting contrast validation...');
    this.issueCounter = 0;

    const issues: AuditIssue[] = [];
    const pages = parsed.pages.slice(0, MAX_PAGES_CONTRAST);

    if (parsed.pages.length > MAX_PAGES_CONTRAST) {
      logger.warn(`[PdfContrastValidator] Large document — checking first ${MAX_PAGES_CONTRAST} of ${parsed.pages.length} pages`);
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
    const [va, vb, vc, vd, ve, vf] = viewport.transform;

    const issues: AuditIssue[] = [];
    const usedCells = new Set<string>();

    for (const rawItem of textContent.items) {
      if (issues.length >= MAX_ISSUES_PER_PAGE) break;

      // TextItem (not TextMarkedContent which has no str field)
      if (!('str' in rawItem)) continue;
      const item = rawItem as { str: string; transform: number[]; width?: number; height?: number };

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

      // Background: average of a 5px strip just above the text bbox
      const bgColor = this.sampleAverage(data, canvasX, top - 5, itemW, 5, cw, ch);
      if (!bgColor) continue;

      // Text color: darkest 30th-percentile pixels within the text bbox
      const textColor = this.sampleDark(data, canvasX, top, itemW, itemH, cw, ch);
      if (!textColor) continue;

      const isBold = str === str.toUpperCase() && str.length < 5
        ? false
        : false; // font-name bold detection not available from text content
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
        });
      }
    }

    return issues;
  }

  // ─── Pixel sampling helpers ────────────────────────────────────────────────

  private sampleAverage(
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

  /** Returns the average color of the darkest 30% of pixels (estimates text color). */
  private sampleDark(
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
    const take = Math.max(1, Math.floor(pixels.length * 0.3));
    const subset = pixels.slice(0, take);
    return {
      r: subset.reduce((s, v) => s + v.r, 0) / take,
      g: subset.reduce((s, v) => s + v.g, 0) / take,
      b: subset.reduce((s, v) => s + v.b, 0) / take,
    };
  }

  // ─── Public helpers (used by tests and AI analysis) ───────────────────────

  calculateContrastRatio(color1: RgbColor, color2: RgbColor): number {
    const l1 = this.getLuminance(color1.r, color1.g, color1.b);
    const l2 = this.getLuminance(color2.r, color2.g, color2.b);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
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
