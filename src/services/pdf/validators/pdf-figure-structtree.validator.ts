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
 * ("figure_p{page}_mc{mcid}", or "figure_p{page}_{index}" when no MCID is
 * resolvable) is a new, struct-tree-native format pdfModifierService.
 * setAltText resolves directly (bypassing its existing image/xObject-name
 * matching entirely) — see that method's own doc comment for the
 * extension. dispatchIssue's existing ALT_TEXT_MISSING_CODES branch already
 * degrades gracefully when imageById has no entry for this id
 * (fallbackToPageRender renders the page directly from issue.pageNumber),
 * so no dispatch changes were needed either.
 *
 * Several real correctness bugs found by CodeRabbit/Codex on this file's
 * first version, all fixed here:
 *
 * 1. `visit`'s traversal required every resolved node to be a PDFDict,
 *    silently skipping the entire subtree whenever an indirect /K
 *    reference pointed at a PDFArray instead (a real, common producer
 *    shape — including StructTreeRoot's own /K in many real documents).
 *    Generalized to resolve one ref/array/dict layer at a time and recurse
 *    into arrays explicitly, matching pdfModifierService.traverseStructTree's
 *    own handling.
 *
 * 2. Page resolution only ever read the Figure's own direct /Pg, defaulting
 *    to page 1 whenever that was absent -- both a real case (a Figure can
 *    inherit its page from an ancestor with no /Pg of its own) and silently
 *    wrong (an issue's page/element id pointing at the wrong page makes
 *    setAltText's own page-scoped Figure search fail or, worse, resolve a
 *    same-numbered Figure on the wrong page). `visit` now threads an
 *    inherited page down through the traversal, and /K's own MCR-dictionary
 *    form (`<</Type /MCR /Pg ref /MCID n>>`, used when a Figure's content
 *    genuinely lives on a different page than its structural position) is
 *    resolved explicitly rather than only handling a bare MCID integer.
 *
 * 3. An explicit empty `/Alt` ("") -- the PDF/UA-compliant way to mark a
 *    Figure decorative, and the exact convention pdf-alttext.validator.ts's
 *    own image path already honors (image.altText === '' short-circuits as
 *    already-resolved, never re-flagged) -- was being treated as "missing"
 *    here (`.trim().length > 0` requires non-empty content). A struct-tree-
 *    only Figure with a real, deliberate empty /Alt would flip from
 *    accepted to failing purely because it has no discoverable image
 *    XObject. Now: an /Alt or /ActualText entry that's PRESENT at all
 *    (even empty) counts as having an alternate.
 *
 * 4. setAltText only recognized this validator's MCID-based id format
 *    (figure_p{page}_mc{mcid}); the positional fallback id
 *    (figure_p{page}_{index}, emitted when no MCID is resolvable) fell
 *    through to the unrelated img_p{page}_{index} regex, which doesn't
 *    match either -- silently defaulting to page 1/index 0 and potentially
 *    overwriting an unrelated Figure's /Alt while reporting success.
 *    setAltText now has a matching positional branch (mirroring
 *    setActualText's identical mc-vs-idx handling), and explicitly rejects
 *    an unrecognized figure_p-prefixed id rather than falling through to
 *    the image-based matching at all.
 *
 * 5. The emitted issue `message` was identical for every Figure on the same
 *    page ("Figure on page N has no alternative text") -- base-audit.
 *    service.ts's deduplicateIssues keys on (source, code,
 *    matterhornCheckpoint, pageNumber, location, boundingBox, message),
 *    and with no boundingBox set here either, every Figure on the same
 *    page produced an IDENTICAL key, silently collapsing multiple real,
 *    distinct issues into one in the final audit's result.issues (though
 *    not result.altTextIssues, which isn't deduplicated) -- confirmed a
 *    real, live-relevant bug: the real Math_Weir_PDF.pdf document's page 17
 *    alone has 3 such Figures. The element id, which is unique per Figure,
 *    is now included in the message.
 */

import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFString, PDFHexString, PDFRawStream } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { pdfModifierService } from '../pdf-modifier.service';
import { imageExtractorService } from '../image-extractor.service';
import { decodePageContent } from '../pdf-content-stream-io';
import { locateMcidBoundingBoxes, type FormXObjectInfo } from '../mcid-bounding-box';
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
    const pageInfoFor = (pgEntry: unknown): PageInfo | undefined =>
      pgEntry instanceof PDFRef ? pageByRef.get(pgEntry.toString()) : undefined;

    const perPageIndex = new Map<number, number>();
    const seen = new Set<string>();
    // Every emitted issue whose MCID resolved to a real page, collected for
    // a single post-pass bounding-box lookup below (grouped by page, one
    // decode + one locateMcidBoundingBoxes call per page rather than one
    // per figure) -- mirrors computeImageCoveredFigures's own "compute once,
    // reuse" convention above.
    const pendingBoxLookup: Array<{ issue: AuditIssue; pageNumber: number; mcid: number }> = [];

    const visit = (nodeRef: unknown, inheritedPage: PageInfo | undefined): void => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;

      // An indirect /K can point straight at an array (common — including
      // StructTreeRoot's own /K in many real documents), not only a dict.
      if (node instanceof PDFArray) {
        for (const item of node.asArray()) visit(item, inheritedPage);
        return;
      }
      if (!(node instanceof PDFDict)) return;

      const ownPage = pageInfoFor(node.get(PDFName.of('Pg'))) ?? inheritedPage;

      if (node.get(PDFName.of('S'))?.toString() === '/Figure') {
        totalFigures++;
        if (this.hasAlternate(node)) {
          withAlternate++;
        } else if (!coveredFigures.has(node)) {
          const content = this.resolveContentRef(node, ownPage, doc, pageInfoFor);
          const issue = this.buildIssue(content.pageInfo, content.mcid, perPageIndex);
          issues.push(issue);
          if (content.mcid !== undefined && content.pageInfo) {
            pendingBoxLookup.push({ issue, pageNumber: content.pageInfo.pageNumber, mcid: content.mcid });
          }
        }
      }

      const k = node.get(PDFName.of('K'));
      if (k !== undefined) visit(k, ownPage);
    };

    visit(root, undefined);

    this.attachBoundingBoxes(doc, pendingBoxLookup);

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

  /**
   * Attaches a real boundingBox to each issue whose Figure content actually
   * resolves to drawn geometry on its page — closes a real, confirmed-live
   * gap: without this, every one of these issues fell back to a WHOLE-PAGE
   * render for AI captioning (fallbackToPageRender in ai-analysis.service.ts
   * has no bounding box to crop to), and on a page with more than one such
   * Figure, every separate issue got the IDENTICAL full-page image with no
   * way to tell which one it was being asked about. Confirmed as the real
   * cause of Auto Mode's yield collapsing to near zero after its first
   * round on a real 377-page document (Math_Weir_PDF.pdf): 433 -> 303 in
   * round 2 (real embedded images, handled fine by the image-based path),
   * then only 3-7 out of 283 struct-tree-only Figures per round for five
   * more rounds.
   *
   * One content-stream decode + one locateMcidBoundingBoxes call per PAGE
   * (not per figure), grouping every pending issue on that page into a
   * single lookup — mirrors computeImageCoveredFigures's own batching.
   * Leaves `issue.boundingBox` unset (never fabricated) for any MCID whose
   * span produced no real geometry, or whose page content couldn't be
   * decoded — callers already treat a missing boundingBox as a safe,
   * pre-existing fallback to the whole-page render.
   *
   * The device→top-left flip below (`pageHeight - box.maxY`) assumes
   * /Rotate 0 and a MediaBox origin at (0,0) — a page with real rotation or
   * a non-zero CropBox/MediaBox origin needs pdfjs's own per-page viewport
   * transform, not a bare height subtraction, to land on the same pixels
   * ai-analysis.service.ts's crop later renders (CodeRabbit finding on
   * PR #583, confirmed real). NOT fixed here: this is the exact same
   * simplification image-extractor.service.ts's own ImageInfo.position
   * already makes and this whole codebase's AuditIssue.boundingBox
   * convention is built on — a pre-existing, shared limitation, not one
   * newly introduced by this file, and unconfirmed to matter for any real
   * document exercised so far (Math_Weir_PDF.pdf has no rotated pages).
   */
  private attachBoundingBoxes(
    doc: ParsedPDF['pdfLibDoc'],
    entries: Array<{ issue: AuditIssue; pageNumber: number; mcid: number }>,
  ): void {
    const byPage = new Map<number, Array<{ issue: AuditIssue; mcid: number }>>();
    for (const entry of entries) {
      if (!byPage.has(entry.pageNumber)) byPage.set(entry.pageNumber, []);
      byPage.get(entry.pageNumber)!.push({ issue: entry.issue, mcid: entry.mcid });
    }

    for (const [pageNumber, list] of byPage) {
      try {
        const content = decodePageContent(doc, pageNumber);
        if (!content) continue;
        const boxes = locateMcidBoundingBoxes(content, new Set(list.map(l => l.mcid)), {
          resolveFormXObject: this.buildFormXObjectResolver(doc, pageNumber),
        });
        if (boxes.size === 0) continue;

        const { width: pageWidth, height: pageHeight } = doc.getPage(pageNumber - 1).getSize();
        for (const { issue, mcid } of list) {
          const box = boxes.get(mcid);
          if (!box) continue;
          issue.boundingBox = {
            x: box.minX,
            y: pageHeight - box.maxY,
            width: box.maxX - box.minX,
            height: box.maxY - box.minY,
            pageWidth,
            pageHeight,
          };
        }
      } catch (err) {
        logger.debug(`[PdfFigureStructTreeValidator] Could not compute bounding boxes for page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Builds a locateMcidBoundingBoxes-shaped resolver for a single page's
   * /Resources/XObject dict -- real incident, Math_Nikitopoulos_PDF.pdf
   * (2026-09-25): all 6 of this document's real struct-tree-only Figures
   * are `Do`-only spans invoking Form XObjects (the standard "/Fm{N}"
   * naming convention) with substantial real BBoxes, which
   * locateMcidBoundingBoxes' own unit-square fallback (no resolver)
   * collapsed to a useless ~1x1-point device-space box every time. Memoized
   * per page (a handful of Do names at most, but cheap either way) since a
   * page can invoke the same Form multiple times.
   */
  private buildFormXObjectResolver(
    doc: ParsedPDF['pdfLibDoc'],
    pageNumber: number,
  ): (name: string) => FormXObjectInfo | null {
    const cache = new Map<string, FormXObjectInfo | null>();
    let xobjDict: PDFDict | undefined;
    try {
      const resources = doc.getPage(pageNumber - 1).node.Resources();
      const raw = resources?.get(PDFName.of('XObject'));
      const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (resolved instanceof PDFDict) xobjDict = resolved;
    } catch {
      xobjDict = undefined;
    }

    return (name: string): FormXObjectInfo | null => {
      if (cache.has(name)) return cache.get(name)!;
      let info: FormXObjectInfo | null = null;
      try {
        const key = name.startsWith('/') ? name.slice(1) : name;
        const ref = xobjDict?.get(PDFName.of(key));
        const resolved = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (resolved instanceof PDFRawStream) {
          const dict = resolved.dict;
          if (dict.get(PDFName.of('Subtype'))?.toString() === '/Form') {
            const bboxArr = dict.get(PDFName.of('BBox'));
            if (bboxArr instanceof PDFArray && bboxArr.size() === 4) {
              const bbox = [0, 1, 2, 3].map(i => {
                const v = bboxArr.get(i);
                const resolvedV = v instanceof PDFRef ? doc.context.lookup(v) : v;
                return resolvedV instanceof PDFNumber ? resolvedV.asNumber() : 0;
              }) as [number, number, number, number];

              let matrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
              const matrixArr = dict.get(PDFName.of('Matrix'));
              if (matrixArr instanceof PDFArray && matrixArr.size() === 6) {
                matrix = [0, 1, 2, 3, 4, 5].map(i => {
                  const v = matrixArr.get(i);
                  const resolvedV = v instanceof PDFRef ? doc.context.lookup(v) : v;
                  return resolvedV instanceof PDFNumber ? resolvedV.asNumber() : (i === 0 || i === 3 ? 1 : 0);
                }) as [number, number, number, number, number, number];
              }
              info = { bbox, matrix };
            }
          }
        }
      } catch {
        info = null;
      }
      cache.set(name, info);
      return info;
    };
  }

  /**
   * An /Alt or /ActualText entry that's PRESENT at all — even an explicit
   * empty string, the PDF/UA-compliant way to mark decorative content —
   * counts as having an alternate. Only a genuinely ABSENT entry (no /Alt
   * and no /ActualText key at all) is missing one.
   */
  private hasAlternate(elem: PDFDict): boolean {
    for (const key of ['ActualText', 'Alt'] as const) {
      const v = elem.get(PDFName.of(key));
      if (v instanceof PDFString || v instanceof PDFHexString) return true;
    }
    return false;
  }

  private buildIssue(
    pageInfo: PageInfo | undefined,
    mcid: number | undefined,
    perPageIndex: Map<number, number>,
  ): AuditIssue {
    const pageNumber = pageInfo?.pageNumber ?? 1;

    const positional = perPageIndex.get(pageNumber) ?? 0;
    perPageIndex.set(pageNumber, positional + 1);

    const element = mcid !== undefined ? `figure_p${pageNumber}_mc${mcid}` : `figure_p${pageNumber}_${positional}`;

    return {
      id: `pdf-figure-structtree-${++this.issueCounter}`,
      source: 'pdf-figure-structtree',
      severity: 'critical',
      code: 'MATTERHORN-13-001',
      // Includes the element id specifically so multiple Figures on the same
      // page produce distinct deduplication keys — see this file's own
      // header comment (finding 5) for the real silent-drop bug this fixes.
      message: `Figure "${element}" on page ${pageNumber} has no alternative text`,
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

  /**
   * Resolves a Figure's content reference: the MCID it's bound to (a bare
   * integer, or the /MCID entry of an MCR dictionary — `<</Type /MCR /Pg
   * ref /MCID n>>`, used when the referenced content genuinely lives on a
   * different page than the Figure's own structural position) and the page
   * that content is actually on. An MCR's own /Pg, when present, takes
   * priority over the inherited page passed in from the traversal — that's
   * the whole reason the MCR form exists. Falls back to the inherited page
   * (from the Figure's own or an ancestor's /Pg) when /K carries no
   * resolvable MCID at all.
   */
  private resolveContentRef(
    elem: PDFDict,
    inheritedPage: PageInfo | undefined,
    doc: ParsedPDF['pdfLibDoc'],
    pageInfoFor: (pgEntry: unknown) => PageInfo | undefined,
  ): { pageInfo: PageInfo | undefined; mcid: number | undefined } {
    const k = elem.get(PDFName.of('K'));
    const items = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];

    for (const raw of items) {
      const item = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (item instanceof PDFNumber) {
        return { pageInfo: inheritedPage, mcid: item.asNumber() };
      }
      if (item instanceof PDFDict) {
        const mcidEntry = item.get(PDFName.of('MCID'));
        if (mcidEntry instanceof PDFNumber) {
          const pageInfo = pageInfoFor(item.get(PDFName.of('Pg'))) ?? inheritedPage;
          return { pageInfo, mcid: mcidEntry.asNumber() };
        }
      }
    }
    return { pageInfo: inheritedPage, mcid: undefined };
  }

  private getStructTreeRoot(doc: ParsedPDF['pdfLibDoc']): PDFDict | undefined {
    const ref = doc.catalog.get(PDFName.of('StructTreeRoot'));
    const root = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    return root instanceof PDFDict ? root : undefined;
  }
}

export const pdfFigureStructTreeValidator = new PdfFigureStructTreeValidator();
