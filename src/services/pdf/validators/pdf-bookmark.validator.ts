/**
 * PDF Bookmark Validator
 *
 * Validates that PDF documents have adequate bookmark coverage and
 * that bookmark titles are descriptive rather than generic.
 *
 * WCAG 2.4.5 (Multiple Ways) - Level AA
 * PDF/UA: Bookmarks required for documents longer than a single page
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';
import { PDFOutlineItem } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

// Matches generic/auto-generated bookmark titles
const GENERIC_TITLE_RE = /^(section|chapter|untitled|bookmark|\d+)([\s\d.:-]*)$/i;

// Minimum pages before bookmark checks apply
const MIN_PAGES_FOR_BOOKMARKS = 10;
// Minimum pages before coverage check applies
const MIN_PAGES_FOR_COVERAGE = 20;
// One bookmark per this many pages is the minimum recommended ratio
const PAGES_PER_BOOKMARK = 15;

class PdfBookmarkValidator {
  name = 'PdfBookmarkValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfBookmarkValidator] Starting bookmark validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    const pageCount = parsed.metadata.pageCount;

    // Short documents don't require bookmarks
    if (pageCount <= MIN_PAGES_FOR_BOOKMARKS) {
      logger.info(`[PdfBookmarkValidator] Skipping — document has only ${pageCount} pages`);
      return [];
    }

    const outline: PDFOutlineItem[] = parsed.parsedPdf?.structure.outline ?? [];

    // BOOKMARK-MISSING: no bookmarks at all
    if (outline.length === 0) {
      issues.push({
        id: `bookmark-${++this.issueCounter}`,
        source: 'bookmark-validator',
        severity: 'moderate',
        code: 'BOOKMARK-MISSING',
        message: `Document has no bookmarks (${pageCount} pages)`,
        wcagCriteria: ['2.4.5'],
        location: 'Document',
        category: 'bookmarks',
        suggestion:
          'Add bookmarks for all major sections. In Microsoft Word, export with "Create bookmarks using Headings" enabled. ' +
          'In InDesign, enable "Create PDF Bookmarks" in export settings with paragraph styles mapped to bookmark levels.',
        context: `Pages: ${pageCount}, Bookmarks: 0`,
      });
      logger.info('[PdfBookmarkValidator] Found BOOKMARK-MISSING');
      return issues;
    }

    // BOOKMARK-INSUFFICIENT: too few bookmarks for document length
    const totalBookmarks = this.countBookmarks(outline);
    if (pageCount > MIN_PAGES_FOR_COVERAGE && totalBookmarks < Math.ceil(pageCount / PAGES_PER_BOOKMARK)) {
      issues.push({
        id: `bookmark-${++this.issueCounter}`,
        source: 'bookmark-validator',
        severity: 'minor',
        code: 'BOOKMARK-INSUFFICIENT',
        message: `Document has ${totalBookmarks} bookmark(s) for ${pageCount} pages (recommended: ≥${Math.ceil(pageCount / PAGES_PER_BOOKMARK)})`,
        wcagCriteria: ['2.4.5'],
        location: 'Document',
        category: 'bookmarks',
        suggestion:
          'Add bookmarks to cover all major sections and subsections so users can navigate to any part of the document.',
        context: `Pages: ${pageCount}, Bookmarks: ${totalBookmarks}`,
      });
    }

    // BOOKMARK-GENERIC-TEXT: walk outline and flag generic titles
    this.walkOutline(outline, issues);

    logger.info(`[PdfBookmarkValidator] Found ${issues.length} bookmark issue(s)`);
    return issues;
  }

  private walkOutline(items: PDFOutlineItem[], issues: AuditIssue[]): void {
    for (const item of items) {
      const title = (item.title ?? '').trim();

      if (!title || GENERIC_TITLE_RE.test(title)) {
        issues.push({
          id: `bookmark-${++this.issueCounter}`,
          source: 'bookmark-validator',
          severity: 'minor',
          code: 'BOOKMARK-GENERIC-TEXT',
          message: `Bookmark has a generic or empty title: "${title || '(empty)'}"`,
          wcagCriteria: ['2.4.4'],
          location: item.destination !== undefined ? `Page ${item.destination}` : 'Document',
          category: 'bookmarks',
          suggestion:
            'Replace the generic bookmark title with a descriptive name that reflects the section content ' +
            '(e.g., "Chapter 3: Financial Risk Assessment" instead of "Section 3").',
          context: `Bookmark title: "${title || '(empty)'}"`,
          pageNumber: item.destination,
        });
      }

      if (item.children?.length) {
        this.walkOutline(item.children, issues);
      }
    }
  }

  private countBookmarks(items: PDFOutlineItem[]): number {
    return items.reduce((count, item) => {
      const childCount = item.children ? this.countBookmarks(item.children) : 0;
      return count + 1 + childCount;
    }, 0);
  }
}

export const pdfBookmarkValidator = new PdfBookmarkValidator();
