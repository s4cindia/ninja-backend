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
 * description. Real examples (device-space, top-down, points):
 *   - Page 15: main story's last /P ends at y514-600; the sidebar /P
 *     ("Some organizations view marketing purely as...") sits at y146-172,
 *     in the gap between the page's own heading and the main story's
 *     first paragraph -- tagged dead last instead of there.
 *   - Page 72: main story continues through y486-617; a /Figure + caption
 *     ("Figure 5.1 The negotiator's five dilemmas") sits at y108-373,
 *     occupying the visually EARLIER top half of the same page -- tagged
 *     AFTER the story that visually follows it.
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
 * Detection heuristic: walks the real /StructTreeRoot directly via pdf-lib
 * (RoleMap-resolved, same duplicated-per-file convention pdf-rolemap-
 * integrity.validator.ts's own buildRoleMap uses, rather than pdfjs's own
 * getStructTree() -- this lets the validator's own tests build a fixture
 * with a deliberately WRONG /K order directly, which Seam-C's own
 * buildStructTreeFromZones can never produce: it always synthesizes a
 * geometrically-correct order via synthesizeReadingOrder, regardless of
 * input order). Flattens the tree into an ordered sequence of block-level
 * zones (same ZONE_TAGS/CONTAINER_TAGS split tagged-pdf-extractor.ts's own
 * mapStructTag uses, duplicated here rather than imported -- isolated
 * per-feature structure-tree helpers are this project's established
 * preference over cross-module coupling), computes each zone's own device-
 * space bounding box via mcid-bounding-box.ts's locateMcidBoundingBoxes
 * (content-stream-based; Form-XObject-invoked Figures resolved via
 * pdf-figure-structtree.validator.ts's own buildFormXObjectResolver, the
 * same already-bug-hardened resolver other callers share), then flags an
 * ADJACENT pair (i, i+1) in that flattened, same-page sequence only when
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
 * theoretical edge case this threshold happens to also cover).
 */

import { PDFDict, PDFName, PDFRef, PDFArray, PDFNumber, PDFDocument } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { decodePageContent, findBdcTagSpanForMcid } from '../pdf-content-stream-io';
import { locateMcidBoundingBoxes, DeviceBoundingBox } from '../mcid-bounding-box';
import { buildFormXObjectResolver } from './pdf-figure-structtree.validator';
import { logger } from '../../../lib/logger';

export interface ReadingOrderValidationResult {
  issues: AuditIssue[];
  metadata: {
    pagesAnalyzed: number;
    blocksAnalyzed: number;
    flagged: number;
  };
}

// Block-level tags whose own subtree is treated as ONE flattenable
// reading-order unit -- collects every descendant MCID across the whole
// subtree, then stops recursing (its own internal order, e.g. a table's
// rows/cells, is a different checkpoint's concern). Same membership as
// tagged-pdf-extractor.ts's own ZONE_TAGS, minus Header/Footer/Hdr/FTR/
// THead/TFoot (running heads/feet aren't part of the page's own content
// reading sequence this checkpoint cares about -- see
// pdf-header-footer-content.validator.ts for that territory).
const ZONE_TAGS = new Set([
  'P', 'BlockQuote', 'Code', 'BibEntry', 'Formula',
  'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'Title',
  'Table', 'Figure', 'Form', 'Caption', 'Note', 'NT', 'FENote',
  'LI', 'TOCI',
]);

// Transparent containers -- recurse into children in document order,
// without emitting a block of their own. Same membership as tagged-pdf-
// extractor.ts's own CONTAINER_TAGS (minus Root/StructTreeRoot/
// DocumentFragment, which this file's own walk never recurses INTO via
// this set -- the walk starts one level below StructTreeRoot already).
const CONTAINER_TAGS = new Set([
  'Document', 'Part', 'Div', 'Sect', 'Art', 'Aside', 'Index',
  'L', 'LBody', 'TOC', 'TR', 'TBody', 'NonStruct', 'Private',
]);

// Inline-only tags, and running heads/feet -- explicitly SKIPPED (neither
// flattened as a block nor recursed into). Almost always already absorbed
// into an ancestor ZONE_TAGS block's own collected MCIDs; a bare top-level
// occurrence (unusual) is deliberately not treated as its own reading-order
// unit, to avoid noisy false positives from e.g. a hyperlink's anchor text
// sitting mid-paragraph.
const SKIPPED_TAGS = new Set([
  'Span', 'Quote', 'Em', 'Strong', 'Sub', 'Lbl',
  'Annot', 'Link', 'Reference',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  'Hdr', 'FTR', 'Header', 'Footer', 'THead', 'TFoot',
]);

// See this file's own header comment ("Detection heuristic") for why each
// of these two thresholds was chosen and how they were validated against
// the real document's own one genuine multi-column page.
const MIN_X_OVERLAP_FRACTION = 0.5;
const MIN_VERTICAL_GAP_PT = 5;

interface FlatBlock {
  pageIdx: number; // 0-based
  role: string;
  mcids: Set<number>;
}

interface CollectedMcid {
  pageIdx: number;
  mcid: number;
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

    const doc = parsedPdf.pdfLibDoc;
    const structTreeRootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
    if (!structTreeRootRef) return empty;
    const structTreeRoot = doc.context.lookup(structTreeRootRef);
    if (!(structTreeRoot instanceof PDFDict)) return empty;

    const roleMap = this.buildRoleMap(doc, structTreeRoot);

    const pages = doc.getPages();
    const pageIndexByRef = new Map<string, number>();
    pages.forEach((p, i) => pageIndexByRef.set(p.ref.toString(), i));

    const flat: FlatBlock[] = [];
    const rootK = structTreeRoot.get(PDFName.of('K'));
    if (rootK !== undefined) {
      this.flattenBlocks(doc, rootK, roleMap, null, pageIndexByRef, flat, 0);
    }

    const byPage = new Map<number, number[]>(); // pageIdx -> indices into flat[]
    flat.forEach((b, i) => {
      const arr = byPage.get(b.pageIdx);
      if (arr) arr.push(i);
      else byPage.set(b.pageIdx, [i]);
    });

    if (flat.length < 2) {
      return { issues: [], metadata: { pagesAnalyzed: byPage.size, blocksAnalyzed: flat.length, flagged: 0 } };
    }

    // Resolve each block's own device-space (bottom-left origin) bounding
    // box, one locateMcidBoundingBoxes call per page covering every block
    // on it together (matches this codebase's established "batch per page"
    // convention elsewhere, e.g. pdf-figure-structtree.validator.ts).
    const bboxByBlockIndex = new Map<number, DeviceBoundingBox>();
    for (const [pageIdx, indices] of byPage) {
      let content: string | null;
      try {
        content = decodePageContent(doc, pageIdx + 1);
      } catch {
        content = null;
      }
      if (!content) continue;

      const allMcids = new Set<number>();
      for (const idx of indices) for (const m of flat[idx].mcids) allMcids.add(m);
      if (allMcids.size === 0) continue;

      let perMcid: Map<number, DeviceBoundingBox>;
      try {
        perMcid = locateMcidBoundingBoxes(content, allMcids, {
          allowSinglePointBoxes: true,
          resolveFormXObject: buildFormXObjectResolver(doc, pageIdx + 1),
        });
      } catch (err) {
        logger.debug(`[PdfReadingOrderValidator] Could not compute bounding boxes on page ${pageIdx + 1}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const idx of indices) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of flat[idx].mcids) {
          const b = perMcid.get(m);
          if (!b) continue;
          minX = Math.min(minX, b.minX);
          maxX = Math.max(maxX, b.maxX);
          minY = Math.min(minY, b.minY);
          maxY = Math.max(maxY, b.maxY);
        }
        if (minX !== Infinity) bboxByBlockIndex.set(idx, { minX, minY, maxX, maxY });
      }
    }

    const issues: AuditIssue[] = [];
    for (let i = 0; i < flat.length - 1; i++) {
      const a = flat[i];
      const b = flat[i + 1];
      if (a.pageIdx !== b.pageIdx) continue; // only a same-page sequence is this checkpoint's target shape

      const boxA = bboxByBlockIndex.get(i);
      const boxB = bboxByBlockIndex.get(i + 1);
      if (!boxA || !boxB) continue;

      const overlapX = Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX);
      const minWidth = Math.min(boxA.maxX - boxA.minX, boxB.maxX - boxB.minX);
      const xOverlapFraction = minWidth > 0 ? overlapX / minWidth : 0;

      // Bottom-left (PDF user-space) origin: a LARGER y is higher up the
      // page. "b entirely above a" means b's own bottom edge (minY) clears
      // a's own top edge (maxY) by more than the gap tolerance.
      const verticalGap = boxB.minY - boxA.maxY;

      if (xOverlapFraction > MIN_X_OVERLAP_FRACTION && verticalGap > MIN_VERTICAL_GAP_PT) {
        issues.push(
          this.buildIssue(a, b, boxA, boxB, pages[a.pageIdx].getWidth(), pages[a.pageIdx].getHeight(), a.pageIdx + 1, doc),
        );
      }
    }

    logger.info(
      `[PdfReadingOrderValidator] ${flat.length} block(s) across ${byPage.size} page(s) analyzed, ${issues.length} candidate reading-order violation(s) flagged`
    );

    return {
      issues,
      metadata: { pagesAnalyzed: byPage.size, blocksAnalyzed: flat.length, flagged: issues.length },
    };
  }

  private buildIssue(
    a: FlatBlock,
    b: FlatBlock,
    boxA: DeviceBoundingBox,
    boxB: DeviceBoundingBox,
    pageWidth: number,
    pageHeight: number,
    pageNumber: number,
    doc: PDFDocument,
  ): AuditIssue {
    // Top-down (y grows downward) for human-readable "distance from top of
    // page" phrasing and for AuditIssue.boundingBox's own documented
    // convention.
    const aTop = pageHeight - boxA.maxY;
    const aBottom = pageHeight - boxA.minY;
    const bTop = pageHeight - boxB.maxY;
    const bBottom = pageHeight - boxB.minY;

    const firstMcidOfB = Math.min(...b.mcids);
    let content: string | null = null;
    try {
      content = decodePageContent(doc, pageNumber);
    } catch {
      content = null;
    }
    const textSample = content ? this.bestEffortTextSample(content, firstMcidOfB) : '';

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
        x: boxB.minX,
        y: bTop,
        width: boxB.maxX - boxB.minX,
        height: boxB.maxY - boxB.minY,
        pageWidth,
        pageHeight,
      },
    };
  }

  /**
   * Best-effort literal-string extraction for a human-readable message
   * snippet only -- NOT used for the actual order comparison. Reuses
   * pdf-content-stream-io.ts's own already-tested findBdcTagSpanForMcid to
   * locate the MCID's own BDC, then greps literal `(...)` strings out of a
   * fixed window right after it. Doesn't handle octal escapes or nested
   * unbalanced parens perfectly -- fine for a display-only sample, never
   * relied on for correctness.
   */
  private bestEffortTextSample(content: string, mcid: number): string {
    const span = findBdcTagSpanForMcid(content, mcid);
    if (!span) return '';
    const window = content.slice(span.end, span.end + 400);
    const matches = window.match(/\(((?:\\.|[^()\\])*)\)/g) ?? [];
    const text = matches
      .map((m) => m.slice(1, -1).replace(/\\(.)/g, '$1'))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 80);
  }

  /** Same pattern as pdf-structure-writer.service.ts's own buildRoleMap -- duplicated per this project's established preference for isolated per-feature structure-tree helpers over cross-module coupling (see pdf-rolemap-integrity.validator.ts's own identical comment). */
  private buildRoleMap(doc: PDFDocument, structTreeRoot: PDFDict): Map<string, string> {
    const roleMap = new Map<string, string>();
    const rmRaw = structTreeRoot.get(PDFName.of('RoleMap'));
    const rm = rmRaw instanceof PDFRef ? doc.context.lookup(rmRaw) : rmRaw;
    if (!(rm instanceof PDFDict)) return roleMap;

    for (const [key, value] of rm.entries()) {
      const customTag = key.toString().replace(/^\//, '');
      const stdTag = value instanceof PDFName ? value.toString().replace(/^\//, '') : null;
      if (stdTag) roleMap.set(customTag, stdTag);
    }
    return roleMap;
  }

  private resolveRoleMapChain(roleMap: Map<string, string>, rawType: string): string {
    const visited = new Set<string>();
    let current = rawType;
    while (roleMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = roleMap.get(current)!;
    }
    return current;
  }

  /**
   * Walks a /K value (a bare ref, an array, or a leaf) in document order,
   * classifying each real StructElem by its own (RoleMap-resolved) /S:
   *   - ZONE_TAGS: package its whole subtree as one flattened block (all
   *     descendant MCIDs, grouped by the page they actually resolve to --
   *     see collectMcidsForPage), then stop recursing.
   *   - CONTAINER_TAGS, or any unrecognized tag (never silently dropped,
   *     same "default to visible" convention tagged-pdf-extractor.ts's own
   *     mapStructTag uses): recurse into children, preserving order.
   *   - SKIPPED_TAGS: neither flattened nor recursed into.
   * /Pg is inherited down the tree per PDF32000-1:2008 SS14.7.4.3 until a
   * descendant declares its own.
   */
  private flattenBlocks(
    doc: PDFDocument,
    node: unknown,
    roleMap: Map<string, string>,
    inheritedPageRef: PDFRef | null,
    pageIndexByRef: Map<string, number>,
    out: FlatBlock[],
    depth: number,
  ): void {
    if (depth > 200) return; // defensive -- malformed/cyclic trees shouldn't hang this
    const resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;

    if (resolved instanceof PDFArray) {
      for (const item of resolved.asArray()) {
        this.flattenBlocks(doc, item, roleMap, inheritedPageRef, pageIndexByRef, out, depth + 1);
      }
      return;
    }
    if (!(resolved instanceof PDFDict)) return;

    const typeName = resolved.get(PDFName.of('Type'))?.toString();
    if (typeName === '/MCR' || typeName === '/OBJR') return; // a content/object reference, not a StructElem

    const pgRaw = resolved.get(PDFName.of('Pg'));
    const ownPageRef = pgRaw instanceof PDFRef ? pgRaw : inheritedPageRef;
    const kRaw = resolved.get(PDFName.of('K'));

    const sRaw = resolved.get(PDFName.of('S'));
    if (sRaw === undefined) {
      // No /S of its own (e.g. a malformed node) -- stay transparent.
      if (kRaw !== undefined) this.flattenBlocks(doc, kRaw, roleMap, ownPageRef, pageIndexByRef, out, depth + 1);
      return;
    }

    const rawTag = sRaw.toString().replace(/^\//, '');
    const resolvedTag = this.resolveRoleMapChain(roleMap, rawTag);

    if (SKIPPED_TAGS.has(resolvedTag)) return;

    if (!ZONE_TAGS.has(resolvedTag) || CONTAINER_TAGS.has(resolvedTag)) {
      // CONTAINER_TAGS, or a tag that's neither a known zone nor container
      // (e.g. a custom RoleMap target that didn't resolve to anything this
      // file recognizes) -- recurse, never silently drop real content.
      if (kRaw !== undefined) this.flattenBlocks(doc, kRaw, roleMap, ownPageRef, pageIndexByRef, out, depth + 1);
      return;
    }

    const collected: CollectedMcid[] = [];
    if (kRaw !== undefined) this.collectMcidsForPage(doc, kRaw, ownPageRef, pageIndexByRef, collected, new Set(), 0);
    if (collected.length === 0) return; // an empty zone has no geometry to compare

    // All of a single block's content is expected on one page -- use the
    // FIRST page found (document order) as this block's page, and keep
    // only the MCIDs that actually resolve to it. A block that genuinely
    // spans a page break is a rare edge case this best-effort heuristic
    // doesn't need to handle precisely: the comparison below only ever
    // fires between two blocks already confirmed to share a page.
    const primaryPageIdx = collected[0].pageIdx;
    const mcids = new Set(collected.filter((c) => c.pageIdx === primaryPageIdx).map((c) => c.mcid));
    out.push({ pageIdx: primaryPageIdx, role: resolvedTag, mcids });
  }

  /**
   * Collects every MCID reachable under a zone's own /K, tagged with the
   * page it resolves to (honoring /Pg inheritance -- see flattenBlocks's
   * own doc comment). Handles a bare MCID integer, an array of either, a
   * nested StructElem (recurses into ITS /K, inheriting the current page),
   * and an /MCR marked-content-reference dict (used for content inside a
   * Form XObject) -- an /OBJR (annotation reference) carries no content
   * geometry and is skipped.
   */
  private collectMcidsForPage(
    doc: PDFDocument,
    node: unknown,
    inheritedPageRef: PDFRef | null,
    pageIndexByRef: Map<string, number>,
    out: CollectedMcid[],
    visited: Set<string>,
    depth: number,
  ): void {
    if (depth > 200) return;
    if (node instanceof PDFRef) {
      const key = node.toString();
      if (visited.has(key)) return;
      visited.add(key);
    }
    const resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;

    if (resolved instanceof PDFArray) {
      for (const item of resolved.asArray()) {
        this.collectMcidsForPage(doc, item, inheritedPageRef, pageIndexByRef, out, visited, depth + 1);
      }
      return;
    }
    if (resolved instanceof PDFNumber) {
      if (inheritedPageRef) {
        const pageIdx = pageIndexByRef.get(inheritedPageRef.toString());
        if (pageIdx !== undefined) out.push({ pageIdx, mcid: resolved.asNumber() });
      }
      return;
    }
    if (!(resolved instanceof PDFDict)) return;

    const typeName = resolved.get(PDFName.of('Type'))?.toString();
    const pgRaw = resolved.get(PDFName.of('Pg'));
    const ownPageRef = pgRaw instanceof PDFRef ? pgRaw : inheritedPageRef;

    if (typeName === '/MCR') {
      const mcidRaw = resolved.get(PDFName.of('MCID'));
      if (mcidRaw instanceof PDFNumber && ownPageRef) {
        const pageIdx = pageIndexByRef.get(ownPageRef.toString());
        if (pageIdx !== undefined) out.push({ pageIdx, mcid: mcidRaw.asNumber() });
      }
      return;
    }
    if (typeName === '/OBJR') return;

    const kRaw = resolved.get(PDFName.of('K'));
    if (kRaw !== undefined) this.collectMcidsForPage(doc, kRaw, ownPageRef, pageIndexByRef, out, visited, depth + 1);
  }
}

export const pdfReadingOrderValidator = new PdfReadingOrderValidator();
