/**
 * PDF Link Completeness Validator
 *
 * Detects URL-shaped PLAIN TEXT with no underlying Link annotation at all --
 * distinct from PdfLinkValidator, which only judges the TEXT QUALITY of
 * links that already exist. A tagged PDF can be internally consistent
 * (every EXISTING Link annotation correctly wrapped in a Link structure
 * element) while still containing citation/reference URLs that were never
 * made into real hyperlinks in the first place -- invisible to
 * PdfLinkValidator (which only iterates parsed.pages[].links, i.e. existing
 * annotations) and to the rest of this codebase, since nothing else scans
 * prose TEXT CONTENT for URL patterns.
 *
 * Real incident: Curiel_187961_CSHP.pdf has ZERO annotations of any kind
 * anywhere in the document (confirmed via direct pikepdf inspection --
 * page.get('/Annots') is empty on every page) despite ~200 reference-list
 * citation URLs rendered as plain, unstyled prose text (near-black,
 * non-underlined, same italic body style as the rest of each citation) --
 * PAC's "Link in text does not have a 'Link' element" / "Completeness of
 * 'Link' elements" finding. Matterhorn checkpoint 28-011 ("A link
 * annotation is not nested within a Link tag") requires a real annotation
 * to nest in the first place; the matching fixer (a separate, later piece)
 * creates both the annotation and its structure element together.
 *
 * WCAG has no single criterion purpose-built for "this text should be a
 * real hyperlink" -- mapped to 1.3.1/4.1.2 (Name/Role/Value), the same
 * mapping pdf-audit.service.ts's generateMatterhornResults uses for
 * checkpoint 01 (untagged content): assistive tech can't recognize
 * something as an interactive control it isn't structurally tagged as.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfLink } from '../pdf-comprehensive-parser.service';
import { logger } from '../../../lib/logger';

// Matches a URL starting at a word boundary. Excludes whitespace and common
// closing/quoting characters that are essentially never part of the URL
// itself (the ")" closing "(see https://example.com)", a wrapping quote,
// etc.) -- trailing sentence punctuation ("." ending a sentence) is
// stripped separately below since it's syntactically valid in a URL path
// and can't be excluded from the character class itself.
// Global flag required for matchAll -- a single text item can legitimately
// contain more than one URL (CodeRabbit finding on PR #637).
const URL_IN_TEXT_GLOBAL_RE = /\b(?:https?:\/\/|www\.)[^\s)\]}>"']+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:]+$/;

// Floor beneath which a match is almost certainly a stray fragment (e.g. a
// lone "www." with nothing meaningful after it), not a real citation URL
// worth flagging.
const MIN_LINK_TEXT_LENGTH = 10;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UrlSpan {
  url: string;
  box: Box;
}

class PdfLinkCompletenessValidator {
  name = 'PdfLinkCompletenessValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfLinkCompletenessValidator] Starting link completeness validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];
    const pdfjsDoc = parsed.parsedPdf?.pdfjsDoc;
    if (!pdfjsDoc) {
      logger.warn('[PdfLinkCompletenessValidator] No pdfjsDoc available -- skipping');
      return issues;
    }

    for (const page of parsed.pages) {
      try {
        const spans = await this.findMissingLinkSpans(pdfjsDoc, page.pageNumber, page.links);
        for (const span of spans) {
          issues.push(this.createIssue(page.pageNumber, span, page.width, page.height));
        }
      } catch (error) {
        logger.warn(
          `[PdfLinkCompletenessValidator] Failed on page ${page.pageNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    logger.info(`[PdfLinkCompletenessValidator] Found ${issues.length} missing-link issue(s)`);
    return issues;
  }

  private async findMissingLinkSpans(
    pdfjsDoc: pdfjsLib.PDFDocumentProxy,
    pageNumber: number,
    existingLinks: PdfLink[]
  ): Promise<UrlSpan[]> {
    const page = await pdfjsDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Array<{ str: string; transform: number[]; width?: number }> = [];
    for (const rawItem of content.items) {
      if (!('str' in rawItem)) continue;
      items.push(rawItem as { str: string; transform: number[]; width?: number });
    }

    // Deliberately does NOT attempt to join a URL that wraps across physical
    // lines back into one span. Tried first, then abandoned as unsafe: in a
    // hanging-indent bibliography (this validator's real target case), a
    // genuine line-wrap continuation and the START OF THE NEXT, UNRELATED
    // CITATION are geometrically indistinguishable -- both are a new line
    // starting at the same left margin. Confirmed live on
    // Curiel_187961_CSHP.pdf: a geometry-based join produced garbage like
    // "https://doi.org/10.1093/bjsw/bcad186Canadian" (silently concatenating
    // one citation's URL with the NEXT citation's author name) and
    // "...Standards-for-Practice...v2-7.pdfBaker" -- actively wrong, not
    // merely an undercount, and dangerous if a later fixer used it to build
    // a real hyperlink pointing at a URL that was never actually printed
    // anywhere. Reporting a wrapped URL's own line-fragment as-is (an
    // accurate, if incomplete, quote of what's actually rendered) is the
    // safe direction to be wrong in; a false merge is not. See this
    // project's own recurring "bail rather than guess" convention
    // (contrast-content-stream.ts, findPrecedingColor, etc.) for the same
    // reasoning applied elsewhere in this codebase.
    const spans: UrlSpan[] = [];
    for (const item of items) {
      // matchAll (not a single exec) -- CodeRabbit finding on PR #637,
      // confirmed real: a single item can legitimately contain more than
      // one URL (e.g. "See https://a.com or https://b.com"); exec() alone
      // silently dropped every match after the first.
      for (const match of item.str.matchAll(URL_IN_TEXT_GLOBAL_RE)) {
        const url = match[0].replace(TRAILING_PUNCTUATION_RE, '');
        if (url.length < MIN_LINK_TEXT_LENGTH) continue;
        // Requires a domain-name dot somewhere after the scheme/www prefix --
        // filters obviously-incomplete fragments (e.g. a bare "https://www"
        // or "https://cyccb" cut off mid-domain by an unrelated line/kerning
        // split) that aren't a usable link target as printed.
        if (!/[a-z0-9-]\.[a-z]{2,}/i.test(url)) continue;
        const box = this.itemBox(item, viewport);
        if (this.hasNearbyLinkAnnotation(box, existingLinks)) continue;
        spans.push({ url, box });
      }
    }

    return spans;
  }

  /** Unscaled PDF-point box, top-left origin (y grows downward) -- matches
   *  AuditIssue.boundingBox's documented convention and the same convention
   *  structure-analyzer.service.ts's own analyzeLinks uses for
   *  PdfLink.position (viewport.height - rect[3], the TOP edge, not the
   *  bottom). CodeRabbit finding on PR #637, confirmed real: transform[5] is
   *  the glyph's BASELINE, which sits near the BOTTOM of a normal line of
   *  text (most of a glyph's ink is ABOVE its baseline, extending up by the
   *  font's ascent). The first version returned a box with its top AT the
   *  baseline extending fontSize further DOWN -- mostly covering the blank
   *  space under the line, not the text itself, both for the reported
   *  boundingBox and for hasNearbyLinkAnnotation's overlap check against
   *  PdfLink.position (which already used the correct top-edge convention,
   *  so the two would have silently failed to line up). Subtracting fontSize
   *  moves the box's top to approximately the ascent line instead. */
  private itemBox(item: { transform: number[]; width?: number }, viewport: pdfjsLib.PageViewport): Box {
    const fontSize = Math.abs(item.transform[0]) || 12;
    const baselineY = viewport.height - item.transform[5];
    return {
      x: item.transform[4],
      y: baselineY - fontSize,
      width: item.width ?? 40,
      height: fontSize,
    };
  }

  /** True when a REAL Link annotation already sits at/near this span --
   *  this document already has a functional link here, nothing to fix. */
  private hasNearbyLinkAnnotation(box: Box, existingLinks: PdfLink[]): boolean {
    return existingLinks.some(link => {
      const xOverlap =
        Math.min(box.x + box.width, link.position.x + link.position.width) - Math.max(box.x, link.position.x);
      const yOverlap =
        Math.min(box.y + box.height, link.position.y + link.position.height) - Math.max(box.y, link.position.y);
      return xOverlap > 0 && yOverlap > 0;
    });
  }

  private createIssue(pageNumber: number, span: UrlSpan, pageWidth: number, pageHeight: number): AuditIssue {
    return {
      id: `link-completeness-${++this.issueCounter}`,
      source: 'link-completeness-validator',
      severity: 'serious',
      code: 'LINK-MISSING-ANNOTATION',
      message: `Text reads as a hyperlink ("${span.url.substring(0, 80)}") but has no underlying Link annotation`,
      wcagCriteria: ['1.3.1', '4.1.2'],
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
      location: `Page ${pageNumber} at (${Math.round(span.box.x)}, ${Math.round(span.box.y)})`,
      category: 'links',
      suggestion:
        'Convert this text into a real hyperlink: add a Link annotation with a URI action pointing to the address, and wrap it in a matching Link structure element.',
      context: `URL-shaped text: "${span.url.substring(0, 120)}"`,
      pageNumber,
      boundingBox: {
        x: span.box.x,
        y: span.box.y,
        width: span.box.width,
        height: span.box.height,
        pageWidth,
        pageHeight,
      },
    };
  }
}

export const pdfLinkCompletenessValidator = new PdfLinkCompletenessValidator();
