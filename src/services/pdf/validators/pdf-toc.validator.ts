/**
 * PDF TOC Validator
 *
 * S4 Carlisle manual QC, Round 2, item #4 ("Not Resolved", no existing
 * fix): "The TOC structure was not generated correctly. Furthermore, the
 * required two-way navigation links between the TOC and the corresponding
 * content sections were missing."
 *
 * Confirmed real via direct inspection of Karsaklian_189165_9781606497623.pdf
 * (the exact file S4 reviewed) -- its two in-content TOC pages ("Contents",
 * page 7, and "List of Figures and Tables", page 9) are detected correctly
 * by TocDetector's own heuristics (dot-leaders + a high page-ref ratio), but
 * every entry on them is tagged as a plain, generic /P (RoleMap-resolved,
 * same as nearly everything else in this InDesign export -- see
 * pdf-rolemap-integrity.validator.ts's own header comment), never /TOC or
 * /TOCI, and the WHOLE document has zero /Link annotations anywhere (0 of
 * any kind, confirmed by direct pikepdf-equivalent /Annots inspection on
 * every page) -- so clicking a TOC entry does nothing at all. Two distinct
 * sub-defects, both flagged here, with two different safety verdicts:
 *
 *   (a) TOC-STRUCTURE-MISSING (detect-only): the TOC page's content isn't
 *       tagged with the standard TOC/TOCI structure types ISO 32000-1
 *       Table 333 defines for exactly this purpose (Matterhorn checkpoint
 *       09-006, "A TOC-related structure element is used in a way that
 *       does not conform to Table 333 in ISO 32000-1" -- the PDF
 *       Association's own Tagged PDF school and axe-core's dedicated
 *       "toc-tagging" rule independently confirm this is a real,
 *       machine-checkable requirement, not a Matterhorn-only nicety; see
 *       this file's own git history for the sources checked). Retagging
 *       ~20-60 flat sibling /P elements per page into a correctly-nested
 *       /TOC > /TOCI > (title, Link) tree is a from-scratch structural
 *       rebuild on the scale of this codebase's own MATTERHORN-15-001
 *       table-retagging effort (6 slices across several PRs) -- genuinely
 *       too large and too risky to build and ship as a same-PR auto-fix,
 *       so this stays manual-review-only, same scope-boundary choice this
 *       codebase already made once for "real index page-reference link-
 *       building" (PR #811).
 *
 *   (b) TOC-LINK-MISSING (auto-fixable where resolvable): each TOC row's
 *       own trailing page-number/roman-numeral label -- "25", "ix" -- is
 *       ALREADY its own completely isolated bare-MCID /P span (confirmed
 *       live; see toc-entry-extractor.ts's own header comment), and a live
 *       sweep of every entry on both of this document's real TOC pages
 *       (12/12 sampled, covering front-matter roman numerals, all 10
 *       chapters, and figure/table sub-entries) resolves to EXACTLY ONE
 *       real page via this document's own /PageLabels number tree -- more
 *       tractable than a general cross-reference ("see Chapter 3"),
 *       which can't always be resolved this cleanly. This reuses
 *       pdf-structure-writer.service.ts's own buildLinkAnnotationFix core
 *       (the same one backing LINK-MISSING-ANNOTATION and CROSS-REFERENCE-
 *       MISSING-LINK) via a thin, direct-MCID path (fixTocEntryLink) that
 *       skips the text-search step entirely, since the target MCID is
 *       already known exactly -- see that method's own doc comment.
 *
 * "Two-way navigation": per the PDF Association's own Tagged PDF school
 * (TOC/TOCI pages) and every other real source checked, this means the
 * forward TOC-entry -> content jump must be a real, activatable link --
 * NOT that a second, reverse content -> TOC link needs to be synthesized
 * at every heading (no checked source requires that, and inventing one
 * would mean guessing where on a heading to attach it). "Two-way" in
 * practice is satisfied by (1) this forward link existing at all, and (2)
 * ordinary PDF viewer back-navigation plus this document's own bookmarks
 * (a pre-existing, separately validated/fixed gap -- see
 * pdf-bookmark.validator.ts's BOOKMARK-MISSING) -- neither of which this
 * validator needs to re-implement.
 */

import { PDFDict, PDFName, PDFArray, PDFRef, PDFDocument } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfLink } from '../pdf-comprehensive-parser.service';
import { pdfParserService } from '../pdf-parser.service';
import { decodePageContent } from '../pdf-content-stream-io';
import { extractTocRowCandidates, AVG_CHAR_WIDTH_FACTOR, type TocRowCandidate } from '../toc-entry-extractor';
import { tocDetector } from '../smart-triage/toc.detector';
import { logger } from '../../../lib/logger';

/** Standard structure types ISO 32000-1 Table 333 defines for a Table of
 *  Contents (after RoleMap resolution) -- a page already carrying either
 *  of these is correctly tagged, nothing to flag. */
const TOC_TAGS = new Set(['TOC', 'TOCI']);

interface PageTagScan {
  /** Pages hosting at least one real /TOC or /TOCI (RoleMap-resolved) element. */
  tocTaggedPages: Set<number>;
  /** Pages hosting at least one real /Table (RoleMap-resolved) element --
   *  already owned by smart-triage/triage.service.ts's own TOC-TAGGING
   *  reclassification (the "TOC mistagged as Table" case); this validator
   *  must not double-flag the same page with a second, differently-worded
   *  structure issue. */
  tableTaggedPages: Set<number>;
}

class PdfTocValidator {
  name = 'PdfTocValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfTocValidator] Starting TOC structure/link validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    const doc = parsed.parsedPdf?.pdfLibDoc;
    if (!doc) {
      logger.warn('[PdfTocValidator] No pdfLibDoc available -- skipping');
      return issues;
    }

    const tocPages = await tocDetector.detectTocPages(parsed);
    if (tocPages.size === 0) {
      logger.info('[PdfTocValidator] No TOC pages detected -- skipping');
      return issues;
    }

    const { tocTaggedPages, tableTaggedPages } = this.scanExistingTags(doc);
    const pageLabels = pdfParserService.extractPageLabels(doc, parsed.metadata.pageCount);

    for (const pageNumber of [...tocPages].sort((a, b) => a - b)) {
      if (!tocTaggedPages.has(pageNumber) && !tableTaggedPages.has(pageNumber)) {
        issues.push(this.createStructureIssue(pageNumber));
      }

      issues.push(...this.findMissingLinks(doc, pageNumber, pageLabels, parsed));
    }

    logger.info(`[PdfTocValidator] Found ${issues.length} TOC issue(s) across ${tocPages.size} TOC page(s)`);
    return issues;
  }

  /** Duplicated local RoleMap walk, same shape as pdf-rolemap-integrity.
   *  validator.ts's own buildRoleMap/resolveRoleMapChain/countTagUsage --
   *  this project's established preference for isolated per-feature
   *  structure-tree helpers over cross-module coupling. One pass over the
   *  whole tree, not per-page, since both page sets this validator needs
   *  are document-wide facts checked against a handful of candidate pages. */
  private scanExistingTags(doc: PDFDocument): PageTagScan {
    const tocTaggedPages = new Set<number>();
    const tableTaggedPages = new Set<number>();

    const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const structRoot = structRootRaw instanceof PDFRef ? doc.context.lookup(structRootRaw) : structRootRaw;
    if (!(structRoot instanceof PDFDict)) return { tocTaggedPages, tableTaggedPages };

    const roleMap = new Map<string, string>();
    const rmRaw = structRoot.get(PDFName.of('RoleMap'));
    const rm = rmRaw instanceof PDFRef ? doc.context.lookup(rmRaw) : rmRaw;
    if (rm instanceof PDFDict) {
      for (const [key, value] of rm.entries()) {
        const customTag = key.toString().replace(/^\//, '');
        const stdTag = value instanceof PDFName ? value.toString().replace(/^\//, '') : null;
        if (stdTag) roleMap.set(customTag, stdTag);
      }
    }
    const resolve = (rawType: string): string => {
      const visited = new Set<string>();
      let current = rawType;
      while (roleMap.has(current) && !visited.has(current)) {
        visited.add(current);
        current = roleMap.get(current)!;
      }
      return current;
    };

    const pages = doc.getPages();
    const pageRefToNumber = new Map<number, number>();
    pages.forEach((p, idx) => pageRefToNumber.set(p.ref.objectNumber, idx + 1));

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
        if (sRaw) {
          const resolved = resolve(sRaw.toString().replace(/^\//, ''));
          const pgRaw = node.get(PDFName.of('Pg'));
          const pageNumber = pgRaw instanceof PDFRef ? pageRefToNumber.get(pgRaw.objectNumber) : undefined;
          if (pageNumber !== undefined) {
            if (TOC_TAGS.has(resolved)) tocTaggedPages.add(pageNumber);
            else if (resolved === 'Table') tableTaggedPages.add(pageNumber);
          }
        }
        const kids = node.get(PDFName.of('K'));
        if (kids) walk(kids, depth + 1);
      }
    };
    walk(structRoot, 0);

    return { tocTaggedPages, tableTaggedPages };
  }

  private findMissingLinks(
    doc: PDFDocument,
    pageNumber: number,
    pageLabels: string[] | undefined,
    parsed: PdfParseResult
  ): AuditIssue[] {
    const content = decodePageContent(doc, pageNumber);
    if (!content) return [];

    const rows = extractTocRowCandidates(content);
    if (rows.length === 0) return [];

    const page = parsed.pages[pageNumber - 1];
    const existingLinks = page?.links ?? [];
    const pageWidth = page?.width ?? 0;
    const pageHeight = page?.height ?? 0;

    const out: AuditIssue[] = [];
    for (const row of rows) {
      const targetPageIndex = this.resolveLabelToPageIndex(row.label, pageLabels);
      if (targetPageIndex === null) continue; // ambiguous or unresolvable -- decline, don't guess

      const box = this.rowBoundingBox(row, pageWidth, pageHeight);
      if (this.hasNearbyLinkAnnotation(box, existingLinks)) continue; // already linked (e.g. a prior fix on a re-audit)

      out.push(this.createLinkIssue(pageNumber, row, targetPageIndex, box));
    }
    return out;
  }

  /** The label's own baseline origin, converted from toc-entry-extractor.ts's
   *  native PDF device-space (bottom-left origin) to AuditIssue.boundingBox's
   *  documented TOP-LEFT-origin convention -- same conversion pdf-link-
   *  completeness.validator.ts's own itemBox already performs, just with the
   *  flip computed directly against the page height rather than via a
   *  pdfjs viewport object. Width is approximated from character count
   *  (no true glyph-width data available from a bare Tj anchor -- see
   *  TocRowCandidate's own doc comment). */
  private rowBoundingBox(
    row: TocRowCandidate,
    pageWidth: number,
    pageHeight: number
  ): NonNullable<AuditIssue['boundingBox']> {
    const width = Math.max(row.label.length * row.labelFontSize * AVG_CHAR_WIDTH_FACTOR, row.labelFontSize);
    return {
      x: row.labelOriginX,
      y: pageHeight - row.labelOriginY - row.labelFontSize,
      width,
      height: row.labelFontSize,
      pageWidth,
      pageHeight,
    };
  }

  /** Same page-scoped bare-number-label-to-/PageLabels matching
   *  pdf-structure-writer.service.ts's own resolveCrossReferenceDestination
   *  uses for its "page"/"pg"/"p" cross-reference branch, generalized to
   *  not require the literal "see page N" phrasing a TOC entry never uses
   *  -- just the trailing label text itself, matched against a real
   *  /PageLabels entry. Requires exactly one match; declines otherwise. */
  private resolveLabelToPageIndex(label: string, pageLabels: string[] | undefined): number | null {
    if (!pageLabels) return null;
    const matches: number[] = [];
    for (let i = 0; i < pageLabels.length; i++) {
      if (pageLabels[i] === label) matches.push(i);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /** Same bbox-overlap convention pdf-link-completeness.validator.ts's own
   *  hasNearbyLinkAnnotation already uses. */
  private hasNearbyLinkAnnotation(box: NonNullable<AuditIssue['boundingBox']>, existingLinks: PdfLink[]): boolean {
    return existingLinks.some(link => {
      const xOverlap = Math.min(box.x + box.width, link.position.x + link.position.width) - Math.max(box.x, link.position.x);
      const yOverlap = Math.min(box.y + box.height, link.position.y + link.position.height) - Math.max(box.y, link.position.y);
      return xOverlap > 0 && yOverlap > 0;
    });
  }

  private createStructureIssue(pageNumber: number): AuditIssue {
    return {
      id: `toc-structure-${++this.issueCounter}`,
      source: 'pdf-toc-validator',
      severity: 'moderate',
      code: 'TOC-STRUCTURE-MISSING',
      message: `Page ${pageNumber}: this Table of Contents is not tagged with the standard /TOC and /TOCI structure types`,
      wcagCriteria: ['1.3.1'],
      matterhornCheckpoint: '09-006',
      matterhornHow: 'M',
      location: `Page ${pageNumber}`,
      category: 'structure',
      suggestion:
        'Re-export the document from the authoring tool with proper TOC export settings, or manually retag this ' +
        'page\'s entries as /TOC containing /TOCI children (ISO 32000-1 Table 333) -- each /TOCI should in turn ' +
        'contain a /Link to its target section. Manual review recommended: converting this document\'s existing ' +
        'flat paragraph tags into correctly nested TOC/TOCI structure is a large structural rewrite, not a safe ' +
        'same-pass automated fix.',
      context: 'Detected as a TOC page by content heuristics (dot-leaders + a high ratio of trailing page numbers), ' +
        'but no /TOC or /TOCI structure element is anchored to it.',
      pageNumber,
    };
  }

  private createLinkIssue(
    pageNumber: number,
    row: TocRowCandidate,
    targetPageIndex: number,
    bbox: NonNullable<AuditIssue['boundingBox']>
  ): AuditIssue {
    const title = row.titleText || '(untitled entry)';
    return {
      id: `toc-link-${++this.issueCounter}`,
      source: 'pdf-toc-validator',
      severity: 'serious',
      code: 'TOC-LINK-MISSING',
      message: `Page ${pageNumber}: TOC entry "${title.slice(0, 80)}" (page ${row.label}) has no Link annotation to its target section`,
      wcagCriteria: ['1.3.1', '4.1.2'],
      matterhornCheckpoint: '28-011',
      matterhornHow: 'M',
      location: `Page ${pageNumber} at (${Math.round(bbox.x)}, ${Math.round(bbox.y)})`,
      category: 'links',
      suggestion:
        'Add a real internal link (a Link annotation with a GoTo action) from this TOC entry\'s own page-number ' +
        'label to its resolved target page, so activating it jumps there.',
      context: `TOC entry: "${title.slice(0, 120)}", resolved target page label: "${row.label}"`,
      tocLinkData: {
        mcid: row.labelMcid,
        label: row.label,
        targetPageIndex,
        entryText: title,
      },
      pageNumber,
      boundingBox: bbox,
    };
  }
}

export const pdfTocValidator = new PdfTocValidator();
