/**
 * TOC Detector
 *
 * Detects pages that are Table of Contents (TOC) using heuristic scoring,
 * with a Haiku LLM fallback for ambiguous cases.
 *
 * TOC pages tagged as <Table> instead of <TOC>/<TOCI> generate hundreds of
 * false-positive table accessibility issues. This detector identifies them so
 * SmartTriageService can suppress those issues and emit a single TOC-TAGGING
 * issue per page instead.
 */

import { logger } from '../../../lib/logger';
import { claudeService } from '../../ai/claude.service';
import { PdfParseResult, PdfPage } from '../pdf-comprehensive-parser.service';
import { PDFOutlineItem } from '../pdf-parser.service';

// Heuristic thresholds
const HIGH_CONFIDENCE = 0.85;   // auto-accept as TOC
const LOW_CONFIDENCE  = 0.50;   // below this → not a TOC
// Between LOW and HIGH → ask Haiku

// Scoring weights (must sum to ≤1.0)
const W_DOT_LEADERS  = 0.35;
const W_PAGE_REFS    = 0.35;
const W_OUTLINE_MATCH = 0.20;
const W_POSITION     = 0.10;

// Regex patterns
const DOT_LEADER_RE = /[.·•]{3,}|…{2,}|\s{2,}\d+\s*$/;
const TRAILING_NUM_RE = /\s+\d{1,4}\s*$/;

export class TocDetector {
  /**
   * Returns the set of physical page numbers that are TOC pages.
   */
  async detectTocPages(parsed: PdfParseResult): Promise<Set<number>> {
    const outline = parsed.parsedPdf?.structure.outline ?? [];
    const outlineTitles = this.flattenOutlineTitles(outline);
    const firstOutlineDestination = this.firstDestination(outline);

    const tocPages = new Set<number>();

    for (const page of parsed.pages) {
      // Score every page — we can't rely on page.tables (from the structure analyzer)
      // because the table validator detects TOC-as-Table via PDF structure tags, which
      // may not be reflected in the content-based page.tables array.
      const score = this.scorePage(page, outlineTitles, firstOutlineDestination);

      if (score >= HIGH_CONFIDENCE) {
        logger.debug(`[TocDetector] Page ${page.pageNumber} → TOC (score=${score.toFixed(2)}, heuristic)`);
        tocPages.add(page.pageNumber);
      } else if (score >= LOW_CONFIDENCE) {
        const confirmed = await this.confirmWithLLM(page);
        if (confirmed) {
          logger.debug(`[TocDetector] Page ${page.pageNumber} → TOC (score=${score.toFixed(2)}, llm-confirmed)`);
          tocPages.add(page.pageNumber);
        } else {
          logger.debug(`[TocDetector] Page ${page.pageNumber} → not TOC (score=${score.toFixed(2)}, llm-rejected)`);
        }
      }
    }

    return tocPages;
  }

  private scorePage(
    page: PdfPage,
    outlineTitles: Set<string>,
    firstOutlineDest: number
  ): number {
    let score = 0;

    // Signal 1: Dot-leader patterns in page text content
    if (this.checkDotLeaders(page)) score += W_DOT_LEADERS;

    // Signal 2: Most text items end with a page number
    if (this.checkPageRefRatio(page)) score += W_PAGE_REFS;

    // Signal 3: Cell text matches PDF outline titles
    if (outlineTitles.size > 0 && this.checkOutlineMatch(page, outlineTitles)) {
      score += W_OUTLINE_MATCH;
    }

    // Signal 4: This page comes before the first chapter in the outline
    if (firstOutlineDest > 0 && page.pageNumber < firstOutlineDest) {
      score += W_POSITION;
    }

    return Math.min(1.0, score);
  }

  private checkDotLeaders(page: PdfPage): boolean {
    const textItems = page.content.map(c => c.text);
    return textItems.some(t => DOT_LEADER_RE.test(t));
  }

  private checkPageRefRatio(page: PdfPage): boolean {
    const lines = page.content.map(c => c.text.trim()).filter(t => t.length > 0);
    if (lines.length === 0) return false;
    const withTrailingNum = lines.filter(t => TRAILING_NUM_RE.test(t));
    return withTrailingNum.length / lines.length > 0.5;
  }

  private checkOutlineMatch(page: PdfPage, outlineTitles: Set<string>): boolean {
    const pageTexts = page.content.map(c => c.text.toLowerCase().trim());
    let matches = 0;
    for (const title of outlineTitles) {
      if (pageTexts.some(t => t.includes(title) || title.includes(t.substring(0, 20)))) {
        matches++;
      }
    }
    return matches / Math.max(1, outlineTitles.size) > 0.3;
  }

  private async confirmWithLLM(page: PdfPage): Promise<boolean> {
    try {
      const text = page.content
        .map(c => c.text)
        .join(' ')
        .substring(0, 800)
        .trim();

      if (!text) return false;

      const result = await claudeService.generateJSON<{
        isToc: boolean;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      }>(
        `Classify this PDF page content. Is it a Table of Contents — a list of chapter or section titles paired with page numbers?

Content: "${text}"

Respond with JSON only: { "isToc": true|false, "confidence": "HIGH"|"MEDIUM"|"LOW" }`,
        { model: 'haiku', maxTokens: 64, temperature: 0 }
      );

      return result.isToc === true && result.confidence !== 'LOW';
    } catch (err) {
      logger.warn(`[TocDetector] LLM fallback failed for page ${page.pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private flattenOutlineTitles(outline: PDFOutlineItem[]): Set<string> {
    const titles = new Set<string>();
    const walk = (items: PDFOutlineItem[]) => {
      for (const item of items) {
        if (item.title) titles.add(item.title.toLowerCase().trim());
        if (item.children) walk(item.children);
      }
    };
    walk(outline);
    return titles;
  }

  private firstDestination(outline: PDFOutlineItem[]): number {
    for (const item of outline) {
      if (item.destination !== undefined && item.destination > 0) return item.destination;
    }
    return 0;
  }
}

export const tocDetector = new TocDetector();
