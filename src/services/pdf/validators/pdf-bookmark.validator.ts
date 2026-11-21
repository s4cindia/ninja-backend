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

// Matches generic/auto-generated bookmark titles. The "p(age)?" branch is
// confirmed real via Karsaklian_189165_9781606497623.pdf's actual bookmarks
// (67 of them, every single one literally "Section — p.25", "Section — p.26",
// etc.) -- InDesign's own fallback when it can't resolve real heading text
// for a bookmark. The original [\s\d.:-]* branch alone doesn't match these
// (the literal "p" isn't in that character class), a real false negative
// this exact document slipped through.
//
// The dash is a real U+2014 EM DASH, not a hyphen -- confirmed byte-for-byte
// via this codebase's own pdf-lib decode on a fresh live run (2026-11-13).
// An earlier version of this regex (and its own tests) assumed the plain-
// ASCII-looking "Section p.25" from eyeballing the rendered PDF, which
// silently swallows the em dash -- that version matched ZERO of the 42 real
// titles, so BOOKMARK-GENERIC-TEXT never fired and regenerateGenericBookmarkTitles
// (which shares this exact regex) never got a chance to run on this document,
// even after the fix that introduced the "p(age)?" branch had shipped and
// deployed. The dash class below covers hyphen and the common Unicode dash
// variants (en dash, em dash, figure dash, horizontal bar) and is optional/
// repeatable so "Section p.25", "Section-p.25", and "Section — p.25" all match.
// Exported so pdf-structure-writer.service.ts's regenerateGenericBookmarkTitles
// can detect the SAME "this title is a placeholder" condition this validator
// flags, rather than risking drift between two independently-maintained copies.
export const GENERIC_TITLE_RE =
  /^(section|chapter|untitled|bookmark|\d+)((?:\s|[‐-―])*p(?:age)?\.?\s*\d+(-\d+)?|[\s\d.:‐-―-]*)$/i;

// Minimum pages before bookmark checks apply
const MIN_PAGES_FOR_BOOKMARKS = 10;
// Minimum pages before coverage check applies
const MIN_PAGES_FOR_COVERAGE = 20;
// One bookmark per this many pages is the minimum recommended ratio
const PAGES_PER_BOOKMARK = 15;
// A document's bookmark outline starting beyond this page leaves a real,
// navigable gap at the front of the document -- confirmed real via
// Karsaklian_189165_9781606497623_R4_1.pdf: 67 real, correctly-nested,
// correctly-titled bookmarks (generateBookmarksFromHeadings + its own title
// regeneration both working as intended), but the FIRST one targets page 25
// -- pages 1-24 (title page, copyright, dedication, table of contents; all
// present in the struct tree, just under publisher-specific InDesign style
// names like COPF/TPAU/DEF/CFM that don't resolve to a literal H1-H9 role)
// have zero bookmark coverage, and nothing in this validator caught it:
// BOOKMARK-INSUFFICIENT only looks at total bookmark COUNT vs. page count,
// and 67 bookmarks is plenty for a ~190-page book -- it is silent about
// WHERE those bookmarks are concentrated. Deliberately detect-only, not an
// auto-fix: which custom role names represent "Title Page" vs. "Copyright"
// vs. "Dedication" is publisher-specific and not safe to guess (same
// "decline rather than guess" convention as cross-reference-link resolution
// and the heading-style-mismatch classifier elsewhere in this codebase).
const MAX_PAGES_BEFORE_FIRST_BOOKMARK = 10;

class PdfBookmarkValidator {
  name = 'PdfBookmarkValidator';
  private issueCounter = 0;

  // No boundingBox by design: bookmark issues are non-spatial. They derive from
  // the document outline (PDFOutlineItem = title + destination page + children),
  // which points to a page but has no on-page rectangle to highlight.

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
        // Whole-document issue, anchored to page 1 -- same convention
        // pdf-structure.validator.ts's own document-level issues (missing
        // title/language, multiple H1s) already use. Without a pageNumber,
        // BaseAuditService.calculateAffectedPageRatio's "no page data for
        // this severity bucket" fallback treats it as affecting 100% of
        // pages -- correct for a genuinely whole-document concern like a
        // missing title, but this issue's own severity bucket can end up
        // holding ONLY this one issue once others in it are fixed (real
        // Math_Weir_PDF.pdf incident: fixing HEADING-MULTIPLE-H1 left this
        // as the sole 'moderate' issue, and the fallback alone swung the
        // score 91 -> 53 despite the document becoming MORE accessible).
        pageNumber: 1,
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
        // Same whole-document anchoring as BOOKMARK-MISSING above -- see its comment.
        pageNumber: 1,
      });
    }

    // BOOKMARK-MISSING-FRONT-MATTER: the outline exists and may well have
    // plenty of bookmarks overall, but none of them cover the start of the
    // document -- see MAX_PAGES_BEFORE_FIRST_BOOKMARK's own comment.
    const firstBookmarkedPage = this.earliestDestination(outline);
    if (firstBookmarkedPage !== null && firstBookmarkedPage > MAX_PAGES_BEFORE_FIRST_BOOKMARK + 1) {
      const uncoveredPages = firstBookmarkedPage - 1;
      issues.push({
        id: `bookmark-${++this.issueCounter}`,
        source: 'bookmark-validator',
        severity: 'moderate',
        code: 'BOOKMARK-MISSING-FRONT-MATTER',
        message: `Bookmark outline begins on page ${firstBookmarkedPage}, leaving the first ${uncoveredPages} page(s) without any bookmark coverage`,
        wcagCriteria: ['2.4.5'],
        location: 'Document',
        category: 'bookmarks',
        suggestion:
          'Add bookmark entries for the uncovered front matter (e.g., Title Page, Copyright, Dedication, Table of Contents) ' +
          'so the full document, not just the body chapters, is reachable from the bookmarks panel.',
        context: `First bookmarked page: ${firstBookmarkedPage}, Pages without coverage: 1-${uncoveredPages}`,
        // Same whole-document anchoring as BOOKMARK-MISSING/BOOKMARK-INSUFFICIENT above.
        pageNumber: 1,
      });
      logger.info(`[PdfBookmarkValidator] Found BOOKMARK-MISSING-FRONT-MATTER (first bookmark on page ${firstBookmarkedPage})`);
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

  /** Earliest page any bookmark in the tree targets, or null if none has a
   *  resolvable page destination. Walks the whole tree rather than trusting
   *  the first top-level entry alone -- generateBookmarksFromHeadings always
   *  emits headings in document order so its own trees are already sorted,
   *  but a source PDF's pre-existing outline (never rebuilt by that method,
   *  only title-regenerated -- see regenerateGenericBookmarkTitles' own doc
   *  comment) carries no such guarantee. */
  private earliestDestination(items: PDFOutlineItem[]): number | null {
    let earliest: number | null = null;
    for (const item of items) {
      if (item.destination !== undefined && (earliest === null || item.destination < earliest)) {
        earliest = item.destination;
      }
      if (item.children?.length) {
        const childEarliest = this.earliestDestination(item.children);
        if (childEarliest !== null && (earliest === null || childEarliest < earliest)) {
          earliest = childEarliest;
        }
      }
    }
    return earliest;
  }
}

export const pdfBookmarkValidator = new PdfBookmarkValidator();
