/**
 * PDF Figure Struct-Tree Validator
 *
 * Walks the tagged structure tree directly for /Figure elements that lack a
 * text alternative (/Alt or /ActualText) — the same pattern
 * pdf-formula.validator.ts already uses for /Formula elements, applied to
 * /Figure. pdf-alttext.validator.ts's own detection is entirely gated
 * through image-extractor.service.ts's page-level Resources/XObject scan:
 * it never independently walks the structure tree, so a /Figure that
 * doesn't wrap a Do-invoked raster Image XObject is completely invisible to
 * it (not flagged, not counted, not skipped-with-a-reason — it simply
 * doesn't exist as far as that pipeline is concerned).
 *
 * Confirmed live on a real 377-page document (Math_Weir_PDF) via the real
 * PAC/axesPAC desktop tool: 513 total /Figure elements, 80 with an
 * alternate, 433 without — an EXACT match to this validator's own
 * struct-tree walk. Ninja's own audit for the same document reported only
 * ~2 remaining missing-alt-text issues. The gap is concrete: page 17 (a
 * "List of Key Symbols" glossary page) has 3 /Figure elements, each with a
 * bare-integer /K (a direct MCID reference, no XObject at all) — a
 * rasterized math symbol glyph (e.g. "X̄", the sample-mean symbol) tagged
 * as its own Figure, never enumerable via any Do operator because none
 * exists for it.
 *
 * Deliberately does NOT duplicate pdf-alttext.validator.ts's own coverage:
 * a Figure that DOES resolve to a real, already-extracted image (via
 * pdfModifierService.resolveFigureForImage, the exact same resolution
 * image-extractor.service.ts itself uses) is skipped here regardless of
 * whether that image has alt text — pdf-alttext.validator.ts's own pass
 * already decides that case correctly. This validator exists ONLY to catch
 * what that pipeline structurally cannot see: Figures with no discoverable
 * XObject at all (vector-drawn, or a bare-MCID marked-content reference),
 * or ones whose Image XObject lives inside a Form XObject's own resources
 * (image-extractor.service.ts only reads the page's *direct*
 * Resources/XObject).
 *
 * Emits the SAME MATTERHORN-13-001 code pdf-alttext.validator.ts already
 * uses for missing Figure alt text — not a new code — so these issues flow
 * through the existing ALT_TEXT_MISSING_CODES dispatch in
 * ai-analysis.service.ts and pac-report.service.ts's NINJA_TESTABLE_
 * CONDITIONS with zero additional wiring. The element id
 * ("figure_p{page}_mc{mcid}") is a new, struct-tree-native format
 * pdfModifierService.setAltText resolves directly by MCID (bypassing its
 * existing image/xObject-name matching entirely, since the MCID already
 * uniquely identifies the exact Figure) — see that method's own doc
 * comment for the extension. dispatchIssue's existing ALT_TEXT_MISSING_
 * CODES branch already degrades gracefully when imageById has no entry for
 * this id (fallbackToPageRender renders the page directly from
 * issue.pageNumber), so no dispatch changes were needed either.
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { pdfModifierService } from '../pdf-modifier.service';
import { imageExtractorService } from '../image-extractor.service';
import { logger } from '../../../lib/logger';

export interface FigureStructTreeValidationResult {
  issues: AuditIssue[];
  metadata: {
    totalFigures: number;
    figuresWithAlternate: number;
    figuresCoveredByImagePath: number;
    figuresMissingAlternate: number;
  };
}

interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

class PdfFigureStructTreeValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<FigureStructTreeValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const issues: AuditIssue[] = [];
    let totalFigures = 0;
    let withAlternate = 0;

    const root = this.getStructTreeRoot(doc);
    if (!root) {
      return { issues, metadata: { totalFigures: 0, figuresWithAlternate: 0, figuresCoveredByImagePath: 0, figuresMissingAlternate: 0 } };
    }

    // Every Figure the image-based path (pdf-alttext.validator.ts) already
    // resolves to a real image, regardless of whether that image has alt
    // text — skip these entirely; that pipeline already decides them
    // correctly, and double-flagging would produce a duplicate issue for
    // the same Figure. No base64 needed here, only position/id for
    // resolveFigureForImage's own MCID-exact matching.
    const coveredFigures = await this.computeImageCoveredFigures(parsedPdf, doc);

    const pageByRef = new Map<string, PageInfo>();
    doc.getPages().forEach((page, i) => {
      const { width, height } = page.getSize();
      pageByRef.set(page.ref.toString(), { pageNumber: i + 1, width, height });
    });

    const perPageIndex = new Map<number, number>();
    const seen = new Set<string>();

    const visit = (nodeRef: unknown): void => {
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
      if (!(node instanceof PDFDict)) return;
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }

      if (node.get(PDFName.of('S'))?.toString() === '/Figure') {
        totalFigures++;
        if (this.hasAlternate(node)) {
          withAlternate++;
        } else if (!coveredFigures.has(node)) {
          issues.push(this.buildIssue(node, pageByRef, perPageIndex, doc));
        }
      }

      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
      for (const kid of kids) if (kid instanceof PDFRef || kid instanceof PDFDict) visit(kid);
    };

    visit(root);

    logger.info(
      `[PdfFigureStructTreeValidator] ${totalFigures} figure(s): ${withAlternate} with alternate, ` +
      `${coveredFigures.size} covered by the image-extraction path, ${issues.length} missing (struct-tree-only)`,
    );

    return {
      issues,
      metadata: {
        totalFigures,
        figuresWithAlternate: withAlternate,
        figuresCoveredByImagePath: coveredFigures.size,
        figuresMissingAlternate: issues.length,
      },
    };
  }

  /**
   * Resolves every image image-extractor.service.ts would find (cheap —
   * no base64) to its Figure struct element via the exact same
   * pdfModifierService.resolveFigureForImage MCID-exact matching that
   * service itself uses, so "covered" here means EXACTLY what
   * pdf-alttext.validator.ts's own pass will decide. Reference equality on
   * the returned PDFDict is safe: pdf-lib's PDFContext caches one object
   * instance per indirect reference, and precomputedFigures guarantees
   * resolveFigureForImage searches (and returns from) this exact array.
   */
  private async computeImageCoveredFigures(parsedPdf: ParsedPDF, doc: ParsedPDF['pdfLibDoc']): Promise<Set<PDFDict>> {
    const covered = new Set<PDFDict>();
    try {
      const allFigures = pdfModifierService.getAllFigureElements(doc);
      if (allFigures.length === 0) return covered;

      const documentImages = await imageExtractorService.extractImages(parsedPdf, {
        includeBase64: false,
        maxImageSize: 1024,
        minWidth: 10,
        minHeight: 10,
      });
      for (const pageImages of documentImages.pages) {
        for (const image of pageImages.images) {
          const figure = pdfModifierService.resolveFigureForImage(doc, image.id, allFigures);
          if (figure) covered.add(figure);
        }
      }
    } catch (err) {
      logger.debug(`[PdfFigureStructTreeValidator] Could not compute image-covered figures: ${err instanceof Error ? err.message : String(err)}`);
    }
    return covered;
  }

  private hasAlternate(elem: PDFDict): boolean {
    for (const key of ['ActualText', 'Alt'] as const) {
      const v = elem.get(PDFName.of(key));
      if ((v instanceof PDFString || v instanceof PDFHexString) && v.decodeText().trim().length > 0) return true;
    }
    return false;
  }

  private buildIssue(
    elem: PDFDict,
    pageByRef: Map<string, PageInfo>,
    perPageIndex: Map<number, number>,
    doc: ParsedPDF['pdfLibDoc'],
  ): AuditIssue {
    const pgRef = elem.get(PDFName.of('Pg'));
    const pageInfo = pgRef instanceof PDFRef ? pageByRef.get(pgRef.toString()) : undefined;
    const pageNumber = pageInfo?.pageNumber ?? 1;

    const positional = perPageIndex.get(pageNumber) ?? 0;
    perPageIndex.set(pageNumber, positional + 1);

    const mcid = this.firstMcid(elem, doc);
    const element = mcid !== undefined ? `figure_p${pageNumber}_mc${mcid}` : `figure_p${pageNumber}_${positional}`;

    return {
      id: `pdf-figure-structtree-${++this.issueCounter}`,
      source: 'pdf-figure-structtree',
      severity: 'critical',
      code: 'MATTERHORN-13-001',
      message: `Figure on page ${pageNumber} has no alternative text`,
      wcagCriteria: ['1.1.1'],
      location: `Page ${pageNumber}`,
      suggestion: 'Add descriptive alternative text to the figure. Alt text should convey the same information as the figure.',
      category: 'alt-text',
      element,
      pageNumber,
      matterhornCheckpoint: '13-001',
      matterhornHow: 'M',
    };
  }

  /** First MCID referenced by the element's /K (single number or first number in an array). */
  private firstMcid(elem: PDFDict, doc: ParsedPDF['pdfLibDoc']): number | undefined {
    const k = elem.get(PDFName.of('K'));
    if (k instanceof PDFNumber) return k.asNumber();
    if (k instanceof PDFArray) {
      for (const item of k.asArray()) {
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (resolved instanceof PDFNumber) return resolved.asNumber();
      }
    }
    return undefined;
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const ref = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const root = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    return root instanceof PDFDict ? root : undefined;
  }
}

export const pdfFigureStructTreeValidator = new PdfFigureStructTreeValidator();
