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
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
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

// Prose-style internal cross-references -- "see Chapter 3", "see p. 45",
// "see Fig. 2" -- confirmed real via a live S4 Carlisle manual QC report
// ("Cross-reference links not retained") plus direct inspection of the
// exact file they reviewed: it has zero named destinations anywhere
// (/Names/Dests entirely absent), so this class of reference was never a
// real link even before this platform touched the document. Deliberately
// requires a specific numbered target (Chapter/Section/Figure/Table/page
// + a number) -- an unqualified "see above"/"see below" has no specific
// destination to link to, and guessing one would be worse than not
// flagging it at all (same "bail rather than guess" convention as
// URL_IN_TEXT_GLOBAL_RE's own deliberate non-handling of line-wrapped
// URLs, above). This validator only DETECTS and captures keyword+number
// (crossReferenceData, below) -- resolving WHICH chapter/page this means,
// and deciding whether that resolution is unambiguous enough to trust, is
// ai-analysis.service.ts's dispatch gate / pdf-structure-writer.service
// .ts's fixCrossReferenceLink's job, not this validator's. "figure"/"fig"/
// "table" keywords are captured the same way but have no resolution path
// wired up yet (matching "Figure 2" to a specific numbered Figure struct
// element wasn't investigated) -- they stay manual-review-only today.
const CROSS_REFERENCE_RE = /\bsee\s+(chapter|section|figure|fig|table|page|pg|p)\.?\s+(\d+(?:\.\d+)*)\b/gi;

// In-text citations -- "(Author, Year)", "(Author and Author2, Year)",
// "(Author Year)" (no comma), optionally with a disambiguating suffix
// letter ("2025b") and/or a trailing page locator ("(Kotler 1999, 13)") --
// confirmed real via direct inspection of
// Karsaklian_189165_9781606497623.pdf's own body text: 20 real, single-
// text-item citations found across pages 46-149, EVERY one matching
// EXACTLY ONE entry in this document's own reference list (pages 181-184,
// each a raw /REF-tagged struct element -- see pdf-structure-writer.
// service.ts's resolveCitationDestination for the matching logic this
// feeds). Deliberately requires the match to end exactly at the closing
// paren (CROSS_REFERENCE_RE's own sibling convention) so a compound,
// multi-citation parenthetical ("(Smith 2020; Jones 2021)", not seen in
// this document but a real APA/Chicago shape elsewhere) is correctly left
// unmatched rather than silently grabbing only its first half.
const CITATION_RE = /\(([A-Z][A-Za-zÀ-ÿ'-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-zÀ-ÿ'-]+)?),?\s+(\d{4})([a-z]?)(?:,\s*(?:pp?\.?\s*)?\d+(?:[-–]\d+)?)?\)/g;

// Raw InDesign-exported custom tags this platform already knows (via
// pdf-rolemap-integrity.validator.ts's own classifyDegenerateRoleMapEntry /
// INDEX_PATTERN) mean "index entry" regardless of what /RoleMap currently
// resolves them to -- same real document shape pdf-structure-writer.
// service.ts's fixIndexStructure already builds real /Index/L/LI/LBody
// structure around (ROLEMAP-INDEX-FLATTENED). This validator's own concern
// is a DIFFERENT, additional defect that survives even after that fix: the
// page-number references an index entry's own text carries (e.g.
// "Advertising, 1, 2, 5, ...") are never real Link annotations pointing at
// those pages, on either side of that structural fix.
const INDEX_RAW_TAGS = new Set(['IDX1', 'IDX1F', 'IDX2', 'IDX3']);

// A trailing (or whole-line) comma-separated list of page numbers/ranges --
// the shape every real index entry's own page-reference tail takes on
// Karsaklian_189165_9781606497623.pdf (e.g. "Advertising, 1, 2, 5, 9, 11,
// 15, 19, 32," wrapping onto a continuation line "41, 64, 90, 111", or a
// single-number tail like "strategy, 56"). Deliberately loose (this feeds
// ONE aggregated, detect-only issue -- see INDEX-ENTRY-MISSING-PAGE-LINK's
// own doc comment below for why no per-number auto-fix is attempted), not
// a precise per-number locator.
const INDEX_PAGEREF_TAIL_RE = /(?:,\s*\d{1,4}(?:[-–]\d{1,4})?)+,?\s*$|^\s*\d{1,4}(?:[-–]\d{1,4})?(?:\s*,\s*\d{1,4}(?:[-–]\d{1,4})?)*\s*,?\s*$/;

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

interface CrossRefSpan {
  text: string;
  keyword: string;
  number: string;
  box: Box;
}

interface CitationSpan {
  text: string;
  authorText: string;
  year: string;
  box: Box;
}

interface IndexPageRefExample {
  page: number;
  text: string;
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

    // Document-wide pre-scan, gating the per-page index-pagerefs check
    // below to only the pages that genuinely carry raw IDX1(F)/IDX2/IDX3
    // content -- see findIndexPageNumbers' own doc comment for why this
    // structural gate matters (a bare per-page numeric-list regex, with no
    // such gate, would false-positive on any other comma-separated number
    // list anywhere in a 190-page document).
    const indexPageNumbers = parsed.parsedPdf?.pdfLibDoc
      ? this.findIndexPageNumbers(parsed.parsedPdf.pdfLibDoc)
      : new Set<number>();
    let indexEntriesWithPageRefs = 0;
    const indexExamples: IndexPageRefExample[] = [];

    for (const page of parsed.pages) {
      try {
        const { items, viewport } = await this.getTextItems(pdfjsDoc, page.pageNumber);

        const urlSpans = this.findMissingLinkSpans(items, viewport, page.links);
        for (const span of urlSpans) {
          issues.push(this.createIssue(page.pageNumber, span, page.width, page.height));
        }

        const crossRefSpans = this.findMissingCrossReferenceSpans(items, viewport, page.links);
        for (const span of crossRefSpans) {
          issues.push(this.createCrossReferenceIssue(page.pageNumber, span, page.width, page.height));
        }

        const citationSpans = this.findMissingCitationSpans(items, viewport, page.links);
        for (const span of citationSpans) {
          issues.push(this.createCitationIssue(page.pageNumber, span, page.width, page.height));
        }

        if (indexPageNumbers.has(page.pageNumber)) {
          const found = this.findIndexPageRefLines(items, viewport, page.links);
          indexEntriesWithPageRefs += found.length;
          for (const text of found) {
            if (indexExamples.length < 5) indexExamples.push({ page: page.pageNumber, text });
          }
        }
      } catch (error) {
        logger.warn(
          `[PdfLinkCompletenessValidator] Failed on page ${page.pageNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (indexEntriesWithPageRefs > 0) {
      issues.push(this.createIndexPageRefIssue(indexEntriesWithPageRefs, indexPageNumbers.size, indexExamples));
    }

    logger.info(`[PdfLinkCompletenessValidator] Found ${issues.length} missing-link issue(s)`);
    return issues;
  }

  private async getTextItems(
    pdfjsDoc: pdfjsLib.PDFDocumentProxy,
    pageNumber: number
  ): Promise<{ items: Array<{ str: string; transform: number[]; width?: number }>; viewport: pdfjsLib.PageViewport }> {
    const page = await pdfjsDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Array<{ str: string; transform: number[]; width?: number }> = [];
    for (const rawItem of content.items) {
      if (!('str' in rawItem)) continue;
      items.push(rawItem as { str: string; transform: number[]; width?: number });
    }
    return { items, viewport };
  }

  private findMissingLinkSpans(
    items: Array<{ str: string; transform: number[]; width?: number }>,
    viewport: pdfjsLib.PageViewport,
    existingLinks: PdfLink[]
  ): UrlSpan[] {
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

  /** Same per-item scanning shape as findMissingLinkSpans, but for prose
   *  cross-references rather than URLs -- see CROSS_REFERENCE_RE's own doc
   *  comment for why this is detect-only and requires a specific numbered
   *  target. */
  private findMissingCrossReferenceSpans(
    items: Array<{ str: string; transform: number[]; width?: number }>,
    viewport: pdfjsLib.PageViewport,
    existingLinks: PdfLink[]
  ): CrossRefSpan[] {
    const spans: CrossRefSpan[] = [];
    for (const item of items) {
      for (const match of item.str.matchAll(CROSS_REFERENCE_RE)) {
        const text = match[0];
        const keyword = match[1].toLowerCase();
        const number = match[2];
        const box = this.itemBox(item, viewport);
        if (this.hasNearbyLinkAnnotation(box, existingLinks)) continue;
        spans.push({ text, keyword, number, box });
      }
    }
    return spans;
  }

  /** Same per-item scanning shape as findMissingLinkSpans/
   *  findMissingCrossReferenceSpans, but for in-text citations -- see
   *  CITATION_RE's own doc comment for the real document evidence behind
   *  this. */
  private findMissingCitationSpans(
    items: Array<{ str: string; transform: number[]; width?: number }>,
    viewport: pdfjsLib.PageViewport,
    existingLinks: PdfLink[]
  ): CitationSpan[] {
    const spans: CitationSpan[] = [];
    for (const item of items) {
      for (const match of item.str.matchAll(CITATION_RE)) {
        const text = match[0];
        const authorText = match[1];
        const year = match[2] + (match[3] ?? '');
        const box = this.itemBox(item, viewport);
        if (this.hasNearbyLinkAnnotation(box, existingLinks)) continue;
        spans.push({ text, authorText, year, box });
      }
    }
    return spans;
  }

  /**
   * Document-wide struct-tree pre-scan: every PDF page a raw /IDX1, /IDX1F,
   * /IDX2, or /IDX3-tagged element's own /Pg resolves to -- see
   * INDEX_RAW_TAGS' own doc comment for why raw tags (not the /RoleMap-
   * resolved generic /P) are the right thing to match on. Read-only, and
   * deliberately tolerant of a malformed/cyclic tree (depth-capped, same
   * convention as pdf-rolemap-integrity.validator.ts's own countTagUsage)
   * since this only gates WHICH pages the per-page numeric-list scan below
   * runs on -- a missed page just means fewer examples found, never a
   * crash or a wrong fix (this whole feature is detect-only).
   */
  private findIndexPageNumbers(doc: PDFDocument): Set<number> {
    const pages = new Set<number>();
    const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
    if (!(structRoot instanceof PDFDict)) return pages;

    const pageIndexByRefNumber = new Map<number, number>();
    doc.getPages().forEach((p, idx) => pageIndexByRefNumber.set(p.ref.objectNumber, idx + 1));

    const visited = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 200) return;
      if (node instanceof PDFRef) {
        const key = node.toString();
        if (visited.has(key)) return;
        visited.add(key);
        walk(doc.context.lookup(node), depth + 1);
        return;
      }
      if (node instanceof PDFArray) {
        for (let i = 0; i < node.size(); i++) walk(node.get(i), depth + 1);
        return;
      }
      if (node instanceof PDFDict) {
        const sRaw = node.get(PDFName.of('S'));
        const rawTag = sRaw?.toString().replace(/^\//, '');
        if (rawTag && INDEX_RAW_TAGS.has(rawTag)) {
          const pgRaw = node.get(PDFName.of('Pg'));
          if (pgRaw instanceof PDFRef) {
            const pageNumber = pageIndexByRefNumber.get(pgRaw.objectNumber);
            if (pageNumber !== undefined) pages.add(pageNumber);
          }
        }
        const kids = node.get(PDFName.of('K'));
        if (kids) walk(kids, depth + 1);
      }
    };
    walk(structRoot, 0);
    return pages;
  }

  /**
   * Per-item scan (same granularity as the other three checks above),
   * restricted by the caller to pages findIndexPageNumbers already
   * confirmed carry real index content -- returns the raw matching line
   * texts (for the aggregated issue's own examples), not individual
   * AuditIssues. See INDEX_PAGEREF_TAIL_RE's own doc comment for why this
   * stays a loose, document-wide COUNT rather than a per-number locator:
   * unlike LINK-MISSING-ANNOTATION/CROSS-REFERENCE-MISSING-LINK/CITATION-
   * MISSING-LINK above, a short bare page number (e.g. "41") is routinely
   * NOT a safe, unique substring to locate in the page's own content
   * stream -- confirmed real on this exact document: "41" appears TWICE on
   * PDF page 187 alone (once in "Advertising"'s own continuation line,
   * once in "agencies, 34, 41"), so a naive buildLinkAnnotationFix-style
   * indexOf search would, by construction, always resolve to the FIRST
   * occurrence -- silently linking the wrong entry's page reference for
   * every subsequent collision. No auto-fix is attempted for this code.
   */
  private findIndexPageRefLines(
    items: Array<{ str: string; transform: number[]; width?: number }>,
    viewport: pdfjsLib.PageViewport,
    existingLinks: PdfLink[]
  ): string[] {
    const found: string[] = [];
    for (const item of items) {
      const trimmed = item.str.trim();
      if (!trimmed || !INDEX_PAGEREF_TAIL_RE.test(item.str)) continue;
      if (!/\d/.test(trimmed)) continue;
      // Reuses the SAME itemBox/hasNearbyLinkAnnotation convention as
      // every other check above (viewport-relative, top-left-origin box) --
      // an earlier version compared raw, untransformed item.transform
      // values directly against PdfLink.position's own top-down convention,
      // a coordinate-space mismatch that silently never matched.
      const box = this.itemBox(item, viewport);
      if (this.hasNearbyLinkAnnotation(box, existingLinks)) continue;
      found.push(trimmed);
    }
    return found;
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
      linkCompletenessData: { url: span.url },
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

  private createCrossReferenceIssue(pageNumber: number, span: CrossRefSpan, pageWidth: number, pageHeight: number): AuditIssue {
    return {
      id: `link-completeness-${++this.issueCounter}`,
      source: 'link-completeness-validator',
      severity: 'moderate',
      code: 'CROSS-REFERENCE-MISSING-LINK',
      message: `Text reads as a cross-reference ("${span.text}") but has no underlying Link annotation to its target`,
      wcagCriteria: ['1.3.1', '4.1.2'],
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
      location: `Page ${pageNumber} at (${Math.round(span.box.x)}, ${Math.round(span.box.y)})`,
      category: 'links',
      suggestion:
        'Manual review recommended -- identify the actual chapter/section/page/figure/table this reference points to and add a real internal link (a Link annotation with a GoTo action) to it.',
      context: `Cross-reference text: "${span.text}"`,
      crossReferenceData: { keyword: span.keyword, number: span.number, fullText: span.text },
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

  private createCitationIssue(pageNumber: number, span: CitationSpan, pageWidth: number, pageHeight: number): AuditIssue {
    return {
      id: `link-completeness-${++this.issueCounter}`,
      source: 'link-completeness-validator',
      severity: 'moderate',
      code: 'CITATION-MISSING-LINK',
      message: `Text reads as an in-text citation ("${span.text}") but has no underlying Link annotation to its reference-list entry`,
      wcagCriteria: ['1.3.1', '4.1.2'],
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
      location: `Page ${pageNumber} at (${Math.round(span.box.x)}, ${Math.round(span.box.y)})`,
      category: 'links',
      suggestion:
        'Convert this citation into a real internal link -- add a Link annotation with a GoTo action pointing to the matching reference-list entry, if it can be resolved unambiguously.',
      context: `Citation text: "${span.text}"`,
      citationData: { authorText: span.authorText, year: span.year, fullText: span.text },
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

  /**
   * ONE aggregated, document-level issue -- same "smell test, not a
   * per-instance flag" convention as pdf-rolemap-integrity.validator.ts's
   * own ROLEMAP-INDEX-FLATTENED/ROLEMAP-FOOTNOTE-FLATTENED and pdf-audit.
   * service.ts's HEADER-FOOTER-TAGGED-AS-CONTENT, rather than one issue per
   * matched index line (which would routinely run into the hundreds on a
   * real index-bearing document and flood the audit report with near-
   * duplicates offering no individually-actionable target -- see
   * findIndexPageRefLines' own doc comment for why no per-number auto-fix
   * exists for this code to drive anyway).
   */
  private createIndexPageRefIssue(
    entryCount: number,
    pageCount: number,
    examples: IndexPageRefExample[]
  ): AuditIssue {
    const exampleText = examples.map((e) => `p${e.page}: "${e.text}"`).join('; ');
    return {
      id: `link-completeness-${++this.issueCounter}`,
      source: 'link-completeness-validator',
      severity: 'moderate',
      code: 'INDEX-ENTRY-MISSING-PAGE-LINK',
      message: `${entryCount} index entr${entryCount === 1 ? 'y' : 'ies'} across ${pageCount} page(s) list page-number references with no underlying Link annotation to the pages they refer to`,
      wcagCriteria: ['1.3.1', '4.1.2'],
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
      location: 'Document-wide (Index section)',
      category: 'links',
      suggestion:
        'Manual review recommended -- each index entry\'s own page-number reference(s) should become a real internal link to that page. Not auto-fixed: a short bare page number is routinely not a safe, unique anchor to locate in the page\'s own content stream (the same number can legitimately appear more than once per page, across different entries).',
      context: exampleText ? `Example entries: ${exampleText}` : undefined,
      element: 'Index',
    };
  }
}

export const pdfLinkCompletenessValidator = new PdfLinkCompletenessValidator();
