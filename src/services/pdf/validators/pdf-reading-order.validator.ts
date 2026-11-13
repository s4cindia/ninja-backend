/**
 * PDF Reading-Order Validator (detect-only)
 *
 * Matterhorn 09-001 ("Tags are not in logical reading order", UA1:7.2-1) --
 * the general structure-tree reading-order checkpoint. DISTINCT from
 * pdf-tab-order.validator.ts (Matterhorn 28-008/28-009), which only covers
 * the page-level /Tabs key used for keyboard/screen-reader navigation
 * between ANNOTATIONS (form fields, links) -- this checkpoint is about the
 * order of ordinary CONTENT elements within the structure tree's own /K
 * arrays, confirmed via direct inspection to be a real, separate defect.
 *
 * Confirmed real: the real S4 Carlisle manual QC Round-2 report's item #5
 * ("the reading order of the document content was not maintained
 * properly... may cause screen readers to present information in an
 * illogical sequence", "Not Resolved", no existing fix anywhere in this
 * codebase) against Karsaklian_189165_9781606497623.pdf, a 190-page,
 * already-tagged (InDesign-exported) academic title. Direct structure-tree
 * + content-stream geometry inspection (2026-11-13) found the SAME concrete
 * shape 16 times across the document: a page has two sibling flow
 * containers under its own /Art -- the main body-text story, and a SECOND,
 * separate story (an "AI Insight"-style sidebar callout box tagged as plain
 * /P, or a /Figure + its caption) that is visually positioned ABOVE the
 * main story's own content (in a gap between a heading and the first body
 * paragraph, or at the top of a page the main story only occupies the
 * bottom half of) but is tagged AFTER the entire main story in the
 * document's own /K order. A screen reader reading this document in order
 * reads the WHOLE main story first, then jumps back up the page to read
 * content that visually came first -- exactly the human QC finding's own
 * description.
 *
 * CRITICAL IMPLEMENTATION NOTE (2026-11-13, post-ship bug fix): this file's
 * FIRST shipped version walked /StructTreeRoot's /K array directly via
 * pdf-lib (a top-down walk) and compared GLOBALLY-adjacent flattened
 * blocks, gated to "same page". Re-running that exact shipped class against
 * the real file (not a new script) returned flagged: 0 -- a real,
 * confirmed implementation bug, not a correction to the "16 real
 * instances" finding. Root cause, confirmed by dumping the shipped
 * private methods' own intermediate state: on the real document, the
 * sidebar/callout "second story" for a given page is NOT a sibling of that
 * page's main story anywhere near it in the GLOBAL /K order -- InDesign
 * exports each THREADED STORY as its own contiguous run, so ALL of the
 * document's sidebar boxes are grouped together as one long separate run,
 * hundreds of struct elements away from the page they visually belong to
 * (confirmed: page 15's sidebar block landed at global flattened index 828,
 * while that same page's main-story blocks were at indices 73-78). A
 * "compare globally-adjacent entries, filtered to same page" loop can never
 * find this pair. A SECOND, independent bug compounded this: the content-
 * stream-only geometry primitive used (mcid-bounding-box.ts's
 * locateMcidBoundingBoxes) gives a Tj/TJ text run only its ANCHOR POINT
 * (not real glyph-width extent -- see that module's own documented
 * limitation), so a plain paragraph with no accompanying clip rect
 * collapsed to a zero-width box, which would have failed the X-overlap
 * check even with adjacency fixed.
 *
 * Both bugs are fixed by using pdfjs's own per-page page.getStructTree()
 * (RoleMap-resolved, and internally reconstructed bottom-up via each page's
 * own /ParentTree + /P parent links -- see pdfjs-dist's StructTreePage,
 * confirmed by reading its own source) instead of a raw top-down pdf-lib
 * /K walk: it already presents each page's own relevant elements in their
 * correct PAGE-LOCAL relative order, regardless of how far apart they sit
 * in the document's global /K array. Paired with tagged-pdf-extractor.ts's
 * own buildContentIdBBoxMap, which derives each content run's bbox from
 * pdfjs's real getTextContent() (font-metrics-aware glyph width, not a bare
 * anchor point), this is the SAME proven architecture
 * pdf-heading-style-mismatch.validator.ts already uses, and the SAME
 * architecture the original standalone investigation script (which found
 * the real 16 violations) used -- this rewrite makes the shipped validator
 * match that already-proven logic instead of a materially different
 * reimplementation that was never round-tripped against the real file
 * after being finalized.
 *
 * Research (2026-11-13): confirmed via this project's own catalog data
 * (src/data/matterhorn-1.1.data.ts, 09-001: how: 'H') AND independently via
 * veraPDF's own real PDF/UA-1 rule source (PDFUA-1.xml, fetched from
 * github.com/veraPDF/veraPDF-validation-profiles) that clause 7.2 (where
 * 09-001 lives, UA1:7.2-1) has ZERO automated rule for reading/tag order --
 * every one of its ~40 real machine rules covers a different requirement
 * (parent-entry presence, table/list/TOC/Ruby/Warichu syntax, etc.), and a
 * full-file search for "order" turns up nothing related to structure-tree
 * sequencing. Matterhorn 09-001 itself, and the wider Matterhorn Protocol
 * listing (taggedpdfschool.pdfa.org), both classify it as a HUMAN-ONLY
 * check for exactly this reason: there is no general, spec-sanctioned way
 * to machine-derive "correct" reading order from geometry alone. This
 * validator is therefore a best-effort HEURISTIC surfacing CANDIDATE
 * violations for human review (matterhornHow: 'H'), not a claim of a
 * genuine automated test -- consistent with this file's own evidence that
 * even the one narrow, repeatedly-confirmed real shape above only has an
 * unambiguous DIRECTION (a later-tagged block sits entirely above an
 * earlier one in the same column), not an unambiguous CORRECT INSERTION
 * POINT (page 15/21's sidebar belongs mid-story, in a specific gap; page
 * 72/85's figure belongs entirely before the story) -- so, per this
 * project's own established precedent for a confident-but-risky structural
 * change (pdf-heading-style-mismatch.validator.ts, pdf-rolemap-integrity.
 * validator.ts's index/footnote categories), this is DETECT-ONLY. No
 * suggestionType routing is registered for READING-ORDER-OUT-OF-SEQUENCE in
 * ai-analysis.service.ts, and pdf-structure-writer.service.ts gets no new
 * fixer for it.
 *
 * Detection heuristic, per page: flattens that page's own struct (sub)tree
 * into an ordered sequence of block-level zones (mapStructTag's own
 * ZONE_TAGS/CONTAINER_TAGS split, reused directly rather than duplicated --
 * unlike most structure-tree helpers in this codebase, this one is already
 * exported specifically for a second caller's reuse, see
 * pdf-heading-style-mismatch.validator.ts's own header comment), excluding
 * header/footer zones (owned by pdf-header-footer-content.validator.ts),
 * computes each zone's own top-down device-space bounding box (union of
 * its descendant content IDs' bboxes, via buildContentIdBBoxMap), then
 * flags an ADJACENT pair (i, i+1) in that page-local sequence only when
 * BOTH:
 *   - block i+1's bounding box is ENTIRELY above block i's (a clean,
 *     non-overlapping vertical gap -- not just "starts higher", which would
 *     also fire on ordinary inline variance);
 *   - the two blocks' X-ranges overlap by more than MIN_X_OVERLAP_FRACTION
 *     of the narrower one's own width.
 * The X-overlap requirement is the deliberate guard against this
 * heuristic's own worst failure mode (warned about explicitly going into
 * this investigation): a genuine multi-column layout, where column 2
 * legitimately restarts near the top of the page right after column 1
 * ends. Validated directly against this real document's own one genuine
 * two-column page (190 pages scanned, page 187: a true side-by-side
 * glossary-style layout) -- that page's real column-to-column transition
 * measures a NEGATIVE x-overlap (columns are disjoint in X, as expected)
 * and is correctly NOT flagged, while all 16 real violations found measure
 * xOverlapFraction === 1.00 (same column width, confirmed real, not a
 * theoretical edge case this threshold happens to also cover). Re-verified
 * after this rewrite: the shipped class, run against the real file,
 * now reproduces all 16 real violations (confirmed via a direct re-run,
 * not just unit-test fixtures).
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { buildContentIdBBoxMap, mapStructTag } from '../../zone-extractor/tagged-pdf-extractor';
import type { ContentIdTextMap } from '../../zone-extractor/tagged-pdf-extractor';
import type { BBox, CanonicalZoneType } from '../../zone-extractor/types';
import { logger } from '../../../lib/logger';

export interface ReadingOrderValidationResult {
  issues: AuditIssue[];
  metadata: {
    pagesAnalyzed: number;
    blocksAnalyzed: number;
    flagged: number;
  };
}

// Zone types excluded from this checkpoint's own comparison -- running
// heads/feet aren't part of the page's own content reading sequence this
// checkpoint cares about (see pdf-header-footer-content.validator.ts for
// that territory).
const EXCLUDED_ZONE_TYPES = new Set<CanonicalZoneType>(['header', 'footer']);

// See this file's own header comment ("Detection heuristic") for why each
// of these two thresholds was chosen and how they were validated against
// the real document's own one genuine multi-column page.
const MIN_X_OVERLAP_FRACTION = 0.5;
const MIN_VERTICAL_GAP_PT = 5;

// Minimal local typing for pdfjs's own getStructTree() result shape -- same
// convention pdf-heading-style-mismatch.validator.ts's own file uses
// (casts through `as unknown as` rather than importing pdfjs-dist's own
// StructTreeNode/StructTreeContent types).
interface StructNode {
  role: string;
  children: (StructNode | StructContent)[];
}

interface StructContent {
  type: string;
  id: string;
}

function isStructContent(child: StructNode | StructContent): child is StructContent {
  return !('role' in child);
}

interface PageBlock {
  zoneType: CanonicalZoneType;
  role: string;
  box: BBox; // top-down (y grows downward), same convention buildContentIdBBoxMap produces
  text: string;
}

class PdfReadingOrderValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<ReadingOrderValidationResult> {
    this.issueCounter = 0;
    const empty: ReadingOrderValidationResult = {
      issues: [],
      metadata: { pagesAnalyzed: 0, blocksAnalyzed: 0, flagged: 0 },
    };

    // Already-tagged documents only -- an untagged PDF has no /K-array
    // reading order of its own to be wrong about (Seam-C's own from-scratch
    // tagger synthesizes a geometrically-correct order at tagging time, see
    // struct-tree-builder.ts's synthesizeReadingOrder).
    if (!parsedPdf.structure?.metadata?.isTagged) return empty;

    const pdfjsDoc = parsedPdf.pdfjsDoc;
    if (!pdfjsDoc) return empty;

    const issues: AuditIssue[] = [];
    let pagesAnalyzed = 0;
    let blocksAnalyzed = 0;

    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
      let tree: StructNode | null = null;
      let textMap: ContentIdTextMap;
      let bboxMap: Map<string, BBox>;
      let pageWidth = 0;
      let pageHeight = 0;

      try {
        const page = await pdfjsDoc.getPage(pageNum);
        const rawTree = await page.getStructTree();
        if (!rawTree?.children?.length) continue;
        tree = rawTree as unknown as StructNode;

        const maps = await buildContentIdBBoxMap(page);
        bboxMap = maps.bboxMap;
        textMap = maps.textMap;

        const viewport = page.getViewport({ scale: 1 });
        pageWidth = viewport.width;
        pageHeight = viewport.height;
      } catch (err) {
        logger.debug(
          `[PdfReadingOrderValidator] Could not read page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const blocks: PageBlock[] = [];
      this.collectPageBlocks(tree, bboxMap, textMap, blocks);
      if (blocks.length === 0) continue;

      pagesAnalyzed++;
      blocksAnalyzed += blocks.length;

      for (let i = 0; i < blocks.length - 1; i++) {
        const a = blocks[i];
        const b = blocks[i + 1];

        const overlapX = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
        const minWidth = Math.min(a.box.w, b.box.w);
        const xOverlapFraction = minWidth > 0 ? overlapX / minWidth : 0;

        // Top-down (y grows downward): a SMALLER y is higher up the page.
        // "b entirely above a" means b's own bottom edge clears a's own top
        // edge (a.box.y) by more than the gap tolerance.
        const verticalGap = a.box.y - (b.box.y + b.box.h);

        if (xOverlapFraction > MIN_X_OVERLAP_FRACTION && verticalGap > MIN_VERTICAL_GAP_PT) {
          issues.push(this.buildIssue(a, b, pageWidth, pageHeight, pageNum));
        }
      }
    }

    logger.info(
      `[PdfReadingOrderValidator] ${blocksAnalyzed} block(s) across ${pagesAnalyzed} page(s) analyzed, ${issues.length} candidate reading-order violation(s) flagged`,
    );

    return {
      issues,
      metadata: { pagesAnalyzed, blocksAnalyzed, flagged: issues.length },
    };
  }

  /**
   * Recursively walks a page's own pdfjs struct tree (already pruned to
   * that page's own relevant elements, in their correct page-local relative
   * order -- see this file's own header comment on why that matters),
   * flattening every block-level zone (mapStructTag's own non-null,
   * non-excluded result) into `out`, in document order. A container
   * (mapStructTag returns null) is recursed into transparently; a zone is
   * packaged as one block (its own full descendant bbox + text) and NOT
   * recursed into further -- its own internal order (e.g. a table's rows)
   * is a different checkpoint's concern.
   */
  private collectPageBlocks(
    node: StructNode,
    bboxMap: Map<string, BBox>,
    textMap: ContentIdTextMap,
    out: PageBlock[],
  ): void {
    for (const child of node.children ?? []) {
      if (isStructContent(child)) continue; // bare content directly under a container -- not this validator's concern
      const zoneType = mapStructTag(child.role);
      if (zoneType === null) {
        this.collectPageBlocks(child, bboxMap, textMap, out);
        continue;
      }
      if (EXCLUDED_ZONE_TYPES.has(zoneType)) continue;

      let box: BBox | null = null;
      const texts: string[] = [];
      const collect = (n: StructNode | StructContent): void => {
        if (isStructContent(n)) {
          const b = bboxMap.get(n.id);
          if (b) box = box ? this.unionBBox(box, b) : { ...b };
          const t = textMap.get(n.id);
          if (t) texts.push(...t);
        } else {
          for (const c of n.children ?? []) collect(c);
        }
      };
      collect(child);

      if (box) out.push({ zoneType, role: child.role, box, text: texts.join('').trim() });
    }
  }

  private unionBBox(a: BBox, b: BBox): BBox {
    const x2 = Math.max(a.x + a.w, b.x + b.w);
    const y2 = Math.max(a.y + a.h, b.y + b.h);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  private buildIssue(a: PageBlock, b: PageBlock, pageWidth: number, pageHeight: number, pageNumber: number): AuditIssue {
    const aTop = a.box.y;
    const aBottom = a.box.y + a.box.h;
    const bTop = b.box.y;
    const bBottom = b.box.y + b.box.h;
    const textSample = b.text.slice(0, 80);

    return {
      id: `reading-order-${++this.issueCounter}`,
      source: 'pdf-reading-order',
      severity: 'moderate',
      code: 'READING-ORDER-OUT-OF-SEQUENCE',
      message:
        `On page ${pageNumber}, a /${b.role} structure element positioned near the top of the page ` +
        `(${bTop.toFixed(0)}-${bBottom.toFixed(0)}pt from top)${textSample ? ` ("${textSample}")` : ''} is tagged ` +
        `AFTER a /${a.role} structure element positioned lower on the page (${aTop.toFixed(0)}-${aBottom.toFixed(0)}pt ` +
        'from top) in the document\'s own structure-tree order -- a screen reader following this order would read ' +
        'the lower content first, then jump back up the page, out of visual sequence.',
      wcagCriteria: ['1.3.2'],
      location: `Page ${pageNumber}`,
      suggestion:
        'Candidate reading-order issue, flagged for manual review (e.g. in a screen reader or PAC tool) -- not ' +
        'auto-fixed. This looks like a sidebar/callout box or figure that visually sits earlier on the page than ' +
        "where it's tagged, but the correct insertion point in the structure tree's /K order varies per instance " +
        "(sometimes it belongs entirely before the surrounding flow, sometimes mid-flow in a specific gap) and " +
        "can't be reliably inferred from geometry alone -- reordering it incorrectly could make reading order worse.",
      category: 'structure',
      pageNumber,
      matterhornCheckpoint: '09-001',
      matterhornHow: 'H',
      boundingBox: {
        x: b.box.x,
        y: bTop,
        width: b.box.w,
        height: b.box.h,
        pageWidth,
        pageHeight,
      },
    };
  }
}

export const pdfReadingOrderValidator = new PdfReadingOrderValidator();
