/**
 * PDF Structure Writer Service
 *
 * Provides MCID-safe mutations of a PDF structure tree using pdf-lib's low-level
 * context API. All public methods operate on an in-memory PDFDocument; the caller
 * is responsible for saving the modified document to a buffer.
 *
 * MCID safety guarantees:
 *   - renameElement: changes only /S — existing MCID bindings unaffected
 *   - rewrapListItems: creates a new L container; LI children (with MCIDs) are reparented
 *   - fixSimpleTableHeaders: renames TD → TH; MCID bindings on cell content unaffected
 *   - generateBookmarksFromHeadings: adds a new /Outlines entry; no MCID interaction
 *
 * PAC 2024 validation checkpoint:
 *   After implementing createElement / renameElement / reparentElement, validate
 *   a test PDF in PAC 2024 before shipping composite operations (Steps 6 & 7).
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFNumber,
  PDFNull,
  PDFObject,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';
import { AuditIssue } from '../audit/base-audit.service';
import { logger } from '../../lib/logger';
import { pdfModifierService } from './pdf-modifier.service';
import { pageContentMcids, orderedPageContentMcids, findBdcTagSpanForMcid, decodePageContent, writePageContent } from './pdf-content-stream-io';
import { locateMcidBoundingBoxes, locateByteRangeBoundingBox, type DeviceBoundingBox } from './mcid-bounding-box';
import { findMcidPageMismatches } from './mcid-page-mismatch';
import { buildFormXObjectResolver } from './validators/pdf-figure-structtree.validator';
import {
  tagUntaggedPaintedPaths,
  splitArtifactAroundTaggedContent,
  findOversizedArtifactSpans,
  extractArtifactTextRuns,
  applyArtifactUnwrap,
  findRealTextSegmentsInSpan,
  buildArtifactSplitEdits,
  findPlacedPdfSpans,
  buildPlacedPdfRetagEdit,
  findArtifactWrappedActualTextSiblings,
  findActualTextRunsMissingMcid,
} from './pdf-artifact-tagger';
import {
  matchCellRanges,
  insertMarkedContentSpans,
  type RangeInsertionRequest,
  type InsertedSpan,
  type CellCoverageResult,
} from './table-content-tagger';
import type { TableCell, TableInfo } from './structure-analyzer.service';
import { locateXObjectInvocation, findNearestMcidForPosition } from './figure-content-tagger';
import { locateTextRun, locateEnclosingTextObject, computeCtmAt, findPrecedingColor, type TextRunMatch } from './contrast-content-stream';
import { MIN_APPLY_CONFIDENCE, resolveSourceColor } from './pdf-contrast-writer.service';
import { verifyStillNoDetectableInk } from './color-contrast-verification';
import { tokenize } from '../zone-extractor/seam-c/content-stream';
import { baseEncodingTable } from './font-encodings';
import type { ParsedPDF } from './pdf-parser.service';
import { classifyDegenerateRoleMapEntry } from './validators/pdf-rolemap-integrity.validator';
import {
  findUrlOperatorRun,
  buildLinkCompletenessSplice,
  findUrlSubstringRun,
  buildUrlSubstringSplice,
  type GlyphTextResolver,
  type LinkCompletenessSplice,
  type UrlSubstringSplice,
} from './pdf-link-completeness-writer';

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface FixResult {
  issueId: string;
  success: boolean;
  before: string;
  after: string;
  error?: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class PdfStructureWriterService {

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — Foundation: Structure Tree Access
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Retrieve the /StructTreeRoot PDFDict from the document catalog.
   * Returns null if the document has no structure tree.
   */
  private getStructTreeRoot(doc: PDFDocument): PDFDict | null {
    try {
      const catalog = doc.context.lookup(doc.context.trailerInfo.Root);
      if (!(catalog instanceof PDFDict)) return null;
      const rawRef = catalog.get(PDFName.of('StructTreeRoot'));
      if (!rawRef) return null;
      const obj = doc.context.lookup(rawRef);
      return obj instanceof PDFDict ? obj : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads /StructTreeRoot's own /RoleMap, if any: a dict of custom tag name
   * -> standard tag name (PDF32000-1:2008 §14.7.4.3). Confirmed live on a
   * real Math_Weir_PDF.pdf incident: its headings are tagged with the
   * publisher's own custom role names (/a, /b, /c, /cn, /ct, /cptitle,
   * /fmbmct -- 290 elements total), mapped to /H1-/H4 via a RoleMap --
   * fixHeadingHierarchy/fixMultipleH1 matched raw /S values only and so saw
   * zero headings, honestly bailing on a document that actually has real,
   * correctly-tagged heading structure under non-standard names. Custom
   * RoleMaps are a routine InDesign/publisher-production pattern, not a
   * one-document quirk, so this generalizes.
   *
   * Small and duplicated locally rather than imported from
   * structure-tree-completeness.ts's own buildRoleMap (which resolves this
   * same RoleMap for a read-only completeness check, not a mutation) --
   * that module's own header already establishes the project's preference
   * for keeping structure-tree-walking helpers isolated per-feature over
   * cross-module coupling.
   */
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

  /**
   * Follows a /RoleMap mapping to its end, not just one hop -- PDF32000-1:2008
   * §14.7.4.3 permits a custom role to map to ANOTHER custom role rather than
   * a standard type directly (customA -> customB -> H2), and a reader is
   * expected to keep following the chain. A single roleMap.get() lookup (this
   * function's own first version, caught by CodeRabbit review) only resolves
   * one hop, silently failing to recognize a transitively-mapped heading.
   * Tracks visited names to terminate a malformed cyclic mapping (customA ->
   * customB -> customA) rather than looping forever -- returns wherever the
   * cycle was first re-entered rather than crashing or hanging.
   */
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
   * Pre-order depth-first traversal of the structure tree — i.e. document
   * reading order: visit a node, then walk each of its children (and their
   * full subtrees) before moving on to the next sibling.
   *
   * Was breadth-first (level-by-level) until this was found to be a real bug:
   * every caller below either needs true reading order (fixHeadingHierarchy's
   * "skip a level" detection, generateBookmarksFromHeadings's bookmark
   * ordering, extractFirstH1Text's "first" H1) or is order-agnostic, so
   * nothing depends on the old level-order behavior. BFS interleaves
   * unrelated sections at the same tree depth — e.g. it would visit every
   * chapter's top-level heading across an entire multi-section document
   * before descending into any one chapter's own nested sub-headings —
   * which silently desyncs a "previous heading level" walk like
   * fixHeadingHierarchy's from the structurally-correct sequence the
   * validator that raised the original issue uses to detect it, so a
   * "successful" rename can land on the wrong element relative to reading
   * order and never actually resolve the flagged issue.
   *
   * Calls visitor(node, ref) for every PDFDict encountered.
   * If visitor returns true, traversal stops immediately.
   *
   * Uses an explicit stack rather than recursion: a deeply-nested structure
   * tree (long chains of indirect Sect/Div elements are common in
   * real-world tagged PDFs) could otherwise exhaust the call stack.
   */
  private traverseStructTree(
    doc: PDFDocument,
    root: PDFDict,
    visitor: (node: PDFDict, ref: PDFRef | null) => boolean | void,
  ): void {
    type Entry = { dict: PDFDict; ref: PDFRef | null };
    const stack: Entry[] = [{ dict: root, ref: null }];

    while (stack.length > 0) {
      const { dict: node, ref } = stack.pop()!;
      if (visitor(node, ref) === true) return;

      const kids = node.get(PDFName.of('K'));
      const resolved: Entry[] = [];
      const resolveChild = (raw: PDFObject): void => {
        const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
        if (obj instanceof PDFDict) {
          resolved.push({ dict: obj, ref: raw instanceof PDFRef ? raw : null });
        }
      };
      if (kids instanceof PDFArray) {
        for (const kid of kids.asArray()) {
          resolveChild(kid);
        }
      } else if (kids instanceof PDFRef || kids instanceof PDFDict) {
        resolveChild(kids as PDFObject);
      }
      // Push in reverse so the first child is popped (and visited) first,
      // preserving pre-order (document reading) order.
      for (let i = resolved.length - 1; i >= 0; i--) {
        stack.push(resolved[i]);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — Foundation: K-Array Helpers
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * True if `k` (a struct element's own /K value) legitimately contains
   * targetRef as a child -- either as a member of an array, or as the
   * sole SCALAR child itself (a single-child struct element legitimately
   * has a bare /K per spec, not wrapped in an array). Shared by
   * insertIntoKidsAfter/insertIntoKidsBefore's own "is this shape even
   * insertable" gate and buildFigureFromImage's own preflight, which must
   * agree exactly with what those two methods will actually accept --
   * previously buildFigureFromImage's preflight required /K to ALREADY be
   * an array, strictly more restrictive than necessary once those two
   * methods learned to promote a matching scalar (see their own doc
   * comments for the real, confirmed-live gap this closes: 6 of
   * Karsaklian_189165_9781606497623's own 156 real actualtext-missing-
   * mcid-fix candidates permanently declined on exactly this shape).
   */
  private kContainsChild(k: PDFObject | undefined, targetRef: PDFRef): boolean {
    if (k instanceof PDFArray) {
      return k.asArray().some(item => item instanceof PDFRef && item.objectNumber === targetRef.objectNumber);
    }
    return k instanceof PDFRef && k.objectNumber === targetRef.objectNumber;
  }

  /** Append childRef to the /K array of the element at parentRef. */
  private appendToKids(doc: PDFDocument, parentRef: PDFRef, childRef: PDFRef): void {
    const parent = doc.context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) return;

    const k = parent.get(PDFName.of('K'));
    if (k instanceof PDFArray) {
      k.push(childRef);
    } else if (k instanceof PDFRef || k instanceof PDFDict || k instanceof PDFNumber) {
      // Existing single child — promote to array
      parent.set(PDFName.of('K'), doc.context.obj([k as PDFObject, childRef]));
    } else {
      parent.set(PDFName.of('K'), doc.context.obj([childRef]));
    }
  }

  /**
   * Insert newRef into parentRef's /K array immediately after afterRef.
   * Unlike appendToKids (which always appends at the very end), this
   * preserves reading-order proximity to a specific existing sibling --
   * needed when a document's whole body sits under one flat root container
   * rather than nested per-page/per-section containers (Slice 2d finding,
   * confirmed live: Math_Kim's /Document node has 2000+ direct children
   * spanning the entire book; appendToKids there would place new content
   * at the very end of the WHOLE DOCUMENT's reading order regardless of
   * which page it's actually on). Throws rather than guessing when afterRef
   * isn't found in parentRef's /K at all -- matches this file's established
   * "bail rather than guess" convention.
   *
   * A SCALAR /K equal to afterRef (a single-child struct element,
   * legitimate per spec, not wrapped in an array) is promoted to a real
   * array with newRef appended -- exactly as safe as appendToKids already
   * does for its own "no array yet" case, since afterRef is, by
   * construction, this parent's one and only child. Previously declined
   * outright; real, confirmed-live gap (6 of Karsaklian_189165_9781606497623's
   * own 156 real actualtext-missing-mcid-fix candidates, all this exact
   * shape) -- see kContainsChild's own doc comment.
   */
  private insertIntoKidsAfter(doc: PDFDocument, parentRef: PDFRef, afterRef: PDFRef, newRef: PDFRef): void {
    const parent = doc.context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) {
      throw new Error('insertIntoKidsAfter: parent does not resolve to a dictionary');
    }
    const k = parent.get(PDFName.of('K'));
    if (k instanceof PDFRef && k.objectNumber === afterRef.objectNumber) {
      parent.set(PDFName.of('K'), doc.context.obj([afterRef, newRef]));
      return;
    }
    if (!(k instanceof PDFArray)) {
      throw new Error('insertIntoKidsAfter: parent /K is not an array -- cannot position relative to a sibling');
    }
    const arr = k.asArray();
    const idx = arr.findIndex(item => item instanceof PDFRef && item.objectNumber === afterRef.objectNumber);
    if (idx === -1) {
      throw new Error('insertIntoKidsAfter: afterRef not found in parent /K array');
    }
    k.insert(idx + 1, newRef);
  }

  /**
   * Same as insertIntoKidsAfter, anchored on the sibling AFTER which
   * `newRef` should NOT go -- i.e. splices immediately BEFORE `beforeRef`'s
   * own position. Needed (not just insertIntoKidsAfter with a different
   * anchor) when the orphan's confirmed LEFT neighbor isn't its true
   * adjacent sibling in `parentRef`'s own /K array -- e.g. an /Artifact
   * with no own MCID can sit between a real left MCID-neighbor and the
   * gap, so anchoring on the left neighbor alone would insert one slot
   * too early. Anchoring on a confirmed RIGHT neighbor's own position is
   * correct regardless of what sits between it and the left neighbor.
   *
   * Same scalar-/K promotion as insertIntoKidsAfter -- see that method's
   * own doc comment.
   */
  private insertIntoKidsBefore(doc: PDFDocument, parentRef: PDFRef, beforeRef: PDFRef, newRef: PDFRef): void {
    const parent = doc.context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) {
      throw new Error('insertIntoKidsBefore: parent does not resolve to a dictionary');
    }
    const k = parent.get(PDFName.of('K'));
    if (k instanceof PDFRef && k.objectNumber === beforeRef.objectNumber) {
      parent.set(PDFName.of('K'), doc.context.obj([newRef, beforeRef]));
      return;
    }
    if (!(k instanceof PDFArray)) {
      throw new Error('insertIntoKidsBefore: parent /K is not an array -- cannot position relative to a sibling');
    }
    const arr = k.asArray();
    const idx = arr.findIndex(item => item instanceof PDFRef && item.objectNumber === beforeRef.objectNumber);
    if (idx === -1) {
      throw new Error('insertIntoKidsBefore: beforeRef not found in parent /K array');
    }
    k.insert(idx, newRef);
  }

  /** Remove targetRef from the /K array of the element at parentRef. */
  private removeFromKids(doc: PDFDocument, parentRef: PDFRef, targetRef: PDFRef): void {
    const parent = doc.context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) return;

    const k = parent.get(PDFName.of('K'));
    if (!(k instanceof PDFArray)) return;

    const filtered = k.asArray().filter(item => {
      if (item instanceof PDFRef) {
        return item.objectNumber !== targetRef.objectNumber;
      }
      return true;
    });
    parent.set(PDFName.of('K'), doc.context.obj(filtered));
  }

  /** Find the first direct child of parent with the given tag type. */
  private findFirstChild(
    doc: PDFDocument,
    parent: PDFDict,
    tagType: string,
  ): { dict: PDFDict; ref: PDFRef } | null {
    const k = parent.get(PDFName.of('K'));
    const check = (raw: PDFObject): { dict: PDFDict; ref: PDFRef } | null => {
      if (!(raw instanceof PDFRef)) return null;
      const obj = doc.context.lookup(raw);
      if (!(obj instanceof PDFDict)) return null;
      const s = obj.get(PDFName.of('S'));
      if (s && s.toString().replace(/^\//, '') === tagType) return { dict: obj, ref: raw };
      return null;
    };
    if (k instanceof PDFArray) {
      for (const item of k.asArray()) {
        const found = check(item);
        if (found) return found;
      }
    } else if (k) {
      return check(k as PDFObject);
    }
    return null;
  }

  /**
   * The direct child at K-array position 0, regardless of its tag type --
   * unlike findFirstChild(parent, tagType), which searches by TYPE and can
   * return a LATER child (e.g. the second cell in a [TH, TD] row) if it
   * happens to be the first one matching that type. Needed wherever
   * POSITION itself is the signal (e.g. fixSimpleTableColumnHeaders: "is
   * THIS row's first cell a TD that needs promoting"), not "does a TD
   * exist somewhere in this row".
   */
  private firstKidOfAnyType(
    doc: PDFDocument,
    parent: PDFDict,
  ): { dict: PDFDict; ref: PDFRef } | null {
    const k = parent.get(PDFName.of('K'));
    const first = k instanceof PDFArray ? k.get(0) : k;
    if (!(first instanceof PDFRef)) return null;
    const obj = doc.context.lookup(first);
    return obj instanceof PDFDict ? { dict: obj, ref: first } : null;
  }

  /**
   * The most common value in a list of numbers, or null if the highest
   * frequency is tied between two or more distinct values -- CodeRabbit
   * finding on PR #560, confirmed real: the first version of this picked
   * the first-seen value on a tie (e.g. [1,1,3,3] -> 1), which for a table
   * with an equal number of caption-shaped and header-shaped rows could
   * pick the WRONG one with no real basis to prefer either. A genuine
   * tie means this proxy has no real answer -- callers must fail rather
   * than guess, same "bail rather than guess" discipline as everywhere
   * else in this class.
   *
   * Used by fixSimpleTableHeaders as a self-contained, struct-tree-only
   * proxy for "how many columns does this table actually have" -- most
   * rows in a real table are genuine data rows sharing the same real cell
   * count, so their mode is a robust stand-in for columnCount without
   * needing any layout/pdfjs data at apply time.
   */
  private modeOf(values: number[]): number | null {
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestCount = 0;
    let tied = false;
    for (const v of values) {
      const c = (counts.get(v) ?? 0) + 1;
      counts.set(v, c);
      if (c > bestCount) {
        bestCount = c;
        best = v;
        tied = false;
      } else if (c === bestCount && v !== best) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  /**
   * Every real TR under a table, in true document order -- a single
   * traversal of the table's own `/K` array, recursing into THead/TBody/
   * TFoot children exactly where they appear rather than grouping all rows
   * of one wrapper type before another. CodeRabbit finding on PR #560,
   * confirmed real: the first version concatenated
   * `[...direct TRs, ...all TBody rows, ...all THead rows, ...all TFoot
   * rows]` -- for the common `Table -> [THead, TBody]` shape this put every
   * body row BEFORE the real header rows in the search order, so
   * fixSimpleTableHeaders' mode-based row-skip could promote a body row
   * instead of the genuine header sitting inside THead.
   */
  private collectAllRows(doc: PDFDocument, table: PDFDict): Array<{ dict: PDFDict; ref: PDFRef }> {
    const rows: Array<{ dict: PDFDict; ref: PDFRef }> = [];
    const k = table.get(PDFName.of('K'));
    const children = k instanceof PDFArray ? k.asArray() : k ? [k as PDFObject] : [];
    for (const child of children) {
      if (!(child instanceof PDFRef)) continue;
      const resolved = doc.context.lookup(child);
      if (!(resolved instanceof PDFDict)) continue;
      const tag = resolved.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (tag === 'TR') {
        rows.push({ dict: resolved, ref: child });
      } else if (tag === 'THead' || tag === 'TBody' || tag === 'TFoot') {
        rows.push(...this.findAllChildren(doc, resolved, 'TR'));
      }
    }
    return rows;
  }

  /**
   * Read-only core of fixSimpleTableHeaders' own row-finding logic: does
   * one of the first `maxLeadingRowsToSkip` TR rows match this table's
   * modal (most common non-zero) cell count? Extracted so both the writer
   * (mutation) and canFixSimpleTableHeaders (suggestion-time eligibility
   * probe, read-only) ask the SAME question against the SAME struct-tree
   * data, instead of two independently-maintained copies that can drift.
   * The discriminated failure `reason` lets fixSimpleTableHeaders keep
   * reporting its own specific, pre-existing error messages for each
   * distinct "refuse rather than guess" case, rather than collapsing them
   * into one generic message. Never throws.
   */
  private detectTableHeaderRow(
    doc: PDFDocument,
    table: PDFDict,
    maxLeadingRowsToSkip = 4,
  ):
    | { ok: true; headerRowIndex: number; rows: Array<{ dict: PDFDict; ref: PDFRef }>; cellCount: number }
    | { ok: false; reason: 'no-rows' | 'tie' | 'no-regular-row'; rows: Array<{ dict: PDFDict; ref: PDFRef }>; mode: number | null } {
    const rows = this.collectAllRows(doc, table);
    if (rows.length === 0) return { ok: false, reason: 'no-rows', rows, mode: null };

    const cellCounts = rows.map(row =>
      this.findAllChildren(doc, row.dict, 'TD').length + this.findAllChildren(doc, row.dict, 'TH').length
    );
    const mode = this.modeOf(cellCounts.filter(c => c > 0));
    if (mode === null) return { ok: false, reason: 'tie', rows, mode: null };

    for (let i = 0; i < Math.min(rows.length, maxLeadingRowsToSkip); i++) {
      if (cellCounts[i] === mode) return { ok: true, headerRowIndex: i, rows, cellCount: mode };
    }
    return { ok: false, reason: 'no-regular-row', rows, mode };
  }

  /**
   * Suggestion-time eligibility probe, mirroring fixSimpleTableHeaders'
   * apply-time logic exactly (same detectTableHeaderRow call) instead of
   * ai-analysis.service.ts's own findRegularHeaderRowIndex, which judges
   * eligibility from TableInfo's pdfjs/layout-derived cell counts -- a
   * DIFFERENT data source than the real struct tree this writer actually
   * mutates, and one that can disagree with it (this codebase's own
   * pre-existing, documented architectural gap, issue #561).
   *
   * Real incident, Math_Nikitopoulos_PDF.pdf (2026-09-25): 2 of 3 real
   * MATTERHORN-15-002 tables (12x5 and 53x3) were routed to AI-guidance-only
   * because findRegularHeaderRowIndex said "not eligible", even though this
   * exact struct-tree check finds a clean, regular header row and the
   * writer, when called directly, successfully fixes both -- confirmed via
   * a genuine re-audit round trip. Callers should treat EITHER signal
   * (the cheap layout-based check OR this one) as sufficient, since this
   * probe requires loading the real doc and locating the target table
   * (findTargetTable's own page/element-id matching), work the cheap check
   * skips entirely when it already agrees.
   *
   * `maxColumns` enforces the SAME simple-table size boundary the caller
   * already applies against TableInfo.columnCount, but re-checked against
   * the struct tree's OWN detected row cell count -- CodeRabbit finding on
   * this same PR, confirmed real: layout extraction undercounting a wide
   * table (e.g. TableInfo says 5 columns when the struct tree's real modal
   * row has 8) would otherwise let this probe wrongly approve a table
   * above the intended complexity ceiling, since detectTableHeaderRow alone
   * only asks "is there a regular row", never "how wide is it".
   *
   * Never mutates the document. Returns false for anything
   * fixSimpleTableHeaders would itself refuse to guess on (no structure
   * tree, no matching table, no regular row shape, a genuine tie) --
   * exactly the same refusals, since it calls the identical detection core.
   */
  canFixSimpleTableHeaders(doc: PDFDocument, elementId: string | undefined, maxColumns: number): boolean {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return false;
    const target = this.findTargetTable(doc, structRoot, elementId);
    if (!target) return false;
    const detection = this.detectTableHeaderRow(doc, target.dict);
    return detection.ok && detection.cellCount <= maxColumns;
  }

  /** Find all direct children of parent with the given tag type. */
  private findAllChildren(
    doc: PDFDocument,
    parent: PDFDict,
    tagType: string,
  ): Array<{ dict: PDFDict; ref: PDFRef }> {
    const results: Array<{ dict: PDFDict; ref: PDFRef }> = [];
    const k = parent.get(PDFName.of('K'));
    const collect = (raw: PDFObject) => {
      if (!(raw instanceof PDFRef)) return;
      const obj = doc.context.lookup(raw);
      if (!(obj instanceof PDFDict)) return;
      const s = obj.get(PDFName.of('S'));
      if (s && s.toString().replace(/^\//, '') === tagType) results.push({ dict: obj, ref: raw });
    };
    if (k instanceof PDFArray) {
      k.asArray().forEach(collect);
    } else if (k) {
      collect(k as PDFObject);
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — Foundation: Public Mutation Operations
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new structure element and append it to the parent's K array.
   * Returns a PDFRef to the newly created element.
   */
  createElement(
    doc: PDFDocument,
    tagType: string,
    parentRef: PDFRef,
    pageRef?: PDFRef,
  ): PDFRef {
    const entries: Record<string, PDFObject> = {
      Type: PDFName.of('StructElem'),
      S: PDFName.of(tagType),
      P: parentRef,
    };
    if (pageRef) entries['Pg'] = pageRef;

    const elemObj = doc.context.obj(entries);
    const elemRef = doc.context.register(elemObj as PDFDict);
    this.appendToKids(doc, parentRef, elemRef);
    return elemRef;
  }

  /**
   * Change the /S (tag type) of an existing element.
   * MCID bindings on children are untouched — safe for heading / table header fixes.
   */
  renameElement(doc: PDFDocument, elementRef: PDFRef, newTagType: string): void {
    const elem = doc.context.lookup(elementRef);
    if (elem instanceof PDFDict) {
      elem.set(PDFName.of('S'), PDFName.of(newTagType));
    }
  }

  /**
   * Move element from its current parent to newParent.
   * Updates /P on the element and fixes both K arrays.
   */
  reparentElement(doc: PDFDocument, elementRef: PDFRef, newParentRef: PDFRef): void {
    const elem = doc.context.lookup(elementRef);
    if (!(elem instanceof PDFDict)) return;

    const oldParentRaw = elem.get(PDFName.of('P'));
    if (oldParentRaw instanceof PDFRef) {
      this.removeFromKids(doc, oldParentRaw, elementRef);
    }
    elem.set(PDFName.of('P'), newParentRef);
    this.appendToKids(doc, newParentRef, elementRef);
  }

  /**
   * Detach an element from its parent and clear its K array.
   * Descendants remain in the PDF context but are unreachable.
   */
  deleteElement(doc: PDFDocument, elementRef: PDFRef): void {
    const elem = doc.context.lookup(elementRef);
    if (!(elem instanceof PDFDict)) return;

    const parentRaw = elem.get(PDFName.of('P'));
    if (parentRaw instanceof PDFRef) {
      this.removeFromKids(doc, parentRaw, elementRef);
    }
    elem.delete(PDFName.of('K'));
    elem.delete(PDFName.of('P'));
  }

  /**
   * Clears each DIRECT child's own /P before a caller drops its /K array
   * (e.g. retagging a decorative Table to /Artifact, where any former
   * TR/TD children no longer make sense under the new role). Without this,
   * a child's /P keeps pointing at an object that still exists but is no
   * longer a structure element at all -- not a dangling reference in the
   * sense STRUCTURE-DANGLING-REFERENCE checks for (the ref still resolves),
   * but the same orphaning shape identified during this incident's own
   * broader code survey, and a real inconsistency a careful conformance
   * checker could reasonably still flag. Only goes one level deep -- a
   * grandchild (e.g. a TD under a TR) is left alone, since its own /P
   * still correctly points at the still-existing TR, which is now simply
   * unreachable from the root rather than invalid (the same accepted
   * "orphaned, not dangling" semantics deleteElement's own doc comment
   * already documents).
   */
  private detachDirectChildrenParentPointers(doc: PDFDocument, kRaw: PDFObject | undefined): void {
    if (kRaw === undefined) return;
    const context = doc.context;
    const resolved = kRaw instanceof PDFRef ? context.lookup(kRaw) : kRaw;
    const entries = resolved instanceof PDFArray
      ? Array.from({ length: resolved.size() }, (_, i) => resolved.get(i))
      : [kRaw];
    for (const entry of entries) {
      if (!(entry instanceof PDFRef)) continue; // bare MCID integers have no /P to clear
      const child = context.lookup(entry);
      if (child instanceof PDFDict) child.delete(PDFName.of('P'));
    }
  }

  /**
   * True if ANY descendant of `node` carries a real MCID (a bare integer,
   * an MCR dict's /MCID, or any entry inside a /K array holding either) --
   * i.e. genuine painted content exists somewhere under this subtree, not
   * just an empty structural shell. Used by markTableAsArtifact to verify
   * its own documented safety assumption (every confirmed-decorative target
   * has a /K-less TD) before trusting it -- see that method's own doc
   * comment for the real incident this guards against.
   */
  private tableSubtreeHasRealContent(doc: PDFDocument, node: PDFDict, seen = new Set<string>()): boolean {
    const kRaw = node.get(PDFName.of('K'));
    const k = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    if (k === undefined) return false;
    if (k instanceof PDFNumber) return true;
    const entries = k instanceof PDFArray ? Array.from({ length: k.size() }, (_, i) => k.get(i)) : [k];
    for (const entry of entries) {
      const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
      if (resolved instanceof PDFNumber) return true;
      if (resolved instanceof PDFDict) {
        if (resolved.get(PDFName.of('MCID')) !== undefined) return true;
        if (entry instanceof PDFRef) {
          const key = entry.toString();
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (this.tableSubtreeHasRealContent(doc, resolved, seen)) return true;
      }
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — Scope Attribute (Required for TH elements)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Write /Scope to the element's /A (attributes) array.
   *
   * The scope lives in a Table-owner attribute object:
   *   { /O: /Table, /Scope: /Column | /Row | /Both }
   *
   * Per Matterhorn Protocol 15-003: TH elements MUST have a /Scope attribute
   * (mismapped as "07-002" — the real 07-002 is an unrelated ViewerPreferences/
   * DisplayDocTitle condition — in this comment and three others in this file
   * until corrected alongside pdf-table-header-scope.validator.ts, which
   * closes the standalone detection gap for an already-tagged TH with no
   * /Scope at all).
   * PAC 2024 validates this independently of the TH tag rename.
   */
  writeScopeAttribute(
    doc: PDFDocument,
    elementRef: PDFRef,
    scope: 'Column' | 'Row' | 'Both',
  ): void {
    const elem = doc.context.lookup(elementRef);
    if (!(elem instanceof PDFDict)) return;

    const aRaw = elem.get(PDFName.of('A'));

    if (!aRaw) {
      // No /A yet — create a new Table attribute dict and wrap in array
      const attrRef = this.makeTableAttrDict(doc, scope);
      elem.set(PDFName.of('A'), doc.context.obj([attrRef]));
      return;
    }

    // /A exists — find or replace the Table-owner dict
    if (aRaw instanceof PDFArray) {
      let replaced = false;
      for (const item of aRaw.asArray()) {
        const obj = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (obj instanceof PDFDict && obj.get(PDFName.of('O'))?.toString() === '/Table') {
          obj.set(PDFName.of('Scope'), PDFName.of(scope));
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        aRaw.push(this.makeTableAttrDict(doc, scope));
      }
      return;
    }

    if (aRaw instanceof PDFRef) {
      const aObj = doc.context.lookup(aRaw);
      if (aObj instanceof PDFDict && aObj.get(PDFName.of('O'))?.toString() === '/Table') {
        aObj.set(PDFName.of('Scope'), PDFName.of(scope));
        return;
      }
      // Existing /A ref is a different owner — wrap with the Table attr
      elem.set(PDFName.of('A'), doc.context.obj([aRaw, this.makeTableAttrDict(doc, scope)]));
      return;
    }

    // Fallback: replace /A with a new array
    elem.set(PDFName.of('A'), doc.context.obj([this.makeTableAttrDict(doc, scope)]));
  }

  private makeTableAttrDict(doc: PDFDocument, scope: 'Column' | 'Row' | 'Both'): PDFRef {
    const dict = doc.context.obj({ O: PDFName.of('Table'), Scope: PDFName.of(scope) });
    return doc.context.register(dict as PDFDict);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — Composite: Heading Hierarchy Fix
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fix heading hierarchy by renaming H elements to eliminate skipped levels.
   * Algorithm: walk headings in document order; if Hn jumps more than one level
   * above the previous heading, rename it to (previous + 1).
   *
   * Recognizes a heading whether it's tagged with a literal /H1-/H9 or with a
   * custom role name the document's own /RoleMap maps to one (see
   * buildRoleMap's doc comment for the real incident this fixes) -- either
   * way, the actual RENAME always writes a literal /H<n> onto that one
   * element (renameElement), never touching the RoleMap or any other
   * same-role-tagged element, so this stays exactly as MCID-safe and
   * single-element-scoped as before.
   *
   * MCID-safe: only /S is modified, MCID bindings remain on child elements.
   *
   * @param issues - HEADING-SKIP AuditIssues (used for FixResult reporting only)
   */
  fixHeadingHierarchy(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const roleMap = this.buildRoleMap(doc, structRoot);

    // Collect all Hn elements in document (reading) order
    const headingRefs: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const rawType = sTag.toString().replace(/^\//, '');
      const resolvedType = this.resolveRoleMapChain(roleMap, rawType);
      const m = /^H([1-9])$/.exec(resolvedType);
      if (m) headingRefs.push({ ref, level: parseInt(m[1], 10) });
    });

    // A structure tree with zero Hn elements (literal or RoleMap-resolved)
    // means there is nothing this method can ever fix, no matter how many
    // HEADING-SKIP issues detection reports — detection uses a separate
    // text/font-size heuristic that scans visible content directly, entirely
    // independent of the tag tree (see structure-tree-completeness.ts's
    // isHeadingShell, which exists to catch and retag exactly this case
    // upstream). Bailing to failure here too, rather than reporting success,
    // is a deliberate second line of defense: it stays honest even if that
    // upstream check didn't run, was bypassed, or the tree became
    // heading-empty some other way. Reporting success on a 0-Hn tree
    // previously meant every one of these issues got silently marked
    // resolved every round on documents whose headings were simply never
    // tagged in the first place.
    if (headingRefs.length === 0) {
      logger.info('[StructureWriter] fixHeadingHierarchy: 0 heading(s) renamed (0 Hn elements found in structure tree)');
      return issues.map(i => ({
        issueId: i.id,
        success: false,
        before: 'Heading hierarchy with skipped levels',
        after: 'unknown',
        error: 'Structure tree has no heading (H1-H9) elements to fix — likely a sparse/incomplete tagging pass',
      }));
    }

    let currentLevel = 0;
    let fixCount = 0;
    for (const h of headingRefs) {
      if (h.level > currentLevel + 1) {
        const corrected = currentLevel + 1;
        logger.debug(`[StructureWriter] Renaming H${h.level} → H${corrected}`);
        this.renameElement(doc, h.ref, `H${corrected}`);
        currentLevel = corrected;
        fixCount++;
      } else {
        currentLevel = h.level;
      }
    }

    // fixCount can legitimately be 0 here even though headingRefs.length > 0
    // (this call's own document-wide pass found nothing left to fix) — every
    // caller invokes this with a single-issue array and no per-issue
    // correlation (see @param below), so a batch apply over many
    // HEADING-SKIP issues calls this once per issue; the first call resolves
    // every real skip in one pass, and every subsequent call in the same
    // batch correctly finds the tree already normalized. That is still a
    // genuine success (the hierarchy IS correct after this call), unlike the
    // headingRefs.length === 0 case above.
    logger.info(`[StructureWriter] fixHeadingHierarchy: ${fixCount} heading(s) renamed (${headingRefs.length} Hn elements in structure tree)`);
    return issues.map(i => ({
      issueId: i.id,
      success: true,
      before: 'Heading hierarchy with skipped levels',
      after: fixCount > 0
        ? `Fixed ${fixCount} heading level(s) by renaming`
        : 'No headings required renaming',
    }));
  }

  /**
   * Fix multiple H1s: keep the first H1, demote all subsequent H1 elements to H2,
   * and cascade the shift to all headings within each demoted section so that the
   * logical hierarchy is preserved (e.g. H2 under a demoted H1 becomes H3).
   *
   * Algorithm:
   *   1. Collect all Hn elements in document (reading) order.
   *   2. For each H1 after the first:
   *      a. Rename it to H2.
   *      b. For every heading between it and the next H1 (exclusive), increment
   *         the level by 1 (capped at H6).
   *   3. Run fixHeadingHierarchy() as a cleanup pass to close any remaining gaps.
   */
  fixMultipleH1(doc: PDFDocument, issue: AuditIssue): FixResult {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No structure tree root found' };
    }

    const roleMap = this.buildRoleMap(doc, structRoot);

    // Collect all heading elements in document (reading) order -- resolves
    // custom role-mapped heading tags too, see buildRoleMap's doc comment.
    const allHeadings: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const rawType = sTag.toString().replace(/^\//, '');
      const resolvedType = this.resolveRoleMapChain(roleMap, rawType);
      const m = /^H([1-9])$/.exec(resolvedType);
      if (m) allHeadings.push({ ref, level: parseInt(m[1], 10) });
    });

    const h1Indices = allHeadings
      .map((h, i) => (h.level === 1 ? i : -1))
      .filter(i => i >= 0);

    if (h1Indices.length <= 1) {
      return { issueId: issue.id, success: true, before: `${h1Indices.length} H1`, after: 'No change needed' };
    }

    let demoted = 0;
    let cascaded = 0;

    for (let k = 1; k < h1Indices.length; k++) {
      const sectionStart = h1Indices[k];
      const sectionEnd = k + 1 < h1Indices.length ? h1Indices[k + 1] : allHeadings.length;

      // Demote this H1 → H2
      this.renameElement(doc, allHeadings[sectionStart].ref, 'H2');
      allHeadings[sectionStart].level = 2;
      demoted++;

      // Cascade: shift all headings within this section down by one level
      for (let j = sectionStart + 1; j < sectionEnd; j++) {
        const h = allHeadings[j];
        const newLevel = Math.min(h.level + 1, 6);
        if (newLevel !== h.level) {
          this.renameElement(doc, h.ref, `H${newLevel}`);
          allHeadings[j].level = newLevel;
          cascaded++;
        }
      }
    }

    // Final cleanup pass: close any level-skip gaps left over from the cascade
    this.fixHeadingHierarchy(doc, [issue]);

    logger.info(`[StructureWriter] fixMultipleH1: demoted ${demoted} H1(s) to H2, cascaded ${cascaded} sub-heading(s)`);
    return {
      issueId: issue.id,
      success: true,
      before: `${h1Indices.length} H1 headings`,
      after: `Demoted ${demoted} H1(s) to H2; shifted ${cascaded} sub-heading(s) down by one level`,
    };
  }

  /**
   * Set a page's own /Tabs entry to /S (structure order) -- Matterhorn
   * 28-008/28-009 (PDF32000-1:2008 §12.5, §14.8.4.2). A page with any
   * /Annots but no /Tabs=/S leaves keyboard/screen-reader tab order
   * undefined or viewer-dependent instead of following the structure tree's
   * reading order. Purely mechanical: a single key set with no MCID/struct-
   * tree interaction and no failure mode once the page itself resolves.
   */
  fixTabOrder(doc: PDFDocument, issue: AuditIssue): FixResult {
    if (!issue.pageNumber) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue is missing pageNumber' };
    }
    let page;
    try {
      page = doc.getPage(issue.pageNumber - 1);
    } catch {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${issue.pageNumber} not found` };
    }

    const before = page.node.get(PDFName.of('Tabs'))?.toString() ?? 'missing';
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'));

    logger.info(`[StructureWriter] fixTabOrder: page ${issue.pageNumber} /Tabs ${before} -> /S`);
    return { issueId: issue.id, success: true, before: `/Tabs ${before}`, after: '/Tabs /S' };
  }

  /**
   * Retargets a single /RoleMap entry (e.g. /H1A -> /P becomes /H1A -> /H1).
   * Document-wide by nature: every element tagged with this custom style was
   * deliberately applied by the original author, so correcting the ONE
   * RoleMap entry fixes every instance at once for any RoleMap-resolving
   * consumer (NVDA included). Only ever called for 'heading'/'caption'
   * categories from pdf-rolemap-integrity.validator.ts's
   * classifyDegenerateRoleMapEntry -- those are the only two with one
   * unambiguous correct target; 'index'/'footnote' are detect-only and have
   * no dispatch routing here (see that validator's own header comment for
   * why).
   */
  fixDegenerateRoleMapEntry(doc: PDFDocument, issue: AuditIssue): FixResult {
    const customTag = issue.element;
    if (!customTag) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue is missing element (the custom tag name)' };
    }

    const classification = classifyDegenerateRoleMapEntry(customTag);
    if (!classification || (classification.category !== 'heading' && classification.category !== 'caption')) {
      return {
        issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
        error: `No safe, unambiguous RoleMap retarget for "${customTag}" (category: ${classification?.category ?? 'unrecognized'})`,
      };
    }

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No structure tree root found' };
    }

    const rmRaw = structRoot.get(PDFName.of('RoleMap'));
    const rm = rmRaw instanceof PDFRef ? doc.context.lookup(rmRaw) : rmRaw;
    if (!(rm instanceof PDFDict)) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No /RoleMap dict found on StructTreeRoot' };
    }

    const before = rm.get(PDFName.of(customTag))?.toString() ?? 'missing';
    const targetType = classification.category === 'heading' ? `H${classification.headingLevel}` : 'Caption';
    rm.set(PDFName.of(customTag), PDFName.of(targetType));

    logger.info(`[StructureWriter] fixDegenerateRoleMapEntry: /RoleMap "/${customTag}" ${before} -> /${targetType}`);
    return { issueId: issue.id, success: true, before: `/${customTag} -> ${before}`, after: `/${customTag} -> /${targetType}` };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — Composite: List Rewrap
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Wrap orphaned LI elements into a new L parent.
   * An "orphaned" LI is one whose direct parent is not an L element.
   *
   * MCID-safe: a new L container is created; the LI children (which hold MCIDs)
   * are reparented but their MCID bindings are not touched.
   *
   * @param issues - LIST-IMPROPER-MARKUP AuditIssues
   */
  rewrapListItems(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    // Find all LI elements whose parent is not an L
    const orphaned: Array<{ ref: PDFRef; parentRef: PDFRef; pageRef: PDFRef | undefined }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (sTag !== 'LI') return;

      const parentRaw = node.get(PDFName.of('P'));
      if (!(parentRaw instanceof PDFRef)) return;

      const parent = doc.context.lookup(parentRaw);
      if (!(parent instanceof PDFDict)) return;

      const parentTag = parent.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (parentTag === 'L') return; // Already correctly wrapped

      const pgRaw = node.get(PDFName.of('Pg'));
      orphaned.push({
        ref,
        parentRef: parentRaw,
        pageRef: pgRaw instanceof PDFRef ? pgRaw : undefined,
      });
    });

    if (orphaned.length === 0) {
      return issues.map(i => ({
        issueId: i.id, success: true,
        before: 'LI not wrapped in L', after: 'No orphaned LI elements found',
      }));
    }

    // Group consecutive LIs by shared parent (same parent ref object number)
    const byParent = new Map<number, typeof orphaned>();
    for (const li of orphaned) {
      const key = li.parentRef.objectNumber;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(li);
    }

    let fixCount = 0;
    const errors: string[] = [];

    for (const [, lis] of byParent) {
      try {
        const lRef = this.createElement(doc, 'L', lis[0].parentRef, lis[0].pageRef);
        for (const li of lis) {
          this.reparentElement(doc, li.ref, lRef);
        }
        fixCount++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    logger.info(`[StructureWriter] rewrapListItems: ${fixCount} group(s) wrapped`);
    return issues.map(i => ({
      issueId: i.id,
      success: fixCount > 0 && errors.length === 0,
      before: 'LI elements not wrapped in L container',
      after: fixCount > 0
        ? `Wrapped ${fixCount} group(s) of LI elements in new L containers`
        : 'No orphaned LI elements fixed',
      error: errors.length > 0 ? errors.join('; ') : undefined,
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — Composite: Simple Table Header Fix
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolves an element's own /Pg, or (if absent) the first /Pg found in its
   * subtree. Some taggers (e.g. Seam C, confirmed via a real trial document)
   * never put /Pg on composite elements like /Table -- only on leaf row/cell
   * descendants (e.g. the first /TH) -- so a direct .get('Pg') is often empty
   * even though the element is unambiguously scoped to one page. Mirrors
   * pdfModifierService.resolveElementPageRef for the same reason.
   */
  private resolveElementPageRef(doc: PDFDocument, el: PDFDict, maxDepth = 6): PDFRef | undefined {
    const direct = el.get(PDFName.of('Pg'));
    if (direct instanceof PDFRef) return direct;
    if (maxDepth <= 0) return undefined;

    const children: PDFDict[] = [];
    const collect = (raw: PDFObject) => {
      const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (obj instanceof PDFDict) children.push(obj);
    };
    const k = el.get(PDFName.of('K'));
    if (k instanceof PDFArray) {
      k.asArray().forEach(collect);
    } else if (k) {
      collect(k as PDFObject);
    }

    for (const child of children) {
      const pg = child.get(PDFName.of('Pg'));
      if (pg instanceof PDFRef) return pg;
    }
    for (const child of children) {
      const nested = this.resolveElementPageRef(doc, child, maxDepth - 1);
      if (nested) return nested;
    }
    return undefined;
  }

  /**
   * Every leaf MCID this element's subtree references, walking /K
   * recursively -- both a bare integer entry (e.g. a /TD whose /K is just
   * `3`) and an MCR (marked-content reference) dict's own /MCID attribute.
   * Depth-bounded (8) purely as a recursion-safety guard, not a discovered
   * data boundary -- every real leaf MCID seen so far sits at depth 2-3
   * (e.g. Table > TR > TD > 3). Mirrors pdfModifierService.collectLeafMcids.
   */
  private collectLeafMcids(doc: PDFDocument, el: PDFDict, maxDepth = 8, out: number[] = []): number[] {
    if (maxDepth <= 0) return out;
    const items: PDFObject[] = [];
    const k = el.get(PDFName.of('K'));
    if (k instanceof PDFArray) {
      k.asArray().forEach(item => items.push(item));
    } else if (k) {
      items.push(k as PDFObject);
    }

    for (const item of items) {
      const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (resolved instanceof PDFNumber) {
        out.push(resolved.asNumber());
      } else if (resolved instanceof PDFDict) {
        const mcidAttr = resolved.get(PDFName.of('MCID'));
        if (mcidAttr instanceof PDFNumber) {
          out.push(mcidAttr.asNumber());
        } else {
          this.collectLeafMcids(doc, resolved, maxDepth - 1, out);
        }
      }
    }
    return out;
  }

  /**
   * Verifies a structure element genuinely belongs to `targetPage` via
   * content-stream evidence, for elements resolveElementPageRef can't place
   * at all (no /Pg anywhere in its own subtree -- see that method's doc
   * comment). MCIDs are page-scoped by PDF spec, so a leaf MCID this element
   * references being opened (`<< /MCID n >> BDC`) in targetPage's own
   * content stream is real, spec-legal evidence the element's content lives
   * there, independent of whether any /Pg attribute exists at all. Mirrors
   * pdfModifierService.resolvesToPageViaMcid -- see its doc comment for the
   * full reasoning behind why this is deliberately only ever a fallback for
   * a missing /Pg (never an override of a confident, if perhaps mismatched,
   * one), and for why this requires a strict MAJORITY of leaf MCIDs to
   * match rather than just one (too weak -- MCID numbers are reused across
   * pages) or literally all of them (too strong -- breaks a table whose
   * rows genuinely straddle a page boundary, an already-known, documented
   * gap elsewhere in this codebase's table matching).
   */
  private resolvesToPageViaMcid(doc: PDFDocument, el: PDFDict, targetPage: number): boolean {
    const mcids = this.collectLeafMcids(doc, el);
    if (mcids.length === 0) return false;
    const pageMcids = pageContentMcids(doc, targetPage);
    if (!pageMcids) return false;
    const matchCount = mcids.filter(mcid => pageMcids.has(mcid)).length;
    return matchCount > mcids.length / 2;
  }

  /**
   * Locates the specific /Table structure element an issue's id refers to
   * (format "table_p{page}_{index}", optionally with a "_dupN" disambiguation
   * suffix from structureAnalyzerService -- both parse the same leading
   * page+index, which is all that's needed here). Filters all /Table
   * elements to the target page (via resolveElementPageRef, since a direct
   * /Pg is often absent) and indexes into that page's list in document
   * order, mirroring pdfModifierService.setTableSummary's targeting.
   *
   * Returns both the dict and its ref -- renameElement/reparentElement/
   * deleteElement all key off the ref, not the dict, so callers that need to
   * mutate the element itself (not just read it, as fixSimpleTableHeaders
   * originally only needed) require both.
   */
  private findTargetTable(doc: PDFDocument, structRoot: PDFDict, elementId: string | undefined): { dict: PDFDict; ref: PDFRef } | null {
    const match = elementId?.match(/table_p(\d+)_(\d+)/);
    if (!match) return null;
    const targetPage = parseInt(match[1], 10);
    const targetIndex = parseInt(match[2], 10);

    const allTables: Array<{ dict: PDFDict; ref: PDFRef }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (sTag === 'Table') allTables.push({ dict: node, ref });
    });

    let pageRef: PDFRef;
    try {
      pageRef = doc.getPage(targetPage - 1).ref;
    } catch {
      return null;
    }
    const tablesOnPage = allTables.filter(t => {
      const pg = this.resolveElementPageRef(doc, t.dict);
      // A confident (structure-tree-sourced) /Pg wins outright, matching or
      // not -- only fall back to MCID verification when there's no /Pg
      // anywhere in this table's own subtree to consult in the first place.
      if (pg) return pg.toString() === pageRef.toString();
      return this.resolvesToPageViaMcid(doc, t.dict, targetPage);
    });

    return tablesOnPage[targetIndex] ?? null;
  }

  /**
   * True if a StructElem's /K references the given MCID (bare number, array,
   * or MCR dict) -- mirrors pdf-modifier.service.ts's own structElemHasMcid
   * (that copy has the same indirect-reference gap this one just fixed;
   * left as-is there, out of scope for this file's own PR).
   *
   * Resolves /K itself, and each array entry, through doc.context.lookup
   * before matching -- this pdf-lib version (^1.17.1) does not auto-resolve
   * PDFRefs on .get(), and an indirect /K or indirect array entry is a
   * real, valid PDF shape (CodeRabbit finding on PR #555, confirmed real:
   * the direct-only version silently missed any struct element using one,
   * causing findStructElementByMcid to fail to find a real anchor that DID
   * reference the target MCID).
   */
  private structElemHasMcid(doc: PDFDocument, node: PDFDict, mcid: number): boolean {
    const kRaw = node.get(PDFName.of('K'));
    const k = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    if (k instanceof PDFNumber) return k.asNumber() === mcid;
    if (k instanceof PDFArray) {
      for (let i = 0; i < k.size(); i++) {
        const itemRaw = k.get(i);
        const item = itemRaw instanceof PDFRef ? doc.context.lookup(itemRaw) : itemRaw;
        if (item instanceof PDFNumber && item.asNumber() === mcid) return true;
        if (item instanceof PDFDict) {
          const mRaw = item.get(PDFName.of('MCID'));
          const m = mRaw instanceof PDFRef ? doc.context.lookup(mRaw) : mRaw;
          if (m instanceof PDFNumber && m.asNumber() === mcid) return true;
        }
      }
    }
    return false;
  }

  /**
   * Finds the struct element on `pageNumber` whose /K references `mcid` --
   * resolves a "nearest tagged content" MCID (from figure-content-tagger.ts's
   * findNearestMcidForPosition) back to the real struct element to anchor a
   * new /Figure's placement near, via insertIntoKidsAfter. Page-filtered the
   * same way findTargetTable already is (confident /Pg first, MCID-verified
   * fallback for a /Pg-less subtree) -- reuses the same helpers, not a new
   * pattern.
   */
  private findStructElementByMcid(doc: PDFDocument, structRoot: PDFDict, pageNumber: number, mcid: number): { dict: PDFDict; ref: PDFRef } | null {
    let pageRef: PDFRef;
    try {
      pageRef = doc.getPage(pageNumber - 1).ref;
    } catch {
      return null;
    }
    let found: { dict: PDFDict; ref: PDFRef } | null = null;
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref || !this.structElemHasMcid(doc, node, mcid)) return;
      const pg = this.resolveElementPageRef(doc, node);
      const onPage = pg ? pg.toString() === pageRef.toString() : this.resolvesToPageViaMcid(doc, node, pageNumber);
      if (onPage) {
        found = { dict: node, ref };
        return true;
      }
    });
    return found;
  }

  /**
   * Builds a real /Figure struct element + MCID + /ParentTree wiring for a
   * genuinely-untagged image (the "no /Figure anywhere on the page" half of
   * the alt-text Figure-indexing investigation -- see figure-content-tagger.ts's
   * own doc comment and the session's plan file for the full reasoning).
   * Once this exists, pdf-modifier.service.ts's own setAltText already
   * correctly resolves and writes /Alt to it -- this method's only job is
   * making the Figure exist and correctly resolve, not writing alt text
   * itself.
   *
   * Placement: a genuinely-untagged image has no existing struct element
   * "about" it to anchor near the way buildTableFromLayout's MATTERHORN-15-001
   * case had (the spuriously-paired trivial box, PR #552) -- reconnaissance
   * (this session) confirmed the same flat-/Document landmine Slice 2d hit
   * (2278 direct children) makes raw geometric proximity unsafe to insert by
   * directly, but that insertIntoKidsAfter (anchor-relative insertion,
   * already built and battle-tested) is still the right tool once a real
   * anchor is found: locate the EXISTING tagged content nearest the image's
   * own position (findNearestMcidForPosition), resolve that back to its
   * owning struct element (findStructElementByMcid), and insert the new
   * Figure immediately after that element's own tree position. No distance
   * cutoff -- a distant anchor only costs reading-order quality, not
   * structural correctness (unlike Slice 2d's FIFO-shift bug, which
   * corrupted a DIFFERENT element's own classification; nothing analogous
   * is at stake here since no other element's role changes).
   *
   * Structurally simpler than buildTableFromLayout: a Figure is one leaf
   * element (its own /K holds the new MCID directly), no TR/TD/Span nesting
   * -- an image is one marked-content sequence, not a grid of cells.
   *
   * Same preflight-before-mutation discipline the Tables effort's later fix
   * rounds established (PR #552): resolve every entry's attach point AND
   * validate the page's /ParentTree shape BEFORE any content-stream
   * mutation; buffer results and only commit success once the final
   * per-page /ParentTree commit actually succeeds. On a late commit
   * failure, the newly-created (never-yet-reachable-from-anywhere-else)
   * Figure element is fully deleted via the existing deleteElement
   * primitive -- a cleaner mitigation than buildTableFromLayout's own
   * retag-to-Artifact trick, which had to repurpose an EXISTING element;
   * here there's nothing pre-existing to preserve, so full removal is safe
   * and leaves nothing misleading behind.
   *
   * @param images - each a real, position-known image (imageId in
   *   img_p{page}_{index}_{xObjectName} form, matching image-extractor.service.ts's
   *   own ImageInfo.id/position) confirmed to have NO resolvable /Figure
   *   today (e.g. via pdfModifierService.setAltText failing for it). The
   *   `index` slot is the occurrence ordinal (0-based) of this specific
   *   invocation among every same-named XObject invocation on the page --
   *   see ImageInfo's own doc comment -- used below to target the CORRECT
   *   `/xObjectName Do` when the same resource is invoked more than once on
   *   one page (a reused image, a normal authoring pattern), rather than
   *   bailing on the ambiguity the way a plain name-only lookup must.
   */
  async buildFigureFromImage(
    doc: PDFDocument,
    parsedPdf: ParsedPDF,
    images: Array<{ imageId: string; pageNumber: number; position: { x: number; y: number; width: number; height: number } }>
  ): Promise<FixResult[]> {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return images.map(img => ({
        issueId: img.imageId, success: false, before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const byPage = new Map<number, typeof images>();
    for (const img of images) {
      const list = byPage.get(img.pageNumber) ?? [];
      list.push(img);
      byPage.set(img.pageNumber, list);
    }

    const results: FixResult[] = [];

    for (const [pageNumber, pageImages] of byPage) {
      let pageContent: string | null;
      try {
        pageContent = decodePageContent(doc, pageNumber);
      } catch (err) {
        for (const img of pageImages) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (pageContent === null) {
        for (const img of pageImages) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `No readable content stream for page ${pageNumber}` });
        }
        continue;
      }

      let pageRef: PDFRef;
      let pageHeight: number;
      try {
        const page = doc.getPage(pageNumber - 1);
        pageRef = page.ref;
        pageHeight = page.getHeight();
      } catch (err) {
        for (const img of pageImages) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      // Resolve EVERY entry's Do-invocation range AND attach point BEFORE
      // any mutation happens -- same "resolve everything first" discipline
      // that closed real bugs in buildTableFromLayout (PR #552): content-
      // stream mutation ahead of full validation risks orphan MCIDs for an
      // entry that can't complete.
      type ValidEntry = {
        img: (typeof images)[number];
        range: { start: number; end: number };
        anchorRef: PDFRef;
        parentRef: PDFRef;
      };
      const validEntries: ValidEntry[] = [];
      for (const img of pageImages) {
        // The `index` slot is the occurrence ordinal (0-based) of THIS
        // specific invocation among every same-named XObject invocation on
        // the page (see ImageInfo's own doc comment in
        // image-extractor.service.ts), not just a disambiguation-free name --
        // passed through to locateXObjectInvocation so a reused image
        // resource (invoked more than once on one page, at different
        // positions) resolves to the CORRECT invocation instead of bailing
        // on the ambiguity a name-only lookup would hit.
        const idMatch = img.imageId.match(/^img_p\d+_(\d+)_(.+)$/);
        if (!idMatch) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `Could not parse XObject name from imageId "${img.imageId}"` });
          continue;
        }
        const occurrence = parseInt(idMatch[1], 10);
        const xObjectName = idMatch[2];
        const range = locateXObjectInvocation(pageContent, xObjectName, occurrence);
        if (!range) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `No "/${xObjectName} Do" invocation found at occurrence ${occurrence} on page ${pageNumber}` });
          continue;
        }
        const nearest = await findNearestMcidForPosition(parsedPdf, pageNumber, img.position);
        if (!nearest) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `No existing tagged content found on page ${pageNumber} to anchor placement near` });
          continue;
        }
        const anchor = this.findStructElementByMcid(doc, structRoot, pageNumber, nearest.mcid);
        if (!anchor) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `Nearest MCID ${nearest.mcid} did not resolve to a real struct element` });
          continue;
        }
        const parentRaw = anchor.dict.get(PDFName.of('P'));
        if (!(parentRaw instanceof PDFRef)) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor struct element has no /P (parent) entry' });
          continue;
        }
        // Preflight what insertIntoKidsAfter itself would need to succeed --
        // a property of the document as it already stands (nothing mutates
        // this parent's /K between here and the actual insertion below),
        // fully knowable up front. kContainsChild accepts a single-child
        // struct element's legitimate SCALAR /K (per spec, not wrapped in
        // an array) too -- insertIntoKidsAfter now promotes that shape to
        // a real array rather than declining (see its own doc comment);
        // this preflight must agree exactly with what it will actually do,
        // or a page that WOULD now succeed would still wrongly decline here
        // first.
        const parentDict = doc.context.lookup(parentRaw);
        if (!(parentDict instanceof PDFDict)) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor parent does not resolve to a dictionary' });
          continue;
        }
        const parentK = parentDict.get(PDFName.of('K'));
        if (!this.kContainsChild(parentK, anchor.ref)) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor not found in its own parent /K (neither as an array member nor as a matching scalar)' });
          continue;
        }
        validEntries.push({ img, range, anchorRef: anchor.ref, parentRef: parentRaw });
      }

      if (validEntries.length === 0) continue;

      // Content-range order, not input order (Codex/CodeRabbit finding on
      // PR #555, confirmed real): insertMarkedContentSpans itself assigns
      // MCIDs in byte-offset order regardless of what order requests are
      // built in, and -- more importantly -- when two images share the same
      // nearest anchor, chaining each subsequent Figure after the
      // PREVIOUSLY inserted one (see the per-entry loop below) only
      // produces correct reading order if entries are processed in the same
      // order their content actually appears on the page.
      validEntries.sort((a, b) => a.range.start - b.range.start);

      // Preflight the page's /ParentTree shape BEFORE the content-stream
      // mutation below -- same reasoning as buildTableFromLayout's own
      // preflight (PR #552, CodeRabbit pushback): every failure mode
      // resolveParentTreeNumsArray checks is a property of the document as
      // it already stands, knowable up front.
      let parentTreePageSize: number;
      try {
        parentTreePageSize = this.getPageParentTreeArraySize(doc, pageNumber);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const ve of validEntries) {
          results.push({ issueId: ve.img.imageId, success: false, before: 'unknown', after: 'unknown', error: message });
        }
        continue;
      }

      // Only NOW does the content stream get rewritten -- every entry
      // reaching this point already has a confirmed Do-invocation range and
      // a resolvable attach point. Tagged /Figure, matching real-world PDF/UA
      // convention (the marked-content tag matches the struct role) rather
      // than reusing the generic /Span default.
      const requests: RangeInsertionRequest[] = validEntries.map((ve, i) => ({ range: ve.range, id: String(i) }));
      let inserted: InsertedSpan[];
      try {
        // minNextMcid: the page's real /ParentTree array length, resolved
        // above -- see getPageParentTreeArraySize's own doc comment for why
        // a content-stream-only scan can undercount this.
        inserted = insertMarkedContentSpans(doc, pageNumber, requests, 'Figure', parentTreePageSize);
      } catch (err) {
        for (const ve of validEntries) {
          results.push({ issueId: ve.img.imageId, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const mcidById = new Map(inserted.map(s => [s.id!, s.mcid]));

      const pageParentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
      // Buffered rather than pushed straight into `results` -- same reason
      // as buildTableFromLayout's own pageResults: the /ParentTree commit
      // for the whole page hasn't happened yet when each Figure is built.
      const pageResults: FixResult[] = [];
      const figureRefsByIndex = new Map<number, PDFRef>();
      // Group A fix (Codex/CodeRabbit finding on PR #555, confirmed real):
      // when two images resolve to the SAME nearest anchor, chain each
      // subsequent Figure after the PREVIOUSLY inserted one for that
      // anchor, not the original anchor every time -- otherwise every
      // insertion targets the same fixed point and later entries land
      // BEFORE earlier ones (content order [A,B] -> structure order
      // [anchor,B,A]), reversing reading order for screen readers. Keyed by
      // object number since PDFRef doesn't have a canonical string key this
      // file already uses elsewhere.
      const lastInsertedByAnchor = new Map<number, PDFRef>();

      // A single unhandled per-entry failure invalidates the WHOLE page's
      // batch, not just that entry (Codex/CodeRabbit finding on PR #555,
      // confirmed real) -- every failure mode insertIntoKidsAfter itself can
      // hit is now preflighted above, so reaching this catch means something
      // genuinely unexpected happened; treat it exactly like a failed final
      // /ParentTree commit below (full rollback), for the same reason: an
      // entry already built here shares the SAME page content-stream
      // mutation as every sibling entry on this page, so a partial, silently
      // inconsistent result would be worse than failing the whole page.
      let pageFailureMessage: string | null = null;

      for (let i = 0; i < validEntries.length; i++) {
        const ve = validEntries[i];
        try {
          const mcid = mcidById.get(String(i));
          if (mcid === undefined) {
            pageResults.push({ issueId: ve.img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'MCID missing from insertMarkedContentSpans result' });
            continue;
          }
          // /A/BBox, matching the shape every correctly-tagged (InDesign-
          // native) /Figure in a real document already carries. Real
          // incident (Karsaklian_189165_9781606497623.pdf, 2026-11-09): PAC
          // flagged "'Figure' element on a single page with no bounding box"
          // for all 4 Figures this method had created -- it never wrote /A
          // at all, even though img.position already carries the exact
          // geometry needed. position is top-left-origin (image-extractor
          // .service.ts's own extractImagePlacementsFromContent computes it
          // as `viewport.height - f - height`, flipping native bottom-left
          // PDF space) -- /BBox needs bottom-left-origin PDF points, same
          // pageHeight - y flip pdf-form.validator.ts's own buildBoundingBox
          // already uses for the identical conversion.
          const { x, y, width, height } = ve.img.position;
          const bbox = doc.context.obj([x, pageHeight - (y + height), x + width, pageHeight - y]);
          const figureObj = doc.context.obj({
            Type: PDFName.of('StructElem'),
            S: PDFName.of('Figure'),
            P: ve.parentRef,
            Pg: pageRef,
            K: PDFNumber.of(mcid),
            A: doc.context.obj({ O: PDFName.of('Layout'), BBox: bbox, Placement: PDFName.of('Block') }),
          });
          const figureRef = doc.context.register(figureObj as PDFDict);
          figureRefsByIndex.set(i, figureRef);

          const anchorKey = ve.anchorRef.objectNumber;
          const insertAfter = lastInsertedByAnchor.get(anchorKey) ?? ve.anchorRef;
          this.insertIntoKidsAfter(doc, ve.parentRef, insertAfter, figureRef);
          lastInsertedByAnchor.set(anchorKey, figureRef);

          pageParentTreeEntries.push({ mcid, structElementRef: figureRef });
          pageResults.push({
            issueId: ve.img.imageId,
            success: true,
            before: 'Untagged image (no /Figure)',
            after: `Built Figure element, MCID ${mcid}`,
          });
        } catch (err) {
          pageFailureMessage = err instanceof Error ? err.message : String(err);
          break;
        }
      }

      if (pageFailureMessage !== null) {
        // Full rollback (Codex/CodeRabbit finding on PR #555, confirmed
        // real and, unlike buildTableFromLayout's analogous residual risk
        // -- issue #553 -- genuinely achievable here): this page has exactly
        // ONE content-stream rewrite for its whole batch (the single
        // insertMarkedContentSpans call above), so restoring the captured
        // pre-mutation pageContent undoes ALL of this page's Figure
        // insertions at once, not just the struct-tree side deleteElement
        // already cleans up.
        writePageContent(doc, pageNumber, pageContent);
        for (const figureRef of figureRefsByIndex.values()) {
          this.deleteElement(doc, figureRef);
        }
        for (const ve of validEntries) {
          results.push({ issueId: ve.img.imageId, success: false, before: 'unknown', after: 'unknown', error: pageFailureMessage });
        }
        continue;
      }

      // The one combined per-page ParentTree commit -- same reasoning as
      // buildTableFromLayout's own: insertMarkedContentSpans assigns MCIDs
      // in content-stream byte-offset order across the whole page's batch,
      // not grouped by entry, so extendParentTree must be called once with
      // everything sorted by MCID, not once per entry.
      if (pageParentTreeEntries.length > 0) {
        pageParentTreeEntries.sort((a, b) => a.mcid - b.mcid);
        try {
          this.extendParentTree(doc, pageNumber, pageParentTreeEntries);
          results.push(...pageResults);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Full rollback here too, not just struct-tree cleanup (Codex/
          // CodeRabbit finding on PR #555, confirmed real): deleteElement
          // alone leaves this page's BDC/EMC + MCID marks sitting in the
          // content stream with no owning struct element -- restore the
          // ORIGINAL content first, matching the per-entry rollback above.
          writePageContent(doc, pageNumber, pageContent);
          pageResults.forEach((r, i) => {
            if (!r.success) return;
            const figureRef = figureRefsByIndex.get(i);
            if (figureRef) this.deleteElement(doc, figureRef);
          });
          for (const r of pageResults) {
            results.push(r.success ? { ...r, success: false, error: message } : r);
          }
        }
      } else {
        results.push(...pageResults);
      }
    }

    return results;
  }

  /**
   * Wraps a mis-placed bare MCID (one that implicitly inherits its owning
   * struct element's own /Pg but doesn't actually exist on that page's
   * content stream) into a proper MCR dict declaring the correct /Pg --
   * see mcid-page-mismatch.ts's own header comment for the full real
   * incident and exact shape this fixes.
   *
   * Re-runs findMcidPageMismatches fresh (never trusts the issue's own
   * analysis-time snapshot) and only mutates if the EXACT same (page,
   * mcid) pair is still found -- matching this file's "always re-confirm
   * at apply time" discipline elsewhere (findTargetTable, resolveFigureForImage).
   * No /ParentTree change needed: the correct page's own ParentTree slot
   * for this MCID already correctly points at this struct element (the
   * defect is purely in the downward /K direction), confirmed live for
   * the real incident this was built for.
   */
  fixMcidPageMismatch(doc: PDFDocument, issue: AuditIssue): FixResult {
    const match = issue.element ? /^mcid-mismatch_p(\d+)_mc(\d+)$/.exec(issue.element) : null;
    if (!match) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Unrecognized element id "${issue.element}"` };
    }
    const wrongPage = parseInt(match[1], 10);
    const mcid = parseInt(match[2], 10);

    const mismatches = findMcidPageMismatches(doc);
    const target = mismatches.find(m => m.wrongPage === wrongPage && m.mcid === mcid);
    if (!target) {
      return {
        issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
        error: `Could not re-confirm a page mismatch for MCID ${mcid} on page ${wrongPage} -- may already be fixed, or the document changed`,
      };
    }

    let correctPageRef: PDFRef;
    try {
      correctPageRef = doc.getPage(target.correctPage - 1).ref;
    } catch (err) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }

    const mcrDict = doc.context.obj({ Type: PDFName.of('MCR'), Pg: correctPageRef, MCID: PDFNumber.of(mcid) });
    target.kArray.set(target.entryIndex, mcrDict);

    return {
      issueId: issue.id,
      success: true,
      before: `Bare MCID ${mcid} implicitly on page ${wrongPage} (doesn't exist in that page's content)`,
      after: `Wrapped as an MCR dict pointing to page ${target.correctPage} (where MCID ${mcid} actually exists)`,
    };
  }

  /**
   * When a buildFigureFromImage-created Figure's own underlying image is
   * classified decorative (ai-analysis.service.ts's analyzeAltText,
   * isDecorative === true), retag it as /Artifact instead of leaving it a
   * /Figure with an empty /Alt. PDF/UA's real convention for decorative
   * content is Artifact, not a Figure with an empty description -- PAC
   * treats an explicitly-empty /Alt the same as a genuinely missing one.
   *
   * Real incident (Karsaklian_189165_9781606497623.pdf, 2026-11-09): refs
   * 4120/4121 (a BATNA/ZOPA negotiation-box background card graphic, built
   * by buildFigureFromImage, correctly classified decorative by Gemini --
   * the real informational text is separate, already-tagged vector text
   * layered on top) both flagged "Alternative text missing for Figure"
   * despite carrying a real, explicit /Alt ().
   *
   * Scoped to EXACTLY buildFigureFromImage's own created shape -- a
   * /Figure whose /K is a single bare MCID (no array, no MCR dict, no
   * sibling content). A pre-existing, InDesign-native Figure with a richer
   * /K shape is a document-authoring decision this method has no business
   * overriding; declines rather than guessing for anything outside this
   * one shape.
   *
   * Mirrors markTableAsArtifact's "retag to Artifact" shape, but that
   * method's whole safety assumption is an ALWAYS-EMPTY decorative box (no
   * /K at all, nothing in the content stream to touch) -- this Figure
   * carries a REAL MCID with real painted content, so unlike
   * markTableAsArtifact/deleteElement, this must ALSO rewrite the
   * content-stream's own opening BDC tag (/Figure <</MCID n>>BDC ->
   * /Artifact BMC -- EMC closes either form identically, no tag name of
   * its own) and null out this page's /ParentTree slot for that MCID
   * (array.set, never shrinking the array -- a later-appended MCID on this
   * page may already assume this array's current length as its own append
   * position, the same contiguity invariant extendParentTree enforces).
   */
  retagDecorativeFigureAsArtifact(doc: PDFDocument, issueId: string, imageId: string): FixResult {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: 'No structure tree root found' };
    }

    const figureDict = pdfModifierService.resolveFigureForImage(doc, imageId);
    if (!figureDict) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: `No Figure element found for image "${imageId}"` };
    }

    const kRaw = figureDict.get(PDFName.of('K'));
    if (!(kRaw instanceof PDFNumber)) {
      return {
        issueId, success: false, before: 'unknown', after: 'unknown',
        error: 'Figure /K is not a single bare MCID -- not the buildFigureFromImage shape this fix is scoped to',
      };
    }
    const mcid = kRaw.asNumber();

    const pageMatch = imageId.match(/^img_p(\d+)_/);
    const pageNumber = pageMatch ? parseInt(pageMatch[1], 10) : null;
    if (pageNumber === null) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: `Could not parse page number from image id "${imageId}"` };
    }

    const parentRaw = figureDict.get(PDFName.of('P'));
    if (!(parentRaw instanceof PDFRef)) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: 'Figure has no /P (parent) entry' };
    }
    const parentDict = doc.context.lookup(parentRaw);
    if (!(parentDict instanceof PDFDict)) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: 'Figure parent does not resolve to a dictionary' };
    }

    // Find this Figure's own ref by identity within its parent's /K --
    // deleteElement-style removal needs the REF, not just the dict, and
    // resolveFigureForImage (pdf-modifier.service.ts) only ever returns the
    // dict. Safe: pdf-lib's PDFContext caches one canonical object instance
    // per ref, so repeated lookups of the SAME ref return the SAME object.
    const parentKRaw = parentDict.get(PDFName.of('K'));
    const parentKArr = parentKRaw instanceof PDFRef ? doc.context.lookup(parentKRaw) : parentKRaw;
    let figureRef: PDFRef | null = null;
    if (parentKArr instanceof PDFArray) {
      for (const entry of parentKArr.asArray()) {
        if (entry instanceof PDFRef && doc.context.lookup(entry) === figureDict) { figureRef = entry; break; }
      }
    }
    if (!figureRef) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: "Figure not found by identity in its own parent's /K array" };
    }

    const content = decodePageContent(doc, pageNumber);
    if (content === null) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: `Could not decode page ${pageNumber} content stream` };
    }
    const span = findBdcTagSpanForMcid(content, mcid);
    if (!span) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: `No BDC sequence found opening MCID ${mcid} on page ${pageNumber}` };
    }

    // Resolve this page's own per-page /ParentTree value array BEFORE any
    // mutation -- same "resolve everything first" discipline as
    // buildFigureFromImage's own preflight. Mirrors extendParentTree's own
    // foundIndex lookup (never reuses it directly -- that method's own
    // append-only contract has no "retire a slot" mode, and this is a
    // small enough lookup to duplicate rather than risk changing tested,
    // heavily-relied-on logic for an unrelated caller).
    let pageTreeArr: PDFArray;
    try {
      const { numsArr, pageKey } = this.resolveParentTreeNumsArray(doc, pageNumber);
      const raw = numsArr.asArray();
      let foundIndex = -1;
      for (let i = 0; i < raw.length; i += 2) {
        const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
        if (keyObj instanceof PDFNumber && keyObj.asNumber() === pageKey) { foundIndex = i; break; }
      }
      if (foundIndex === -1) {
        return { issueId, success: false, before: 'unknown', after: 'unknown', error: `Page ${pageNumber} has no existing /ParentTree entry` };
      }
      const valueRaw = raw[foundIndex + 1];
      const valueResolved = valueRaw instanceof PDFRef ? doc.context.lookup(valueRaw) : valueRaw;
      if (!(valueResolved instanceof PDFArray) || mcid >= valueResolved.size()) {
        return { issueId, success: false, before: 'unknown', after: 'unknown', error: `Page ${pageNumber}'s /ParentTree array has no slot for MCID ${mcid}` };
      }
      pageTreeArr = valueResolved;
    } catch (err) {
      return { issueId, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }

    // Only now mutate: content stream, struct tree, /ParentTree.
    const newContent = content.slice(0, span.start) + '/Artifact BMC' + content.slice(span.end);
    writePageContent(doc, pageNumber, newContent);

    this.removeFromKids(doc, parentRaw, figureRef);
    figureDict.delete(PDFName.of('K'));
    figureDict.delete(PDFName.of('P'));
    pageTreeArr.set(mcid, PDFNull);

    return {
      issueId,
      success: true,
      before: 'Figure with an empty /Alt (decorative, PAC flags empty as missing)',
      after: `Retagged as /Artifact (MCID ${mcid} removed from the structure tree and /ParentTree)`,
    };
  }

  /**
   * Promote a header row's TD cells to TH + add scope="Column" for simple
   * tables. "Simple" = the row has ≤3 cells and none appear to have
   * spanning attributes.
   *
   * Both steps are required:
   *   1. renameElement(TD → TH)  — fixes tag type
   *   2. writeScopeAttribute(Column) — fixes Matterhorn 15-003
   *
   * Complex tables (merged cells, id/headers associations) remain HITL.
   *
   * Targets the specific table each issue's id refers to (see
   * findTargetTable) -- previously this walked from the structure tree root
   * and fixed whichever /Table it reached first, regardless of which issue
   * was being processed. Since a batch calls this once per issue against the
   * same mutating doc, that meant only the very first table in document
   * order (across the whole batch) ever received a real fix; every other
   * issue re-found that same now-already-fixed table and reported a false
   * "success" without ever touching the table it was actually about.
   *
   * Does NOT assume row 0 is the real header row -- confirmed wrong on real
   * Math_Kim data: many real tables have one or more LEADING rows that are
   * a running page header or a table caption/title merged into a single
   * spanning cell (real content, e.g. "Table 3.1.1. Math Navigation Chart"),
   * pushing the genuine header row (e.g. "Steps" | "New Problem") down to
   * index 1, 2, or 3. Self-contained at apply time -- computes the MODE
   * cell count across all real rows (the natural proxy for "how many
   * columns does this table actually have", since most rows are real data
   * rows sharing that count) and promotes the first of the first
   * MAX_LEADING_ROWS_TO_SKIP rows whose own cell count matches it, instead
   * of unconditionally targeting row 0. Confirmed via direct measurement:
   * this correctly locates a real header row for 65/101 (64%) of Math_Kim's
   * actual MATTERHORN-15-002 tables (was 0/101 when hardcoded to row 0).
   *
   * @param issues - MATTERHORN-15-002 AuditIssues (simple tables only)
   * @param preResolvedTargets - see resolveTableTargets's own doc comment:
   *   when a caller batches this together with another writer that also
   *   renames same-page /Table elements in the same approval run (e.g.
   *   table-artifact-fix, table-from-layout-fix, table-header-fix-column),
   *   findTargetTable's positional "Nth /Table on this page" indexing can
   *   drift mid-batch -- CodeRabbit finding on PR #560, confirmed real,
   *   same class of bug already fixed for the artifact/layout pair on PR
   *   #554. Pass the whole batch's issues through resolveTableTargets
   *   ONCE, upfront, and thread the result to every writer in play.
   */
  fixSimpleTableHeaders(
    doc: PDFDocument,
    issues: AuditIssue[],
    preResolvedTargets?: Map<string, { dict: PDFDict; ref: PDFRef }>,
  ): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const MAX_LEADING_ROWS_TO_SKIP = 4;
    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const target = preResolvedTargets?.get(issue.id) ?? this.findTargetTable(doc, structRoot, issue.element);
        if (!target) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No Table element found matching "${issue.element}"`,
          });
          continue;
        }
        const table = target.dict;

        const detection = this.detectTableHeaderRow(doc, table, MAX_LEADING_ROWS_TO_SKIP);
        if (!detection.ok) {
          const errorByReason: Record<typeof detection.reason, string> = {
            'no-rows': 'Target table has no TR row to promote headers on',
            'tie': 'No single typical row shape -- row cell counts are evenly split, refusing to guess',
            'no-regular-row': `No row within the first ${MAX_LEADING_ROWS_TO_SKIP} matches this table's typical (${detection.mode}-cell) row shape`,
          };
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: errorByReason[detection.reason],
          });
          continue;
        }
        const { headerRowIndex, rows } = detection;
        const headerRow = rows[headerRowIndex];

        // Count all cells (TD + TH) to determine complexity
        const tds = this.findAllChildren(doc, headerRow.dict, 'TD');
        const ths = this.findAllChildren(doc, headerRow.dict, 'TH');
        const totalCells = tds.length + ths.length;

        if (totalCells === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table\'s header row is empty',
          });
          continue;
        }

        if (tds.length === 0) {
          // Already TH, but don't just trust that -- CodeRabbit finding on
          // PR #560, confirmed real (originally raised against
          // fixSimpleTableColumnHeaders below, same gap exists here):
          // an existing TH could have no /Scope at all, or a conflicting
          // one, and this used to report false "success" without ever
          // checking. writeScopeAttribute is idempotent (creates or
          // replaces), safe to call unconditionally.
          for (const th of ths) this.writeScopeAttribute(doc, th.ref, 'Column');
          results.push({
            issueId: issue.id,
            success: true,
            before: 'Header-row cells tagged as TD',
            after: 'Table headers already present — no changes needed',
          });
          continue;
        }

        let fixedCellCount = 0;
        for (const td of tds) {
          this.renameElement(doc, td.ref, 'TH');
          this.writeScopeAttribute(doc, td.ref, 'Column');
          fixedCellCount++;
        }

        results.push({
          issueId: issue.id,
          success: true,
          before: `Row ${headerRowIndex} cells tagged as TD`,
          after: `Promoted ${fixedCellCount} TD cell(s) at row ${headerRowIndex} to TH with scope="Column"`,
        });
      } catch (err) {
        results.push({
          issueId: issue.id, success: false,
          before: 'unknown', after: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Column-oriented counterpart to fixSimpleTableHeaders: promotes the FIRST
   * cell of EVERY row to TH with scope="Row", instead of every cell of the
   * first row to TH with scope="Column". Used when
   * classifyTableHeaderOrientation (structure-analyzer.service.ts) has
   * already determined -- from real bold-formatting evidence, at suggestion
   * time -- that this specific table's real header is its left column, not
   * its top row (the classic key-value/label-value table shape). The
   * orientation decision is made once, upstream, and threaded through as a
   * distinct suggestionType ('table-header-fix-column'); this method never
   * re-derives orientation itself, since font/bold data isn't available
   * from the struct tree alone at apply time.
   *
   * Walks every TR under the table (direct children, or nested under
   * THead/TBody/TFoot -- same normalization fixSimpleTableHeaders' own
   * first-TR lookup already applies, just for every row instead of one) and
   * renames each row's first TD to TH. A row with zero cells, or whose
   * first cell is already TH, is left alone (not an error) -- unlike
   * fixSimpleTableHeaders' single-first-row check, a genuinely irregular
   * table can have some rows already correct and others not.
   *
   * @param issues - MATTERHORN-15-002 AuditIssues already classified 'column'
   * @param preResolvedTargets - see fixSimpleTableHeaders' own doc comment
   *   on this same parameter; identical cross-batch drift risk applies here.
   */
  fixSimpleTableColumnHeaders(
    doc: PDFDocument,
    issues: AuditIssue[],
    preResolvedTargets?: Map<string, { dict: PDFDict; ref: PDFRef }>,
  ): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const target = preResolvedTargets?.get(issue.id) ?? this.findTargetTable(doc, structRoot, issue.element);
        if (!target) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No Table element found matching "${issue.element}"`,
          });
          continue;
        }
        const table = target.dict;

        const rows = this.collectAllRows(doc, table);

        if (rows.length === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table has no TR rows to promote headers on',
          });
          continue;
        }

        let fixedCellCount = 0;
        let alreadyHeaderCount = 0;
        for (const row of rows) {
          // The row's cell at K-array POSITION 0 -- not "the first TD found
          // by type", which findFirstChild(doc, row.dict, 'TD') would wrongly
          // return even when a TD sits AFTER an already-TH first cell (caught
          // by this method's own test suite: a [TH, TD] row was misidentified
          // as needing the TD promoted, when the real first cell was already
          // correct).
          const firstCell = this.firstKidOfAnyType(doc, row.dict);
          if (!firstCell) continue;
          const tag = firstCell.dict.get(PDFName.of('S'))?.toString().replace(/^\//, '');
          if (tag === 'TD') {
            this.renameElement(doc, firstCell.ref, 'TH');
            this.writeScopeAttribute(doc, firstCell.ref, 'Row');
            fixedCellCount++;
          } else if (tag === 'TH') {
            // Already TH, but don't just trust that -- CodeRabbit finding on
            // PR #560, confirmed real: an existing TH could have no /Scope
            // at all, or a conflicting one, and this used to count it as
            // "complete" without ever checking. writeScopeAttribute is
            // idempotent (creates or replaces), safe to call unconditionally.
            this.writeScopeAttribute(doc, firstCell.ref, 'Row');
            alreadyHeaderCount++;
          }
        }

        if (fixedCellCount === 0 && alreadyHeaderCount === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'No first-cell TD or TH found in any row — nothing to promote',
          });
          continue;
        }

        if (fixedCellCount === 0) {
          results.push({
            issueId: issue.id,
            success: true,
            before: 'First-column cells tagged as TD',
            after: 'Table headers already present — no changes needed',
          });
          continue;
        }

        results.push({
          issueId: issue.id,
          success: true,
          before: 'First-column cells tagged as TD',
          after: `Promoted ${fixedCellCount} TD cell(s) to TH with scope="Row" across ${rows.length} row(s)`,
        });
      } catch (err) {
        results.push({
          issueId: issue.id, success: false,
          before: 'unknown', after: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Matterhorn 15-003 fix: writes /Scope to every EXISTING TH cell in the
   * target table that's missing one, inferred purely from the cell's own
   * position in the table grid — never promotes a TD to TH (that's
   * fixSimpleTableHeaders/fixSimpleTableColumnHeaders's job, for a
   * genuinely different issue). See pdf-table-header-scope.validator.ts's
   * own header comment for the real gap this closes: a TH that's ALREADY
   * correctly tagged (by the document's own producer, or an earlier
   * remediation round) but was never given a Scope attribute at all,
   * confirmed on a real document via the real PAC/axesPAC desktop tool —
   * 708 TH cells across 105 real tables, zero with any Scope.
   *
   * A TH in the header row (row index 0) gets scope="Column" (it describes
   * the column below it); a TH in the header column (column index 0) gets
   * scope="Row". The row-0/col-0 corner cell is genuinely ambiguous by
   * position alone — it's ALSO in row 0 of every plain header-row-only
   * table (the common case: a single header row, TD everywhere else,
   * including column 0) — so its scope is decided by checking for real
   * evidence of a header column elsewhere in the table (a TH at column 0
   * in some row other than row 0) and, symmetrically, real evidence of a
   * header row elsewhere (a TH at row 0 in some column other than column
   * 0): both → scope="Both", header-column evidence only → scope="Row",
   * otherwise (including the plain header-row-only case) → scope="Column".
   * A TH found outside row 0 and column 0 entirely (a genuinely irregular
   * or multi-level-header shape) is deliberately left unscoped rather than
   * guessed at, matching this codebase's own "bail rather than guess"
   * convention — those need Headers/IDs-based association instead, a
   * separate, larger undertaking. A table with a MIX (some fixable, some
   * not) still reports success for the ones that could be fixed. The one
   * exception to "outside row 0/column 0 is always ambiguous": a row whose
   * entire cell shape is TH and matches row 0's TH count exactly is a
   * repeated column-header row (long-table readability convention, not a
   * data row or a two-level header) — see the repeatedHeaderRowIndices
   * comment below for the real data this was built from.
   */
  fixTableHeaderScope(
    doc: PDFDocument,
    issues: AuditIssue[],
    preResolvedTargets?: Map<string, { dict: PDFDict; ref: PDFRef }>,
  ): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const target = preResolvedTargets?.get(issue.id) ?? this.findTargetTable(doc, structRoot, issue.element);
        if (!target) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No Table element found matching "${issue.element}"`,
          });
          continue;
        }

        const rows = this.collectAllRows(doc, target.dict);
        if (rows.length === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table has no TR row',
          });
          continue;
        }

        const rowCells = rows.map(r => this.findAllCellsInOrder(doc, r.dict));

        // Real evidence of headers on each axis, excluding the ambiguous
        // corner cell itself, used to decide the corner's own scope below.
        const hasHeaderColumnBeyondRow0 = rowCells.slice(1).some(cells => cells[0]?.tag === 'TH');
        const hasHeaderRowBeyondCol0 = (rowCells[0] ?? []).slice(1).some(cell => cell.tag === 'TH');

        // A later row whose ENTIRE cell shape is TH, matching row 0's own
        // TH-cell count exactly, is the same column-header row repeated
        // mid-table for long-table readability -- not a data row, and not
        // a two-level group/sub-column header block either. Confirmed real
        // on Math_Weir_PDF.pdf: 3 of its 5 remaining TABLE-HEADER-MISSING-
        // SCOPE tables repeat their header row once (row 34) or twice
        // (rows 34 and 68) every ~34 data rows, accounting for 27 of the
        // 33 real missing-/Scope cells -- retagMultiLevelTableHeaders's
        // group/sub-column detector correctly declines these since there's
        // no group row above them, leaving them to fall through here.
        const row0Cells = rowCells[0] ?? [];
        const row0IsFullHeaderRow = row0Cells.length > 0 && row0Cells.every(c => c.tag === 'TH');
        const repeatedHeaderRowIndices = new Set<number>();
        if (row0IsFullHeaderRow) {
          rowCells.forEach((cells, idx) => {
            if (idx === 0 || cells.length !== row0Cells.length) return;
            if (cells.every(c => c.tag === 'TH')) repeatedHeaderRowIndices.add(idx);
          });
        }

        let fixedCount = 0;
        let skippedCount = 0;
        rowCells.forEach((cells, rowIndex) => {
          cells.forEach((cell, colIndex) => {
            if (cell.tag !== 'TH') return;
            if (this.hasScopeAttributeForFix(doc, cell.dict)) return;

            const isHeaderRow = rowIndex === 0;
            const isHeaderCol = colIndex === 0;
            // colIndex 0 is deliberately excluded here -- it's already
            // covered by isHeaderCol above regardless of which row it's
            // in, and giving it Column scope too would contradict that
            // existing, already-correct handling.
            const isRepeatedHeaderRow = colIndex !== 0 && repeatedHeaderRowIndices.has(rowIndex);
            if (!isHeaderRow && !isHeaderCol && !isRepeatedHeaderRow) { skippedCount++; return; }

            let scope: 'Row' | 'Column' | 'Both';
            if (isHeaderRow && isHeaderCol) {
              scope = hasHeaderColumnBeyondRow0
                ? (hasHeaderRowBeyondCol0 ? 'Both' : 'Row')
                : 'Column';
            } else if (isRepeatedHeaderRow) {
              scope = 'Column';
            } else {
              scope = isHeaderRow ? 'Column' : 'Row';
            }

            this.writeScopeAttribute(doc, cell.ref, scope);
            fixedCount++;
          });
        });

        // Cells outside row 0/column 0 (skippedCount above) are exactly
        // pdf-table-header-scope.validator.ts's own "genuinely multi-level
        // header" case -- a Scope value can't correctly describe a cell
        // that's neither the header row nor the header column. Attempt
        // Headers/IDs-based association instead, Matterhorn 15-003's OTHER
        // accepted organization: see retagMultiLevelTableHeaders's own doc
        // comment for the real, recurring two-level shape this closes.
        const headersIdsDataCells = skippedCount > 0
          ? this.retagMultiLevelTableHeaders(doc, rowCells, issue.element ?? issue.id, issue.pageNumber)
          : 0;

        if (fixedCount === 0 && headersIdsDataCells === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: `${skippedCount} TH cell(s) missing /Scope`, after: 'unknown',
            error: skippedCount > 0
              ? `All ${skippedCount} missing-/Scope TH cell(s) are outside row 0/column 0, and no recognizable multi-level header block was found to Headers/IDs-tag instead`
              : 'No TH cells missing /Scope found on this table (already fixed or moved)',
          });
          continue;
        }

        const parts: string[] = [];
        if (fixedCount > 0) parts.push(`${fixedCount} TH cell(s) now have /Scope`);
        if (headersIdsDataCells > 0) parts.push(`${headersIdsDataCells} data cell(s) now have /Headers (multi-level header block)`);
        const remainingUnhandled = skippedCount > 0 && headersIdsDataCells === 0 ? skippedCount : 0;
        if (remainingUnhandled > 0) parts.push(`${remainingUnhandled} outside row 0/column 0 left unscoped`);

        results.push({
          issueId: issue.id,
          success: true,
          before: `${fixedCount + skippedCount} TH cell(s) missing /Scope`,
          after: parts.join('; '),
        });
      } catch (err) {
        results.push({
          issueId: issue.id, success: false,
          before: 'unknown', after: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Retags a table's genuine two-level "group header + sub-column header"
   * blocks with Headers/IDs association — Matterhorn 15-003's OTHER
   * accepted table organization, alongside plain Scope — closing the exact
   * gap fixTableHeaderScope's own "outside row 0/column 0" bail exists to
   * document. Confirmed real on Math_Weir_PDF.pdf: every one of its 20
   * residual tables (215 TH cells) shares ONE recurring shape — a corner
   * plus a single group-header cell in one row, immediately followed by a
   * row-label cell plus N sub-column-header cells in the next row —
   * sometimes repeated multiple times within the SAME physical table for
   * long-table readability (confirmed live: a 110-row table repeats this
   * block three times, at rows 0-1/38-39/76-77, accounting for exactly its
   * 32 real missing cells — 10+1+10+1+10).
   *
   * Scans the WHOLE table, not only row 0, since a repeated block can
   * start anywhere. For each detected block: assigns a unique /ID to the
   * row-label header, each group header, and each sub-column header
   * (skipped if an /ID is already present — idempotent, safe to call
   * again), then sets /Headers on every data cell between this block and
   * the next one (or the table's end) to reference the row-label header's
   * own ID plus the covering group header's ID and the specific
   * sub-column header's ID for that cell's column. A column-0 data cell
   * (the row's own label value, e.g. "Group A") references only the
   * row-label header, mirroring what a plain Scope="Row" would mean for
   * that same cell.
   *
   * Multiple group cells in one block are only handled when every one of
   * them carries an explicit /ColSpan summing exactly to the sub-header
   * count, OR none of them carry /ColSpan at all — in which case real
   * group boundaries are established from each header cell's own on-page
   * geometry instead (see mapSubColumnsToGroupsByGeometry); any other
   * shape (a partial mix, or spans that don't add up) is genuinely
   * ambiguous and the block is left entirely untouched rather than
   * guessing. Confirmed real on Math_Weir_PDF.pdf: most blocks have
   * exactly one group cell, which trivially "spans" every sub-column with
   * no ambiguity at all; table_p269_0 ("TABLE 16.4", 3 groups —
   * "Good"/"Average"/"Poor" — each covering an "Observed"/"Expected" pair,
   * no /ColSpan on any of them) is the geometry-resolved case.
   */
  private retagMultiLevelTableHeaders(
    doc: PDFDocument,
    rowCells: Array<Array<{ dict: PDFDict; ref: PDFRef; tag: string }>>,
    idPrefix: string,
    pageNumber: number | undefined,
  ): number {
    let taggedDataCells = 0;
    let blockCounter = 0;
    let i = 0;

    while (i < rowCells.length - 1) {
      const groupRow = rowCells[i];
      const subRow = rowCells[i + 1];
      const block = this.classifyHeaderBlock(groupRow, subRow, rowCells[i + 2]);
      if (!block) { i++; continue; }

      // Idempotent: a block already retagged has its row-label header's own /ID.
      if (this.hasIdForFix(subRow[0].dict)) { i += 2; continue; }

      const subToGroupIndex = this.mapSubColumnsToGroups(doc, pageNumber, groupRow, subRow, block);
      if (!subToGroupIndex) { i += 2; continue; }

      blockCounter++;
      const idFor = (role: string) => `hdrid_${idPrefix}_${blockCounter}_${role}`;

      const rowLabelId = this.writeIdAttributeForFix(subRow[0].dict, idFor('rowlabel'));
      const groupIds = block.groupIndices.map((gi, k) => this.writeIdAttributeForFix(groupRow[gi].dict, idFor(`group${k}`)));
      const subIds = block.subIndices.map((si, k) => this.writeIdAttributeForFix(subRow[si].dict, idFor(`sub${k}`)));

      // This block's data range: rows after subRow, up to (not including)
      // the next detected block, or the table's end.
      let dataEnd = rowCells.length;
      for (let j = i + 2; j < rowCells.length - 1; j++) {
        if (this.classifyHeaderBlock(rowCells[j], rowCells[j + 1], rowCells[j + 2])) { dataEnd = j; break; }
      }

      for (let r = i + 2; r < dataEnd; r++) {
        rowCells[r].forEach((cell, colIndex) => {
          if (colIndex === 0) {
            this.writeHeadersAttributeForFix(doc, cell.ref, [rowLabelId]);
          } else {
            const subPos = colIndex - 1;
            if (subPos >= subIds.length) return; // a ragged row beyond the header's own shape — skip defensively
            const headerIds = [rowLabelId, groupIds[subToGroupIndex[subPos]], subIds[subPos]];
            this.writeHeadersAttributeForFix(doc, cell.ref, headerIds);
          }
          taggedDataCells++;
        });
      }

      i = dataEnd;
    }

    return taggedDataCells;
  }

  /**
   * True if (groupRow, subRow) looks like a genuine two-level header block:
   * groupRow = [corner(TH), group-header(TH), ...], subRow = [row-label(TH),
   * sub-column-header(TH), ...], with strictly fewer real group cells than
   * real sub-column cells (equal counts would mean each "group" trivially
   * covers exactly one sub-column — not a real hierarchy, and safer to
   * leave alone than misclassify). When a first data row is available, its
   * own cell count must match subRow's — a sanity check against misfiring
   * on an unrelated pair of rows that merely both happen to start with TH.
   */
  private classifyHeaderBlock(
    groupRow: Array<{ tag: string }> | undefined,
    subRow: Array<{ tag: string }> | undefined,
    firstDataRow: Array<{ tag: string }> | undefined,
  ): { groupIndices: number[]; subIndices: number[] } | null {
    if (!groupRow || !subRow) return null;
    const groupThIndices = groupRow.map((c, idx) => (c.tag === 'TH' ? idx : -1)).filter(idx => idx >= 0);
    const subThIndices = subRow.map((c, idx) => (c.tag === 'TH' ? idx : -1)).filter(idx => idx >= 0);

    if (groupThIndices.length < 2 || groupThIndices[0] !== 0) return null;
    if (subThIndices.length < 2 || subThIndices[0] !== 0) return null;

    const groupIndices = groupThIndices.slice(1);
    const subIndices = subThIndices.slice(1);
    if (groupIndices.length >= subIndices.length) return null;

    if (firstDataRow && firstDataRow.length !== subRow.length) return null;

    return { groupIndices, subIndices };
  }

  /**
   * Maps each real sub-column position (0-based) to the index (into
   * block.groupIndices) of the group cell that covers it. A single group
   * cell trivially covers every sub-column — the shape confirmed for most
   * real blocks found on Math_Weir_PDF.pdf. Multiple group cells are
   * mapped in one of two ways:
   *   1. Every group cell carries an explicit /ColSpan and those spans sum
   *      exactly to the sub-column count — used verbatim.
   *   2. NO group cell carries /ColSpan at all — real, evidence-based group
   *      boundaries are established from each header cell's own on-page
   *      geometry instead (see mapSubColumnsToGroupsByGeometry). CodeRabbit
   *      finding on PR #593, confirmed real: an earlier version of this
   *      inferred an even split purely from divisibility (subCount %
   *      groupCount === 0) with no positional evidence at all — a table
   *      with, say, 1 and 3 real sub-columns under two groups would also
   *      pass that check and get an incorrect 2-2 split reported as
   *      success. Confirmed real on Math_Weir_PDF.pdf's table_p269_0: 3
   *      groups ("Good"/"Average"/"Poor"), 6 sub-columns ("Observed"/
   *      "Expected" ×3), no /ColSpan anywhere — the geometry path resolves
   *      it correctly using each header's own rendered X-position, not an
   *      assumption about the count alone.
   * Any other shape (a partial mix of some group cells carrying /ColSpan
   * and others not, spans that don't add up, or geometry that can't be
   * located or doesn't cleanly partition) is genuinely ambiguous and
   * returns null rather than guessing a split.
   */
  private mapSubColumnsToGroups(
    doc: PDFDocument,
    pageNumber: number | undefined,
    groupRow: Array<{ dict: PDFDict }>,
    subRow: Array<{ dict: PDFDict }>,
    block: { groupIndices: number[]; subIndices: number[] },
  ): number[] | null {
    const subCount = block.subIndices.length;
    const groupCount = block.groupIndices.length;
    if (groupCount === 1) return new Array(subCount).fill(0);

    const spans = block.groupIndices.map(gi => this.readColSpanForFix(doc, groupRow[gi].dict));

    if (spans.every(sp => sp !== null && sp > 0)) {
      const nonNullSpans = spans as number[];
      const total = nonNullSpans.reduce((a, b) => a + b, 0);
      if (total !== subCount) return null;
      const mapping: number[] = [];
      nonNullSpans.forEach((span, groupIdx) => {
        for (let k = 0; k < span; k++) mapping.push(groupIdx);
      });
      return mapping;
    }

    if (spans.every(sp => sp === null)) {
      return this.mapSubColumnsToGroupsByGeometry(doc, pageNumber, groupRow, subRow, block);
    }

    return null;
  }

  /**
   * Establishes real group-to-subcolumn boundaries from each header cell's
   * own on-page geometry (via mcid-bounding-box.ts's locateMcidBoundingBoxes)
   * when no /ColSpan is present to declare them explicitly — replaces a
   * blind divisibility guess with real evidence (see mapSubColumnsToGroups's
   * own doc comment for the CodeRabbit finding this closes). Each
   * sub-column is assigned to whichever group header's own real X center is
   * CLOSEST (nearest-neighbor by absolute distance) — not "the nearest
   * group to its left," which was this method's first, incorrect attempt:
   * confirmed real on Math_Weir_PDF.pdf's table_p269_0 that a group header
   * (e.g. "Average") is CENTERED over its own two sub-columns, so its own
   * anchor sits numerically BETWEEN its "Observed" and "Expected"
   * sub-headers, not to the left of both — a "nearest to the left" rule
   * mis-assigned every group's own FIRST sub-column to the PREVIOUS group
   * instead (live-caught before merge via a full re-audit round trip, not
   * assumed correct from "success: true" alone). Nearest-by-distance is the
   * correct general rule regardless of whether a producer left-aligns,
   * centers, or right-aligns its group-header text over its sub-columns.
   *
   * Declines (returns null) whenever the evidence is incomplete rather
   * than guessing: the page's content stream can't be decoded, any header
   * cell carries no locatable MCID geometry at all, the resulting
   * assignment leaves any group with zero sub-columns (a real group must
   * cover at least one), or the assignment isn't monotonically
   * non-decreasing left to right (a sub-column assigned to an EARLIER
   * group than the one before it means the struct tree's own /K order
   * doesn't match real reading order — too unusual a shape to trust).
   */
  private mapSubColumnsToGroupsByGeometry(
    doc: PDFDocument,
    pageNumber: number | undefined,
    groupRow: Array<{ dict: PDFDict }>,
    subRow: Array<{ dict: PDFDict }>,
    block: { groupIndices: number[]; subIndices: number[] },
  ): number[] | null {
    if (pageNumber === undefined) return null;
    const content = decodePageContent(doc, pageNumber);
    if (!content) return null;

    const groupMcids = block.groupIndices.map(gi => this.collectCellMcids(doc, groupRow[gi].dict));
    const subMcids = block.subIndices.map(si => this.collectCellMcids(doc, subRow[si].dict));

    const allMcids = new Set<number>();
    for (const list of [...groupMcids, ...subMcids]) for (const m of list) allMcids.add(m);
    if (allMcids.size === 0) return null;

    // allowSinglePointBoxes: true -- these header cells are almost always a
    // single short word (e.g. "Good", "Observed") with no accompanying
    // leader line or clip rect, so their own real content IS a true single
    // point in practice. Only an X position is needed here to order cells
    // relative to each other, not a real croppable area.
    const boxes = locateMcidBoundingBoxes(content, allMcids, { allowSinglePointBoxes: true });

    const mergedXCenter = (mcids: number[]): number | null => {
      let minX = Infinity, maxX = -Infinity, found = false;
      for (const m of mcids) {
        const box = boxes.get(m);
        if (!box) continue;
        found = true;
        if (box.minX < minX) minX = box.minX;
        if (box.maxX > maxX) maxX = box.maxX;
      }
      return found ? (minX + maxX) / 2 : null;
    };

    const groupCenters = groupMcids.map(mergedXCenter);
    const subCenters = subMcids.map(mergedXCenter);
    if (groupCenters.some(c => c === null) || subCenters.some(c => c === null)) return null;

    const mapping: number[] = [];
    const assignedCount = new Array(block.groupIndices.length).fill(0);
    for (const subCenter of subCenters as number[]) {
      let bestIdx = 0;
      let bestDist = Infinity;
      (groupCenters as number[]).forEach((groupCenter, idx) => {
        const dist = Math.abs(groupCenter - subCenter);
        if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
      });
      mapping.push(bestIdx);
      assignedCount[bestIdx]++;
    }

    if (assignedCount.some(c => c === 0)) return null;
    for (let i = 1; i < mapping.length; i++) {
      if (mapping[i] < mapping[i - 1]) return null;
    }

    return mapping;
  }

  /**
   * All numeric MCIDs reachable from a struct element's own /K — bare
   * numbers, array entries, MCR dict /MCID values (resolving indirect
   * refs, mirroring structElemHasMcid's own resolution), AND, up to
   * `maxDepth` levels, a nested CHILD STRUCT ELEMENT's own /K. Confirmed
   * real and necessary on Math_Weir_PDF.pdf's table_p269_0: a header TH
   * cell's own /K is not a bare MCID at all, but a ref to an InDesign
   * `/tsp` ("text span") struct element one level down, whose OWN /K is
   * the real MCID -- an earlier version of this method that only looked at
   * the cell's own /K found zero geometry for every real header cell in
   * this table, silently declining the whole multi-level-header retagging
   * this was built for. Depth-limited (not unbounded) purely as a
   * defensive bound against a malformed or cyclic tree; every real sample
   * seen is a single level of /tsp nesting.
   */
  private collectCellMcids(doc: PDFDocument, cell: PDFDict, maxDepth = 4): number[] {
    const mcids: number[] = [];
    const visit = (item: unknown, depth: number): void => {
      if (depth <= 0) return;
      const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (resolved instanceof PDFNumber) { mcids.push(resolved.asNumber()); return; }
      if (resolved instanceof PDFArray) {
        for (const entry of resolved.asArray()) visit(entry, depth);
        return;
      }
      if (resolved instanceof PDFDict) {
        const mRaw = resolved.get(PDFName.of('MCID'));
        const m = mRaw instanceof PDFRef ? doc.context.lookup(mRaw) : mRaw;
        if (m instanceof PDFNumber) { mcids.push(m.asNumber()); return; }
        const nestedK = resolved.get(PDFName.of('K'));
        if (nestedK !== undefined) visit(nestedK, depth - 1);
      }
    };
    visit(cell.get(PDFName.of('K')), maxDepth);
    return mcids;
  }

  /** The /ColSpan value from an element's Table-owner attribute dict, or null if absent. */
  private readColSpanForFix(doc: PDFDocument, elem: PDFDict): number | null {
    const aRaw = elem.get(PDFName.of('A'));
    const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
    const items = a instanceof PDFArray ? a.asArray() : a ? [a] : [];
    for (const item of items) {
      const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (resolved instanceof PDFDict) {
        const cs = resolved.get(PDFName.of('ColSpan'));
        if (cs instanceof PDFNumber) return cs.asNumber();
      }
    }
    return null;
  }

  /** True if the structure element already carries its own /ID (direct dict entry, not inside /A). */
  private hasIdForFix(elem: PDFDict): boolean {
    return elem.get(PDFName.of('ID')) !== undefined;
  }

  /**
   * Writes /ID directly on the structure element (ISO 32000-1 §14.7.2 —
   * NOT inside /A; /ID identifies the element itself, independent of any
   * table attribute). Never overwrites an existing /ID, matching this
   * method's own idempotency contract — and returns whichever id ends up
   * in effect (the pre-existing one, decoded, if present; otherwise the
   * newly written one), so a caller building a /Headers reference to this
   * exact element always points at what's REALLY there. CodeRabbit finding
   * on PR #584, confirmed real: a caller that instead used its own
   * locally-generated id regardless of this method's own no-op decision
   * would write a /Headers array referencing a value absent from the
   * header cell it's supposed to describe — a dangling reference reported
   * as a success.
   */
  private writeIdAttributeForFix(elem: PDFDict, id: string): string {
    const existing = elem.get(PDFName.of('ID'));
    // Decoded PLAIN TEXT, not existing.toString()'s bracketed PDF-syntax
    // representation -- callers re-encode whatever this returns via
    // PDFHexString.fromText for /Headers, and encoding an already-encoded
    // string would double-encode it (a real bug caught by this method's
    // own regression tests: every /Headers reference came out wrapped in
    // an extra, spurious layer of hex).
    if (existing instanceof PDFHexString || existing instanceof PDFString) return existing.decodeText();
    if (existing !== undefined) return existing.toString();
    elem.set(PDFName.of('ID'), PDFHexString.fromText(id));
    return id;
  }

  /**
   * Writes /Headers to the element's /A (attributes) array, inside the
   * same Table-owner dict /Scope/ColSpan/RowSpan live in — mirroring
   * writeScopeAttribute's own find-or-create logic exactly, just for a
   * different key. Each header id is encoded as a hex string, matching
   * writeIdAttributeForFix's own encoding — /Headers values must
   * byte-for-byte match the referenced elements' own /ID.
   */
  private writeHeadersAttributeForFix(doc: PDFDocument, elementRef: PDFRef, headerIds: string[]): void {
    const elem = doc.context.lookup(elementRef);
    if (!(elem instanceof PDFDict)) return;
    const headersArray = doc.context.obj(headerIds.map(id => PDFHexString.fromText(id)));

    const aRaw = elem.get(PDFName.of('A'));
    if (!aRaw) {
      const attrRef = doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: headersArray }));
      elem.set(PDFName.of('A'), doc.context.obj([attrRef]));
      return;
    }
    if (aRaw instanceof PDFArray) {
      for (const item of aRaw.asArray()) {
        const obj = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (obj instanceof PDFDict && obj.get(PDFName.of('O'))?.toString() === '/Table') {
          obj.set(PDFName.of('Headers'), headersArray);
          return;
        }
      }
      aRaw.push(doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: headersArray })));
      return;
    }
    if (aRaw instanceof PDFRef) {
      const aObj = doc.context.lookup(aRaw);
      if (aObj instanceof PDFDict && aObj.get(PDFName.of('O'))?.toString() === '/Table') {
        aObj.set(PDFName.of('Headers'), headersArray);
        return;
      }
      elem.set(PDFName.of('A'), doc.context.obj([aRaw, doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: headersArray }))]));
      return;
    }
    // /A can also be a single direct dict (a legal singleton, not wrapped
    // in an array or an indirect ref) -- CodeRabbit finding on PR #584,
    // confirmed real: the previous fallback here unconditionally REPLACED
    // /A with a brand-new Headers-only array, silently discarding whatever
    // this direct dict already held (e.g. a real /RowSpan or /ColSpan, or
    // another owner's attributes entirely). Mutate it in place when it's
    // already the /Table owner, matching the PDFRef branch's own logic;
    // otherwise wrap it alongside a new Headers-only dict rather than
    // dropping it.
    if (aRaw instanceof PDFDict) {
      if (aRaw.get(PDFName.of('O'))?.toString() === '/Table') {
        aRaw.set(PDFName.of('Headers'), headersArray);
        return;
      }
      elem.set(PDFName.of('A'), doc.context.obj([aRaw, doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: headersArray }))]));
      return;
    }
    elem.set(PDFName.of('A'), doc.context.obj([doc.context.register(doc.context.obj({ O: PDFName.of('Table'), Headers: headersArray }))]));
  }

  /** Every direct cell (TD or TH) of a row, in original /K order, tagged with which. */
  private findAllCellsInOrder(doc: PDFDocument, row: PDFDict): Array<{ dict: PDFDict; ref: PDFRef; tag: string }> {
    const results: Array<{ dict: PDFDict; ref: PDFRef; tag: string }> = [];
    const k = row.get(PDFName.of('K'));
    const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
    for (const kid of kids) {
      if (!(kid instanceof PDFRef)) continue;
      const resolved = doc.context.lookup(kid);
      if (!(resolved instanceof PDFDict)) continue;
      const tag = resolved.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (tag === 'TD' || tag === 'TH') results.push({ dict: resolved, ref: kid, tag });
    }
    return results;
  }

  /**
   * True if the element's /A (attributes) already carries a Table-owner
   * dict with a /Scope entry. Requires /O === /Table specifically, mirroring
   * pdf-table-header-scope.validator.ts's own hasScopeAttribute (CodeRabbit
   * finding on PR #582, confirmed real: a differently-owned attribute dict
   * that happens to carry a same-named "Scope" key must not be misread as
   * already satisfying Matterhorn 15-003).
   */
  private hasScopeAttributeForFix(doc: PDFDocument, elem: PDFDict): boolean {
    const aRaw = elem.get(PDFName.of('A'));
    const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
    const check = (d: unknown): boolean =>
      d instanceof PDFDict && d.get(PDFName.of('O'))?.toString() === '/Table' && d.get(PDFName.of('Scope')) !== undefined;
    if (check(a)) return true;
    if (a instanceof PDFArray) {
      for (const item of a.asArray()) {
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (check(resolved)) return true;
      }
    }
    return false;
  }

  /**
   * Finds (or creates) the PDF 2.0 (ISO 32000-2) standard structure
   * namespace entry in /StructTreeRoot's /Namespaces array, returning its
   * ref so a caller can bind an element to it via that element's own /NS
   * entry.
   *
   * ONLY used by buildTableFromLayout's own ParentTree-wiring-failure
   * rollback (the one spot left after markTableAsArtifact and this
   * method's other former caller were switched to deleteElement instead --
   * see markTableAsArtifact's own doc comment for why: a real PAC report
   * found PAC 26.1.0.0 doesn't recognize this namespace mechanism at all,
   * regardless of how correctly it's bound, so an /S /Artifact struct
   * element built this way still fails PAC's "Role mapping" check every
   * time). That rollback path is different from the two deleted-instead
   * callers: it's inertifying a table that was just built from REAL
   * layout-detected content with genuine MCID-tagged children, not an
   * always-empty decorative box -- deleting it outright would leave those
   * children's content-stream MCID tags orphaned (unresolvable via
   * /ParentTree), a worse defect than the known PAC gap this still carries.
   * Converting that content-stream region to a proper tag-free /Artifact
   * span instead of relying on this namespace trick would close that gap
   * too, but is real additional content-stream-splice work out of scope
   * for this pass -- this path is a rare, "accepted residual risk" failure
   * fallback (see its own call site), not a proven-live defect the way the
   * two deleted-instead cases were.
   */
  private getOrCreatePdf2Namespace(doc: PDFDocument, structRoot: PDFDict): PDFRef {
    const PDF2_STRUCTURE_NAMESPACE_URI = 'http://iso.org/pdf2/ssn';
    doc.catalog.set(PDFName.of('Version'), PDFName.of('2.0'));

    const existing = structRoot.get(PDFName.of('Namespaces'));
    const nsRefs: PDFRef[] = existing instanceof PDFArray
      ? existing.asArray().filter((n): n is PDFRef => n instanceof PDFRef)
      : [];

    for (const ref of nsRefs) {
      const ns = doc.context.lookup(ref);
      if (ns instanceof PDFDict) {
        const uri = ns.get(PDFName.of('NS'));
        if (uri instanceof PDFString && uri.decodeText() === PDF2_STRUCTURE_NAMESPACE_URI) return ref;
      }
    }

    const nsRef = doc.context.register(doc.context.obj({
      Type: PDFName.of('Namespace'),
      NS: PDFString.of(PDF2_STRUCTURE_NAMESPACE_URI),
    }));
    structRoot.set(PDFName.of('Namespaces'), doc.context.obj([...nsRefs, nsRef]));
    return nsRef;
  }

  /**
   * Extends a page's /ParentTree entry with new MCID -> owning-struct-element
   * mappings -- the reverse direction of a struct element's own /K (which
   * points forward, element -> MCID). Slice 2c of the MATTERHORN-15-001
   * from-scratch retagger: the CALLER (Slice 2d's skeleton assembly) owns
   * setting /K on the struct elements these refs point to; this method has
   * no opinion on that and doesn't need to look at it.
   *
   * Live-confirmed shape (Math_Kim): /StructTreeRoot's /ParentTree is an
   * INDIRECT dict with an inline /Nums number-tree array (flat
   * [key1, value1, key2, value2, ...], ascending by key). A page's own
   * /StructParents integer (read from the page dict here -- NEVER assumed
   * to equal pageNumber - 1, even though that happens to hold on Math_Kim)
   * is the key. The matching value is itself an inline PDFArray of refs,
   * positionally indexed by MCID (value[3] = the struct element owning MCID
   * 3 on that page) -- confirmed live against Math_Kim page 25's real
   * 12-entry array, including duplicate refs where multiple MCIDs share one
   * owning element (e.g. several marked-content spans under one /Span).
   *
   * Appending to an EXISTING page array is only correct because new MCIDs
   * are allocated starting at the page's existing max + 1 (see
   * table-content-tagger.ts's insertMarkedContentSpans, Slice 2b) --
   * appending preserves the "array index == MCID" invariant the whole
   * number tree depends on. Enforced here too: every requested MCID must
   * land at exactly the next contiguous index (existing array's current
   * length, then +1, +2, ...), or this throws rather than silently writing
   * a self-inconsistent number tree (this file's established "bail rather
   * than guess" convention). Same contiguity requirement applies when
   * creating a page's FIRST entry (must start at MCID 0) -- a fresh array
   * with a gap at the front is exactly as broken as one with a gap in the
   * middle.
   *
   * /StructTreeRoot's /ParentTreeNextKey is a DIFFERENT PDF mechanism
   * (assigning /StructParent keys to standalone objects like Link
   * annotations, confirmed via zone-extractor/seam-c/struct-tree-builder.ts's
   * own usage) -- page-content MCIDs are keyed by /StructParents, not by
   * this counter, so this method has no reason to read or write it EXCEPT
   * when introducing a brand-new page key that could violate the counter's
   * own "always greater than every key in the tree" invariant; see the
   * new-page-entry path below. Never creates /ParentTreeNextKey from
   * nothing, and never touches it when extending an ALREADY-existing
   * page's array (that path introduces no new top-level key).
   *
   * Rejects (throws on) one /ParentTree shape rather than handling it,
   * intentionally out of scope until live validation (Slice 2d) actually
   * hits it: a page's existing /ParentTree value being something OTHER
   * than an array (e.g. a lone dict/ref for a page that historically used
   * exactly one MCID -- promoting it to array form is unverified
   * guesswork).
   *
   * A hierarchical /Kids number tree (PDF32000 7.9.7 -- real documents with
   * many pages split one giant /Nums array into several /Limits-bounded
   * leaves to keep each node small) IS supported: findParentTreeLeafNums
   * walks /Kids, at any depth, to the leaf whose /Limits covers the page's
   * key, and extendParentTree's own append/insert logic runs against that
   * leaf's /Nums exactly as it would against a flat root /Nums. Confirmed
   * against a real document (Karsaklian_189165): 5 leaves, /Limits
   * [0,31]/[32,63]/[64,95]/[96,127]/[128,177], 178 entries total -- fixing
   * 11 permanently-failed link-missing-annotation-fix suggestions that
   * previously declined outright (PR #551's original "real, separate work"
   * deferral). Still declines (never guesses) when no leaf's /Limits
   * covers the requested key -- see findParentTreeLeafNums's own doc
   * comment for why that residual case isn't attempted.
   */
  /**
   * Resolves (creating if wholly absent) the page's /StructParents key and
   * /StructTreeRoot /ParentTree /Nums array, validating every document-shape
   * assumption extendParentTree depends on -- WITHOUT touching any specific
   * entries. Split out from extendParentTree so a caller (buildTableFromLayout)
   * can preflight "would this page's ParentTree even accept new entries" BEFORE
   * committing to a content-stream mutation, rather than discovering a shape
   * problem only after inserting real MCIDs with nowhere to wire them
   * (CodeRabbit finding on PR #552, confirmed real: the previous preflight only
   * covered findTargetTable/parent resolution, not ParentTree shape).
   *
   * Every failure mode here is a property of the DOCUMENT as it already
   * stands -- knowable before any entries are considered, unlike the
   * contiguity checks in extendParentTree itself, which depend on what's
   * being requested and can only be evaluated once real MCIDs exist (see
   * extendParentTree's own doc comment for why that residual case is
   * accepted, not preflighted).
   */
  private resolveParentTreeNumsArray(doc: PDFDocument, pageNumber: number): { numsArr: PDFArray; pageKey: number } {
    const page = doc.getPage(pageNumber - 1);
    const structParentsRaw = page.node.get(PDFName.of('StructParents'));
    const structParents = structParentsRaw instanceof PDFRef ? doc.context.lookup(structParentsRaw) : structParentsRaw;
    if (!(structParents instanceof PDFNumber)) {
      throw new Error(`extendParentTree: page ${pageNumber} has no /StructParents entry -- cannot locate its ParentTree slot.`);
    }
    const pageKey = structParents.asNumber();

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      throw new Error('extendParentTree: no structure tree root found');
    }

    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    let parentTreeDict: PDFDict;
    if (parentTreeRaw) {
      const looked = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
      if (!(looked instanceof PDFDict)) {
        throw new Error('extendParentTree: /StructTreeRoot /ParentTree does not resolve to a dictionary');
      }
      parentTreeDict = looked;
    } else {
      parentTreeDict = doc.context.obj({ Nums: doc.context.obj([]) }) as PDFDict;
      structRoot.set(PDFName.of('ParentTree'), doc.context.register(parentTreeDict));
    }

    const numsRaw = parentTreeDict.get(PDFName.of('Nums'));
    let numsArr: PDFArray;
    if (numsRaw) {
      const looked = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
      if (!(looked instanceof PDFArray)) {
        throw new Error('extendParentTree: /ParentTree /Nums does not resolve to an array');
      }
      numsArr = looked;
    } else {
      // A number-tree node has EITHER /Kids (an intermediate/root node in a
      // multi-level hierarchical tree -- real documents with very many
      // pages use this to avoid one giant flat array) OR /Nums (a leaf
      // node with actual key-value pairs), never both. When /Kids is
      // present, the real page mapping lives under one of its leaves, not
      // here -- walk to it rather than blindly adding an empty /Nums
      // beside /Kids (which would never find the real mapping and would
      // produce an invalid node carrying both keys).
      const kidsRaw = parentTreeDict.get(PDFName.of('Kids'));
      if (kidsRaw) {
        numsArr = this.findParentTreeLeafNums(doc, parentTreeDict, pageKey);
      } else {
        numsArr = doc.context.obj([]) as unknown as PDFArray;
        parentTreeDict.set(PDFName.of('Nums'), numsArr);
      }
    }

    return { numsArr, pageKey };
  }

  /**
   * The real, authoritative "how many MCID slots has this page already
   * used" count -- the per-page /ParentTree array's own current length.
   * Returns 0 when the page has no existing entry yet (equivalent to "no
   * constraint", matching what a brand-new page's content-stream-derived
   * MCID count would already compute on its own).
   *
   * Exists because a struct element can occupy a /ParentTree slot without
   * ever writing a literal "/MCID n" BDC span into the content stream (e.g.
   * one registered directly by a prior extendParentTree call elsewhere) --
   * a scan of the content stream's own text (pageContentMcids,
   * insertMarkedContentSpans's own default allocation) can then undercount
   * the real next-available MCID. Real incident
   * (Karsaklian_189165_9781606497623.pdf, page 74, 2026-11-09):
   * buildFigureFromImage's content-stream-derived "next MCID" computed
   * 2557, but the page's real /ParentTree array already had 2559 entries
   * (slots 2557/2558 claimed by an earlier ACTUALTEXT-MISSING-MCID fix that
   * never wrote a matching literal BDC span) -- extendParentTree's own
   * contiguity guard correctly refused rather than silently misaligning the
   * array, failing the whole apply. Callers that can cheaply know this real
   * count up front (buildFigureFromImage already resolves the array for its
   * own preflight) should pass it to insertMarkedContentSpans as a floor.
   */
  private getPageParentTreeArraySize(doc: PDFDocument, pageNumber: number): number {
    const { numsArr, pageKey } = this.resolveParentTreeNumsArray(doc, pageNumber);
    const raw = numsArr.asArray();
    for (let i = 0; i < raw.length; i += 2) {
      const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
      if (keyObj instanceof PDFNumber && keyObj.asNumber() === pageKey) {
        const valueRaw = raw[i + 1];
        const valueResolved = valueRaw instanceof PDFRef ? doc.context.lookup(valueRaw) : valueRaw;
        return valueResolved instanceof PDFArray ? valueResolved.size() : 0;
      }
    }
    return 0;
  }

  /**
   * Recursively walks a hierarchical /ParentTree number-tree node's /Kids
   * chain (PDF32000 7.9.7 -- arbitrary depth is legal; a node has /Kids
   * XOR /Nums, never both) to the leaf whose /Limits range covers pageKey,
   * returning that leaf's /Nums array for extendParentTree to append/
   * insert into exactly as it would a flat root /Nums.
   *
   * Only ever LOCATES an existing leaf -- never creates one, never
   * rebalances /Limits, never merges/splits nodes. If no leaf's /Limits
   * covers pageKey, that page genuinely has no slot anywhere in the tree
   * yet; deciding which leaf should absorb a brand-new key (and updating
   * that leaf's own /Limits to cover it) is real tree-maintenance work
   * this method doesn't attempt -- bail rather than guess, matching this
   * file's established convention. Not expected to matter in practice for
   * extendParentTree's own callers: every real case found so far (link-
   * missing-annotation-fix, table/figure retagging) extends a page that
   * already has SOME tagged content, so its key already has a leaf.
   */
  private findParentTreeLeafNums(doc: PDFDocument, node: PDFDict, pageKey: number): PDFArray {
    const numsRaw = node.get(PDFName.of('Nums'));
    if (numsRaw) {
      const looked = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
      if (!(looked instanceof PDFArray)) {
        throw new Error("extendParentTree: a /ParentTree leaf node's /Nums does not resolve to an array");
      }
      return looked;
    }

    const kidsRaw = node.get(PDFName.of('Kids'));
    if (!kidsRaw) {
      throw new Error('extendParentTree: a /ParentTree number-tree node has neither /Nums nor /Kids');
    }
    const kidsLooked = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
    if (!(kidsLooked instanceof PDFArray)) {
      throw new Error('extendParentTree: /ParentTree /Kids does not resolve to an array');
    }

    for (const kidRaw of kidsLooked.asArray()) {
      const kidDict = kidRaw instanceof PDFRef ? doc.context.lookup(kidRaw) : kidRaw;
      if (!(kidDict instanceof PDFDict)) continue;

      const limitsRaw = kidDict.get(PDFName.of('Limits'));
      const limits = limitsRaw instanceof PDFRef ? doc.context.lookup(limitsRaw) : limitsRaw;
      if (!(limits instanceof PDFArray) || limits.size() !== 2) continue;

      const lo = limits.get(0);
      const hi = limits.get(1);
      const loResolved = lo instanceof PDFRef ? doc.context.lookup(lo) : lo;
      const hiResolved = hi instanceof PDFRef ? doc.context.lookup(hi) : hi;
      if (!(loResolved instanceof PDFNumber) || !(hiResolved instanceof PDFNumber)) continue;

      if (pageKey >= loResolved.asNumber() && pageKey <= hiResolved.asNumber()) {
        return this.findParentTreeLeafNums(doc, kidDict, pageKey);
      }
    }

    throw new Error(
      `extendParentTree: no /ParentTree leaf node's /Limits covers page key ${pageKey} -- ` +
      `cannot determine where a brand-new entry would go (real, separate work).`
    );
  }

  extendParentTree(doc: PDFDocument, pageNumber: number, entries: Array<{ mcid: number; structElementRef: PDFRef }>): void {
    if (entries.length === 0) return;

    const { numsArr, pageKey } = this.resolveParentTreeNumsArray(doc, pageNumber);
    const structRoot = this.getStructTreeRoot(doc)!;

    const sorted = [...entries].sort((a, b) => a.mcid - b.mcid);
    const raw = numsArr.asArray();

    let foundIndex = -1;
    for (let i = 0; i < raw.length; i += 2) {
      const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
      if (keyObj instanceof PDFNumber && keyObj.asNumber() === pageKey) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      const valueRaw = raw[foundIndex + 1];
      const valueResolved = valueRaw instanceof PDFRef ? doc.context.lookup(valueRaw) : valueRaw;
      if (!(valueResolved instanceof PDFArray)) {
        throw new Error(
          `extendParentTree: page ${pageNumber}'s existing /ParentTree entry (key ${pageKey}) is not an ` +
          `array -- promoting a non-array entry to array form is out of scope.`
        );
      }
      const startAt = valueResolved.size();
      sorted.forEach((e, i) => {
        if (e.mcid !== startAt + i) {
          throw new Error(
            `extendParentTree: MCID ${e.mcid} does not append contiguously onto page ${pageNumber}'s ` +
            `existing ${startAt}-entry array -- expected ${startAt + i}.`
          );
        }
      });
      for (const e of sorted) {
        valueResolved.push(e.structElementRef);
      }
      return;
    }

    sorted.forEach((e, i) => {
      if (e.mcid !== i) {
        throw new Error(
          `extendParentTree: page ${pageNumber} has no existing /ParentTree entry -- a new one must start ` +
          `at MCID 0 and be contiguous, got MCID ${e.mcid} at position ${i}.`
        );
      }
    });

    let insertPos = raw.length;
    for (let i = 0; i < raw.length; i += 2) {
      const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
      if (keyObj instanceof PDFNumber && keyObj.asNumber() > pageKey) {
        insertPos = i;
        break;
      }
    }
    const valueArr = doc.context.obj(sorted.map(e => e.structElementRef));
    numsArr.insert(insertPos, valueArr);
    numsArr.insert(insertPos, PDFNumber.of(pageKey));

    // /ParentTreeNextKey is documented as always greater than every key
    // anywhere in the parent tree -- a separate mechanism (assigning
    // /StructParent keys to standalone objects like Link annotations)
    // relies on that invariant to hand out a guaranteed-unused key. This
    // branch just introduced a brand-new pageKey; if it's >= the current
    // counter, the invariant breaks and a later annotation-tagging
    // operation could reuse pageKey, colliding with the mapping just
    // written. Only ever RAISES an existing counter -- never creates one
    // from nothing (this method has no business introducing a mechanism
    // the document never used), and silently leaves a malformed (non-
    // PDFNumber) existing value alone rather than treating an unrelated
    // pre-existing quirk as this call's problem to fix (Codex finding on
    // PR #551, confirmed real).
    const nextKeyRaw = structRoot.get(PDFName.of('ParentTreeNextKey'));
    if (nextKeyRaw) {
      const nextKeyResolved = nextKeyRaw instanceof PDFRef ? doc.context.lookup(nextKeyRaw) : nextKeyRaw;
      if (nextKeyResolved instanceof PDFNumber && pageKey >= nextKeyResolved.asNumber()) {
        structRoot.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(pageKey + 1));
      }
    }
  }

  /**
   * Builds a real Table/TR/TH/TD struct-tree skeleton for MATTERHORN-15-001
   * cases -- genuinely tabular LAYOUT content with no existing tagging of
   * its own (structure-analyzer.service.ts's TableInfo/TableCell, carrying
   * `anchor`/`sourceItems` per PR #549/#550). Unlike every other method in
   * this file, this INSERTS new content-stream marked content and
   * struct-tree elements rather than renaming/reparenting/deleting existing
   * ones -- Slice 2d of the plan, wiring table-content-tagger.ts's
   * matchCellRanges/insertMarkedContentSpans (Slice 2b) together with
   * extendParentTree (Slice 2c).
   *
   * Per-cell resolution: matchCellRanges finds every source TextItem's real
   * content-stream location; a cell needing multiple ranges (content split
   * across several runs -- confirmed common, Slice 2a's diagnostic found
   * only 45.7% of cells resolve to a single run) gets one fresh /Span leaf
   * PER RANGE, each with its own MCID. Cells that only partially resolve
   * are tagged for the resolved subset only (honest but incomplete, per
   * CellCoverageResult's own documented tradeoff) -- whether that's
   * acceptable, or whether such a cell needs some other fallback treatment,
   * is left to a caller/future decision, not this method.
   *
   * Table placement (open question in the plan, resolved empirically here,
   * Slice 2d finding): naively appending to the trivial decorative box's
   * own parent (the box findTargetTable resolves the issue's element id
   * to) is WRONG for a document whose whole body sits under one flat root
   * container -- confirmed live against Math_Kim: the trivial box's parent
   * is /Document with 2000+ direct children spanning the ENTIRE book, and
   * appendToKids always appends at the very END of that array. Blindly
   * appending there would place the new Table at the end of the WHOLE
   * DOCUMENT's reading order, nowhere near the page it's actually on.
   * Fixed via insertIntoKidsAfter: the new Table is spliced immediately
   * AFTER the trivial box's own position in its parent's /K array,
   * preserving at least rough reading-order proximity to where the real
   * table actually sits. This is a heuristic, not a proven-optimal
   * position (the trivial box's position was never meant to indicate
   * anything about the real table's layout, only found usable for
   * cross-referencing) -- worth a real placement-quality check before this
   * graduates beyond one validated case.
   *
   * Groups entries by page and calls insertMarkedContentSpans ONCE per page
   * (not per table, not per cell) -- required by that function's own
   * same-page batching contract. This slice validates exactly one table
   * per page; broader multi-table-per-page batching is Slice 2e's job.
   *
   * Every entry's positioning anchor + parent is resolved and validated
   * BEFORE either mutation phase (content-stream, then struct-tree) begins
   * -- an entry that can't resolve is excluded from insertMarkedContentSpans
   * entirely, never attempted then reported failed afterward. Content-stream
   * mutation ahead of full validation previously meant a failed entry could
   * leave orphan MCIDs with no owning struct element or /ParentTree mapping
   * (CodeRabbit/Codex finding on PR #552, confirmed real).
   *
   * The page's /ParentTree shape (resolveParentTreeNumsArray) is ALSO
   * preflighted before the content-stream mutation, for the same reason --
   * CodeRabbit correctly pushed back that the first round of validation
   * covered findTargetTable/parent resolution but not this, so a malformed
   * /ParentTree or an unsupported hierarchical /Kids number tree still
   * surfaced only after real MCIDs and struct elements already existed with
   * nowhere to wire them. Every one of those is a property of the document
   * as it already stands, knowable up front. What ISN'T preflighted, and is
   * an explicitly accepted residual risk rather than a silently-ignored one:
   * extendParentTree's own MCID-contiguity checks depend on the ACTUAL MCIDs
   * assigned by insertMarkedContentSpans, which only exist after that call
   * runs -- if a later entry on a multi-entry page throws partway through
   * struct-tree building (e.g. an unexpected createElement failure) AFTER
   * this page's ONE combined content-stream mutation has already committed,
   * that entry's MCIDs can be left without a /ParentTree mapping. Closing
   * this fully would mean either transactional rollback of a content-stream
   * splice, or wrapping this whole page's struct-tree-building phase so any
   * entry's failure discards every other entry's already-built structure too
   * -- both real, disproportionate undertakings for a failure mode this
   * codebase's existing primitives (createElement, renameElement, etc.) make
   * very unlikely in practice, not attempted here.
   *
   * CALLER CONTRACT (CodeRabbit finding on PR #552, confirmed real): this
   * method mutates `doc` IN PLACE and does not roll those mutations back on
   * a reported failure -- a failed entry's content-stream/struct-tree
   * changes remain in `doc` even though its own FixResult says `success:
   * false`. A caller MUST check `results.every(r => r.success)` before
   * persisting `doc` (e.g. via pdfModifierService.savePDF). If any entry
   * failed, do not save `doc` as-is and do not retry the failed entries
   * in place -- discard `doc` entirely and reload a fresh PDFDocument from
   * the original, unmodified buffer before trying again. This mirrors how
   * `ai-analysis.service.ts`'s `applyApprovedSuggestions` already treats a
   * PDFDocument for an entire apply-cycle: never partially persisted,
   * always a fresh load per attempt.
   *
   * Every valid entry's TH cells also get a /Scope attribute derived independently from
   * `hasHeaderRow`/`hasHeaderColumn` and the cell's own row/column (not from
   * `isHeader` alone, which can't distinguish which case applies) -- per
   * Matterhorn 15-003, PAC 2024 checks /Scope independently of the TH tag
   * itself (same CodeRabbit/Codex review round). /ParentTree is extended
   * ONCE per page across every entry's combined MCIDs, sorted by MCID --
   * not once per entry -- since insertMarkedContentSpans assigns MCIDs in
   * content-stream byte-offset order across the whole page's batch, not
   * grouped by entry; two entries whose cells interleave in byte order could
   * otherwise hand a single entry's own call a non-contiguous MCID subset,
   * which extendParentTree correctly rejects even though the page's whole
   * MCID sequence is internally consistent.
   *
   * @param entries - MATTERHORN-15-001 AuditIssues paired with the
   *   corresponding LAYOUT-detected TableInfo (looked up via issue.element,
   *   which doubles as both the TableInfo's own id and the id
   *   findTargetTable resolves to the spuriously-paired trivial box, per
   *   PR #546/#547's established pairing)
   * @param preResolvedTargets - optional, keyed by issue.id. See
   *   resolveTableTargets's own doc comment: when a caller (
   *   ai-analysis.service.ts's applyApprovedSuggestions) runs this in the
   *   same approval batch as markTableAsArtifact, both writers' targets
   *   must be resolved from the SAME still-unmutated tree upfront, since
   *   both independently rename some /Table element to /Artifact as part
   *   of their own operation -- whichever writer runs second would
   *   otherwise see a tree already shifted by the first (CodeRabbit/Codex
   *   finding on PR #554, confirmed real; reordering the two batches does
   *   NOT fix this, both directions have the identical symmetric risk).
   *   Falls back to the normal internal resolution for any issue missing
   *   from the map, so existing callers that never pass this see no
   *   behavior change.
   */
  buildTableFromLayout(
    doc: PDFDocument,
    entries: Array<{ issue: AuditIssue; table: TableInfo }>,
    preResolvedTargets?: Map<string, { dict: PDFDict; ref: PDFRef }>
  ): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return entries.map(e => ({
        issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const byPage = new Map<number, Array<{ issue: AuditIssue; table: TableInfo }>>();
    for (const e of entries) {
      const list = byPage.get(e.table.pageNumber) ?? [];
      list.push(e);
      byPage.set(e.table.pageNumber, list);
    }

    const results: FixResult[] = [];

    for (const [pageNumber, pageEntries] of byPage) {
      let pageContent: string | null;
      try {
        pageContent = decodePageContent(doc, pageNumber);
      } catch (err) {
        for (const e of pageEntries) {
          results.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (pageContent === null) {
        for (const e of pageEntries) {
          results.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: `No readable content stream for page ${pageNumber}` });
        }
        continue;
      }

      let pageRef: PDFRef;
      try {
        pageRef = doc.getPage(pageNumber - 1).ref;
      } catch (err) {
        for (const e of pageEntries) {
          results.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      // Resolve and validate EVERY entry's positioning anchor + parent
      // BEFORE any document mutation happens (content-stream or struct-tree)
      // -- two things this protects against, both real findings on PR #552:
      //  1. findTargetTable's own "Nth /Table on this page" indexing depends
      //     on tree state staying stable within this call; this method also
      //     retags each resolved anchor away from /Table later, so a second
      //     entry's fresh re-walk could otherwise miss an anchor an earlier
      //     entry already retagged in the SAME call -- the identical lesson
      //     markTableAsArtifact already learned (PR #547).
      //  2. insertMarkedContentSpans below WRITES to the content stream --
      //     an entry whose anchor or parent can't be resolved must be
      //     excluded from that call entirely, not attempted and reported
      //     failed afterward. Real content-stream mutation ahead of full
      //     validation previously meant a failed entry could still leave
      //     orphan MCIDs in the content stream with no owning struct element
      //     and no /ParentTree mapping -- a corrupted, partially-tagged
      //     document, silently reported as just one more failed FixResult.
      //     Full transactional rollback of a content-stream splice is real,
      //     separate work not worth building here (CodeRabbit/Codex finding
      //     on PR #552) -- preventing the mutation from ever starting for an
      //     entry that can't complete is simpler and just as correct.
      type ValidEntry = { entryIndex: number; e: { issue: AuditIssue; table: TableInfo }; targetRef: PDFRef; parentRaw: PDFRef };
      const validEntries: ValidEntry[] = [];
      pageEntries.forEach((e, entryIndex) => {
        const target = preResolvedTargets?.get(e.issue.id) ?? this.findTargetTable(doc, structRoot, e.issue.element);
        if (!target) {
          results.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: `No positioning anchor found matching "${e.issue.element}"` });
          return;
        }
        const parentRaw = target.dict.get(PDFName.of('P'));
        if (!(parentRaw instanceof PDFRef)) {
          results.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Positioning anchor has no /P (parent) entry' });
          return;
        }
        validEntries.push({ entryIndex, e, targetRef: target.ref, parentRaw });
      });

      if (validEntries.length === 0) continue;

      // Preflight the page's /ParentTree shape BEFORE the content-stream
      // mutation below -- closes the deterministic half of a CodeRabbit
      // pushback on PR #552: extendParentTree previously only ran AFTER
      // insertMarkedContentSpans and struct-tree creation, so a document-
      // shape problem (no /StructParents, no struct tree root, a malformed
      // /ParentTree, or an unsupported hierarchical /Kids number tree --
      // see resolveParentTreeNumsArray's own doc comment) surfaced only
      // once real MCIDs and struct elements already existed with nowhere
      // to wire them. Every one of those conditions is a property of the
      // document as it already stands, knowable before any entries are
      // considered -- unlike extendParentTree's own contiguity checks,
      // which depend on the actual MCIDs assigned below and can't be
      // known until insertMarkedContentSpans has already run (an entry
      // that throws mid-struct-tree-build on a multi-entry page, after
      // this page's ONE combined content-stream mutation has committed,
      // remains a narrower accepted residual risk -- see this method's own
      // top-level doc comment).
      try {
        this.resolveParentTreeNumsArray(doc, pageNumber);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const ve of validEntries) {
          results.push({ issueId: ve.e.issue.id, success: false, before: 'unknown', after: 'unknown', error: message });
        }
        continue;
      }

      type CellPlan = { entryIndex: number; cellIndex: number; cell: TableCell; coverage: CellCoverageResult };
      const cellPlans: CellPlan[] = [];
      const requests: RangeInsertionRequest[] = [];

      for (const ve of validEntries) {
        ve.e.table.cells.forEach((cell, cellIndex) => {
          const coverage = matchCellRanges(pageContent!, cell);
          cellPlans.push({ entryIndex: ve.entryIndex, cellIndex, cell, coverage });
          coverage.ranges.forEach((range, rangeIndex) => {
            requests.push({ range, id: `${ve.entryIndex}:${cellIndex}:${rangeIndex}` });
          });
        });
      }

      // Only NOW does the content stream get rewritten -- every entry
      // reaching this point already has a confirmed-resolvable anchor and
      // parent.
      let inserted: InsertedSpan[];
      try {
        inserted = insertMarkedContentSpans(doc, pageNumber, requests);
      } catch (err) {
        for (const ve of validEntries) {
          results.push({ issueId: ve.e.issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      const mcidById = new Map(inserted.map(s => [s.id!, s.mcid]));

      // Collected across ALL of this page's valid entries and committed to
      // /ParentTree in ONE call below, sorted by MCID -- not once per entry.
      // insertMarkedContentSpans assigns MCIDs in content-stream byte-offset
      // order across the WHOLE page's request batch, not grouped by which
      // entry submitted them; if two entries' cells physically interleave in
      // byte order, a single entry's own MCIDs are not guaranteed to form a
      // contiguous run on their own, but extendParentTree requires each call
      // to append an exactly-contiguous range. A per-entry call could
      // incorrectly throw on a non-contiguous subset even though the WHOLE
      // page's MCID sequence is internally consistent (CodeRabbit finding on
      // PR #552, confirmed real).
      const pageParentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
      // Buffered rather than pushed straight into `results`: an entry's
      // struct-tree build can succeed here while the ParentTree commit for
      // the WHOLE page still hasn't happened yet (that's one combined call
      // below, after this loop). Pushing "success: true" immediately would
      // be a lie if that later call throws -- these are only provisional
      // until the commit actually lands.
      const pageResults: FixResult[] = [];
      // Parallel to pageResults' success entries -- lets the final commit's
      // failure path (below) retag each newly-built Table rather than
      // leaving it dangling as a structurally-complete-looking but
      // ParentTree-orphaned table (CodeRabbit finding on PR #552).
      const pageTableRefsByEntry = new Map<number, PDFRef>();

      for (const ve of validEntries) {
        const { entryIndex, e, targetRef, parentRaw } = ve;
        try {
          const tableObj = doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Table'), P: parentRaw, Pg: pageRef });
          const tableRef = doc.context.register(tableObj as PDFDict);
          pageTableRefsByEntry.set(entryIndex, tableRef);
          this.insertIntoKidsAfter(doc, parentRaw, targetRef, tableRef);

          // Remove the spuriously-paired trivial box from the tree entirely,
          // same operation markTableAsArtifact performs (deleteElement --
          // see that method's own doc comment for why this replaced an
          // earlier rename-to-/Artifact design: PAC doesn't recognize the
          // PDF 2.0 namespace binding that design relied on to stay
          // spec-valid, confirmed live against a real PAC report). This is
          // not just cleanup: structure-analyzer.service.ts's
          // enhanceTablesFromTags pairs LAYOUT candidates to real struct-tree
          // /Table elements via queue-based FIFO positional matching per
          // page (findTaggedTables/consumeNextTable) -- walking the tree in
          // document order and consuming the next LAYOUT candidate for every
          // element still typed /Table it finds. Leaving the old box tagged
          // /Table alongside the newly-inserted one means the walk now finds
          // TWO /Table elements where it used to find one, shifting every
          // LATER same-page /Table's FIFO position by one -- confirmed live
          // against Math_Kim: the flagged issue stayed flagged (still paired
          // to the untouched old box) while an UNRELATED table on the same
          // page got its structural match corrupted to the new table's own
          // shape. Deleting removes the box from the walk's /Table count
          // entirely (net-zero change to the page's tally at that tree
          // position), restoring correct FIFO alignment for every other
          // same-page table. Also the semantically correct outcome, not a
          // workaround: MATTERHORN-15-001 is genuinely tabular LAYOUT content
          // spuriously paired with a decorative box (PR #546) -- that box is
          // exactly what MATTERHORN-15-005's existing fix already removes,
          // so it no longer sits around as an untouched leftover here either.
          this.deleteElement(doc, targetRef);

          const myCells = cellPlans.filter(cp => cp.entryIndex === entryIndex);
          const byRow = new Map<number, CellPlan[]>();
          for (const cp of myCells) {
            const list = byRow.get(cp.cell.row) ?? [];
            list.push(cp);
            byRow.set(cp.cell.row, list);
          }

          let cellCount = 0;
          let leafCount = 0;

          for (const rowIdx of [...byRow.keys()].sort((a, b) => a - b)) {
            const trRef = this.createElement(doc, 'TR', tableRef, pageRef);
            const rowCells = byRow.get(rowIdx)!.sort((a, b) => a.cell.column - b.cell.column);
            for (const cp of rowCells) {
              const cellTag = cp.cell.isHeader ? 'TH' : 'TD';
              const cellRef = this.createElement(doc, cellTag, trRef, pageRef);
              cellCount++;
              if (cellTag === 'TH') {
                // isHeader alone can't distinguish WHICH kind of header this
                // is (CodeRabbit/Codex finding on PR #552) -- re-derive from
                // the same two conditions structure-analyzer.service.ts's
                // own isHeader formula ORs together
                // ((hasHeaderRow && row===0) || (hasHeaderColumn &&
                // column===0)), since both can independently be true for the
                // same corner cell. Per Matterhorn 15-003, every TH needs a
                // /Scope PAC 2024 checks independently of the tag itself --
                // building a table with TH cells but no /Scope trades one
                // accessibility failure for another.
                const isRowHeaderCell = e.table.hasHeaderRow && cp.cell.row === 0;
                const isColumnHeaderCell = e.table.hasHeaderColumn && cp.cell.column === 0;
                const scope = isRowHeaderCell && isColumnHeaderCell ? 'Both' : isRowHeaderCell ? 'Column' : 'Row';
                this.writeScopeAttribute(doc, cellRef, scope);
              }
              cp.coverage.ranges.forEach((_, rangeIndex) => {
                const id = `${entryIndex}:${cp.cellIndex}:${rangeIndex}`;
                const mcid = mcidById.get(id);
                if (mcid === undefined) return;
                const spanRef = this.createElement(doc, 'Span', cellRef, pageRef);
                const spanDict = doc.context.lookup(spanRef);
                if (spanDict instanceof PDFDict) spanDict.set(PDFName.of('K'), PDFNumber.of(mcid));
                pageParentTreeEntries.push({ mcid, structElementRef: spanRef });
                leafCount++;
              });
            }
          }

          pageResults.push({
            issueId: e.issue.id,
            success: true,
            before: `Untagged layout table (${e.table.rowCount}x${e.table.columnCount}, ${e.table.cells.length} cells)`,
            after: `Built Table/${byRow.size} TR/${cellCount} cells, ${leafCount} tagged MCID span(s)`,
          });
        } catch (err) {
          pageResults.push({ issueId: e.issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
        }
      }

      // The one combined per-page ParentTree commit -- see this method's own
      // doc comment for why a per-entry call would be wrong. If THIS throws
      // (the accepted residual risk: an earlier entry's mid-build exception
      // left a genuine MCID gap, or some other contiguity/shape surprise
      // resolveParentTreeNumsArray's preflight didn't catch), every entry
      // provisionally marked successful above never actually got its
      // ParentTree wiring -- flip them to failed rather than reporting a
      // success that isn't real. This also means buildTableFromLayout never
      // throws uncaught: every other writer method in this file returns a
      // FixResult[] even on failure, and this call previously sat outside
      // any try/catch entirely.
      if (pageParentTreeEntries.length > 0) {
        pageParentTreeEntries.sort((a, b) => a.mcid - b.mcid);
        try {
          this.extendParentTree(doc, pageNumber, pageParentTreeEntries);
          results.push(...pageResults);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Not full transactional rollback (CodeRabbit asked for that on
          // PR #552 and correctly labeled it a heavy lift -- true rollback
          // of a content-stream splice plus every struct element created
          // during this page's loop is real, disproportionate work). This
          // is a cheap, meaningful partial mitigation instead: a Table this
          // call can no longer honestly claim is wired into /ParentTree
          // gets retagged to /Artifact -- same operations used elsewhere in
          // this method for the trivial box -- so if a caller persists the
          // document anyway, what's left behind is an inert, non-misleading
          // Artifact rather than a structurally-complete-looking table with
          // orphaned MCIDs no reader can correctly resolve.
          const rollbackNsRef = this.getOrCreatePdf2Namespace(doc, structRoot);
          validEntries.forEach((ve, i) => {
            const r = pageResults[i];
            if (!r.success) return;
            const tableRef = pageTableRefsByEntry.get(ve.entryIndex);
            const tableDict = tableRef ? doc.context.lookup(tableRef) : undefined;
            if (tableDict instanceof PDFDict) {
              this.renameElement(doc, tableRef!, 'Artifact');
              tableDict.set(PDFName.of('NS'), rollbackNsRef);
              // Same "descendants become unreachable garbage, not literally
              // removed from the file" semantics deleteElement already
              // documents -- the TR/TH/TD/Span children below still exist
              // as registered objects but are no longer reachable from a
              // struct element real readers will walk. Their own /P is
              // cleared first so it doesn't keep pointing at an object that
              // still exists but is no longer a structure element at all.
              this.detachDirectChildrenParentPointers(doc, tableDict.get(PDFName.of('K')));
              tableDict.delete(PDFName.of('K'));
            }
          });
          for (const r of pageResults) {
            results.push(r.success ? { ...r, success: false, error: message } : r);
          }
        }
      } else {
        results.push(...pageResults);
      }
    }

    return results;
  }

  /**
   * Resolves each issue's target /Table struct element via findTargetTable,
   * all in ONE pass against the tree as it currently stands -- for a caller
   * that needs to run MULTIPLE DIFFERENT writer methods against the same
   * batch of table_p{page}_{index}-style ids (ai-analysis.service.ts's
   * applyApprovedSuggestions, batching both markTableAsArtifact and
   * buildTableFromLayout in one approval run).
   *
   * Why this exists: both markTableAsArtifact and buildTableFromLayout
   * independently rename some /Table element to /Artifact as part of their
   * own operation (markTableAsArtifact always; buildTableFromLayout for the
   * spuriously-paired trivial box behind each entry it successfully
   * processes). findTargetTable's positional "Nth /Table on this page"
   * indexing depends on the tree staying stable relative to when
   * table_p{page}_{index} ids were originally computed (at analysis time,
   * against the fully-unmodified tree) -- if one writer runs first and
   * renames a table away, the SECOND writer's own internal findTargetTable
   * resolution would see a shifted tree on any page where both suggestion
   * types coexist, corrupting whichever runs second (CodeRabbit/Codex
   * finding on PR #554, confirmed real). Reordering the two batches does
   * NOT fix this -- both directions have the identical symmetric risk,
   * since both writers eventually rename something. Calling this ONCE,
   * upfront, for every issue across BOTH suggestion types, before either
   * writer mutates anything, keeps every target anchored to the tree as it
   * stood when the ids were computed -- then pass the resulting map to both
   * markTableAsArtifact and buildTableFromLayout's own preResolvedTargets
   * parameter.
   *
   * Returns an empty map (not a per-issue failure) when there's no
   * structure tree at all -- callers already handle that case via their
   * own "no structure tree root found" FixResult path when an issue they
   * expected an entry for isn't in this map.
   */
  resolveTableTargets(doc: PDFDocument, issues: AuditIssue[]): Map<string, { dict: PDFDict; ref: PDFRef }> {
    const result = new Map<string, { dict: PDFDict; ref: PDFRef }>();
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return result;
    for (const issue of issues) {
      const target = this.findTargetTable(doc, structRoot, issue.element);
      if (target) result.set(issue.id, target);
    }
    return result;
  }

  /**
   * Marks the specific /Table struct element each issue's id refers to as
   * /Artifact instead (MATTERHORN-15-005). Targets via findTargetTable,
   * same as fixSimpleTableHeaders -- deliberately NOT a whole-document
   * sweep for "any structurally trivial /Table" (an earlier version of
   * this method did exactly that, and it was wrong): a trivial real /Table
   * is ALSO the exact shape MATTERHORN-15-001 issues are about (genuinely
   * tabular LAYOUT content spuriously paired with an unrelated decorative
   * box -- see pdf-table.validator.ts's isGenuinelyTabularDespiteTrivial
   * Match), and that distinction lives entirely in LAYOUT-analysis data
   * this writer has no access to. A structural-only sweep can't tell the
   * two apart, and confirmed live against Math_Kim that it doesn't just
   * "also fix" -001 boxes -- it actively regresses them: once the
   * underlying box is retagged away from /Table, pdf-table.validator.ts's
   * own tagged-PDF matching discards the now-unmatched LAYOUT candidate as
   * a text-detector false positive, silently making MATTERHORN-15-001
   * stop being reported at all for that region without ever actually
   * fixing it. Only the specific element a confirmed MATTERHORN-15-005
   * issue names may be touched.
   *
   * renameElement only changes /S -- MCID-safe by construction, no
   * content-stream changes, matching the same guarantee fixSimpleTableHeaders
   * and fixHeadingHierarchy already rely on.
   *
   * Resolves every issue's target ref in a first pass, BEFORE renaming any
   * of them, then renames in a second pass -- unlike fixSimpleTableHeaders
   * (which only ever touches TD/TH children, never a /Table's own /S),
   * this method renames the /Table itself, which findTargetTable's
   * positional "Nth /Table on this page" indexing depends on staying
   * stable across the whole batch. This protects same-page issues WITHIN
   * one call, but production (applyApprovedSuggestions, the single-
   * suggestion controller) calls this ONE issue at a time -- so the real
   * fix for cross-call index drift is at the CALLER: applyApprovedSuggestions
   * now collects every table-artifact-fix issue from the same approval
   * batch and calls this once with all of them, before any other fix in
   * that batch runs, rather than looping one issue per call (CodeRabbit/
   * Codex finding on PR #547; confirmed live -- 6 of 49 real Math_Kim
   * cases failed under naive one-issue-at-a-time positional targeting).
   * The single-suggestion controller endpoint has no such batch to collect
   * (each HTTP request only knows about the one suggestion it's applying)
   * -- applying multiple table-artifact-fix suggestions there one at a time
   * without an intervening re-audit can still hit this same drift; treated
   * as a known, accepted residual limitation of that manual path rather
   * than solved here (would need a "re-audit between every positional
   * apply" change, a materially larger effort, not worth blocking this fix
   * on given the primary automated/batch remediation path is fully safe).
   *
   * Deletes the target element outright (via deleteElement) rather than
   * retagging it to /S /Artifact -- a real PAC/axesPAC report against a
   * remediated Farrar 2E PDF found this fix's ORIGINAL design (rename to
   * Artifact, bound to the PDF 2.0 structure namespace via /NS so the
   * non-standard type would be spec-valid per ISO/TS 32005:2023) still
   * failing every time as "Non-standard structure type Artifact is neither
   * mapped to a standard structure type nor to another non-standard
   * structure type" -- PAC 26.1.0.0 simply doesn't recognize PDF 2.0
   * namespace-scoped structure types at all, regardless of how correctly
   * they're bound (confirmed live: catalog /Version was /2.0, the
   * element's own /NS correctly pointed at a /Namespaces entry whose /NS
   * URI was exactly http://iso.org/pdf2/ssn -- spec-correct, tool-rejected
   * anyway). /Artifact was never meant to be a structure-tree element type
   * in the first place (PDF 1.7/ISO 32000-1: it's solely a content-stream
   * marked-content tag, a different mechanism); every target this fix has
   * ever been confirmed to touch -- all 5 live Farrar cases, and every
   * existing unit-test fixture for this method -- has a /K-less TD (no
   * MCID, no painted content at all under it, confirmed via a direct
   * raw-object scan of the real remediated file finding zero orphaned
   * struct elements of any kind after this fix runs), so there is no
   * content-stream region that ever needs an Artifact tag of its own --
   * removing the element from the tree is both simpler and the only
   * variant actually proven to satisfy a real external validator. The
   * target element's own TR/TD children (if a future case ever has any)
   * become unreachable along with it, via the same "descendants remain in
   * the PDF context but are unreachable, not literally removed from the
   * file" semantics deleteElement already documents -- but their own /P
   * is explicitly cleared first (detachDirectChildrenParentPointers, same
   * call buildTableFromLayout's rollback path already makes), NOT left
   * pointing at the now-removed table. A real, live incident on Farrar
   * (2026-11-04) found that skipping this step recreates the exact
   * "/TR's /P names a real but unreachable /Table" shape
   * reattachOrphanedTableAncestor exists to repair -- which then
   * faithfully reattaches the table this method just correctly removed,
   * which gets re-flagged as MATTERHORN-15-005 and deleted again next
   * round, forever: two fixers with opposite ground truth about the same
   * table, each undoing the other every single Auto Mode round.
   *
   * @param issues - MATTERHORN-15-005 AuditIssues for a confirmed-decorative
   *   trivial-struct-match table (see ai-analysis.service.ts's dispatch gate)
   * @param preResolvedTargets - optional, keyed by issue.id. When a caller
   *   needs to run markTableAsArtifact and buildTableFromLayout in the same
   *   approval batch, see resolveTableTargets's own doc comment for why
   *   both must have their targets resolved from the SAME still-unmutated
   *   tree, upfront, rather than each independently re-deriving via its own
   *   internal findTargetTable call (CodeRabbit/Codex finding on PR #554,
   *   confirmed real). Falls back to the normal internal resolution for any
   *   issue missing from the map, so existing callers that never pass this
   *   see no behavior change.
   */
  markTableAsArtifact(
    doc: PDFDocument,
    issues: AuditIssue[],
    preResolvedTargets?: Map<string, { dict: PDFDict; ref: PDFRef }>
  ): FixResult[] {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(i => ({
        issueId: i.id, success: false,
        before: 'unknown', after: 'unknown',
        error: 'No structure tree root found',
      }));
    }

    const targets = issues.map(issue => ({
      issue,
      target: preResolvedTargets?.get(issue.id) ?? this.findTargetTable(doc, structRoot, issue.element),
    }));

    const results: FixResult[] = [];

    for (const { issue, target } of targets) {
      try {
        if (!target) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No Table element found matching "${issue.element}"`,
          });
          continue;
        }

        // This method's own safety assumption (see its doc comment) is that
        // every confirmed-decorative target has a /K-less TD -- no MCID, no
        // painted content at all. Verify that directly rather than trusting
        // the AI/heuristic classification blindly: a real, live Farrar case
        // (table_p15_0, 2026-11-04) broke that assumption -- its TD carries
        // a real MCID (painted content) -- and deleting it anyway produced
        // an infinite cycle, NOT the clean one-time removal PR #761 assumed
        // would follow once the dangling /P gap was patched: every
        // downstream repair fixer (reattachTableRow's own document-flow
        // fallback especially) correctly keeps trying to give that real
        // content a container back, re-triggering this fix on the rebuilt
        // wrapper next round, forever. Declining here, rather than guessing
        // the AI classification is right, matches this file's established
        // philosophy everywhere else -- surfaces as a visible, actionable
        // "needs investigation" failure instead of a silent infinite thrash.
        if (this.tableSubtreeHasRealContent(doc, target.dict)) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Table has a descendant cell with real painted content (a genuine MCID) -- not the always-empty decorative box this fix is safe for; declining rather than deleting real content',
          });
          continue;
        }

        // Clear any TR/TD children's own /P BEFORE deleteElement drops this
        // table's /K -- same call buildTableFromLayout's rollback path
        // already makes for the identical "retag to Artifact" shape (see
        // detachDirectChildrenParentPointers's own doc comment). Without
        // this, a row still pointing at this now-unreachable table via /P
        // is exactly the shape reattachOrphanedTableAncestor looks for and
        // will faithfully splice back into the tree -- confirmed live on
        // Farrar: markTableAsArtifact and reattachTableRow's orphan-repair
        // path were deleting and resurrecting the same page-15 table every
        // other Auto Mode round forever, each one undoing the other.
        this.detachDirectChildrenParentPointers(doc, target.dict.get(PDFName.of('K')));
        this.deleteElement(doc, target.ref);

        results.push({
          issueId: issue.id,
          success: true,
          before: 'Tagged as Table (decorative box, no real column grid)',
          after: 'Removed from the structure tree (decorative, no tag required)',
        });
      } catch (err) {
        results.push({
          issueId: issue.id, success: false,
          before: 'unknown', after: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — Composite: Bookmark Generation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Build a PDF /Outlines (bookmark) tree from H1–H6 structure elements.
   *
   * Text extraction priority:
   *   1. /ActualText or /Alt attribute on the heading element
   *   2. Recursive walk of child elements for /ActualText
   *   3. Fallback placeholder: "Section N — p.X"
   *
   * /Dest format (per PDF spec): [pageRef /XYZ null null null]
   * Uses null null null to preserve the viewer's current zoom level.
   *
   * Sets /PageMode: /UseOutlines on the catalog so bookmarks open automatically.
   */
  generateBookmarksFromHeadings(doc: PDFDocument): { generated: number } {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return { generated: 0 };

    const pages = doc.getPages();
    if (pages.length === 0) return { generated: 0 };

    // Build pageRef → index lookup
    const pageRefToIndex = new Map<number, number>();
    pages.forEach((p, idx) => pageRefToIndex.set(p.ref.objectNumber, idx));

    // Resolves custom role-mapped heading tags too -- see buildRoleMap's own
    // doc comment (added for fixHeadingHierarchy/fixMultipleH1's identical
    // real Math_Weir_PDF.pdf incident). Without this, a document whose FIRST
    // heading is deliberately left under its original role name (e.g.
    // fixMultipleH1 always keeps the first H1 that way) would silently open
    // its generated bookmark outline on the SECOND heading, never the true
    // first one.
    const roleMap = this.buildRoleMap(doc, structRoot);

    // Collect headings in document order
    const headings: Array<{
      level: number;
      title: string;
      pageIndex: number;
      fallback: boolean;
    }> = [];

    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const rawTag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (!rawTag) return;
      const sTag = this.resolveRoleMapChain(roleMap, rawTag);
      const m = /^H([1-9])$/.exec(sTag);
      if (!m) return;

      const level = parseInt(m[1], 10);
      let pageIndex = 0;
      const pgRaw = node.get(PDFName.of('Pg'));
      if (pgRaw instanceof PDFRef) {
        pageIndex = pageRefToIndex.get(pgRaw.objectNumber) ?? 0;
      }

      const extracted = this.extractTextFromStructElem(doc, node);
      const title = extracted
        ? extracted.slice(0, 200)
        : `Section — p.${pageIndex + 1}`;

      headings.push({ level, title, pageIndex, fallback: !extracted });
    });

    if (headings.length === 0) {
      logger.info('[StructureWriter] generateBookmarksFromHeadings: no headings found');
      return { generated: 0 };
    }

    const fallbackCount = headings.filter(h => h.fallback).length;
    if (fallbackCount > 0) {
      logger.info(`[StructureWriter] Bookmark generation: ${fallbackCount}/${headings.length} headings used placeholder titles`);
    }

    const outlineRef = this.buildOutlineTree(doc, headings, pages);
    if (!outlineRef) return { generated: 0 };

    doc.catalog.set(PDFName.of('Outlines'), outlineRef);
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

    logger.info(`[StructureWriter] Generated ${headings.length} bookmark(s)`);
    return { generated: headings.length };
  }

  private buildOutlineTree(
    doc: PDFDocument,
    headings: Array<{ level: number; title: string; pageIndex: number; fallback: boolean }>,
    pages: ReturnType<PDFDocument['getPages']>,
  ): PDFRef | null {
    if (headings.length === 0) return null;

    // Create root /Outlines dict
    const rootDict = doc.context.obj({ Type: PDFName.of('Outlines'), Count: 0 }) as PDFDict;
    const rootRef = doc.context.register(rootDict);

    // Stack entry: parent node reference + number of direct children so far
    type StackEntry = { ref: PDFRef; dict: PDFDict; level: number; childCount: number };
    const stack: StackEntry[] = [{ ref: rootRef, dict: rootDict, level: 0, childCount: 0 }];

    for (const h of headings) {
      // Pop until we find a parent with level strictly less than this heading
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];

      // Resolve page ref — fall back to page 0 if out of range
      const pageRef = (pages[h.pageIndex] ?? pages[0]).ref;
      // Dest: [pageRef /XYZ null null null] — go to page, preserve zoom
      const dest = doc.context.obj([pageRef, PDFName.of('XYZ'), null, null, null]);

      // Build item dict (Title as PDFHexString for full Unicode support)
      const itemDict = doc.context.obj({
        Title: PDFHexString.fromText(h.title),
        Dest: dest,
        Parent: parent.ref,
        Count: 0,
      }) as PDFDict;
      const itemRef = doc.context.register(itemDict);

      // Link siblings
      if (parent.childCount > 0 && parent.dict.get(PDFName.of('Last')) instanceof PDFRef) {
        const prevRef = parent.dict.get(PDFName.of('Last')) as PDFRef;
        const prevDict = doc.context.lookup(prevRef) as PDFDict;
        prevDict.set(PDFName.of('Next'), itemRef);
        itemDict.set(PDFName.of('Prev'), prevRef);
      } else {
        parent.dict.set(PDFName.of('First'), itemRef);
      }
      parent.dict.set(PDFName.of('Last'), itemRef);
      parent.childCount++;

      stack.push({ ref: itemRef, dict: itemDict, level: h.level, childCount: 0 });
    }

    // Compute Count values (total visible descendants) via First/Next traversal
    this.updateOutlineCounts(doc, rootRef, rootDict);

    return rootRef;
  }

  private updateOutlineCounts(doc: PDFDocument, ref: PDFRef, dict: PDFDict): number {
    let count = 0;
    let cur: PDFObject | undefined = dict.get(PDFName.of('First'));
    while (cur instanceof PDFRef) {
      const child = doc.context.lookup(cur);
      if (!(child instanceof PDFDict)) break;
      count += 1 + this.updateOutlineCounts(doc, cur, child);
      cur = child.get(PDFName.of('Next'));
    }
    if (count > 0 || ref === doc.context.lookup(doc.context.trailerInfo.Root)) {
      dict.set(PDFName.of('Count'), doc.context.obj(count));
    }
    return count;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — Text Extraction (for titles and extractFirstH1Text)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Extract the text of the first H1 (or H) structure element.
   * Used by pdf-modifier.service.ts for title derivation in deriveAndSetTitle().
   * Returns null if no H1 found or text cannot be extracted.
   */
  extractFirstH1Text(doc: PDFDocument): string | null {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return null;

    let result: string | null = null;
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const tag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (tag !== 'H1' && tag !== 'H') return;

      const text = this.extractTextFromStructElem(doc, node);
      if (text) {
        result = text;
        return true; // Stop traversal
      }
    });

    return result;
  }

  /**
   * Attempt to extract a text string from a structure element.
   * Priority: /ActualText → /Alt → recursive walk of K children.
   * Returns null if no text can be found without parsing content streams.
   */
  private extractTextFromStructElem(doc: PDFDocument, elem: PDFDict): string | null {
    // Direct text attributes on the element
    for (const attrName of ['ActualText', 'Alt']) {
      const raw = elem.get(PDFName.of(attrName));
      if (raw instanceof PDFString) return raw.decodeText();
      if (raw instanceof PDFHexString) return raw.decodeText();
    }

    // Walk K children for text (depth-limited to avoid stack overflow)
    const parts: string[] = [];
    this.collectTextFromK(doc, elem.get(PDFName.of('K')), parts, 0);
    const text = parts.join('').trim();
    return text || null;
  }

  private collectTextFromK(
    doc: PDFDocument,
    raw: PDFObject | undefined,
    parts: string[],
    depth: number,
  ): void {
    if (depth > 12 || !raw) return;

    if (raw instanceof PDFRef) {
      const obj = doc.context.lookup(raw);
      if (!(obj instanceof PDFDict)) return;
      const sTag = obj.get(PDFName.of('S'));
      if (sTag) {
        // Child structure element — check for ActualText/Alt first, then recurse
        for (const attrName of ['ActualText', 'Alt']) {
          const attr = obj.get(PDFName.of(attrName));
          if (attr instanceof PDFString) { parts.push(attr.decodeText()); return; }
          if (attr instanceof PDFHexString) { parts.push(attr.decodeText()); return; }
        }
        this.collectTextFromK(doc, obj.get(PDFName.of('K')), parts, depth + 1);
      }
      // MCR dict (MCID + Pg, no S) — text requires content stream parsing; skip
    } else if (raw instanceof PDFArray) {
      for (const item of raw.asArray()) {
        this.collectTextFromK(doc, item, parts, depth + 1);
      }
    }
    // PDFNumber = inline MCID reference — needs content stream parsing; skip
  }

  /**
   * Matterhorn 01-005 fix — wraps every untagged painted-path region on each
   * issue's page in `/Artifact BMC … EMC` (see pdf-artifact-tagger.ts for
   * the full detection/merging logic and the real-document finding behind
   * it). Purely a marked-content change: never touches path geometry,
   * colors, or any other operator, so it's always a deterministic, no-AI,
   * risk-free apply-to-pdf fix — confirmed live via a rendered pixel diff
   * against a real affected page (zero pixels differ before vs. after).
   */
  fixUntaggedContent(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    return issues.map((issue) => {
      if (!issue.pageNumber) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber' };
      }

      let content: string | null;
      try {
        content = decodePageContent(doc, issue.pageNumber);
      } catch (err) {
        return {
          issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
          error: `Could not decode page ${issue.pageNumber}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!content) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${issue.pageNumber} has no content stream` };
      }

      const { content: fixed, count } = tagUntaggedPaintedPaths(content);
      if (count === 0) {
        return { issueId: issue.id, success: false, before: 'untagged content present', after: 'unknown', error: 'No untagged painted-path regions found on this page (already fixed or moved)' };
      }

      writePageContent(doc, issue.pageNumber, fixed);
      return {
        issueId: issue.id,
        success: true,
        before: `${count} untagged vector-graphics region(s)`,
        after: `${count} region(s) marked as /Artifact`,
      };
    });
  }

  /**
   * Matterhorn 01-004 fix — splits each issue's page's enclosing
   * `/Artifact BMC … EMC` span around any real tagged content found nested
   * inside it (see pdf-artifact-tagger.ts's findTaggedContentInsideArtifact
   * for the full detection logic and the real-document finding behind it).
   * Purely a marked-content boundary change: never touches the real tag's
   * own bytes or any path/text/image operator, so it's always a
   * deterministic, no-AI, risk-free apply-to-pdf fix, same class as
   * fixUntaggedContent above.
   */
  fixTaggedContentInsideArtifact(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    return issues.map((issue) => {
      if (!issue.pageNumber) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber' };
      }

      let content: string | null;
      try {
        content = decodePageContent(doc, issue.pageNumber);
      } catch (err) {
        return {
          issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
          error: `Could not decode page ${issue.pageNumber}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!content) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${issue.pageNumber} has no content stream` };
      }

      const { content: fixed, count } = splitArtifactAroundTaggedContent(content);
      if (count === 0) {
        return { issueId: issue.id, success: false, before: 'tagged content nested inside an Artifact span', after: 'unknown', error: 'No Artifact-nested real content found on this page (already fixed or moved)' };
      }

      writePageContent(doc, issue.pageNumber, fixed);
      return {
        issueId: issue.id,
        success: true,
        before: `${count} real structure element(s) nested inside an /Artifact span`,
        after: `${count} element(s) excised from the Artifact's marked-content range`,
      };
    });
  }

  /**
   * ARTIFACT-SWALLOWS-CONTENT fix: splits each confirmed-boundary oversized
   * Artifact span (see pdf-artifact-tagger.ts's findOversizedArtifactSpans
   * and ai-analysis.service.ts's analyzeArtifactSwallowsContent for the
   * full detection/AI-verification trail) and gives the real content its
   * own fresh /Span struct element, wired into the structure tree at its
   * correct document-flow position.
   *
   * `storedValue` is the AI analysis's own persisted decision -- a
   * JSON-encoded array of the confirmed real-content-opening TEXT, one per
   * oversized span on this page, in document order (not a raw byte
   * offset, which wouldn't survive another fix rewriting this same page's
   * content stream first; not an array index, which wouldn't survive this
   * page's span list re-deriving in a different order after an unrelated
   * edit). Relocated here by an EXACT text match against a fresh
   * re-extraction of this page's own text runs -- if even one span's
   * confirmed text can no longer be found, the whole page's fix is
   * declined rather than guessing which spans still apply.
   *
   * Document-flow insertion mirrors reattachTableRow's own fallback
   * technique one level down: resolves the nearest EXISTING tagged
   * neighbors by CONTENT-STREAM POSITION, not MCID value -- the new
   * span's MCID is freshly allocated and always larger than everything
   * already on the page, so value-based neighbor arithmetic (mcid-1/
   * mcid+1) doesn't apply the way it does for an already-numbered orphan.
   * Resolves each neighbor's own document-flow parent via its /P and
   * requires left/right agreement (or accepts whichever one resolves),
   * same "decline rather than guess" philosophy as every other ambiguity
   * check in this file.
   *
   * All-or-nothing per page: one content-stream rewrite covers every span
   * on this page, so a failure partway through rolls back every struct
   * element created so far (the content-stream rewrite itself is only
   * ever applied after every struct element succeeds, so there's nothing
   * to roll back on that side).
   */
  fixArtifactSwallowsContent(doc: PDFDocument, issue: AuditIssue, storedValue: string | null): FixResult {
    if (!issue.pageNumber) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber' };
    }
    if (!storedValue) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No AI-confirmed boundary data available for this issue' };
    }

    let confirmedSnippets: string[];
    try {
      const parsedValue = JSON.parse(storedValue);
      if (!Array.isArray(parsedValue) || !parsedValue.every((s): s is string => typeof s === 'string')) {
        throw new Error('not a string array');
      }
      confirmedSnippets = parsedValue;
    } catch {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Stored AI value is not a valid JSON string array' };
    }

    const pageNumber = issue.pageNumber;
    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!originalContent) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${pageNumber} has no content stream` };
    }

    const spans = findOversizedArtifactSpans(originalContent);
    if (spans.length === 0) {
      return { issueId: issue.id, success: false, before: 'oversized Artifact span(s) present', after: 'unknown', error: 'No oversized Artifact spans found on this page (already fixed or moved)' };
    }
    if (spans.length !== confirmedSnippets.length) {
      return {
        issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
        error: `Page's oversized-Artifact-span count (${spans.length}) no longer matches the analyzed count (${confirmedSnippets.length}) -- declining rather than guessing which spans still apply`,
      };
    }

    const realContentStarts: number[] = [];
    for (let i = 0; i < spans.length; i++) {
      const runs = extractArtifactTextRuns(originalContent, spans[i].contentStart, spans[i].closeOpStart);
      const match = runs.find((r) => r.text === confirmedSnippets[i]);
      if (!match) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Could not relocate span ${i + 1}'s confirmed real-content text on the current page -- it may have changed since analysis` };
      }
      realContentStarts.push(match.start);
    }

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No /StructTreeRoot found' };
    }
    const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
    if (!pageArr) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No /ParentTree entry found for page ${pageNumber}` };
    }
    const pageArrRaw = pageArr.asArray();
    const positionedMcids = orderedPageContentMcids(originalContent);

    const resolveEntry = (mcid: number | undefined): PDFRef | null => {
      if (mcid === undefined) return null;
      const entry = pageArrRaw[mcid];
      return entry instanceof PDFRef ? entry : null;
    };
    const resolveParentOf = (entryRef: PDFRef | null): PDFRef | null => {
      if (!entryRef) return null;
      const dict = doc.context.lookup(entryRef, PDFDict);
      const p = dict?.get(PDFName.of('P'));
      return p instanceof PDFRef ? p : null;
    };

    interface PlannedInsertion {
      mcid: number;
      insertOffset: number;
      flowParent: PDFRef;
      anchorRef: PDFRef;
      anchorBefore: boolean;
    }

    const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
    let nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

    const planned: PlannedInsertion[] = [];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      const realContentStart = realContentStarts[i];

      const leftCandidate = [...positionedMcids].reverse().find((p) => p.start < realContentStart);
      const rightCandidate = positionedMcids.find((p) => p.start > span.closeOpEnd);
      const leftEntry = resolveEntry(leftCandidate?.mcid);
      const rightEntry = resolveEntry(rightCandidate?.mcid);
      const leftParent = resolveParentOf(leftEntry);
      const rightParent = resolveParentOf(rightEntry);

      if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Span ${i + 1}'s left/right tagged neighbors resolve to different document-flow parents -- ambiguous, declining rather than guessing` };
      }

      let flowParent: PDFRef | null = null;
      let anchorRef: PDFRef | null = null;
      let anchorBefore = false;
      if (rightParent && rightEntry) {
        flowParent = rightParent; anchorRef = rightEntry; anchorBefore = true;
      } else if (leftParent && leftEntry) {
        flowParent = leftParent; anchorRef = leftEntry; anchorBefore = false;
      }

      if (!flowParent || !anchorRef) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Span ${i + 1} has no usable tagged neighbor on this page to anchor its document-flow position to -- declining rather than guessing` };
      }

      planned.push({ mcid: nextMcid, insertOffset: realContentStart, flowParent, anchorRef, anchorBefore });
      nextMcid++;
    }

    const sortedByOffsetDesc = [...planned].sort((a, b) => b.insertOffset - a.insertOffset);
    let newContent = originalContent;
    for (const p of sortedByOffsetDesc) {
      newContent = applyArtifactUnwrap(newContent, p.insertOffset, p.mcid);
    }

    const pageRef = doc.getPages()[pageNumber - 1].ref;
    const createdRefs: PDFRef[] = [];
    const parentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
    const lastInsertedByAnchor = new Map<number, PDFRef>();

    try {
      for (const p of planned) {
        const spanObj = doc.context.obj({
          Type: PDFName.of('StructElem'),
          S: PDFName.of('Span'),
          P: p.flowParent,
          Pg: pageRef,
          K: PDFNumber.of(p.mcid),
        });
        const spanRef = doc.context.register(spanObj as PDFDict);
        createdRefs.push(spanRef);

        if (p.anchorBefore) {
          this.insertIntoKidsBefore(doc, p.flowParent, p.anchorRef, spanRef);
        } else {
          const insertAfter = lastInsertedByAnchor.get(p.anchorRef.objectNumber) ?? p.anchorRef;
          this.insertIntoKidsAfter(doc, p.flowParent, insertAfter, spanRef);
          lastInsertedByAnchor.set(p.anchorRef.objectNumber, spanRef);
        }

        const spanDict = doc.context.lookup(spanRef, PDFDict);
        spanDict?.set(PDFName.of('P'), p.flowParent);

        parentTreeEntries.push({ mcid: p.mcid, structElementRef: spanRef });
      }

      writePageContent(doc, pageNumber, newContent);
      parentTreeEntries.sort((a, b) => a.mcid - b.mcid);
      this.extendParentTree(doc, pageNumber, parentTreeEntries);
    } catch (err) {
      // Full rollback (same reasoning as buildFigureFromImage's own
      // CodeRabbit/Codex-confirmed fix on PR #555): deleteElement alone
      // would leave this page's newly-spliced BDC/MCID marks sitting in
      // the content stream with no owning struct element if
      // extendParentTree is what throws (writePageContent above already
      // ran by then) -- restore the page's own original bytes too, not
      // just the struct-tree side.
      writePageContent(doc, pageNumber, originalContent);
      for (const ref of createdRefs) this.deleteElement(doc, ref);
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }

    return {
      issueId: issue.id,
      success: true,
      before: `${spans.length} oversized /Artifact span(s) swallowing real, never-tagged content`,
      after: `${spans.length} span(s) split; real content given a fresh /Span structure tag, wired into the document flow`,
    };
  }

  /**
   * ARTIFACT-SWALLOWS-CONTENT-COMPLEX fix: the "has path-paint ops too"
   * sibling of fixArtifactSwallowsContent, for oversized Artifact spans
   * that interleave real text WITH decorative drawing (see
   * findRealTextSegmentsInSpan's own doc comment for why this never has to
   * decide whether that drawing is itself decorative or a real
   * chart/diagram -- it only ever acts on text). Finds every real text
   * segment fresh from the CURRENT page content; no AI-confirmed stored
   * value needed, unlike fixArtifactSwallowsContent's heuristic text-
   * baseline-Y boundary guess -- "a text-show op not immediately preceded
   * by another text-show op since the last path-paint op" is a purely
   * structural fact about the content stream, not a judgment call. Splits
   * each segment out into its own fresh /Span, leaving the decorative
   * drawing between them exactly as Artifact as it already was.
   *
   * Confirmed live on Farrar_2E_Comp_188910.pdf: 9 of 16 remaining
   * "complex" oversized-Artifact pages have real swallowed text (two-
   * column glossary tables, section running heads, body paragraphs) mixed
   * with decorative grid lines/shading -- the other 7 are pure decorative
   * graphics with no text inside at all and correctly stay declined by
   * this method returning a no-real-text failure for them.
   *
   * Document-flow insertion mirrors fixArtifactSwallowsContent exactly:
   * resolves each span's own nearest EXISTING tagged neighbors by
   * content-stream position (left of the span's first real segment, right
   * of the span's own close), requires left/right agreement, and chains
   * every segment inside the same span off that one anchor point in order.
   *
   * All-or-nothing per page, same rollback convention as
   * fixArtifactSwallowsContent and buildFigureFromImage before it.
   */
  fixArtifactSwallowsContentComplex(doc: PDFDocument, issue: AuditIssue): FixResult {
    if (!issue.pageNumber) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber' };
    }
    const pageNumber = issue.pageNumber;

    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!originalContent) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${pageNumber} has no content stream` };
    }

    const spans = findOversizedArtifactSpans(originalContent).filter((s) => s.hasPathOps);
    if (spans.length === 0) {
      return { issueId: issue.id, success: false, before: 'oversized Artifact span(s) present', after: 'unknown', error: 'No complex oversized Artifact spans found on this page (already fixed or moved)' };
    }

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No /StructTreeRoot found' };
    }
    const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
    if (!pageArr) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No /ParentTree entry found for page ${pageNumber}` };
    }
    const pageArrRaw = pageArr.asArray();
    const positionedMcids = orderedPageContentMcids(originalContent);

    const resolveEntry = (mcid: number | undefined): PDFRef | null => {
      if (mcid === undefined) return null;
      const entry = pageArrRaw[mcid];
      return entry instanceof PDFRef ? entry : null;
    };
    const resolveParentOf = (entryRef: PDFRef | null): PDFRef | null => {
      if (!entryRef) return null;
      const dict = doc.context.lookup(entryRef, PDFDict);
      const p = dict?.get(PDFName.of('P'));
      return p instanceof PDFRef ? p : null;
    };

    interface PlannedSegment {
      mcid: number;
      flowParent: PDFRef;
      anchorRef: PDFRef;
      anchorBefore: boolean;
    }

    const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
    let nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

    const allEdits: Array<{ offset: number; text: string }> = [];
    const planned: PlannedSegment[] = [];
    let totalSegments = 0;

    for (const span of spans) {
      const segments = findRealTextSegmentsInSpan(originalContent, span);
      if (segments.length === 0) continue; // pure decorative span after all -- leave untouched

      const leftCandidate = [...positionedMcids].reverse().find((p) => p.start < segments[0].start);
      const rightCandidate = positionedMcids.find((p) => p.start > span.closeOpEnd);
      const leftEntry = resolveEntry(leftCandidate?.mcid);
      const rightEntry = resolveEntry(rightCandidate?.mcid);
      const leftParent = resolveParentOf(leftEntry);
      const rightParent = resolveParentOf(rightEntry);

      if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Span\'s left/right tagged neighbors resolve to different document-flow parents -- ambiguous, declining rather than guessing' };
      }

      let flowParent: PDFRef | null = null;
      let anchorRef: PDFRef | null = null;
      let anchorBefore = false;
      if (rightParent && rightEntry) {
        flowParent = rightParent; anchorRef = rightEntry; anchorBefore = true;
      } else if (leftParent && leftEntry) {
        flowParent = leftParent; anchorRef = leftEntry; anchorBefore = false;
      }

      if (!flowParent || !anchorRef) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Span has no usable tagged neighbor on this page to anchor its document-flow position to -- declining rather than guessing' };
      }

      const { edits, mcids } = buildArtifactSplitEdits(segments, span.closeOpStart, nextMcid);
      allEdits.push(...edits);
      for (const mcid of mcids) {
        planned.push({ mcid, flowParent, anchorRef, anchorBefore });
      }
      nextMcid += segments.length;
      totalSegments += segments.length;
    }

    if (totalSegments === 0) {
      return { issueId: issue.id, success: false, before: 'oversized Artifact span(s) present', after: 'unknown', error: 'No real text found inside this page\'s complex Artifact span(s) -- purely decorative, nothing to free' };
    }

    allEdits.sort((a, b) => b.offset - a.offset);
    let newContent = originalContent;
    for (const e of allEdits) {
      newContent = newContent.slice(0, e.offset) + e.text + newContent.slice(e.offset);
    }

    const pageRef = doc.getPages()[pageNumber - 1].ref;
    const createdRefs: PDFRef[] = [];
    const parentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
    const lastInsertedByAnchor = new Map<number, PDFRef>();

    try {
      for (const p of planned) {
        const spanObj = doc.context.obj({
          Type: PDFName.of('StructElem'),
          S: PDFName.of('Span'),
          P: p.flowParent,
          Pg: pageRef,
          K: PDFNumber.of(p.mcid),
        });
        const spanRef = doc.context.register(spanObj as PDFDict);
        createdRefs.push(spanRef);

        if (p.anchorBefore) {
          this.insertIntoKidsBefore(doc, p.flowParent, p.anchorRef, spanRef);
        } else {
          const insertAfter = lastInsertedByAnchor.get(p.anchorRef.objectNumber) ?? p.anchorRef;
          this.insertIntoKidsAfter(doc, p.flowParent, insertAfter, spanRef);
          lastInsertedByAnchor.set(p.anchorRef.objectNumber, spanRef);
        }

        const spanDict = doc.context.lookup(spanRef, PDFDict);
        spanDict?.set(PDFName.of('P'), p.flowParent);

        parentTreeEntries.push({ mcid: p.mcid, structElementRef: spanRef });
      }

      writePageContent(doc, pageNumber, newContent);
      parentTreeEntries.sort((a, b) => a.mcid - b.mcid);
      this.extendParentTree(doc, pageNumber, parentTreeEntries);
    } catch (err) {
      // Same full-rollback reasoning as fixArtifactSwallowsContent above.
      writePageContent(doc, pageNumber, originalContent);
      for (const ref of createdRefs) this.deleteElement(doc, ref);
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }

    return {
      issueId: issue.id,
      success: true,
      before: `${spans.length} complex oversized /Artifact span(s) swallowing real content alongside decorative drawing`,
      after: `${totalSegments} real text segment(s) split out into their own /Span structure tag(s); the decorative drawing stays Artifact-wrapped`,
    };
  }

  /**
   * ARTIFACT-HIDES-ACTUALTEXT-SIBLING fix: retags each real-content letter
   * InDesign's own export mis-marked as /Artifact -- confirmed real on
   * Karsaklian_189165_9781606497623 (991 occurrences, 156 pages; see
   * findArtifactWrappedActualTextSiblings's own doc comment for the full
   * defect and its discriminating signal). Pure content-stream
   * reclassification: /Span <</ActualText>> is marked-content-level-only
   * accessibility text (confirmed real: this document's own correctly-
   * tagged sibling letters carry no /MCID at all alongside their own
   * /ActualText), so unlike every other fixer in this file, this one
   * never touches the structure tree, /ParentTree, or any struct element
   * -- the entire fix is replacing each candidate's own opening
   * "/Artifact <props>BDC"/"/Artifact BMC" with
   * "/Span <</ActualText (resolved text)>> BDC", letter for letter,
   * matching exactly how the document's own correctly-tagged siblings are
   * already written.
   *
   * Resolves each candidate's real text via the SAME font-aware
   * /ToUnicode-CMap reader this file already built for the LINK-MISSING-
   * ANNOTATION ligature decoder (buildGlyphTextResolver) -- confirmed
   * real and necessary, not hypothetical: a direct check against this
   * exact document found /ToUnicode already resolves every checked case
   * correctly. The decorative/swash glyph substitution InDesign applied
   * never actually lost the real character; it just wasn't exported with
   * an ActualText fallback the way the OTHER letters in the same word
   * were.
   *
   * Deliberately does NOT fall back to a byte's own raw Latin-1
   * interpretation on a /ToUnicode miss, unlike decodeTextShowOperands's
   * own established convention elsewhere in this codebase -- that
   * convention assumes ordinary text, where a byte code usually already
   * roughly IS its ASCII character and a CMap miss is the rare exception
   * (a ligature). Every candidate this method sees, by construction, uses
   * a decorative/swash glyph substitution -- its raw byte code has no
   * reason to resemble the real letter at all, so a miss here means
   * genuinely declining, not guessing, is the only safe choice.
   *
   * All-or-nothing per page: every candidate is resolved BEFORE any
   * content-stream mutation, so a single unresolvable byte declines the
   * whole page's fix with nothing to actually roll back -- the page is
   * simply never touched.
   */
  fixArtifactActualTextSibling(doc: PDFDocument, issue: AuditIssue): FixResult {
    const fail = (error: string): FixResult => ({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error });

    if (!issue.pageNumber) return fail('Issue has no pageNumber');
    const pageNumber = issue.pageNumber;

    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return fail(`Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!originalContent) return fail(`Page ${pageNumber} has no content stream`);

    const candidates = findArtifactWrappedActualTextSiblings(originalContent);
    if (candidates.length === 0) {
      return fail('No Artifact-wrapped letter beside an already-tagged ActualText sibling found on this page -- already fixed, or the page changed since the audit that found it');
    }

    const resolveGlyphText = this.buildGlyphTextResolver(doc, pageNumber);

    const resolved: Array<{ tagStart: number; tagEnd: number; text: string }> = [];
    for (const c of candidates) {
      if (!c.fontResourceName) {
        return fail(`Could not determine the active font for an Artifact-wrapped letter at byte offset ${c.tagStart} -- declining rather than guessing`);
      }
      let text = '';
      for (let i = 0; i < c.rawBytes.length; i++) {
        const byteCode = c.rawBytes.charCodeAt(i);
        let glyph = resolveGlyphText(c.fontResourceName, byteCode);
        // A /ToUnicode miss on a byte whose font CONFIRMS one of the three
        // standard base encodings (WinAnsi/Standard/MacRoman) as its own
        // declared /Encoding isn't actually ambiguous for that byte's
        // code-point identity -- the substituted glyph may be decorative,
        // but the character a screen reader should announce is still
        // whatever that CONFIRMED encoding defines for the code (real,
        // recurring pattern: byte 149/0x95 = U+2022 BULLET under
        // WinAnsiEncoding, confirmed on two different fonts in
        // WPVP_180188_9798986469300_txt.pdf, 2026-11-10 -- but the SAME
        // byte means 'i-dieresis' under MacRomanEncoding and is unassigned
        // under StandardEncoding, per font-encodings.ts's own tables, so
        // this reads the font's OWN declared encoding rather than assuming
        // WinAnsi universally). Gated on an EXPLICIT /Encoding declaration
        // (fontBaseEncodingName below), never a missing/implicit one -- a
        // symbolic font, or a nonsymbolic one relying on its own built-in
        // encoding with no /Encoding entry at all, stays a genuine decline.
        if (glyph === null) {
          const table = baseEncodingTable(this.fontBaseEncodingName(doc, pageNumber, c.fontResourceName));
          const cp = table?.[byteCode];
          if (cp) glyph = String.fromCodePoint(cp);
        }
        if (glyph === null) {
          return fail(`Font ${c.fontResourceName}'s own /ToUnicode CMap has no entry for byte ${byteCode} at offset ${c.tagStart} -- declining rather than guessing the real letter`);
        }
        text += glyph;
      }
      resolved.push({ tagStart: c.tagStart, tagEnd: c.contentStart, text });
    }

    let newContent = originalContent;
    for (const r of [...resolved].sort((a, b) => b.tagStart - a.tagStart)) {
      const replacement = `/Span <</ActualText ${this.actualTextLiteral(r.text)}>> BDC `;
      newContent = newContent.slice(0, r.tagStart) + replacement + newContent.slice(r.tagEnd);
    }
    writePageContent(doc, pageNumber, newContent);

    return {
      issueId: issue.id,
      success: true,
      before: `${resolved.length} letter(s) on this page hidden as /Artifact beside already-tagged siblings`,
      after: `Retagged ${resolved.length} letter(s) as /Span <</ActualText>> (${resolved.map((r) => r.text).join('')})`,
    };
  }

  /**
   * ACTUALTEXT-MISSING-MCID fix: the real fix findArtifactActualTextSibling
   * above turned out NOT to be -- confirmed live after that fix shipped
   * (PR #780) and was deployed, a fresh PAC run on the remediated output
   * still reported "Text object not tagged" on the exact same running-
   * header text, because `/Span <</ActualText>>` with no real `/MCID` is
   * just as invisible to PDF/UA conformance checking as `/Artifact` is --
   * see findArtifactWrappedActualTextSiblings's own CORRECTION doc
   * comment for the full story. This gives genuine struct-tree
   * reachability to every ActualText-no-MCID run findActualTextRunsMissingMcid
   * finds -- BOTH the letters the earlier fix retagged AND the siblings
   * that were already `/Span <</ActualText>>` before this session ever
   * started, since both now look identical: real ActualText content,
   * no MCID.
   *
   * One real struct element PER RUN (per word-fragment-sequence), not one
   * per letter -- PDF32000 allows a struct element's /K to be an array of
   * several bare MCIDs on the SAME page, exactly how a normal multi-run
   * paragraph is already tagged elsewhere in this same document, so this
   * matches the document's own convention rather than fragmenting one
   * semantic word into N separate struct elements in the tree.
   *
   * Document-flow anchoring mirrors fixArtifactSwallowsContentComplex
   * exactly: resolves each run's own nearest EXISTING tagged neighbors by
   * content-stream position, requires left/right agreement, anchors the
   * new struct element as a sibling via insertIntoKidsBefore/After.
   * Confirmed live on Karsaklian_189165_9781606497623's own page 12: no
   * tagged content precedes the running header at all (it's the first
   * thing on the page), so every run anchors via its right-hand neighbor
   * (the page's first real body paragraph) -- the left-candidate branch
   * exists for whichever page shape needs it instead.
   *
   * All-or-nothing per page, same rollback convention as
   * fixArtifactSwallowsContentComplex and buildFigureFromImage before it.
   */
  fixActualTextMissingMcid(doc: PDFDocument, issue: AuditIssue): FixResult {
    const fail = (error: string): FixResult => ({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error });

    if (!issue.pageNumber) return fail('Issue has no pageNumber');
    const pageNumber = issue.pageNumber;

    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return fail(`Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!originalContent) return fail(`Page ${pageNumber} has no content stream`);

    const runs = findActualTextRunsMissingMcid(originalContent);
    if (runs.length === 0) {
      return fail('No ActualText-tagged content missing a real /MCID found on this page -- already fixed, or the page changed since the audit that found it');
    }

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return fail('No /StructTreeRoot found');
    const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
    if (!pageArr) return fail(`No /ParentTree entry found for page ${pageNumber}`);
    const pageArrRaw = pageArr.asArray();
    const positionedMcids = orderedPageContentMcids(originalContent);

    const resolveEntry = (mcid: number | undefined): PDFRef | null => {
      if (mcid === undefined) return null;
      const entry = pageArrRaw[mcid];
      return entry instanceof PDFRef ? entry : null;
    };
    const resolveParentOf = (entryRef: PDFRef | null): PDFRef | null => {
      if (!entryRef) return null;
      const dict = doc.context.lookup(entryRef, PDFDict);
      const p = dict?.get(PDFName.of('P'));
      return p instanceof PDFRef ? p : null;
    };

    const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
    let nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

    interface PlannedRun {
      mcids: number[];
      flowParent: PDFRef;
      anchorRef: PDFRef;
      anchorBefore: boolean;
    }

    const allEdits: Array<{ offset: number; text: string }> = [];
    const planned: PlannedRun[] = [];

    for (const run of [...runs].sort((a, b) => a.runStart - b.runStart)) {
      const leftCandidate = [...positionedMcids].reverse().find((p) => p.start < run.runStart);
      const rightCandidate = positionedMcids.find((p) => p.start > run.runEnd);
      const leftEntry = resolveEntry(leftCandidate?.mcid);
      const rightEntry = resolveEntry(rightCandidate?.mcid);
      const leftParent = resolveParentOf(leftEntry);
      const rightParent = resolveParentOf(rightEntry);

      if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) {
        return fail('Run\'s left/right tagged neighbors resolve to different document-flow parents -- ambiguous, declining rather than guessing');
      }

      let flowParent: PDFRef | null = null;
      let anchorRef: PDFRef | null = null;
      let anchorBefore = false;
      if (rightParent && rightEntry) {
        flowParent = rightParent; anchorRef = rightEntry; anchorBefore = true;
      } else if (leftParent && leftEntry) {
        flowParent = leftParent; anchorRef = leftEntry; anchorBefore = false;
      }

      if (!flowParent || !anchorRef) {
        return fail('Run has no usable tagged neighbor on this page to anchor its document-flow position to -- declining rather than guessing');
      }

      const mcids: number[] = [];
      for (const insertAt of run.mcidInsertPoints) {
        allEdits.push({ offset: insertAt, text: `/MCID ${nextMcid} ` });
        mcids.push(nextMcid);
        nextMcid++;
      }
      planned.push({ mcids, flowParent, anchorRef, anchorBefore });
    }

    allEdits.sort((a, b) => b.offset - a.offset);
    let newContent = originalContent;
    for (const e of allEdits) {
      newContent = newContent.slice(0, e.offset) + e.text + newContent.slice(e.offset);
    }

    const pageRef = doc.getPages()[pageNumber - 1].ref;
    const createdRefs: PDFRef[] = [];
    const parentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
    const lastInsertedByAnchor = new Map<number, PDFRef>();

    try {
      for (const p of planned) {
        const spanObj = doc.context.obj({
          Type: PDFName.of('StructElem'),
          S: PDFName.of('Span'),
          P: p.flowParent,
          Pg: pageRef,
          K: doc.context.obj(p.mcids.map((m) => PDFNumber.of(m))),
        });
        const spanRef = doc.context.register(spanObj as PDFDict);
        createdRefs.push(spanRef);

        if (p.anchorBefore) {
          this.insertIntoKidsBefore(doc, p.flowParent, p.anchorRef, spanRef);
        } else {
          const insertAfter = lastInsertedByAnchor.get(p.anchorRef.objectNumber) ?? p.anchorRef;
          this.insertIntoKidsAfter(doc, p.flowParent, insertAfter, spanRef);
          lastInsertedByAnchor.set(p.anchorRef.objectNumber, spanRef);
        }

        for (const mcid of p.mcids) {
          parentTreeEntries.push({ mcid, structElementRef: spanRef });
        }
      }

      writePageContent(doc, pageNumber, newContent);
      parentTreeEntries.sort((a, b) => a.mcid - b.mcid);
      this.extendParentTree(doc, pageNumber, parentTreeEntries);
    } catch (err) {
      // Same full-rollback reasoning as fixArtifactSwallowsContentComplex above.
      writePageContent(doc, pageNumber, originalContent);
      for (const ref of createdRefs) this.deleteElement(doc, ref);
      return fail(err instanceof Error ? err.message : String(err));
    }

    const totalFragments = planned.reduce((sum, p) => sum + p.mcids.length, 0);
    return {
      issueId: issue.id,
      success: true,
      before: `${totalFragments} ActualText-tagged fragment(s) in ${planned.length} run(s) on this page with no real /MCID -- invisible to the structure tree`,
      after: `Gave ${totalFragments} fragment(s) a real /MCID, reachable via /ParentTree from ${planned.length} new /Span struct element(s)`,
    };
  }

  /**
   * Attempts to break a genuine left/right-parent tie for one /PlacedPDF
   * span using real on-page geometry, instead of declining outright --
   * the one-line gap this method closes is explicitly flagged in
   * retagPlacedPdfAsFigure's own decline message ("ambiguous, declining
   * rather than guessing"): content-stream TAG ORDER alone can't tell
   * which side is really nearer when both neighbors genuinely resolve to
   * different flow parents (e.g. a real /Sect boundary).
   *
   * The span itself is, by definition, not yet wrapped in its own MCID
   * (that's the whole reason it needs retagging) -- locateByteRangeBoundingBox
   * exists for exactly this (see its own doc comment), keyed by the span's
   * CONTENT byte range (contentStart..closeOpStart — between the BDC and
   * EMC, excluding those operators themselves), not its outer tag range.
   * The two candidates DO already have real MCIDs, so their own boxes come
   * from the existing, already-proven locateMcidBoundingBoxes.
   *
   * Returns null (preserving today's conservative decline) whenever either
   * box can't be located at all, or the two candidate distances aren't
   * clearly decisive -- deliberately asymmetric margins (a relative AND an
   * absolute floor) so a near-tie still declines rather than flipping on
   * measurement noise. NOT yet validated against a real ambiguous
   * /PlacedPDF case: the 5 known live failures on Farrar all have this
   * decline for a reason unrelated to a close geometric call (no sample
   * with genuinely close-but-decisive on-page distances has been available
   * to calibrate the margin below against) -- this is a reasoned starting
   * point, not an empirically-tuned one. Revisit the margin once a real
   * document exercises this path.
   */
  private disambiguatePlacedPdfSpanByGeometry(
    doc: PDFDocument,
    pageNumber: number,
    content: string,
    spanContentRange: { start: number; end: number },
    leftMcid: number,
    rightMcid: number,
  ): 'left' | 'right' | null {
    try {
      const resolveFormXObject = buildFormXObjectResolver(doc, pageNumber);
      const spanBox = locateByteRangeBoundingBox(content, spanContentRange, { resolveFormXObject });
      if (!spanBox) return null;

      const neighborBoxes = locateMcidBoundingBoxes(content, new Set([leftMcid, rightMcid]), {
        allowSinglePointBoxes: true,
        resolveFormXObject,
      });
      const leftBox = neighborBoxes.get(leftMcid);
      const rightBox = neighborBoxes.get(rightMcid);
      if (!leftBox || !rightBox) return null;

      const center = (b: DeviceBoundingBox): { x: number; y: number } => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      const dist = (p: { x: number; y: number }, q: { x: number; y: number }): number => Math.hypot(p.x - q.x, p.y - q.y);
      const spanCenter = center(spanBox);
      const leftDist = dist(spanCenter, center(leftBox));
      const rightDist = dist(spanCenter, center(rightBox));

      const closer: 'left' | 'right' = leftDist <= rightDist ? 'left' : 'right';
      const closerDist = Math.min(leftDist, rightDist);
      const fartherDist = Math.max(leftDist, rightDist);
      // Decisive only when the closer side is BOTH meaningfully nearer in
      // absolute terms (>=10pt -- well above typical single-line-height
      // measurement noise) AND meaningfully nearer in relative terms
      // (<=70% of the farther distance) -- requiring both, not either,
      // keeps a case where the two are merely a few points apart (likely
      // noise, not a real positional preference) from flipping a decline
      // into a guess.
      const decisive = (fartherDist - closerDist) >= 10 && closerDist <= fartherDist * 0.7;
      return decisive ? closer : null;
    } catch {
      return null;
    }
  }

  /**
   * PLACEDPDF-NOT-TAGGED fix: retags every top-level `/PlacedPDF <properties>
   * BDC … EMC` span (see pdf-artifact-tagger.ts's findPlacedPdfSpans for the
   * full forensic trail — Adobe InDesign's own non-standard tag for placed
   * vector art, whose own properties reference resolves to `<< /Metadata
   * ... >>`, never an `/MCID`, so this content has never been reachable from
   * the structure tree at all despite looking tagged) as a fresh `/Figure`
   * with a real MCID, wired into the document flow. Deterministic — no AI
   * judgment needed, since this never decides decorative-vs-informative on
   * its own: every retagged region becomes a real, structure-tree-reachable
   * Figure with NO /Alt set, which the existing alt-text validator/writer
   * pipeline (PdfFigureStructTreeValidator, buildFigureFromImage and
   * friends) already picks up as an ordinary missing-alt-text issue on the
   * next audit pass — the same honest, already-proven hand-off this
   * codebase uses whenever a Figure can't get its alt text resolved in the
   * same step it's created (confirmed live: "buildFigureFromImage: 1/1
   * image(s) could not get a Figure built -- setAltText will fail honestly
   * for these" is already a normal, non-crashing outcome this pipeline
   * handles every day). Marking these Artifact instead was deliberately
   * rejected — some of this content (labeled anatomy diagrams, step-by-step
   * instructional figures) is genuinely informative, and silently excluding
   * real content from the accessible tree is worse than leaving it for the
   * alt-text pipeline to judge.
   *
   * Document-flow insertion mirrors fixArtifactSwallowsContentComplex
   * exactly: resolves each span's own nearest EXISTING tagged neighbors by
   * content-stream position, requires left/right agreement, and chains
   * every span on the same page off their own anchor point in order.
   *
   * All-or-nothing per page, same rollback convention as every other
   * content-stream-plus-struct-tree fix in this file.
   */
  retagPlacedPdfAsFigure(doc: PDFDocument, issue: AuditIssue): FixResult {
    if (!issue.pageNumber) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber' };
    }
    const pageNumber = issue.pageNumber;

    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!originalContent) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${pageNumber} has no content stream` };
    }

    const spans = findPlacedPdfSpans(originalContent);
    if (spans.length === 0) {
      return { issueId: issue.id, success: false, before: '/PlacedPDF span(s) present', after: 'unknown', error: 'No top-level /PlacedPDF spans found on this page (already fixed or moved)' };
    }

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No /StructTreeRoot found' };
    }
    const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
    if (!pageArr) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No /ParentTree entry found for page ${pageNumber}` };
    }
    const pageArrRaw = pageArr.asArray();
    const positionedMcids = orderedPageContentMcids(originalContent);

    const resolveEntry = (mcid: number | undefined): PDFRef | null => {
      if (mcid === undefined) return null;
      const entry = pageArrRaw[mcid];
      return entry instanceof PDFRef ? entry : null;
    };
    const resolveParentOf = (entryRef: PDFRef | null): PDFRef | null => {
      if (!entryRef) return null;
      const dict = doc.context.lookup(entryRef, PDFDict);
      const p = dict?.get(PDFName.of('P'));
      return p instanceof PDFRef ? p : null;
    };

    interface PlannedFigure {
      mcid: number;
      flowParent: PDFRef;
      anchorRef: PDFRef;
      anchorBefore: boolean;
    }

    const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
    let nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

    const allEdits: Array<{ offset: number; deleteThrough: number; text: string }> = [];
    const planned: PlannedFigure[] = [];

    for (const span of spans) {
      const leftCandidate = [...positionedMcids].reverse().find((p) => p.start < span.tagStart);
      const rightCandidate = positionedMcids.find((p) => p.start > span.closeOpEnd);
      const leftEntry = resolveEntry(leftCandidate?.mcid);
      const rightEntry = resolveEntry(rightCandidate?.mcid);
      const leftParent = resolveParentOf(leftEntry);
      const rightParent = resolveParentOf(rightEntry);

      let geometryPick: 'left' | 'right' | null = null;
      if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) {
        geometryPick = this.disambiguatePlacedPdfSpanByGeometry(
          doc, pageNumber, originalContent,
          { start: span.contentStart, end: span.closeOpStart },
          leftCandidate!.mcid, rightCandidate!.mcid,
        );
        if (!geometryPick) {
          return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Span\'s left/right tagged neighbors resolve to different document-flow parents -- ambiguous, declining rather than guessing' };
        }
      }

      let flowParent: PDFRef | null = null;
      let anchorRef: PDFRef | null = null;
      let anchorBefore = false;
      if (geometryPick === 'left') {
        flowParent = leftParent; anchorRef = leftEntry; anchorBefore = false;
      } else if (geometryPick === 'right') {
        flowParent = rightParent; anchorRef = rightEntry; anchorBefore = true;
      } else if (rightParent && rightEntry) {
        flowParent = rightParent; anchorRef = rightEntry; anchorBefore = true;
      } else if (leftParent && leftEntry) {
        flowParent = leftParent; anchorRef = leftEntry; anchorBefore = false;
      }

      if (!flowParent || !anchorRef) {
        return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Span has no usable tagged neighbor on this page to anchor its document-flow position to -- declining rather than guessing' };
      }

      const mcid = nextMcid;
      allEdits.push(buildPlacedPdfRetagEdit(span, mcid));
      planned.push({ mcid, flowParent, anchorRef, anchorBefore });
      nextMcid++;
    }

    allEdits.sort((a, b) => b.offset - a.offset);
    let newContent = originalContent;
    for (const e of allEdits) {
      newContent = newContent.slice(0, e.offset) + e.text + newContent.slice(e.deleteThrough);
    }

    const pageRef = doc.getPages()[pageNumber - 1].ref;
    const createdRefs: PDFRef[] = [];
    const parentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [];
    const lastInsertedByAnchor = new Map<number, PDFRef>();

    try {
      for (const p of planned) {
        const figureObj = doc.context.obj({
          Type: PDFName.of('StructElem'),
          S: PDFName.of('Figure'),
          P: p.flowParent,
          Pg: pageRef,
          K: PDFNumber.of(p.mcid),
        });
        const figureRef = doc.context.register(figureObj as PDFDict);
        createdRefs.push(figureRef);

        if (p.anchorBefore) {
          this.insertIntoKidsBefore(doc, p.flowParent, p.anchorRef, figureRef);
        } else {
          const insertAfter = lastInsertedByAnchor.get(p.anchorRef.objectNumber) ?? p.anchorRef;
          this.insertIntoKidsAfter(doc, p.flowParent, insertAfter, figureRef);
          lastInsertedByAnchor.set(p.anchorRef.objectNumber, figureRef);
        }

        const figureDict = doc.context.lookup(figureRef, PDFDict);
        figureDict?.set(PDFName.of('P'), p.flowParent);

        parentTreeEntries.push({ mcid: p.mcid, structElementRef: figureRef });
      }

      writePageContent(doc, pageNumber, newContent);
      parentTreeEntries.sort((a, b) => a.mcid - b.mcid);
      this.extendParentTree(doc, pageNumber, parentTreeEntries);
    } catch (err) {
      // Same full-rollback reasoning as fixArtifactSwallowsContent/Complex above.
      writePageContent(doc, pageNumber, originalContent);
      for (const ref of createdRefs) this.deleteElement(doc, ref);
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }

    return {
      issueId: issue.id,
      success: true,
      before: `${spans.length} /PlacedPDF span(s) with no real MCID, unreachable from the structure tree`,
      after: `${spans.length} span(s) retagged as /Figure with a real MCID, wired into the document flow (alt text to follow via the normal missing-alt-text pipeline)`,
    };
  }

  /**
   * Matterhorn 01-005-adjacent fix: wraps a SPECIFIC text run — one whose
   * measured ink color exactly matches its background
   * (pdf-contrast.validator.ts's own "single uniform color" detection) —
   * in /Artifact BMC … EMC, the same convention pdf-artifact-tagger.ts
   * already established for untagged painted paths (BMC, not BDC, to
   * avoid a strict validator looking up /Artifact in /Properties and
   * failing with "Undefined property").
   *
   * Confirmed real on Math_Weir_PDF.pdf: 55 of 88 real COLOR-CONTRAST
   * issues are print-production slug-line text — Illustrator/InDesign
   * job-tracking codes like "E9472/Weir/F02.01/746848/mh-R1", embedded by
   * the layout tool and never meant to be seen by ANY reader, sighted or
   * assistive (one even sits INSIDE a real /Figure's own marked-content
   * span, alongside the Figure's genuine image content). Distinguished
   * from a real, measurable low-contrast defect by the ABSENCE of
   * contrastData on the issue — pdf-contrast.validator.ts never populates
   * it for this detection path, since there's no real foreground/
   * background pair to report a ratio for. The correct fix isn't a
   * contrast-ratio adjustment (there is no real ink color to improve) —
   * it's excluding the run from the accessible content tree entirely,
   * matching what a sighted reader already experiences: nothing.
   *
   * Locates the run the SAME way pdf-contrast-writer.service.ts's own
   * fixColorContrast does — contrast-content-stream.ts's locateTextRun,
   * from the issue's own boundingBox — reusing already-proven,
   * live-validated infrastructure rather than a new detection pass.
   */
  async fixInvisibleTextArtifact(doc: PDFDocument, issues: AuditIssue[]): Promise<FixResult[]> {
    const results: FixResult[] = [];
    for (const issue of issues) {
      results.push(await this.fixOneInvisibleTextArtifact(doc, issue));
    }
    return results;
  }

  private async fixOneInvisibleTextArtifact(doc: PDFDocument, issue: AuditIssue): Promise<FixResult> {
    if (!issue.pageNumber || !issue.boundingBox) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no pageNumber or boundingBox' };
    }

    let content: string | null;
    try {
      content = decodePageContent(doc, issue.pageNumber);
    } catch (err) {
      return {
        issueId: issue.id, success: false, before: 'unknown', after: 'unknown',
        error: `Could not decode page ${issue.pageNumber}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!content) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Page ${issue.pageNumber} has no content stream` };
    }

    // Same {x, baselineY} derivation pdf-contrast-writer.service.ts's own
    // fixColorContrast uses, for consistent, already-proven matching.
    const target = { x: issue.boundingBox.x, baselineY: issue.boundingBox.pageHeight - issue.boundingBox.y };
    const match = locateTextRun(content, target);
    // Same safety gate pdf-contrast-writer.service.ts's own
    // fixColorContrast enforces (CodeRabbit finding on PR #585, confirmed
    // real): a near-equally-close runner-up, a mixed-color run, or a
    // moderately-off-target low-confidence match is not safe to mutate --
    // wrapping the WRONG run in Artifact would hide real content, not
    // fix anything.
    if (!match || match.ambiguous || match.confidence < MIN_APPLY_CONFIDENCE) {
      return {
        issueId: issue.id, success: false, before: 'invisible text run', after: 'unknown',
        error: match
          ? `Match too uncertain to safely apply (confidence ${match.confidence}${match.ambiguous ? ', ambiguous' : ''})`
          : 'Could not locate the invisible text run on this page (already fixed, or its position no longer matches)',
      };
    }

    // A run sitting at the page's top level (or nested only inside other
    // /Artifact tags) can be wrapped in place -- no real content is being
    // nested inside anything. Confirmed live on Math_Weir_PDF.pdf: this
    // path alone resolves 0/55 real cases (see relocateAndWrapInvisibleText's
    // own doc comment) -- every real invisible slug-line run sits inside a
    // real /Figure's own tagged content instead.
    const enclosingTag = this.findEnclosingRealTag(content, match.start);
    if (!enclosingTag) {
      const fixed = content.slice(0, match.start) + '/Artifact BMC ' + content.slice(match.start, match.end) + ' EMC ' + content.slice(match.end);
      writePageContent(doc, issue.pageNumber, fixed);
      return {
        issueId: issue.id,
        success: true,
        before: 'invisible text run tagged as real content',
        after: 'text run marked as /Artifact (excluded from assistive-technology reading order)',
      };
    }

    return this.relocateAndWrapInvisibleText(doc, issue, content, match, enclosingTag);
  }

  /**
   * Handles the run-is-nested-inside-real-tagged-content case
   * fixOneInvisibleTextArtifact refuses to wrap in place (Matterhorn 01-003
   * -- "Content marked as Artifact is present inside tagged content").
   * Simply inserting `/Artifact BMC…EMC` around the run without moving it
   * would still leave it byte-range-nested inside the enclosing real tag's
   * own BDC…EMC span, the exact shape 01-003 flags -- confirmed real and
   * universal on Math_Weir_PDF.pdf: ALL 55 real invisible-slug-line-text
   * issues sit inside a /Figure's own marked-content span (the Illustrator/
   * InDesign "Place" pipeline embeds print-production job-tracking text
   * alongside the Figure's real image content, under ONE shared MCID), so
   * refusing to relocate would mean 0/55 real yield -- the actual defect
   * this fix exists to resolve would simply never be fixable.
   *
   * Instead: cuts the run's own self-contained text object (its enclosing
   * `BT…ET` -- `q`/`Q` are illegal inside a text object per PDF32000-1:2008
   * Annex A, so this never needs to touch surrounding graphics-state ops)
   * out of its current position and re-inserts an /Artifact-wrapped copy
   * immediately BEFORE the enclosing real tag's own BDC -- fully outside
   * its tagged span, so the run is no longer "inside tagged content" at
   * all. Three independent safety gates, each bailing (never guessing) to
   * "needs struct-tree-level handling instead" on failure:
   *
   * 1. CTM match -- the ambient transform at the insertion point must equal
   *    the one at the run's own original position (computeCtmAt), or the
   *    run's absolute Tm coordinates would render at a different page
   *    position after the move. A sheared/rotated transform at either
   *    position also bails (computeCtmAt/locateEnclosingTextObject's own
   *    convention).
   * 2. Self-contained block -- the text object must contain no drawing/
   *    graphics-state operator of its own beyond text-showing/positioning
   *    (analyzeTextObjectForRelocation) -- true for every real Math_Weir
   *    case (a self-contained `BT…ET`, sometimes sharing an OUTER `q…Q`
   *    with unrelated sibling content like a decorative border stroke, but
   *    never containing one itself).
   * 3. Color preservation -- if the block doesn't set its own fill color,
   *    the ambient color at its ORIGINAL position (findPrecedingColor,
   *    same utility pdf-contrast-writer.service.ts's own restore logic
   *    uses) is explicitly written into the relocated copy, wrapped in a
   *    fresh `q…Q` so it can never leak into whatever follows at the new
   *    position -- otherwise the run could render in whatever color
   *    happens to be ambient at the destination instead of the one that
   *    made it genuinely invisible.
   *
   * Even after all three gates pass, the result is re-rendered and
   * verified (verifyStillNoDetectableInk) to still read as uniform,
   * undetectable ink at its new position before being reported as success
   * -- reverted otherwise. This is the only way to catch a wrong
   * restored color or an unmodeled state dependency: once relocated, the
   * run is /Artifact-tagged, so pdf-contrast.validator.ts's own Artifact-
   * awareness (PR #585) means a re-audit will never inspect it again
   * regardless of what it actually renders as.
   */
  private async relocateAndWrapInvisibleText(
    doc: PDFDocument,
    issue: AuditIssue,
    content: string,
    match: TextRunMatch,
    enclosingTag: string,
  ): Promise<FixResult> {
    const pageNumber = issue.pageNumber!;
    const fail = (error: string): FixResult => ({
      issueId: issue.id, success: false, before: 'invisible text run', after: 'unknown',
      error: `${error} Needs struct-tree-level handling instead.`,
    });
    const nested = `Run is nested inside a real /${enclosingTag} structure element's own content, and`;

    const enclosing = locateEnclosingTextObject(content, match.start);
    if (!enclosing) {
      return fail(`${nested} its enclosing text object could not be safely characterized (missing BT, or a sheared/rotated transform in effect).`);
    }

    const outer = this.findOutermostRealTagBounds(content, match.start);
    if (!outer || outer.bdcStart >= enclosing.btStart) {
      return fail(`${nested} its enclosing tagged region's bounds could not be determined.`);
    }

    const destCtm = computeCtmAt(content, outer.bdcStart);
    if (!destCtm || !this.ctmsMatch(enclosing.ctm, destCtm)) {
      return fail(`${nested} the ambient transform there differs from (or could not be matched to) the transform at the only safe place to relocate it to -- relocating would risk rendering it at the wrong page position.`);
    }

    const analysis = this.analyzeTextObjectForRelocation(content, enclosing.btStart);
    if (!analysis) {
      return fail(`${nested} its enclosing text object isn't a simple, self-contained block safe to relocate (contains a graphics-state/drawing operator of its own, or an unbalanced BT/ET).`);
    }

    // The text object's own q…Q may establish a CLIP (e.g. `x y w h re W n`)
    // that clips it out of view entirely -- confirmed real and live on
    // Math_Weir_PDF.pdf: a run whose baseline sits just below its own clip
    // rectangle's bottom edge renders as fully invisible black ink in its
    // original position, but becomes plainly visible real text once
    // relocated without that clip (caught by this method's own verify step
    // below, on the very first live validation attempt -- see
    // relocateAndWrapInvisibleText's own doc comment). findClipPreamble
    // captures that clip (and any color op sitting alongside it) so it can
    // be reproduced verbatim at the new position, not just the run's color.
    const preamble = this.findClipPreamble(content, enclosing.btStart);
    if (preamble === null) {
      return fail(`${nested} the graphics state established between its enclosing q and its own BT (e.g. a non-rectangular clip, or another operator this fix doesn't recognize as safe to reproduce elsewhere) could not be safely characterized.`);
    }

    const { etEnd, hasOwnColor } = analysis;
    const btStart = enclosing.btStart;
    const PREAMBLE_COLOR_OPS = new Set(['k', 'K', 'rg', 'RG', 'g', 'G', 'sc', 'SC', 'scn', 'SCN']);
    const preambleHasColor = tokenize(preamble).some((tk) => tk.t === 'op' && PREAMBLE_COLOR_OPS.has(tk.v));

    let ambientColorOp = '';
    if (!hasOwnColor && !preambleHasColor) {
      const ambientColor = findPrecedingColor(content, btStart, (csName, nums) => resolveSourceColor(doc, pageNumber, csName, nums));
      if (!ambientColor) {
        return fail(`${nested} the ambient fill color to preserve when relocating it could not be determined (an untracked colorspace was last set).`);
      }
      ambientColorOp = `${ambientColor[0]} ${ambientColor[1]} ${ambientColor[2]} rg\n`;
    }

    const block = content.slice(btStart, etEnd); // always starts with the literal 'BT'
    const wrapped = `/Artifact BMC\nq\n${preamble}${ambientColorOp}${block}\nQ\nEMC\n`;

    const newContent =
      content.slice(0, outer.bdcStart) +
      wrapped +
      content.slice(outer.bdcStart, btStart) +
      content.slice(etEnd);

    writePageContent(doc, pageNumber, newContent);

    const verifyBuffer = Buffer.from(await doc.save());
    const stillInvisible = await verifyStillNoDetectableInk(verifyBuffer, pageNumber, issue.boundingBox!);
    if (!stillInvisible) {
      writePageContent(doc, pageNumber, content); // revert to the pre-relocation content
      return fail(`Relocating this run out of its enclosing /${enclosingTag} produced a different visual result than the original (its new position no longer renders as uniform, undetectable ink) -- reverted rather than risk introducing a new visible artifact.`);
    }

    return {
      issueId: issue.id,
      success: true,
      before: `invisible text run nested inside a real /${enclosingTag} structure element's own content`,
      after: `relocated outside the /${enclosingTag}'s tagged region and marked /Artifact (verified render unchanged)`,
    };
  }

  private ctmsMatch(
    a: { a: number; d: number; e: number; f: number },
    b: { a: number; d: number; e: number; f: number },
  ): boolean {
    const EPS = 1e-6;
    return Math.abs(a.a - b.a) < EPS && Math.abs(a.d - b.d) < EPS && Math.abs(a.e - b.e) < EPS && Math.abs(a.f - b.f) < EPS;
  }

  /**
   * The byte range [bdcStart, emcEnd) of the OUTERMOST real (non-/Artifact)
   * marked-content tag enclosing `position`, or null if none does. Unlike
   * findEnclosingRealTag (which only needs the innermost tag's NAME to
   * decide whether to bail at all), relocateAndWrapInvisibleText needs the
   * full span of the widest real tag involved -- relocating past only the
   * innermost one could still leave the run nested inside an OUTER real
   * tag, if one exists.
   */
  private findOutermostRealTagBounds(content: string, position: number): { bdcStart: number; emcEnd: number; tag: string } | null {
    const tokens = tokenize(content);
    const stack: Array<{ tag: string; start: number }> = [];
    const operands: string[] = [];
    let dictDepth = 0;
    let target: { tag: string; start: number; stackIndex: number } | null = null;
    // The byte offset of this BDC/BMC's own FIRST operand (the tag name,
    // e.g. `/Figure`) -- NOT the operator keyword's own offset, which sits
    // AFTER the tag name and any properties dict in PDF's postfix syntax.
    // Splicing at the operator's offset would leave the tag name itself
    // behind, corrupting the content stream (confirmed live: produced
    // `/Figure <</MCID 0>>/Artifact BMC ... EMC BDC` -- a stray, orphaned
    // BDC with no operands at all).
    let pendingStart: number | null = null;

    for (const tk of tokens) {
      if (dictDepth > 0) {
        if (tk.t === '<<') dictDepth++;
        else if (tk.t === '>>') dictDepth--;
        continue;
      }
      if (tk.t === '<<') { dictDepth = 1; continue; }

      if (target === null && tk.start >= position) {
        const idx = stack.findIndex((f) => f.tag !== 'Artifact');
        if (idx === -1) return null;
        target = { tag: stack[idx].tag, start: stack[idx].start, stackIndex: idx };
      }

      if (tk.t !== 'op') {
        if (pendingStart === null) pendingStart = tk.start;
        operands.push(tk.v);
        continue;
      }
      if (tk.v === 'BDC' || tk.v === 'BMC') {
        stack.push({ tag: (operands[0] ?? '').replace(/^\//, ''), start: pendingStart ?? tk.start });
      } else if (tk.v === 'EMC') {
        stack.pop();
        if (target !== null && stack.length === target.stackIndex) {
          return { bdcStart: target.start, emcEnd: tk.end, tag: target.tag };
        }
      }
      operands.length = 0;
      pendingStart = null;
    }
    return null;
  }

  /**
   * Validates that the text object starting at `btStart` is safe to
   * relocate wholesale: finds its matching `ET` and confirms nothing
   * between them is a graphics-state or drawing operator PDF32000-1:2008
   * Annex A forbids inside a text object anyway (`q`/`Q`/`Do`/`sh`/`EI`/
   * `cm`) -- a defensive check for a malformed document (pdfjs tolerates
   * this silently per spliceColorFix's own doc comment; a stricter reader
   * would not) rather than something expected on a well-formed one.
   * Also reports whether the block sets its own fill color before its
   * first text-showing op, so the caller knows whether an explicit
   * ambient-color restore is needed. Returns null on an unbalanced
   * BT/ET or a disallowed operator.
   */
  private analyzeTextObjectForRelocation(content: string, btStart: number): { etEnd: number; hasOwnColor: boolean } | null {
    const tokens = tokenize(content);
    const DISALLOWED_IN_TEXT_OBJECT = new Set(['q', 'Q', 'Do', 'sh', 'EI', 'cm']);
    const FILL_COLOR_OPS = new Set(['rg', 'g', 'k', 'sc', 'scn']);
    const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

    let depth = 0;
    let hasOwnColor = false;
    let sawTextShow = false;
    for (const tk of tokens) {
      if (tk.start < btStart) continue;
      if (tk.t !== 'op') continue;
      if (tk.v === 'BT') { depth++; continue; }
      if (tk.v === 'ET') {
        depth--;
        if (depth === 0) return { etEnd: tk.end, hasOwnColor };
        continue;
      }
      if (DISALLOWED_IN_TEXT_OBJECT.has(tk.v)) return null;
      if (!sawTextShow && FILL_COLOR_OPS.has(tk.v)) hasOwnColor = true;
      if (TEXT_SHOW_OPS.has(tk.v)) sawTextShow = true;
    }
    return null; // unbalanced BT/ET
  }

  /**
   * The raw bytes between `btStart`'s immediately-enclosing `q` and
   * `btStart` itself -- e.g. a clip-establishing `x y w h re W n` sequence
   * -- or `''` when there's no enclosing `q` at all (nothing to preserve).
   * Returns null when that gap contains anything outside a narrow, known-
   * safe whitelist (a rectangular clip's own re, W, W-star, and n ops, a fill/stroke
   * color op, or a `gs` ExtGState reference -- all position-independent,
   * safe to reproduce verbatim at a relocated position) -- deliberately
   * narrow: a non-rectangular clip path, a `cm`, another `q`, or anything
   * else this fix doesn't specifically recognize bails rather than risk
   * silently dropping or mischaracterizing state relocateAndWrapInvisibleText
   * can't actually reproduce. `cm` in particular is excluded on purpose:
   * that risk is already covered by this method's own CTM-match gate
   * (computeCtmAt/ctmsMatch), not by this whitelist.
   */
  private findClipPreamble(content: string, btStart: number): string | null {
    const tokens = tokenize(content);
    const qStack: number[] = [];
    for (const tk of tokens) {
      if (tk.start >= btStart) break;
      if (tk.t === 'op' && tk.v === 'q') qStack.push(tk.start);
      else if (tk.t === 'op' && tk.v === 'Q') qStack.pop();
    }
    if (qStack.length === 0) return '';
    const qStart = qStack[qStack.length - 1];
    const preambleStart = qStart + 1; // right after the 'q' operator itself

    const ALLOWED = new Set(['re', 'W', 'W*', 'n', 'k', 'K', 'rg', 'RG', 'g', 'G', 'sc', 'SC', 'scn', 'SCN', 'gs']);
    for (const tk of tokens) {
      if (tk.start < preambleStart || tk.start >= btStart) continue;
      if (tk.t === 'op' && !ALLOWED.has(tk.v)) return null;
    }
    return content.slice(preambleStart, btStart);
  }

  /**
   * The nearest enclosing REAL (non-/Artifact) marked-content tag name
   * open at a given byte position, or null if the position is either at
   * the page's top level or nested only inside /Artifact tags. Used by
   * fixInvisibleTextArtifact to refuse creating a NESTED /Artifact when
   * the target is already inside a real tagged element (Matterhorn 01-003
   * territory — see that method's own doc comment).
   *
   * Reuses the same tokenizer mcid-bounding-box.ts already relies on, with
   * the same dict-skipping technique for a BDC's own inline properties
   * dict (so an inline `<</MCID n>>` never gets mistaken for operands of
   * the BDC/BMC operator itself). Only tracks TAG NAMES and nesting depth
   * here — no CTM or geometry needed for this purpose.
   */
  private findEnclosingRealTag(content: string, position: number): string | null {
    const tokens = tokenize(content);
    const stack: string[] = [];
    const operands: string[] = [];
    let dictDepth = 0;

    for (const tk of tokens) {
      if (tk.start >= position) break;

      if (dictDepth > 0) {
        if (tk.t === '<<') dictDepth++;
        else if (tk.t === '>>') dictDepth--;
        continue;
      }
      if (tk.t === '<<') { dictDepth = 1; continue; }

      if (tk.t !== 'op') { operands.push(tk.v); continue; }

      if (tk.v === 'BDC' || tk.v === 'BMC') {
        stack.push((operands[0] ?? '').replace(/^\//, ''));
      } else if (tk.v === 'EMC') {
        stack.pop();
      }
      operands.length = 0;
    }

    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] !== 'Artifact') return stack[i];
    }
    return null;
  }

  /**
   * Deterministically extracts alt text for a Figure whose entire content
   * is a SINGLE, self-contained text-showing glyph -- e.g. a lone italic
   * variable letter ("V", "d") typeset as its own inline /Figure rather
   * than real paragraph text (an InDesign "PlacedGraphic" convention for
   * embedded math notation). Confirmed real and live on Math_Weir_PDF.pdf:
   * 219 of 437 struct-tree-only missing-alt Figures (50.1%) are exactly
   * this shape -- always exactly one Tj/TJ call, always exactly one
   * printable-ASCII character once non-printable bytes are excluded.
   *
   * Deliberately narrow: only succeeds when the Figure's marked-content
   * span contains EXACTLY ONE text-showing operator (Tj/TJ/'/"), and the
   * decoded literal-string content -- after dropping bytes outside the
   * printable ASCII range 0x20-0x7E, which are almost certainly a custom
   * symbol font's own remapped glyphs (fraction bars, brackets, drawn via
   * octal-escaped control-range byte values like \037) rather than real
   * characters this can interpret without that font's own Differences
   * array -- is non-empty. Hex-encoded strings (a composite/CID font,
   * confirmed real as a co-occurring prefix glyph alongside the readable
   * one in every single-glyph case sampled) are skipped entirely, never
   * guessed at, for the same reason.
   *
   * A Figure with MULTIPLE text-show calls (confirmed real and equally
   * common -- 218 of 437, a multi-part formula like "negative likelihood
   * ratio" + subscripted table-cell variables "C"/"AC"/"D"/"BD", where
   * naive concatenation loses the formula's own structure and reads as
   * confusing run-on text) is refused rather than guessed at -- that class
   * needs a different, structure-aware approach, not this one.
   *
   * Also refuses when the span contains an XObject invocation (`Do`), a
   * shading (`sh`), or an inline image (`EI`) -- confirmed real and live:
   * page 1's cover-image Figure (MCID 0) has a real embedded image
   * (`/Im0 Do`) AND an UNRELATED, still-uncorrected invisible print-
   * production slug line ("E9472/Weir/Front_cover_inside/746841/mh-R1")
   * both inside the same marked-content span -- exactly one readable
   * text-show call, which would otherwise pass every check above and
   * silently become the COVER IMAGE's own alt text. A Figure containing a
   * real embedded image needs a real (image-based) description, never
   * text that merely happens to share its span.
   *
   * Deliberately does NOT exclude plain path-painting operators
   * (fill/stroke) the way pdf-artifact-tagger.ts's own PATH_PAINT_OPS
   * check does for a DIFFERENT purpose -- confirmed real and live: a small
   * stroked line segment directly above the letter is the overline bar for
   * "X̄" (sample mean notation, a font without a precomposed combining-
   * overline glyph draws it as its own short vector stroke), a completely
   * legitimate part of THIS SAME glyph's own visual representation, not
   * unrelated content -- excluding it dropped real yield from 220 to 58 on
   * the very first live check. `Do`/`sh`/`EI` are categorically different:
   * each embeds or invokes a genuinely separate, substantial visual object
   * a plain stroke/fill of a handful of coordinates never does.
   *
   * `content` must already be decoded (decodePageContent); `mcid`
   * identifies the specific Figure by its own marked-content span. Returns
   * null when the shape doesn't qualify or the MCID can't be found --
   * callers should fall back to the existing AI-vision alt-text path, not
   * treat null as a hard failure.
   */
  extractSingleGlyphAltText(content: string, mcid: number): string | null {
    const span = this.findMarkedContentSpanForMcid(content, mcid);
    if (!span) return null;

    const DRAWING_OPS = new Set(['Do', 'sh', 'EI']);
    const tokens = tokenize(content);
    // Counts only text-show ops that carry at least one READABLE (literal-
    // string) operand -- a purely hex-encoded Tj (a composite/CID font's
    // own prefix glyph, confirmed real and common alongside a readable one
    // in the same Figure, e.g. a decorative lead-in glyph before an italic
    // variable letter) is silently skipped for content and does NOT count
    // against the "exactly one fragment" constraint below; only multiple
    // READABLE fragments (the confirmed multi-part-formula shape) refuse.
    let readableTextShowCount = 0;
    let extracted: string | null = null;
    let pendingStrings: Array<{ t: string; v: string }> = [];

    for (const tk of tokens) {
      if (tk.start < span.start || tk.start >= span.end) continue;
      if (tk.t === 'op' && DRAWING_OPS.has(tk.v)) return null;
      if (tk.t === 's' || tk.t === 'h') {
        pendingStrings.push({ t: tk.t, v: content.slice(tk.start, tk.end) });
        continue;
      }
      if (tk.t === '[') { pendingStrings = []; continue; }
      if (tk.t !== 'op') continue;
      if (tk.v === 'Tj' || tk.v === 'TJ' || tk.v === "'" || tk.v === '"') {
        const hasReadable = pendingStrings.some(s => s.t === 's');
        if (hasReadable) {
          readableTextShowCount++;
          if (readableTextShowCount > 1) return null; // more than one readable fragment -- not this fix's shape
          let text = '';
          for (const s of pendingStrings) {
            if (s.t !== 's') continue; // hex/composite-font glyph -- can't interpret without its ToUnicode CMap, skip
            text += this.decodePrintableAsciiOnly(s.v);
          }
          extracted = text;
        }
        pendingStrings = [];
      } else {
        pendingStrings = [];
      }
    }

    if (readableTextShowCount !== 1 || extracted === null) return null;
    const trimmed = extracted.trim();
    // CodeRabbit finding on PR #587, confirmed real (though not a live
    // regression -- every one of the 219 real cases already validated
    // against Math_Weir_PDF.pdf is exactly one character): this method's
    // own name and doc comment promise a SINGLE glyph, but only checked
    // "non-empty," not "exactly one character" -- a 2+-character fragment
    // (a short run of body text this method has no way to distinguish from
    // a genuine multi-character symbol) would have silently qualified.
    // Tightened to match the documented contract exactly.
    return trimmed.length === 1 ? trimmed : null;
  }

  /**
   * Builds a compact, position-annotated text transcript of a Figure's own
   * marked-content span, for the ~50% of real missing-alt-text Figures that
   * are NOT extractSingleGlyphAltText's single-glyph shape but a genuine
   * multi-fragment inline math expression -- confirmed real on
   * Math_Weir_PDF.pdf: subscripted/superscripted statistical notation built
   * from several small Tj/TJ runs, mixed with undecodable custom-symbol-
   * font operator glyphs (SymbolMT, subset-remapped to generic glyph IDs
   * like /g184 with no ToUnicode and no semantic glyph name -- confirmed
   * via direct /Differences inspection, a deterministic per-glyph decode is
   * not possible) and, on a real fraction of cases, a hand-drawn filled-
   * path shape (most often a radical/fraction bar/overline).
   *
   * NOT a rendering-accurate reconstruction -- deliberately coarse, since
   * the goal is giving a text-only AI model useful structural hints, not
   * claiming exact operator identity (which decodePrintableAsciiOnly
   * already can't recover for undecodable glyphs regardless). Each text-
   * show fragment is tagged with one of four labels from two independent,
   * honestly-scoped signals rather than one falsely-precise unified
   * position:
   *   - "raised"/"lowered": this fragment's own Td/TD y-offset, accumulated
   *     since the most recent Tm (which resets the reference to 0 -- matches
   *     the observed real shape of one Tm per sub-expression cluster, small
   *     Td walks between its own fragments), exceeds a small threshold.
   *   - "smaller-script": Y offset alone didn't clear the threshold, but
   *     this fragment's enclosing Tm uses a meaningfully smaller font scale
   *     than the span's own first Tm (ratio < 0.85) -- the OTHER real shape,
   *     a fresh absolute-position Tm per fragment rather than Td deltas,
   *     where a shrunken font size is the clearer signal than Y position.
   *   - "main": neither signal fired.
   * A hex-only (composite/CID font) fragment becomes the literal token
   * "[symbol]" rather than being silently dropped, the same honest-about-
   * uncertainty choice extractSingleGlyphAltText makes for the ones it
   * skips.
   *
   * `content` must already be decoded (decodePageContent); `mcid`
   * identifies the specific Figure by its own marked-content span. Returns
   * null when the span can't be found, contains no text-show output at
   * all, or shares its span with a real embedded image/shading (same
   * DRAWING_OPS refusal extractSingleGlyphAltText uses, for the same
   * reason -- never describe unrelated co-located content as this
   * Figure's own).
   */
  buildFormulaTranscript(content: string, mcid: number): string | null {
    const span = this.findMarkedContentSpanForMcid(content, mcid);
    if (!span) return null;

    const DRAWING_OPS = new Set(['Do', 'sh', 'EI']);
    const FILL_OPS = new Set(['f', 'F', 'f*']);
    const Y_THRESHOLD = 0.3;
    const SCALE_RATIO_THRESHOLD = 0.85;

    const tokens = tokenize(content);
    const fragments: string[] = [];
    let hasDrawnPath = false;
    let baselineScale: number | null = null;
    let curScale: number | null = null;
    let curY = 0;
    let numOperands: number[] = [];
    let pendingStrings: Array<{ t: string; v: string }> = [];

    for (const tk of tokens) {
      if (tk.start < span.start || tk.start >= span.end) continue;

      if (tk.t === 'n') { numOperands.push(parseFloat(tk.v)); continue; }
      if (tk.t === 's' || tk.t === 'h') {
        pendingStrings.push({ t: tk.t, v: content.slice(tk.start, tk.end) });
        continue;
      }
      if (tk.t !== 'op') continue;

      const op = tk.v;
      if (DRAWING_OPS.has(op)) return null;
      if (FILL_OPS.has(op)) hasDrawnPath = true;

      if (op === 'Tm') {
        // a b c d e f -- d is the font-relevant scale for the common
        // (non-rotated, non-skewed) case every real sample here uses.
        const d = numOperands[3];
        if (typeof d === 'number' && !Number.isNaN(d)) {
          if (baselineScale === null) baselineScale = d;
          curScale = d;
        }
        curY = 0;
        numOperands = [];
        pendingStrings = [];
        continue;
      }
      if (op === 'Td' || op === 'TD') {
        const ty = numOperands[numOperands.length - 1];
        if (typeof ty === 'number' && !Number.isNaN(ty)) curY += ty;
        numOperands = [];
        continue;
      }

      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        // CodeRabbit finding, confirmed real: a single TJ array can mix
        // readable and hex operands (e.g. `[(V) <0037> (X)]TJ`) -- the
        // previous version concatenated all readable text into one string
        // and only tracked hex PRESENCE as a boolean, so a hex operand
        // sitting between two readable ones silently vanished (no [symbol]
        // marker at all) whenever ANY readable text existed in the same
        // array. Building one display token per operand, in source order,
        // preserves both the text and the marker.
        const parts: string[] = [];
        for (const s of pendingStrings) {
          if (s.t === 's') {
            const decoded = this.decodePrintableAsciiOnly(s.v).trim();
            if (decoded.length > 0) parts.push(`"${decoded}"`);
          } else {
            parts.push('[symbol]');
          }
        }
        if (parts.length > 0) {
          const isSmaller = baselineScale !== null && curScale !== null && curScale / baselineScale < SCALE_RATIO_THRESHOLD;
          const label = curY > Y_THRESHOLD ? 'raised'
            : curY < -Y_THRESHOLD ? 'lowered'
            : isSmaller ? 'smaller-script'
            : 'main';
          fragments.push(`[${label}] ${parts.join(' ')}`);
        }
        pendingStrings = [];
        numOperands = [];
        continue;
      }

      pendingStrings = [];
      numOperands = [];
    }

    if (fragments.length === 0) return null;

    const header = hasDrawnPath
      ? 'Transcript of an inline mathematical expression (this figure also contains a drawn line or curve, possibly a radical, fraction bar, or overline):'
      : 'Transcript of an inline mathematical expression:';
    return `${header}\n${fragments.join('\n')}`;
  }

  /**
   * The byte range [start, end) of the marked-content span (BDC…EMC)
   * carrying a specific /MCID value, searched across the whole `content`
   * string -- unlike this file's other findXAtPosition-style helpers,
   * there's no anchor position to search from here; the caller only knows
   * the MCID it's looking for. Same dict-skip/pendingStart technique as
   * findOutermostRealTagBounds (a BDC's own inline properties dict must
   * never be mistaken for its operands).
   */
  private findMarkedContentSpanForMcid(content: string, mcid: number): { start: number; end: number } | null {
    const tokens = tokenize(content);
    const operands: Array<{ t: string; v: string; start: number; end: number }> = [];
    let dictDepth = 0;
    let dictMcid: number | null = null;
    let pendingStart: number | null = null;

    for (const tk of tokens) {
      if (dictDepth > 0) {
        if (tk.t === '<<') dictDepth++;
        else if (tk.t === '>>') dictDepth--;
        else if (dictDepth === 1 && tk.t === 'n' && operands.length && operands[operands.length - 1].v === '/MCID') {
          dictMcid = parseInt(tk.v, 10);
        } else if (dictDepth === 1) {
          operands.push(tk);
        }
        continue;
      }
      if (tk.t === '<<') { dictDepth = 1; dictMcid = null; continue; }

      if (tk.t !== 'op') {
        if (pendingStart === null) pendingStart = tk.start;
        operands.push(tk);
        continue;
      }
      if ((tk.v === 'BDC' || tk.v === 'BMC') && dictMcid === mcid) {
        const bdcStart = pendingStart ?? tk.start;
        let depth = 1;
        for (const inner of tokens) {
          if (inner.start <= tk.start) continue;
          if (inner.t !== 'op') continue;
          if (inner.v === 'BDC' || inner.v === 'BMC') depth++;
          else if (inner.v === 'EMC') { depth--; if (depth === 0) return { start: bdcStart, end: inner.end }; }
        }
        return null; // unbalanced -- no matching EMC found
      }
      operands.length = 0;
      dictMcid = null;
      pendingStart = null;
    }
    return null;
  }

  /**
   * Decodes a PDF literal-string token's raw source text (including
   * surrounding parens and any backslash escapes -- PDF32000-1:2008
   * 7.3.4.2) into its printable-ASCII-only content, dropping any byte
   * outside 0x20-0x7E. Handles octal escapes (\ddd, 1-3 digits) explicitly
   * -- confirmed real and necessary live: a naive single-char-escape-only
   * decoder mangles \037 into the literal digit characters "0", "3", "7"
   * instead of the single control-range byte 0x1F it actually represents,
   * which this method would then correctly drop as non-printable instead
   * of leaking as garbage digits into the assembled alt text.
   *
   * Dropping non-printable bytes outright (rather than keeping them) is
   * deliberate: a custom symbol/math font's own Encoding/Differences array
   * can remap ANY byte value to ANY glyph (fraction bars, brackets, sized
   * to fit the surrounding formula), and this method has no access to that
   * font's own table -- keeping them would silently fabricate characters
   * that were never really there.
   */
  private decodePrintableAsciiOnly(raw: string): string {
    const inner = raw.slice(1, -1); // strip surrounding ( )
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      let byte: number;
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const c = inner[i + 1];
        if (c >= '0' && c <= '7') {
          let oct = c;
          let j = i + 2;
          for (let k = 0; k < 2 && j < inner.length && inner[j] >= '0' && inner[j] <= '7'; k++, j++) oct += inner[j];
          byte = parseInt(oct, 8) & 0xff;
          i = j - 1;
        } else if (c === 'n') { byte = 10; i++; }
        else if (c === 'r') { byte = 13; i++; }
        else if (c === 't') { byte = 9; i++; }
        else if (c === 'b') { byte = 8; i++; }
        else if (c === 'f') { byte = 12; i++; }
        else if (c === '\n') { i++; continue; } // line continuation, no byte
        else { byte = c.charCodeAt(0); i++; } // \), \(, \\, or any other escaped char -> itself
      } else {
        byte = inner.charCodeAt(i);
      }
      if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    }
    return out;
  }

  /**
   * Resolves the ParentTree "page array" (the flat list of MCID -> real-
   * content-or-StructElem entries for one page) for a given page number,
   * handling BOTH shapes confirmed real across this codebase's own
   * documents: a flat /Nums array on /ParentTree itself (Math_Kim), and a
   * hierarchical /Kids number tree with per-node /Limits ranges
   * (Math_Weir_PDF.pdf) -- unlike resolveParentTreeNumsArray (used by
   * extendParentTree to WRITE a new entry), which deliberately bails on the
   * hierarchical shape since no confirmed-real case needed writing into one
   * yet, this is READ-ONLY and a genuinely different, simpler need: locating
   * an EXISTING entry, not adding a new one. Returns null (never throws) on
   * any resolution failure -- callers already expect a possibly-missing
   * page array.
   */
  private resolveParentTreePageArray(doc: PDFDocument, pageNumber: number): PDFArray | null {
    const page = doc.getPage(pageNumber - 1);
    const structParentsRaw = page.node.get(PDFName.of('StructParents'));
    const structParents = structParentsRaw instanceof PDFRef ? doc.context.lookup(structParentsRaw) : structParentsRaw;
    if (!(structParents instanceof PDFNumber)) return null;
    const pageKey = structParents.asNumber();

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return null;
    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeDict = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    if (!(parentTreeDict instanceof PDFDict)) return null;

    const findInNode = (node: PDFDict): PDFArray | null => {
      const numsRaw = node.get(PDFName.of('Nums'));
      if (numsRaw) {
        const numsArr = numsRaw instanceof PDFRef ? doc.context.lookup(numsRaw) : numsRaw;
        if (!(numsArr instanceof PDFArray)) return null;
        const raw = numsArr.asArray();
        for (let i = 0; i < raw.length; i += 2) {
          const keyEntry = raw[i];
          const key = keyEntry instanceof PDFNumber ? keyEntry.asNumber() : null;
          if (key !== pageKey) continue;
          const valRaw = raw[i + 1];
          const val = valRaw instanceof PDFRef ? doc.context.lookup(valRaw) : valRaw;
          return val instanceof PDFArray ? val : null;
        }
        return null;
      }
      const kidsRaw = node.get(PDFName.of('Kids'));
      if (!kidsRaw) return null;
      const kids = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
      if (!(kids instanceof PDFArray)) return null;
      for (const kidRef of kids.asArray()) {
        const kid = kidRef instanceof PDFRef ? doc.context.lookup(kidRef) : kidRef;
        if (!(kid instanceof PDFDict)) continue;
        const limitsRaw = kid.get(PDFName.of('Limits'));
        const limits = limitsRaw instanceof PDFRef ? doc.context.lookup(limitsRaw) : limitsRaw;
        if (limits instanceof PDFArray) {
          const bounds = limits.asArray();
          const lo = bounds[0] instanceof PDFNumber ? (bounds[0] as PDFNumber).asNumber() : null;
          const hi = bounds[1] instanceof PDFNumber ? (bounds[1] as PDFNumber).asNumber() : null;
          if (lo !== null && hi !== null && (pageKey < lo || pageKey > hi)) continue;
        }
        const found = findInNode(kid);
        if (found) return found;
      }
      return null;
    };
    return findInNode(parentTreeDict);
  }

  /**
   * Reattaches a figure caption's /Story wrapper into the structure tree --
   * see pdf-figure-caption-tree.validator.ts's own header comment for the
   * real defect this fixes (confirmed on Math_Weir_PDF.pdf: 66 of 75 real
   * /fc caption StructElems tagged in the content stream and correctly
   * cross-referenced in /ParentTree, but never linked into any parent's /K
   * array -- invisible to any top-down reader). Every one of the 66 real
   * cases shares one exact shape, verified before writing this fix rather
   * than assumed:
   *
   *   [[grandparent, K: array, multiple children]]
   *     -> [Sect, K: bare (single child), P: grandparent]
   *          -> [Figure]
   *     -> ... (the /fc's own /Story wrapper belongs HERE, right after Sect)
   *
   * i.e. the /Figure immediately preceding the caption (by MCID, on the
   * SAME page) is always wrapped in its own single-child /Sect, and that
   * /Sect always has a real /P pointing at a genuine multi-child container
   * -- the correct reattachment point, confirmed identical across all 66
   * real cases rather than merely assumed from the first few. Uses
   * insertIntoKidsAfter (already-established anchor-relative insertion) to
   * splice the /Story in immediately after its Figure's /Sect, preserving
   * reading-order proximity, then sets the /Story's own /P (missing
   * entirely on every real case) to the grandparent.
   *
   * Bails (does not guess) when: the element id doesn't resolve to a real
   * /fc at the expected position (the document changed since the issue was
   * generated), the /fc's own /P doesn't point at a real /Story, no
   * /Figure precedes the caption on the same page, that Figure's own
   * parent isn't a single-child wrapper, or that wrapper has no real /P of
   * its own -- each a genuinely different document shape this fix hasn't
   * been verified against, matching this file's established convention.
   */
  reattachFigureCaption(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const m = /^caption_p(\d+)_mc(\d+)$/.exec(issue.element ?? '');
        if (!m) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Unrecognized element id "${issue.element}"` });
          continue;
        }
        const pageNumber = parseInt(m[1], 10);
        const captionMcid = parseInt(m[2], 10);

        const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
        if (!pageArr) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No ParentTree page array found for page ${pageNumber}` });
          continue;
        }
        const pageArrRaw = pageArr.asArray();

        const fcEntry = pageArrRaw[captionMcid];
        if (!(fcEntry instanceof PDFRef)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No real StructElem at MCID ${captionMcid} on page ${pageNumber}` });
          continue;
        }
        const fcDict = doc.context.lookup(fcEntry, PDFDict);
        const fcType = fcDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
        if (fcType !== 'fc') {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `MCID ${captionMcid} on page ${pageNumber} is not a /fc caption (found /${fcType})` });
          continue;
        }

        const storyPRaw = fcDict!.get(PDFName.of('P'));
        if (!(storyPRaw instanceof PDFRef)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Caption /fc has no /P pointing at its /Story wrapper' });
          continue;
        }
        const storyRef = storyPRaw;
        const storyDict = doc.context.lookup(storyRef, PDFDict);
        const storyType = storyDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
        if (!storyDict || storyType !== 'Story') {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Caption's /P does not resolve to a real /Story (found /${storyType})` });
          continue;
        }
        // CodeRabbit finding on PR #592, confirmed real: the /fc -> /Story
        // link was only verified in the UP direction (/fc's own /P) --
        // never cross-checked that /Story's own /K actually references
        // THIS /fc back. /Story /K is a bare ref for a single-caption story
        // (59/66 real cases), but a real /Story can also wrap MULTIPLE /fc
        // children as an array (7/66 real cases -- e.g. a two-part
        // caption split across two /fc paragraphs) -- both confirmed live,
        // so both are accepted; a corrupted or genuinely different shape
        // (neither) still isn't trusted on the /P pointer alone.
        const storyK = storyDict.get(PDFName.of('K'));
        const storyReferencesFc = storyK instanceof PDFRef
          ? storyK.objectNumber === fcEntry.objectNumber
          : storyK instanceof PDFArray
            ? storyK.asArray().some(item => item instanceof PDFRef && item.objectNumber === fcEntry.objectNumber)
            : false;
        if (!storyReferencesFc) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Story\'s /K does not reference this /fc back -- unverified shape, declining rather than guessing' });
          continue;
        }

        // Nearest preceding /Figure on the SAME page, by MCID.
        let bestFigureMcid = -1;
        let bestFigureRef: PDFRef | null = null;
        for (let i = 0; i < Math.min(captionMcid, pageArrRaw.length); i++) {
          const entry = pageArrRaw[i];
          if (!(entry instanceof PDFRef)) continue;
          const resolved = doc.context.lookup(entry);
          if (!(resolved instanceof PDFDict)) continue;
          if (resolved.get(PDFName.of('S'))?.toString() !== '/Figure') continue;
          if (i > bestFigureMcid) { bestFigureMcid = i; bestFigureRef = entry; }
        }
        if (!bestFigureRef) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No preceding /Figure found on page ${pageNumber} to anchor the caption near` });
          continue;
        }

        const figureDict = doc.context.lookup(bestFigureRef, PDFDict);
        const sectPRaw = figureDict?.get(PDFName.of('P'));
        if (!(sectPRaw instanceof PDFRef)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Preceding /Figure has no /P of its own' });
          continue;
        }
        const sectRef = sectPRaw;
        const sectDict = doc.context.lookup(sectRef, PDFDict);
        if (!sectDict) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure\'s /P does not resolve to a real dictionary' });
          continue;
        }

        // Confirmed real shape: the Figure's own direct parent has EXACTLY
        // one child (itself) -- a genuinely different (already multi-
        // child) parent shape hasn't been verified against real data.
        // CodeRabbit finding on PR #592, confirmed real: the original check
        // only confirmed /Sect /K was NOT an array (a lone-child shape) but
        // never confirmed it's a ref to THIS bestFigureRef specifically --
        // subsumed by the stricter exact-match check below (a genuine
        // array still fails the `instanceof PDFRef` half of it).
        const sectK = sectDict.get(PDFName.of('K'));
        if (!(sectK instanceof PDFRef) || sectK.objectNumber !== bestFigureRef.objectNumber) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure\'s parent /K does not reference this /Figure (or has multiple children) -- unverified shape, declining rather than guessing' });
          continue;
        }

        const grandparentPRaw = sectDict.get(PDFName.of('P'));
        if (!(grandparentPRaw instanceof PDFRef)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure\'s single-child parent has no /P of its own' });
          continue;
        }
        const grandparentRef = grandparentPRaw;

        const grandparentDict = doc.context.lookup(grandparentRef, PDFDict);
        const grandparentK = grandparentDict?.get(PDFName.of('K'));
        if (!(grandparentK instanceof PDFArray)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure\'s grandparent /K is not an array' });
          continue;
        }

        // CodeRabbit finding on PR #592, confirmed real: a stale or
        // repeated issue (the same disconnected-caption issue dispatched
        // twice without a fresh audit in between) would previously insert
        // the SAME /Story a second time, corrupting the tree. Idempotent:
        // if the /Story is already exactly where this fix would put it,
        // succeed without mutating; if it's attached ANYWHERE else
        // (a different /P, or present but out of position), decline rather
        // than guess what should happen to it.
        const grandparentKids = grandparentK.asArray();
        const sectIndex = grandparentKids.findIndex(item => item instanceof PDFRef && item.objectNumber === sectRef.objectNumber);
        const storyIndexes = grandparentKids
          .map((item, index) => (item instanceof PDFRef && item.objectNumber === storyRef.objectNumber ? index : -1))
          .filter(index => index >= 0);
        const existingStoryParent = storyDict.get(PDFName.of('P'));
        const alreadyCorrectlyAttached =
          existingStoryParent instanceof PDFRef &&
          existingStoryParent.objectNumber === grandparentRef.objectNumber &&
          sectIndex !== -1 &&
          storyIndexes.length === 1 &&
          storyIndexes[0] === sectIndex + 1;

        if (alreadyCorrectlyAttached) {
          results.push({
            issueId: issue.id,
            success: true,
            before: 'already attached',
            after: `already attached immediately after its figure's /Sect wrapper (${sectRef.toString()}) under ${grandparentRef.toString()}`,
          });
          continue;
        }
        if (existingStoryParent !== undefined || storyIndexes.length > 0) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Story is already attached to the structure tree in an unexpected position -- declining rather than guessing' });
          continue;
        }

        this.insertIntoKidsAfter(doc, grandparentRef, sectRef, storyRef);
        storyDict.set(PDFName.of('P'), grandparentRef);

        results.push({
          issueId: issue.id,
          success: true,
          before: 'disconnected from the structure tree',
          after: `reattached as a sibling immediately after its figure's /Sect wrapper (${sectRef.toString()}) under ${grandparentRef.toString()}`,
        });
      } catch (err) {
        results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return results;
  }

  /**
   * Splices `newRef` into `containerRef`'s own /K array immediately after
   * the bare MCID number `afterMcid` -- the flat-sequence counterpart to
   * insertIntoKidsAfter (which positions relative to a sibling REF's own
   * identity, not a bare MCID value living directly in the array). Throws
   * (never guesses) if containerRef doesn't resolve to a dict, its /K
   * isn't an array, or afterMcid isn't found as a bare number entry in it.
   */
  private insertIntoKidsAfterMcid(doc: PDFDocument, containerRef: PDFRef, afterMcid: number, newRef: PDFRef): void {
    const container = doc.context.lookup(containerRef);
    if (!(container instanceof PDFDict)) {
      throw new Error('insertIntoKidsAfterMcid: container does not resolve to a dictionary');
    }
    const k = container.get(PDFName.of('K'));
    if (!(k instanceof PDFArray)) {
      throw new Error('insertIntoKidsAfterMcid: container /K is not an array -- cannot position relative to a sibling MCID');
    }
    const arr = k.asArray();
    const idx = arr.findIndex(item => item instanceof PDFNumber && item.asNumber() === afterMcid);
    if (idx === -1) {
      throw new Error('insertIntoKidsAfterMcid: afterMcid not found as a bare MCID entry in container /K array');
    }
    k.insert(idx + 1, newRef);
  }

  /**
   * Reattaches a small inline /Figure struct element (e.g. an inline math
   * or symbol glyph embedded mid-caption) that's correctly MCID-tagged and
   * ParentTree-cross-referenced but was never linked into any parent's /K
   * array -- the same disconnection SHAPE as reattachFigureCaption's own
   * /fc-caption case, but structurally simpler: no multi-level Sect/Story
   * climb needed. Confirmed real on Math_Weir_PDF.pdf (round 7 PAC report,
   * pages 73/136/137): all 8 real cases sit inside an already-correct,
   * flat /fc caption /K array (bare MCID numbers interleaved with nested
   * /Span refs, in strict left-to-right reading order) with an exact
   * one-slot gap at the disconnected Figure's own MCID position.
   *
   * Requires BOTH the MCID immediately before and immediately after the
   * gap to resolve (via /ParentTree) to the SAME containing struct
   * element -- confirmed the real, exact shape on all 8 cases -- and that
   * container's own /K array to have a bare-number entry at mcid-1 to
   * splice after. Declines (never guesses) when either neighbor is
   * missing, the two neighbors belong to different containers, or the
   * container's own /K array doesn't have the expected bare MCID entry to
   * anchor on.
   */
  reattachInlineFigure(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const m = /^figure_p(\d+)_mc(\d+)$/.exec(issue.element ?? '');
        if (!m) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Unrecognized element id "${issue.element}"` }); continue; }
        const pageNumber = parseInt(m[1], 10);
        const figureMcid = parseInt(m[2], 10);

        const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
        if (!pageArr) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No ParentTree page array found for page ${pageNumber}` }); continue; }
        const pageArrRaw = pageArr.asArray();

        const figureEntry = pageArrRaw[figureMcid];
        if (!(figureEntry instanceof PDFRef)) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No struct element found at MCID ${figureMcid} on page ${pageNumber}` }); continue; }
        const figureDict = doc.context.lookup(figureEntry, PDFDict);
        const figureType = figureDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
        if (figureType !== 'Figure') { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Struct element at MCID ${figureMcid} is /${figureType}, not /Figure` }); continue; }

        // Derive the natural reattachment point from this MCID's own left
        // and right neighbors FIRST, independent of the figure's own /P
        // state -- both the idempotency check and the "complete a
        // half-made link" path below need to compare against this same,
        // independently verified target (CodeRabbit finding on PR #594,
        // confirmed real: the original version only ever consulted /P in
        // isolation).
        let containerRef: PDFRef | null = null;
        let neighborError: string | null = null;
        if (figureMcid === 0 || figureMcid + 1 >= pageArrRaw.length) {
          neighborError = 'No left and/or right MCID neighbor on this page to anchor reattachment';
        } else {
          const leftEntry = pageArrRaw[figureMcid - 1];
          const rightEntry = pageArrRaw[figureMcid + 1];
          if (!(leftEntry instanceof PDFRef) || !(rightEntry instanceof PDFRef)) {
            neighborError = 'Left or right MCID neighbor does not resolve to a real struct element';
          } else if (leftEntry.objectNumber !== rightEntry.objectNumber) {
            neighborError = 'Left and right MCID neighbors belong to different containers -- ambiguous reattachment point';
          } else {
            containerRef = leftEntry;
          }
        }

        const existingP = figureDict!.get(PDFName.of('P'));
        if (existingP instanceof PDFRef) {
          const parentDict = doc.context.lookup(existingP, PDFDict);
          const parentK = parentDict?.get(PDFName.of('K'));
          const parentKids = parentK instanceof PDFArray ? parentK.asArray() : [];
          const alreadyLinked = parentKids.some(item => item instanceof PDFRef && item.objectNumber === figureEntry.objectNumber);

          if (alreadyLinked) {
            // A reciprocal /P <-> /K link only actually fixes reachability
            // if the parent ITSELF is reachable from the structure tree
            // root -- two orphaned elements pointing at each other would
            // otherwise report false success, and a subsequent re-audit
            // would still find the figure disconnected (CodeRabbit finding
            // on PR #594, confirmed real risk).
            if (this.isReachableFromRoot(doc, existingP)) {
              results.push({ issueId: issue.id, success: true, before: 'already attached', after: `already attached under ${existingP.toString()}` });
            } else {
              results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure\'s /P and that parent\'s own /K reference each other, but the parent itself is not reachable from the structure tree root -- not actually fixed' });
            }
            continue;
          }

          // /P set but not linked back. Only proceed if it names the SAME
          // container this figure's own MCID neighbors independently
          // derive -- completing a half-made link is safe there (CodeRabbit
          // finding on PR #594, confirmed real: declining outright here was
          // needlessly conservative when the verified anchor point already
          // agrees with the existing /P). Anything else remains an
          // unexpected state this declines rather than guesses.
          if (!containerRef || existingP.objectNumber !== containerRef.objectNumber) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Figure already has a /P, but that parent\'s own /K does not reference it back, and it does not match this figure\'s own natural reattachment point -- declining rather than guessing' });
            continue;
          }
        } else if (!containerRef) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: neighborError! });
          continue;
        }

        // Safety check, CodeRabbit finding on PR #594, confirmed real: the
        // container's own /K array must actually list its bare MCID
        // entries in ascending order for a "found mcid-1, insert right
        // after it" positional splice to mean anything -- an out-of-order
        // array (e.g. [2, 0] with this figure at MCID 1) would otherwise
        // splice into a position that doesn't reflect real reading order.
        const finalContainerRef = containerRef;
        const containerDict = doc.context.lookup(finalContainerRef, PDFDict);
        const containerK = containerDict?.get(PDFName.of('K'));
        if (!(containerK instanceof PDFArray)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Container /K is not an array' });
          continue;
        }
        const bareNumbers = containerK.asArray()
          .filter((item): item is PDFNumber => item instanceof PDFNumber)
          .map(n => n.asNumber());
        const isAscending = bareNumbers.every((n, i) => i === 0 || n > bareNumbers[i - 1]);
        if (!isAscending) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Container /K array\'s own bare MCID entries are not in ascending order -- cannot safely determine a positional insertion point' });
          continue;
        }

        this.insertIntoKidsAfterMcid(doc, finalContainerRef, figureMcid - 1, figureEntry);
        figureDict!.set(PDFName.of('P'), finalContainerRef);

        results.push({
          issueId: issue.id,
          success: true,
          before: 'disconnected from the structure tree',
          after: `reattached into ${finalContainerRef.toString()}'s own /K array, immediately after MCID ${figureMcid - 1}`,
        });
      } catch (err) {
        results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return results;
  }

  /**
   * Reattaches a disconnected /TD or /TH table-cell struct element into its
   * containing /TR's own /K array, in correct left-to-right column order --
   * same disconnection SHAPE as reattachInlineFigure above (tagged,
   * ParentTree-cross-referenced, missing from any parent's /K), adapted for
   * one real structural difference: a /TR's own /K array holds TH/TD
   * struct-element REFS (buildTableFromLayout's own column-ordering
   * convention), never bare MCID numbers the way an /fc caption's flat /K
   * array can -- so this anchors splicing on insertIntoKidsAfter's
   * ref-identity shape, not insertIntoKidsAfterMcid's bare-number shape.
   *
   * Confirmed real via direct struct-tree inspection of
   * Farrar_2E_Comp_188910.pdf's remediated output: 5 disconnected /TD
   * elements, each with a clean one-slot gap at its own MCID position.
   *
   * Finding the containing /TR is NOT a direct port of
   * reattachInlineFigure's own "left and right MCID neighbor must be the
   * SAME struct element" technique -- that works for an /fc caption only
   * because multiple MCIDs there funnel to ONE shared owner directly. A
   * table cell owns its OWN MCID, so a row's adjacent cells are naturally
   * DIFFERENT struct elements; requiring them to match would fail on every
   * ordinary multi-column row. Instead: each neighbor cell's own /P is
   * followed to see if it names a /TR, and when both neighbors exist and
   * name one, they must agree -- when only one neighbor exists or only one
   * resolves to a /TR (the orphan is the row's first or last column), that
   * one alone is used. Declines (never guesses) when neither neighbor
   * yields a /TR, the two neighbors disagree, or the row's existing cells'
   * own MCIDs aren't in ascending order.
   */
  reattachTableCell(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const results: FixResult[] = [];

    for (const issue of issues) {
      try {
        const m = /^tablecell_p(\d+)_mc(\d+)$/.exec(issue.element ?? '');
        if (!m) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Unrecognized element id "${issue.element}"` }); continue; }
        const pageNumber = parseInt(m[1], 10);
        const cellMcid = parseInt(m[2], 10);

        const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
        if (!pageArr) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No ParentTree page array found for page ${pageNumber}` }); continue; }
        const pageArrRaw = pageArr.asArray();

        const cellEntry = pageArrRaw[cellMcid];
        if (!(cellEntry instanceof PDFRef)) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No struct element found at MCID ${cellMcid} on page ${pageNumber}` }); continue; }
        const cellDict = doc.context.lookup(cellEntry, PDFDict);
        const cellType = cellDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
        if (cellType !== 'TD' && cellType !== 'TH') { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Struct element at MCID ${cellMcid} is /${cellType}, not /TD or /TH` }); continue; }

        // Derive the natural reattachment point from this MCID's own left
        // and right neighbor CELLS' own /TR parent -- see this method's own
        // doc comment for why this differs from reattachInlineFigure's
        // same-ref-on-both-sides technique.
        const trOfNeighbor = (entry: unknown): PDFRef | null => {
          if (!(entry instanceof PDFRef)) return null;
          const neighborDict = doc.context.lookup(entry, PDFDict);
          const p = neighborDict?.get(PDFName.of('P'));
          if (!(p instanceof PDFRef)) return null;
          const pType = doc.context.lookup(p, PDFDict)?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
          return pType === 'TR' ? p : null;
        };

        const leftTr = cellMcid > 0 ? trOfNeighbor(pageArrRaw[cellMcid - 1]) : null;
        const rightTr = cellMcid + 1 < pageArrRaw.length ? trOfNeighbor(pageArrRaw[cellMcid + 1]) : null;

        let containerRef: PDFRef | null = null;
        let neighborError: string | null = null;
        if (leftTr && rightTr) {
          if (leftTr.objectNumber === rightTr.objectNumber) {
            containerRef = leftTr;
          } else {
            neighborError = 'Left and right neighbor cells belong to different rows -- ambiguous reattachment point';
          }
        } else if (leftTr) {
          containerRef = leftTr; // orphan is the row's last column
        } else if (rightTr) {
          containerRef = rightTr; // orphan is the row's first column
        } else {
          neighborError = 'Neither neighbor cell resolves to a /TR-parented sibling to anchor reattachment';
        }

        const existingP = cellDict!.get(PDFName.of('P'));
        if (existingP instanceof PDFRef) {
          const parentDict = doc.context.lookup(existingP, PDFDict);
          const parentK = parentDict?.get(PDFName.of('K'));
          const parentKids = parentK instanceof PDFArray ? parentK.asArray() : [];
          const alreadyLinked = parentKids.some(item => item instanceof PDFRef && item.objectNumber === cellEntry.objectNumber);

          if (alreadyLinked) {
            if (this.isReachableFromRoot(doc, existingP)) {
              results.push({ issueId: issue.id, success: true, before: 'already attached', after: `already attached under ${existingP.toString()}` });
              continue;
            }
            // The cell<->row link is already correct; the row's OWN /P may
            // name a real /Table that's itself just unreachable -- a
            // confirmed real shape on Farrar (PR #754's fast-follow, now
            // closed with real recon data -- see
            // reattachOrphanedTableAncestor's own doc comment). A /TR
            // carries no MCID of its own (same reason rowPageAndMcid exists
            // at all -- see its own doc comment), so the repair's anchor
            // position is derived from the row's own TD/TH children, not
            // from any direct ParentTree entry for the /TR itself.
            const trDict = doc.context.lookup(existingP, PDFDict);
            const pageByRef = new Map<string, number>();
            doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));
            const rowLocation = trDict ? this.rowPageAndMcid(doc, trDict.get(PDFName.of('K')), pageByRef) : null;
            const tableRef = trDict?.get(PDFName.of('P'));
            const repaired = rowLocation && tableRef instanceof PDFRef
              ? this.reattachOrphanedTableAncestor(doc, tableRef, rowLocation.page, rowLocation.mcid)
              : false;
            if (repaired && tableRef instanceof PDFRef) {
              this.spliceRowIntoTableIfMissing(doc, tableRef, existingP);
            }
            if (repaired && this.isReachableFromRoot(doc, existingP)) {
              results.push({
                issueId: issue.id,
                success: true,
                before: 'disconnected (containing /Table was itself unreachable)',
                after: `cell/row link was already correct; reattached the orphaned /Table ancestor (${(tableRef as PDFRef).toString()}) into the document flow`,
              });
            } else {
              results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Cell\'s /P and that parent\'s own /K reference each other, but the parent itself is not reachable from the structure tree root -- not actually fixed' });
            }
            continue;
          }

          if (!containerRef || existingP.objectNumber !== containerRef.objectNumber) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Cell already has a /P, but that parent\'s own /K does not reference it back, and it does not match this cell\'s own natural reattachment point -- declining rather than guessing' });
            continue;
          }
        } else if (!containerRef) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: neighborError! });
          continue;
        }

        const finalContainerRef = containerRef!;
        const containerDict = doc.context.lookup(finalContainerRef, PDFDict);
        const containerType = containerDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
        if (containerType !== 'TR') {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Natural reattachment point is /${containerType}, not /TR -- declining rather than guessing` });
          continue;
        }
        // Same check the "already linked" branch above already applies
        // before declaring success (:5491) -- this fresh-write branch was
        // missing it, letting it commit a cell<->/TR mutual link that LOOKS
        // internally consistent while the /TR itself is an orphaned island
        // never reachable from /StructTreeRoot. Confirmed live: exactly this
        // shape produced 5 real "Cell's /P and that parent's own /K
        // reference each other, but the parent itself is not reachable"
        // failures on Farrar, reported by the OTHER branch -- this one
        // never caught its own version of the same defect before writing.
        if (!this.isReachableFromRoot(doc, finalContainerRef)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Natural reattachment point (/TR) is itself not reachable from the structure tree root -- declining rather than reporting a false success' });
          continue;
        }
        const containerK = containerDict?.get(PDFName.of('K'));
        if (!(containerK instanceof PDFArray)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Container (/TR) /K is not an array' });
          continue;
        }

        // Resolve each existing sibling cell's own min-MCID (same technique
        // pdf-table-cell-tree.validator.ts's own bottom-up walk uses), in
        // /K array order -- i.e. column reading order.
        const siblingRefs = containerK.asArray().filter((item): item is PDFRef => item instanceof PDFRef);
        const siblingMcids: Array<{ ref: PDFRef; mcid: number }> = [];
        for (const ref of siblingRefs) {
          const sDict = doc.context.lookup(ref, PDFDict);
          const kRaw = sDict?.get(PDFName.of('K'));
          const mcids: number[] = [];
          if (kRaw instanceof PDFArray) {
            for (const item of kRaw.asArray()) if (item instanceof PDFNumber) mcids.push(item.asNumber());
          } else if (kRaw instanceof PDFNumber) {
            mcids.push(kRaw.asNumber());
          }
          if (mcids.length > 0) siblingMcids.push({ ref, mcid: Math.min(...mcids) });
        }

        // Safety check, same reasoning as reattachInlineFigure's own: a
        // "find the sibling before this MCID" positional splice only means
        // anything if the row's existing cells are themselves in ascending
        // MCID (== column) order.
        const isAscending = siblingMcids.every((s, i) => i === 0 || s.mcid > siblingMcids[i - 1].mcid);
        if (!isAscending) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Row\'s existing cells do not have ascending MCIDs -- cannot safely determine a positional insertion point' });
          continue;
        }

        // Last sibling whose own MCID is still below the orphan's -- insert
        // right after it. None found means the orphan is the row's first
        // column (a case reattachInlineFigure's flat-array splice doesn't
        // need to handle, but a /TD legitimately can be).
        let afterRef: PDFRef | null = null;
        for (const s of siblingMcids) {
          if (s.mcid < cellMcid) afterRef = s.ref; else break;
        }

        if (afterRef) {
          this.insertIntoKidsAfter(doc, finalContainerRef, afterRef, cellEntry);
        } else {
          containerK.insert(0, cellEntry);
        }
        cellDict!.set(PDFName.of('P'), finalContainerRef);

        results.push({
          issueId: issue.id,
          success: true,
          before: 'disconnected from the structure tree',
          after: `reattached into its containing /TR's own /K array (${finalContainerRef.toString()}), in column order`,
        });
      } catch (err) {
        results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return results;
  }

  /**
   * Reattaches an existing, fully-built /Table-family element that is
   * itself unreachable from /StructTreeRoot -- NOT creating a new wrapper,
   * splicing the real one back in. Confirmed real shape on
   * Farrar_2E_Comp_188910.pdf (PR #754's own fast-follow, now completed
   * with real recon data): 5 /Table elements with NO /P at all (never
   * linked to anything), each correctly pointed at BY their own /TR (whose
   * own /P already names the table), but never listed back in the table's
   * own /K -- a broken one-way splice on top of a genuinely orphaned
   * table, not two unrelated problems. Both reattachTableCell's
   * "already linked" branch and reattachTableRow's own "existing /P"
   * decline hit this identical shape and, before this method existed,
   * could only decline -- correctly conservative given what each could see
   * in isolation, but now recognized as a safe, specific case to repair.
   *
   * Anchors the reattachment point using the SAME left/right tagged-
   * neighbor technique every other top-level reattach* method in this file
   * uses (retagPlacedPdfAsFigure, reattachTableRow's own wrapper-creation
   * fallback), anchored at the table's own row's (page, MCID) position --
   * the caller's responsibility to supply, since a /Table has no MCID of
   * its own to derive one from.
   *
   * Declines (returns false) rather than guessing whenever: the ref isn't
   * a real /Table-family element, it already has a /P (a different,
   * deeper break this targeted repair doesn't attempt), no safe single
   * neighbor-anchor can be found, or the left/right neighbors disagree --
   * same "decline rather than guess" discipline as every sibling method.
   */
  private reattachOrphanedTableAncestor(
    doc: PDFDocument,
    tableRef: PDFRef,
    anchorPageNumber: number,
    anchorMcid: number,
  ): boolean {
    if (this.isReachableFromRoot(doc, tableRef)) return true;

    const tableDict = doc.context.lookup(tableRef, PDFDict);
    const tableType = tableDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
    if (!tableDict || !tableType || !['Table', 'THead', 'TBody', 'TFoot'].includes(tableType)) return false;

    // A non-empty /P that still isn't reachable is a DIFFERENT, deeper
    // break (e.g. an orphaned THead/TBody wrapper one level further up) --
    // out of scope for this targeted repair; decline rather than guess at
    // an unknown-depth chain.
    if (tableDict.get(PDFName.of('P')) !== undefined) return false;

    const pageArr = this.resolveParentTreePageArray(doc, anchorPageNumber);
    const pageArrRaw = pageArr?.asArray() ?? [];
    const neighborParent = (entry: unknown): PDFRef | null => {
      if (!(entry instanceof PDFRef)) return null;
      const dict = doc.context.lookup(entry, PDFDict);
      const p = dict?.get(PDFName.of('P'));
      return p instanceof PDFRef ? p : null;
    };
    const leftEntry = anchorMcid > 0 ? pageArrRaw[anchorMcid - 1] : undefined;
    const rightEntry = anchorMcid + 1 < pageArrRaw.length ? pageArrRaw[anchorMcid + 1] : undefined;
    const leftParent = neighborParent(leftEntry);
    const rightParent = neighborParent(rightEntry);

    if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) return false;

    let flowParent: PDFRef | null = null;
    let anchorRef: PDFRef | null = null;
    let anchorBefore = false;
    if (rightParent) {
      flowParent = rightParent; anchorRef = rightEntry as PDFRef; anchorBefore = true;
    } else if (leftParent) {
      flowParent = leftParent; anchorRef = leftEntry as PDFRef; anchorBefore = false;
    }
    if (!flowParent || !anchorRef) return false;

    const flowParentK = doc.context.lookup(flowParent, PDFDict)?.get(PDFName.of('K'));
    if (!(flowParentK instanceof PDFArray)) return false;

    if (anchorBefore) {
      this.insertIntoKidsBefore(doc, flowParent, anchorRef, tableRef);
    } else {
      this.insertIntoKidsAfter(doc, flowParent, anchorRef, tableRef);
    }
    tableDict.set(PDFName.of('P'), flowParent);
    return true;
  }

  /**
   * Ensures `trRef` is listed in `tableRef`'s own /K, in correct row order
   * among existing siblings on the same page -- the other half of the
   * broken-splice shape reattachOrphanedTableAncestor's own doc comment
   * describes (the /TR's own /P already names the table; the table's own
   * /K just never listed the /TR back). Reuses rowPageAndMcid for
   * positional ordering, same technique reattachTableRow's own candidates-
   * length-1 success path uses one level up. Builds its own page-ref map
   * rather than taking one from the caller, since both current callers
   * (reattachTableCell, reattachTableRow) don't otherwise need one.
   *
   * Falls back to a plain append (still correct membership-wise, just not
   * guaranteed perfectly ordered) when the row's own position can't be
   * determined or existing siblings aren't cleanly ordered -- never
   * declines outright, since appending a real row to a real table's /K is
   * always safe, just not always optimally placed.
   */
  private spliceRowIntoTableIfMissing(doc: PDFDocument, tableRef: PDFRef, trRef: PDFRef): void {
    const tableDict = doc.context.lookup(tableRef, PDFDict);
    if (!tableDict) return;
    const tableKRaw = tableDict.get(PDFName.of('K'));
    const resolvedK = tableKRaw instanceof PDFRef ? doc.context.lookup(tableKRaw) : tableKRaw;

    // Confirmed real shape on Farrar: a genuinely never-linked /Table's own
    // /K is MISSING entirely (tableDict.get('K') is undefined), not even
    // an empty array -- it was never given one in the first place, not
    // emptied. Create a fresh one rather than bailing out.
    if (resolvedK === undefined) {
      tableDict.set(PDFName.of('K'), doc.context.obj([trRef]));
      return;
    }
    if (!(resolvedK instanceof PDFArray)) return; // a single bare child or other unexpected shape -- decline rather than guess how to merge it
    const tableK = resolvedK;
    const existing = tableK.asArray();
    if (existing.some((item) => item instanceof PDFRef && item.objectNumber === trRef.objectNumber)) return;

    const pageByRef = new Map<string, number>();
    doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

    const trDict = doc.context.lookup(trRef, PDFDict);
    const located = trDict ? this.rowPageAndMcid(doc, trDict.get(PDFName.of('K')), pageByRef) : null;
    if (!located) { tableK.push(trRef); return; }

    const siblingMcids: Array<{ ref: PDFRef; mcid: number }> = [];
    for (const ref of existing) {
      if (!(ref instanceof PDFRef)) continue;
      const sDict = doc.context.lookup(ref, PDFDict);
      if (sDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '') !== 'TR') continue;
      const sLocated = this.rowPageAndMcid(doc, sDict.get(PDFName.of('K')), pageByRef);
      if (sLocated && sLocated.page === located.page) siblingMcids.push({ ref, mcid: sLocated.mcid });
    }
    const isAscending = siblingMcids.every((s, i) => i === 0 || s.mcid > siblingMcids[i - 1].mcid);
    if (!isAscending) { tableK.push(trRef); return; }

    let afterRef: PDFRef | null = null;
    for (const s of siblingMcids) {
      if (s.mcid < located.mcid) afterRef = s.ref; else break;
    }
    if (afterRef) {
      this.insertIntoKidsAfter(doc, tableRef, afterRef, trRef);
    } else {
      tableK.insert(0, trRef);
    }
  }

  /**
   * Finds the first (page, MCID) pair reachable from a struct element's
   * own /K subtree -- same technique and same reason as
   * pdf-table-cell-tree.validator.ts's own `firstPageAndMcid` (duplicated
   * locally rather than imported, matching this file's own established
   * convention of keeping structure-tree-walking helpers self-contained
   * per file): a /TR carries neither /Pg nor an own MCID in the
   * confirmed-real document shape, so both detecting it (the validator)
   * and re-locating it later (this writer) have to derive its identity
   * from its TD/TH children the same way.
   */
  private rowPageAndMcid(
    doc: PDFDocument,
    node: unknown,
    pageByRef: Map<string, number>,
    depth = 0,
  ): { page: number; mcid: number } | null {
    if (depth > 10) return null;
    const resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (resolved instanceof PDFArray) {
      for (const item of resolved.asArray()) {
        const found = this.rowPageAndMcid(doc, item, pageByRef, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (!(resolved instanceof PDFDict)) return null;
    const pgRaw = resolved.get(PDFName.of('Pg'));
    const page = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) : undefined;
    const kRaw = resolved.get(PDFName.of('K'));
    const mcids: number[] = [];
    const collectMcids = (n: unknown): void => {
      const r = n instanceof PDFRef ? doc.context.lookup(n) : n;
      if (r instanceof PDFNumber) { mcids.push(r.asNumber()); return; }
      if (r instanceof PDFArray) { for (const item of r.asArray()) collectMcids(item); }
    };
    if (kRaw !== undefined) collectMcids(kRaw);
    if (page !== undefined && mcids.length > 0) return { page, mcid: Math.min(...mcids) };
    if (kRaw !== undefined) {
      const found = this.rowPageAndMcid(doc, kRaw, pageByRef, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /**
   * Reattaches a disconnected /TR table-row struct element into its
   * containing /Table's own /K array, in correct row order -- one level
   * up from reattachTableCell's own /TD-into-/TR case, for the SAME
   * underlying defect: this document's 5 disconnected /TD cells are each
   * already correctly linked to their own /TR (reattachTableCell finds
   * nothing to fix there), but the /TR itself was never linked into its
   * /Table's own /K array. Confirmed real via direct struct-tree
   * inspection of Farrar_2E_Comp_188910.pdf's remediated output: of 5
   * orphaned /TR elements (one per orphaned /TD's own row), 4 are cleanly
   * the missing FIRST (header) row of an otherwise fully-connected,
   * reachable /Table -- this writer's own scope. The 5th (a table with no
   * reachable /Table sibling rows on its page at all) is a genuinely
   * different, harder shape left for manual review rather than guessed at.
   *
   * Locating the orphan is NOT a /ParentTree lookup the way
   * reattachInlineFigure/reattachTableCell/reattachFigureCaption all do --
   * a /TR has no own MCID to be cross-referenced by, so this re-derives
   * each orphan's (page, MCID) identity from its own TD/TH children (via
   * rowPageAndMcid), the same technique
   * pdf-table-cell-tree.validator.ts's own /TR detection pass used to
   * build the issue's `element` id in the first place, and matches
   * against the ENTIRE set of real /TR StructElems in the file (not just
   * currently-orphaned ones) so an already-fixed row re-dispatched without
   * a fresh audit reports a clean "already attached" rather than a
   * confusing "not found".
   *
   * Finding the containing /Table is done by locating every reachable
   * /Table whose own descendant subtree contains a TD/TH on the orphan's
   * page -- requiring EXACTLY ONE match (zero or multiple candidates
   * decline rather than guess, same philosophy as every other bail-out in
   * this file). Within that Table, the insertion point is the last
   * existing /TR sibling whose own min-MCID is still below the orphan's
   * (or index 0 if none -- the orphan is the table's first row), with the
   * same ascending-order safety check reattachTableCell/reattachInlineFigure
   * both already apply to their own siblings before trusting a positional
   * splice.
   */
  reattachTableRow(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
    const results: FixResult[] = [];

    // A /TR can only ever legitimately have one of these as its /P (PDF/UA
    // requires every /TR to sit inside a /Table or THead/TBody/TFoot
    // ancestor, never bare in document flow -- see both "declining rather
    // than guessing" bail-outs below). Used to recognize the ONE specific,
    // now-identified legacy shape safe to auto-repair: the original, pre-
    // #746 version of this fix spliced orphaned rows straight into a
    // document-flow parent's own /K (a real PAC-caught bug, fixed going
    // forward by #746, but never cleaned up on documents that already had
    // the bad /P written). A /P that resolves to one of THESE types instead
    // is some other, genuinely different /Table-family element -- not this
    // bug's signature -- and still correctly declines.
    const TABLE_FAMILY_TYPES = new Set(['Table', 'THead', 'TBody', 'TFoot']);

    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) {
      return issues.map(issue => ({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'No /StructTreeRoot found' }));
    }

    const pageByRef = new Map<string, number>();
    doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

    // Top-down reachable set, built once up front (not per-issue/per-target
    // the way isReachableFromRoot is elsewhere) -- this method needs to
    // classify EVERY real /TR in the file as connected or orphaned, not
    // check one target ref at a time.
    const reachable = new Set<string>();
    const seenWalk = new Set<string>();
    const visitTopDown = (nodeRef: unknown): void => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (seenWalk.has(key)) return;
        seenWalk.add(key);
        reachable.add(key);
      }
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
      if (node instanceof PDFArray) { for (const item of node.asArray()) visitTopDown(item); return; }
      if (!(node instanceof PDFDict)) return;
      const k = node.get(PDFName.of('K'));
      if (k !== undefined) visitTopDown(k);
    };
    visitTopDown(structRoot.get(PDFName.of('K')));

    // Every real /TR in the file, by its derived (page, MCID) identity --
    // reachable or not, so a re-dispatched already-fixed issue resolves to
    // a real, now-reachable row instead of "not found".
    const rowsByKey = new Map<string, PDFRef>();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (obj.get(PDFName.of('Type'))?.toString() !== '/StructElem') continue;
      if (obj.get(PDFName.of('S'))?.toString().replace(/^\//, '') !== 'TR') continue;
      const located = this.rowPageAndMcid(doc, obj.get(PDFName.of('K')), pageByRef);
      if (!located) continue;
      rowsByKey.set(`${located.page}:${located.mcid}`, ref);
    }

    for (const issue of issues) {
      try {
        const m = /^tablerow_p(\d+)_mc(\d+)$/.exec(issue.element ?? '');
        if (!m) { results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `Unrecognized element id "${issue.element}"` }); continue; }
        const pageNumber = parseInt(m[1], 10);
        const rowMcid = parseInt(m[2], 10);

        const trRef = rowsByKey.get(`${pageNumber}:${rowMcid}`);
        if (!trRef) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No /TR found at page ${pageNumber}, MCID ${rowMcid} -- document may have changed since the issue was generated` });
          continue;
        }
        const trDict = doc.context.lookup(trRef, PDFDict);

        if (reachable.has(trRef.toString())) {
          results.push({ issueId: issue.id, success: true, before: 'already attached', after: 'already attached and reachable from the structure tree root' });
          continue;
        }

        // Find every reachable /Table whose own descendant subtree
        // contains a TD/TH on this exact page -- requiring exactly one
        // match, same "decline rather than guess" philosophy as every
        // other ambiguity check in this file.
        const candidates: PDFRef[] = [];
        const seenTables = new Set<string>();
        const findTables = (nodeRef: unknown): void => {
          if (nodeRef instanceof PDFRef) {
            const key = nodeRef.toString();
            if (seenTables.has(key)) return;
            seenTables.add(key);
          }
          const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
          if (node instanceof PDFArray) { for (const item of node.asArray()) findTables(item); return; }
          if (!(node instanceof PDFDict)) return;
          const s = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
          if (s === 'Table' && nodeRef instanceof PDFRef) {
            let hasMatch = false;
            const seenSub = new Set<string>();
            const scanSubtree = (n2: unknown): void => {
              if (hasMatch) return;
              if (n2 instanceof PDFRef) {
                const key2 = n2.toString();
                if (seenSub.has(key2)) return;
                seenSub.add(key2);
              }
              const nd = n2 instanceof PDFRef ? doc.context.lookup(n2) : n2;
              if (nd instanceof PDFArray) { for (const item of nd.asArray()) scanSubtree(item); return; }
              if (!(nd instanceof PDFDict)) return;
              const ss = nd.get(PDFName.of('S'))?.toString().replace(/^\//, '');
              if (ss === 'TD' || ss === 'TH') {
                const pgRaw = nd.get(PDFName.of('Pg'));
                const pg = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) : undefined;
                if (pg === pageNumber) hasMatch = true;
              }
              const kk = nd.get(PDFName.of('K'));
              if (kk !== undefined) scanSubtree(kk);
            };
            scanSubtree(node.get(PDFName.of('K')));
            if (hasMatch) candidates.push(nodeRef);
          }
          const k = node.get(PDFName.of('K'));
          if (k !== undefined) findTables(k);
        };
        findTables(structRoot.get(PDFName.of('K')));

        if (candidates.length === 0) {
          // Document-flow fallback: this row may never have been wrapped in
          // a dedicated /Table at all. Confirmed real case: Farrar page 15
          // has a single-cell "table" whose content-stream BDC tag name is
          // informally /Table (the same tag-name-isn't-authoritative
          // pattern this file's Matterhorn 01-004 fix already had to
          // account for), with its real H6/P document-flow neighbors
          // sharing one common parent and no /Table wrapper ever created.
          // Locating that document-flow position uses the same "resolve
          // each neighbor's own parent, require agreement (or use whichever
          // one resolves)" technique reattachTableCell/reattachInlineFigure
          // already use one level down, just without requiring the
          // neighbors to share a TYPE the way those do -- but a /TR can
          // never be inserted AT that position directly: PDF/UA requires
          // every /TR to sit inside a /Table (or THead/TBody/TFoot)
          // ancestor, never bare in document flow alongside /H6/P siblings.
          // A real PAC report caught exactly this: the first version of
          // this fallback inserted the bare /TR straight into the
          // document-flow parent's own /K, which PAC correctly flagged as
          // "Invalid use of a TR structure element" even though the row was
          // technically reachable (this method's own `reachable` check,
          // same as every reachability-only validator in this codebase,
          // has no way to see that). Fixed by creating a minimal single-row
          // /Table wrapper AT that position instead, and reattaching the
          // orphaned /TR as ITS sole child -- the wrapper is new, 1-cell,
          // and real (it wraps genuinely orphaned row content), so none of
          // markTableAsArtifact's "always-empty decorative box" assumptions
          // apply to it.
          const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
          const pageArrRaw = pageArr?.asArray() ?? [];
          const neighborParent = (entry: unknown): PDFRef | null => {
            if (!(entry instanceof PDFRef)) return null;
            const dict = doc.context.lookup(entry, PDFDict);
            const p = dict?.get(PDFName.of('P'));
            return p instanceof PDFRef ? p : null;
          };
          const leftEntry = rowMcid > 0 ? pageArrRaw[rowMcid - 1] : undefined;
          const rightEntry = rowMcid + 1 < pageArrRaw.length ? pageArrRaw[rowMcid + 1] : undefined;
          const leftParent = neighborParent(leftEntry);
          const rightParent = neighborParent(rightEntry);

          let flowParent: PDFRef | null = null;
          let anchorRef: PDFRef | null = null;
          let anchorBefore = false;
          if (leftParent && rightParent && leftParent.objectNumber !== rightParent.objectNumber) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No reachable /Table found with any content on page ${pageNumber}, and its left/right MCID neighbors resolve to different document-flow parents -- ambiguous, declining rather than guessing` });
            continue;
          }
          if (leftParent && rightParent) {
            flowParent = rightParent;
            anchorRef = rightEntry as PDFRef;
            anchorBefore = true;
          } else if (rightParent) {
            flowParent = rightParent;
            anchorRef = rightEntry as PDFRef;
            anchorBefore = true;
          } else if (leftParent) {
            flowParent = leftParent;
            anchorRef = leftEntry as PDFRef;
            anchorBefore = false;
          }

          if (!flowParent || !anchorRef) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `No reachable /Table found with any content on page ${pageNumber}, and its MCID neighbors don't resolve to a usable document-flow parent either -- declining rather than guessing` });
            continue;
          }
          const flowParentDict = doc.context.lookup(flowParent, PDFDict);
          const flowParentK = flowParentDict?.get(PDFName.of('K'));
          if (!(flowParentK instanceof PDFArray)) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Document-flow parent /K is not an array' });
            continue;
          }

          // A /TR can only ever legitimately have a /Table-family /P (never
          // a bare document-flow container like /Document) -- so unlike the
          // positional /Table path below, an orphan's own pre-existing /P
          // is never trustworthy here: it's either unset (a genuine first
          // attempt) or a leftover bare-document-flow link from before this
          // fix existed (exactly the invalid shape being corrected). A /P
          // whose own /S resolves to a NON-table-family type is confirmed
          // to be exactly that legacy signature -- see TABLE_FAMILY_TYPES'
          // own doc comment above -- so it's safe to clear (removeFromKids
          // from its stale parent) and proceed below as if unset, rather
          // than leaving the document permanently stuck. Anything else
          // (unresolvable, or a genuine /Table-family /P) still declines,
          // matching every other reattach* method's "unexpected existing
          // /P" bail-out in this file.
          const existingFlowP = trDict?.get(PDFName.of('P'));
          if (existingFlowP instanceof PDFRef) {
            const existingParentType = doc.context.lookup(existingFlowP, PDFDict)?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
            if (existingParentType && TABLE_FAMILY_TYPES.has(existingParentType)) {
              // A real /Table-family parent that just isn't reachable yet --
              // the same confirmed shape reattachOrphanedTableAncestor's own
              // doc comment describes, now recognized and repaired instead
              // of declined (PR #754's fast-follow, closed with real recon
              // data from this exact document).
              const repaired = this.reattachOrphanedTableAncestor(doc, existingFlowP, pageNumber, rowMcid);
              if (repaired) {
                this.spliceRowIntoTableIfMissing(doc, existingFlowP, trRef);
                if (this.isReachableFromRoot(doc, existingFlowP)) {
                  results.push({
                    issueId: issue.id,
                    success: true,
                    before: 'disconnected (containing /Table was itself unreachable)',
                    after: `row's existing /P was already correct; reattached the orphaned /Table ancestor (${existingFlowP.toString()}) into the document flow`,
                  });
                  continue;
                }
              }
              results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Row already has a /P from a previous attempt -- declining rather than guessing whether it\'s safe to replace' });
              continue;
            }
            if (!existingParentType) {
              results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Row already has a /P from a previous attempt -- declining rather than guessing whether it\'s safe to replace' });
              continue;
            }
            this.removeFromKids(doc, existingFlowP, trRef);
          }

          const pageRef = doc.getPages()[pageNumber - 1]?.ref;
          const wrapperTableObj = doc.context.obj({
            Type: PDFName.of('StructElem'),
            S: PDFName.of('Table'),
            P: flowParent,
            ...(pageRef ? { Pg: pageRef } : {}),
          });
          const wrapperTableRef = doc.context.register(wrapperTableObj as PDFDict);

          if (anchorBefore) {
            this.insertIntoKidsBefore(doc, flowParent, anchorRef, wrapperTableRef);
          } else {
            this.insertIntoKidsAfter(doc, flowParent, anchorRef, wrapperTableRef);
          }
          (doc.context.lookup(wrapperTableRef) as PDFDict).set(PDFName.of('K'), doc.context.obj([trRef]));
          trDict!.set(PDFName.of('P'), wrapperTableRef);

          results.push({
            issueId: issue.id,
            success: true,
            before: 'disconnected from the structure tree',
            after: `reattached inside a new single-row /Table wrapper (${wrapperTableRef.toString()}), spliced into its enclosing document-flow container's own /K array (${flowParent.toString()}) between its confirmed reading-order neighbors`,
          });
          continue;
        }
        if (candidates.length > 1) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: `${candidates.length} reachable /Table candidates found with content on page ${pageNumber} -- ambiguous, declining rather than guessing` });
          continue;
        }
        const tableRef = candidates[0];
        const tableDict = doc.context.lookup(tableRef, PDFDict);
        const tableK = tableDict?.get(PDFName.of('K'));
        if (!(tableK instanceof PDFArray)) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Table /K is not an array' });
          continue;
        }

        // Resolve each existing sibling /TR's own min-MCID, in /K array
        // order -- same technique reattachTableCell uses for its own TD
        // siblings, one level up.
        const siblingRefs = tableK.asArray().filter((item): item is PDFRef => item instanceof PDFRef);
        const siblingMcids: Array<{ ref: PDFRef; mcid: number }> = [];
        for (const ref of siblingRefs) {
          const sDict = doc.context.lookup(ref, PDFDict);
          if (sDict?.get(PDFName.of('S'))?.toString().replace(/^\//, '') !== 'TR') continue;
          const located = this.rowPageAndMcid(doc, sDict.get(PDFName.of('K')), pageByRef);
          if (located && located.page === pageNumber) siblingMcids.push({ ref, mcid: located.mcid });
        }

        const isAscending = siblingMcids.every((s, i) => i === 0 || s.mcid > siblingMcids[i - 1].mcid);
        if (!isAscending) {
          results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Table\'s existing rows on this page do not have ascending MCIDs -- cannot safely determine a positional insertion point' });
          continue;
        }

        // An orphan (not in `reachable`) can still have its own /P already
        // set, e.g. a half-made link from a previous partial write -- only
        // trust it when it already names this SAME determined table,
        // otherwise decline rather than silently overwrite an unexpected
        // existing value, same convention as every other reattach* method
        // in this file. One exception: a /P whose own /S is NOT
        // table-family is the same confirmed legacy signature as the
        // document-flow fallback above (see TABLE_FAMILY_TYPES' own doc
        // comment) -- safe to clear and proceed. A /P naming some OTHER
        // real /Table-family element still declines: moving a row between
        // two genuinely different tables is a real structural judgment
        // call this method should not make on its own.
        const existingP = trDict?.get(PDFName.of('P'));
        if (existingP instanceof PDFRef && existingP.objectNumber !== tableRef.objectNumber) {
          const existingParentType = doc.context.lookup(existingP, PDFDict)?.get(PDFName.of('S'))?.toString().replace(/^\//, '');
          if (!existingParentType || TABLE_FAMILY_TYPES.has(existingParentType)) {
            results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Row already has a /P, but it does not match this row\'s own natural reattachment point -- declining rather than guessing' });
            continue;
          }
          this.removeFromKids(doc, existingP, trRef);
        }

        let afterRef: PDFRef | null = null;
        for (const s of siblingMcids) {
          if (s.mcid < rowMcid) afterRef = s.ref; else break;
        }

        if (afterRef) {
          this.insertIntoKidsAfter(doc, tableRef, afterRef, trRef);
        } else {
          tableK.insert(0, trRef);
        }
        trDict!.set(PDFName.of('P'), tableRef);

        results.push({
          issueId: issue.id,
          success: true,
          before: 'disconnected from the structure tree',
          after: `reattached into its containing /Table's own /K array (${tableRef.toString()}), in row order`,
        });
      } catch (err) {
        results.push({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return results;
  }

  /**
   * True if `targetRef` is reachable via a top-down /K walk from
   * /StructTreeRoot -- the same traversal a screen reader or compliance
   * checker uses, and the same check pdf-inline-figure-tree.validator.ts's
   * own `reachable` set performs. Used by reattachInlineFigure's own
   * idempotency check (see its own doc comment for the CodeRabbit finding
   * this closes): a reciprocal /P <-> /K link between a figure and its
   * parent is not a real fix if the parent itself is still disconnected.
   */
  private isReachableFromRoot(doc: PDFDocument, targetRef: PDFRef): boolean {
    const structRoot = this.getStructTreeRoot(doc);
    if (!structRoot) return false;
    const targetKey = targetRef.toString();
    const seen = new Set<string>();
    const visit = (nodeRef: unknown): boolean => {
      if (nodeRef instanceof PDFRef) {
        const key = nodeRef.toString();
        if (key === targetKey) return true;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;
      if (node instanceof PDFArray) {
        return node.asArray().some(item => visit(item));
      }
      if (!(node instanceof PDFDict)) return false;
      const k = node.get(PDFName.of('K'));
      if (k === undefined) return false;
      return visit(k);
    };
    return visit(structRoot.get(PDFName.of('K')));
  }

  /**
   * Escapes a literal PDF string's special characters per PDF32000-1:2008
   * SS7.3.4.2 -- same exact escaping, and same reason, as pdf-modifier.
   * service.ts's own escapePdfString (not imported from there: that one is
   * private to its own file, and duplicating 2 lines is cheaper than
   * exporting a single-purpose helper across an otherwise-unrelated file
   * boundary -- same tradeoff pdf-link-completeness-writer.ts's own
   * decodePdfStringLiteral already made, in the opposite direction).
   * pdf-lib's own PDFString.of(...) does NOT escape parens/backslashes
   * itself; this fixer's new /Link annotation is the first place in THIS
   * file that writes free text (a URL, extracted from the document's own
   * prose, not fully trusted) into a PDFString.
   */
  private escapeLinkPdfString(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  /**
   * Renders a resolved ActualText value for content-stream splicing
   * (fixArtifactActualTextSibling above) as either a plain literal string
   * (escaped) when every character fits in a single Latin-1 byte, or a
   * UTF-16BE hex string (<FEFF...>, the exact convention this codebase's
   * own correctly-tagged ActualText siblings already use -- see that
   * fixer's own test fixture) when it doesn't. A plain literal string
   * byte-truncates anything above U+00FF (0x2022 BULLET & 0xFF = 0x22 =
   * '"') -- latent since this fixer only ever resolved Latin-1-range
   * letters before; surfaced once its own confirmed-encoding ToUnicode
   * fallback started resolving real, confirmed non-Latin-1 characters
   * like bullet (WPVP_180188_9798986469300_txt.pdf, 2026-11-10).
   * charCodeAt-based iteration already yields correct UTF-16BE code units
   * for an astral (surrogate-pair) character too -- no extra handling
   * needed.
   */
  private actualTextLiteral(text: string): string {
    if (/^[\x00-\xff]*$/.test(text)) {
      return `(${this.escapeLinkPdfString(text)})`;
    }
    let hex = '';
    for (let i = 0; i < text.length; i++) {
      hex += text.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return `<FEFF${hex}>`;
  }

  /**
   * Allocates the next free STANDALONE-object /StructParent key and
   * appends [key, structElementRef] to /StructTreeRoot's own top-level
   * /ParentTree /Nums array -- a SEPARATE PDF mechanism from a page's own
   * MCID-indexed ParentTree array (extendParentTree's own doc comment
   * explains the distinction in full; confirmed via zone-extractor/seam-c/
   * struct-tree-builder.ts's real usage, the only other place in this
   * codebase that assigns a standalone object's /StructParent). Needed
   * because a brand-new annotation (unlike every existing fix in this
   * file, which only ever adds page-content MCIDs) needs its OWN key in
   * this separate space.
   *
   * Calls resolveParentTreeNumsArray purely for its validation side effects
   * (page has /StructParents, struct tree root exists) -- NOT for its
   * returned numsArr/pageKey, which (since findParentTreeLeafNums started
   * walking /Kids) are scoped to whichever ONE leaf covers pageNumber's own
   * key. That scope is wrong for this method's actual job: a brand-new
   * STANDALONE /StructParent key lives in a document-wide keyspace shared
   * across every leaf, unrelated to any one page's own MCID-indexed
   * entries (see this method's own header doc comment on the two-
   * mechanisms distinction) -- collectParentTreeLeaves below walks every
   * leaf, not just one.
   *
   * The key is computed as max(existing /ParentTreeNextKey, 1 + the
   * highest key anywhere in ANY leaf's /Nums) -- self-healing against a
   * stale or missing counter rather than trusting it blindly, since this
   * is the first place in this codebase that both READS and WRITES this
   * specific counter for a brand-new standalone key (extendParentTree only
   * ever reads it, and only ever raises it defensively). Validates the
   * computed key isn't already present in ANY leaf before mutating
   * anything -- should never actually fire given the computation above,
   * but costs nothing and matches this file's established paranoia.
   *
   * On a hierarchical tree, the new [key, ref] pair is appended into
   * whichever leaf currently has the HIGHEST /Limits upper bound -- since
   * `key` is, by construction, guaranteed to exceed every existing key
   * anywhere in the tree, it always belongs "after" everything, i.e. in
   * that trailing leaf, whose own /Limits[1] is widened to `key` first
   * (a minimal, always-valid local repair -- never overlaps a sibling
   * leaf's range, since every sibling's own upper bound is, by definition,
   * lower). Only on the single-leaf (flat, non-hierarchical) shape is this
   * exactly the original behavior, unchanged. Confirmed as a real,
   * necessary fix, not a hypothetical: without it, this method silently
   * wrote a new key into whatever ONE leaf resolveParentTreeNumsArray
   * happened to resolve for pageNumber, producing a leaf whose own /Nums
   * violated its own /Limits -- reproduced against a synthetic multi-leaf
   * tree mirroring Karsaklian_189165's real shape before this fix existed.
   */
  private appendAnnotationParentTreeEntry(doc: PDFDocument, pageNumber: number, structElementRef: PDFRef): number {
    this.resolveParentTreeNumsArray(doc, pageNumber);
    const structRoot = this.getStructTreeRoot(doc)!;

    const parentTreeRaw = structRoot.get(PDFName.of('ParentTree'));
    const parentTreeLooked = parentTreeRaw instanceof PDFRef ? doc.context.lookup(parentTreeRaw) : parentTreeRaw;
    if (!(parentTreeLooked instanceof PDFDict)) {
      throw new Error('appendAnnotationParentTreeEntry: /StructTreeRoot /ParentTree does not resolve to a dictionary');
    }
    const leaves = this.collectParentTreeLeaves(doc, parentTreeLooked);
    if (leaves.length === 0) {
      throw new Error('appendAnnotationParentTreeEntry: /ParentTree has no leaf (/Nums-bearing) node to append into');
    }

    let highestKey = -1;
    for (const leaf of leaves) {
      const leafNumsRaw = leaf.dict.get(PDFName.of('Nums'));
      const leafNums = leafNumsRaw instanceof PDFRef ? doc.context.lookup(leafNumsRaw) : leafNumsRaw;
      if (!(leafNums instanceof PDFArray)) continue;
      const raw = leafNums.asArray();
      for (let i = 0; i < raw.length; i += 2) {
        const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
        if (keyObj instanceof PDFNumber && keyObj.asNumber() > highestKey) highestKey = keyObj.asNumber();
      }
    }
    const nextKeyRaw = structRoot.get(PDFName.of('ParentTreeNextKey'));
    const nextKeyResolved = nextKeyRaw instanceof PDFRef ? doc.context.lookup(nextKeyRaw) : nextKeyRaw;
    const counterKey = nextKeyResolved instanceof PDFNumber ? nextKeyResolved.asNumber() : 0;
    const key = Math.max(counterKey, highestKey + 1);

    for (const leaf of leaves) {
      const leafNumsRaw = leaf.dict.get(PDFName.of('Nums'));
      const leafNums = leafNumsRaw instanceof PDFRef ? doc.context.lookup(leafNumsRaw) : leafNumsRaw;
      if (!(leafNums instanceof PDFArray)) continue;
      const raw = leafNums.asArray();
      for (let i = 0; i < raw.length; i += 2) {
        const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
        if (keyObj instanceof PDFNumber && keyObj.asNumber() === key) {
          throw new Error(`appendAnnotationParentTreeEntry: ParentTree already has an entry at key ${key} -- computed key was not actually free`);
        }
      }
    }

    // Pick the target leaf: the single leaf when the tree isn't
    // hierarchical at all, otherwise whichever leaf's /Limits reaches
    // highest -- the new key, exceeding every existing key, always
    // belongs there. A hierarchical leaf with no /Limits of its own is a
    // malformed shape this method declines on rather than guesses at.
    let targetLeaf = leaves[0];
    if (leaves.length > 1) {
      for (const leaf of leaves) {
        if (!leaf.limits) {
          throw new Error("appendAnnotationParentTreeEntry: a /ParentTree leaf node has no /Limits -- can't determine ordering among several leaves");
        }
        if (!targetLeaf.limits || leaf.limits[1] > targetLeaf.limits[1]) targetLeaf = leaf;
      }
    }

    const targetNumsRaw = targetLeaf.dict.get(PDFName.of('Nums'));
    const targetNums = (targetNumsRaw instanceof PDFRef ? doc.context.lookup(targetNumsRaw) : targetNumsRaw) as PDFArray;
    const raw = targetNums.asArray();

    let insertPos = raw.length;
    for (let i = 0; i < raw.length; i += 2) {
      const keyObj = raw[i] instanceof PDFRef ? doc.context.lookup(raw[i] as PDFRef) : raw[i];
      if (keyObj instanceof PDFNumber && keyObj.asNumber() > key) { insertPos = i; break; }
    }
    targetNums.insert(insertPos, structElementRef);
    targetNums.insert(insertPos, PDFNumber.of(key));

    if (targetLeaf.limits && key > targetLeaf.limits[1]) {
      targetLeaf.dict.set(PDFName.of('Limits'), doc.context.obj([targetLeaf.limits[0], key]));
    }
    structRoot.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(key + 1));

    return key;
  }

  /**
   * Every leaf (/Nums-bearing) node reachable from a /ParentTree (sub)tree,
   * in /Kids order, recursing through any depth of intermediate nodes --
   * the read side appendAnnotationParentTreeEntry needs to compute a
   * document-wide highest key and pick the trailing leaf, unlike
   * findParentTreeLeafNums's single-target walk (which stops at the first
   * /Limits-matching leaf for one specific page key). `limits` is null
   * when the node carries no /Limits of its own (legal and expected for
   * the single root leaf of a flat, non-hierarchical tree, which has
   * nothing to bound against) or when /Limits is present but malformed.
   */
  private collectParentTreeLeaves(doc: PDFDocument, node: PDFDict): Array<{ dict: PDFDict; limits: [number, number] | null }> {
    const readLimits = (): [number, number] | null => {
      const limitsRaw = node.get(PDFName.of('Limits'));
      const limits = limitsRaw instanceof PDFRef ? doc.context.lookup(limitsRaw) : limitsRaw;
      if (!(limits instanceof PDFArray) || limits.size() !== 2) return null;
      const lo = limits.get(0);
      const hi = limits.get(1);
      const loResolved = lo instanceof PDFRef ? doc.context.lookup(lo) : lo;
      const hiResolved = hi instanceof PDFRef ? doc.context.lookup(hi) : hi;
      if (!(loResolved instanceof PDFNumber) || !(hiResolved instanceof PDFNumber)) return null;
      return [loResolved.asNumber(), hiResolved.asNumber()];
    };

    if (node.get(PDFName.of('Nums'))) {
      return [{ dict: node, limits: readLimits() }];
    }

    const kidsRaw = node.get(PDFName.of('Kids'));
    if (!kidsRaw) return [];
    const kidsLooked = kidsRaw instanceof PDFRef ? doc.context.lookup(kidsRaw) : kidsRaw;
    if (!(kidsLooked instanceof PDFArray)) return [];

    const leaves: Array<{ dict: PDFDict; limits: [number, number] | null }> = [];
    for (const kidRaw of kidsLooked.asArray()) {
      const kidDict = kidRaw instanceof PDFRef ? doc.context.lookup(kidRaw) : kidRaw;
      if (!(kidDict instanceof PDFDict)) continue;
      leaves.push(...this.collectParentTreeLeaves(doc, kidDict));
    }
    return leaves;
  }

  /**
   * Parses a /ToUnicode CMap's own bfchar/bfrange blocks into a real
   * byte-code -> decoded-Unicode-TEXT map -- NOT just which codes are
   * covered (unlike font-tounicode.service.ts's own parseExistingCMapCodes,
   * built for a different purpose: checking coverage, not reading values).
   * A destination value is one or more UTF-16BE code units per
   * PDF32000-1:2008's own CMap spec -- exactly how a single glyph code can
   * represent a multi-character ligature (e.g. "fi" decodes as the TWO-
   * character destination <0066 0069>, not one). Single-byte (0x00-0xFF)
   * source codes only, matching pdf-link-completeness-writer.ts's own
   * simple-font-only scope. Same regex-based parsing style as
   * font-tounicode.service.ts's own parseExistingCMapCodes (not a full
   * CMap-language parser) -- an established, already-proven-in-production
   * approach in this codebase for reading a real embedded font's real
   * CMap.
   */
  private parseToUnicodeCMapValues(cmapText: string): Map<number, string> {
    const map = new Map<number, string>();
    const decodeHexDest = (hex: string): string => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      }
      return out;
    };

    for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        if (pair[1].length > 2) continue; // multi-byte source code -- out of scope (simple fonts only)
        map.set(parseInt(pair[1], 16), decodeHexDest(pair[2]));
      }
    }
    for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      // Array form: <lo> <hi> [<d0> <d1> ...] -- each source code gets its OWN explicit destination.
      for (const rangeArr of m[1].matchAll(/<([0-9a-fA-F]{1,2})>\s*<([0-9a-fA-F]{1,2})>\s*\[([\s\S]*?)\]/g)) {
        const lo = parseInt(rangeArr[1], 16);
        const dests = [...rangeArr[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((d) => decodeHexDest(d[1]));
        dests.forEach((text, i) => map.set(lo + i, text));
      }
      // Scalar form: <lo> <hi> <dest> -- dest's LAST UTF-16 unit increments per source code.
      for (const rangeScalar of m[1].matchAll(/<([0-9a-fA-F]{1,2})>\s*<([0-9a-fA-F]{1,2})>\s*<([0-9a-fA-F]+)>/g)) {
        const lo = parseInt(rangeScalar[1], 16);
        const hi = parseInt(rangeScalar[2], 16);
        if (hi < lo || hi - lo > 0xff) continue; // malformed/unexpectedly huge range -- ignore rather than loop forever
        const destHex = rangeScalar[3];
        const prefix = decodeHexDest(destHex.slice(0, -4));
        const lastUnit = parseInt(destHex.slice(-4), 16);
        for (let c = lo; c <= hi; c++) map.set(c, prefix + String.fromCharCode(lastUnit + (c - lo)));
      }
    }
    return map;
  }

  /**
   * Builds a GlyphTextResolver (pdf-link-completeness-writer.ts's own
   * type) for a single page: given a font's own resource-dictionary tag
   * name (e.g. "/T1_2", the SAME name a `Tf` operator references) and a
   * single byte code, returns that font's own /ToUnicode-CMap-mapped
   * Unicode text for that code, or null when the font has no usable
   * /ToUnicode CMap, or the code isn't covered by it -- callers fall back
   * to the raw byte's own Latin-1 interpretation in that case (today's
   * existing behavior, unchanged for any document/font that doesn't need
   * this). Each font's own map is built at most once per call to this
   * method (cached by tag name) -- cheap insurance against a page with
   * several LINK-MISSING-ANNOTATION issues re-parsing the SAME font's CMap
   * once per issue (real shape: Curiel_187961_CSHP.pdf's own page 102 has
   * 6).
   *
   * Real incident this exists to fix: Curiel_187961_CSHP.pdf's own
   * embedded Type1 subset fonts (ACaslonPro Regular/Italic) encode
   * typographic ligatures (fi, fl, ff, Th) as custom single-byte glyph
   * codes -- standard PDF subsetting, confirmed live (and confirmed NOT a
   * fixed, reusable table: the SAME ligature maps to a DIFFERENT byte code
   * in the Regular vs Italic subset, each subsetted font getting its own
   * independent encoding). Reading each font's own, already-present
   * /ToUnicode CMap (PDF32000-1:2008's own designed-for-this-exact-purpose
   * mechanism) is both simpler and more broadly correct than re-deriving
   * glyph names via /Differences + the Adobe Glyph List, which
   * font-tounicode.service.ts's OWN buildCodeMap does for the OPPOSITE
   * direction (writing a NEW CMap for a font that lacks one entirely) --
   * that reverse-engineering doesn't apply here, since these fonts already
   * have a real CMap to just read.
   */
  private buildGlyphTextResolver(doc: PDFDocument, pageNumber: number): GlyphTextResolver {
    const page = doc.getPage(pageNumber - 1);
    const resourcesRaw = page.node.get(PDFName.of('Resources'));
    const resources = resourcesRaw instanceof PDFRef ? doc.context.lookup(resourcesRaw, PDFDict) : resourcesRaw instanceof PDFDict ? resourcesRaw : null;
    const fontsRaw = resources?.get(PDFName.of('Font'));
    const fonts = fontsRaw instanceof PDFRef ? doc.context.lookup(fontsRaw, PDFDict) : fontsRaw instanceof PDFDict ? fontsRaw : null;

    const cache = new Map<string, Map<number, string> | null>();

    const buildMapFor = (fontTag: string): Map<number, string> | null => {
      const fontRef = fonts?.get(PDFName.of(fontTag.replace(/^\//, '')));
      const fontDict = fontRef instanceof PDFRef ? doc.context.lookup(fontRef, PDFDict) : fontRef instanceof PDFDict ? fontRef : null;
      if (!fontDict) return null;
      const toUnicodeRaw = fontDict.get(PDFName.of('ToUnicode'));
      const toUnicodeStream = toUnicodeRaw instanceof PDFRef ? doc.context.lookup(toUnicodeRaw) : toUnicodeRaw;
      if (!(toUnicodeStream instanceof PDFRawStream)) return null;
      let cmapText: string;
      try {
        cmapText = Buffer.from(decodePDFRawStream(toUnicodeStream).decode()).toString('latin1');
      } catch {
        return null;
      }
      return this.parseToUnicodeCMapValues(cmapText);
    };

    return (fontTag: string, byteCode: number): string | null => {
      let map = cache.get(fontTag);
      if (map === undefined) {
        map = buildMapFor(fontTag);
        cache.set(fontTag, map);
      }
      return map?.get(byteCode) ?? null;
    };
  }

  /**
   * A page font's own declared base encoding name (e.g. "/WinAnsiEncoding"),
   * read directly from its /Encoding entry -- either a bare Name, or an
   * Encoding dictionary's own /BaseEncoding. Returns undefined when there's
   * no explicit declaration at all (a symbolic font, or a nonsymbolic one
   * relying on its own built-in encoding per PDF32000 9.6.6.2) -- NOT a
   * guessed default, since StandardEncoding/MacRomanEncoding/WinAnsiEncoding
   * disagree on what several byte codes mean (confirmed via
   * font-encodings.ts's own tables: byte 149 alone is bullet under
   * WinAnsiEncoding, unassigned under StandardEncoding, and 'i-dieresis'
   * under MacRomanEncoding) -- only an EXPLICIT declaration makes a
   * byte-code's meaning a confirmed fact rather than an assumption. Used by
   * fixArtifactActualTextSibling's own confirmed-encoding ToUnicode-miss
   * fallback above.
   */
  private fontBaseEncodingName(doc: PDFDocument, pageNumber: number, fontTag: string): string | undefined {
    try {
      const page = doc.getPage(pageNumber - 1);
      const resourcesRaw = page.node.get(PDFName.of('Resources'));
      const resources = resourcesRaw instanceof PDFRef ? doc.context.lookup(resourcesRaw, PDFDict) : resourcesRaw instanceof PDFDict ? resourcesRaw : null;
      const fontsRaw = resources?.get(PDFName.of('Font'));
      const fonts = fontsRaw instanceof PDFRef ? doc.context.lookup(fontsRaw, PDFDict) : fontsRaw instanceof PDFDict ? fontsRaw : null;
      const fontRef = fonts?.get(PDFName.of(fontTag.replace(/^\//, '')));
      const fontDict = fontRef instanceof PDFRef ? doc.context.lookup(fontRef, PDFDict) : fontRef instanceof PDFDict ? fontRef : null;
      if (!fontDict) return undefined;
      let encRaw = fontDict.get(PDFName.of('Encoding'));
      if (encRaw instanceof PDFRef) encRaw = doc.context.lookup(encRaw);
      if (encRaw instanceof PDFName) return encRaw.toString();
      if (encRaw instanceof PDFDict) {
        const base = encRaw.get(PDFName.of('BaseEncoding'));
        return base instanceof PDFName ? base.toString() : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Companion to buildGlyphTextResolver, for the same-operand URL
   * splitter's own font-safety guard (pdf-link-completeness-writer.ts's
   * findUrlSubstringRun): reports whether a font tag resolves to a simple
   * (single-byte) font subtype -- the ONLY kind that module's byte-level
   * cut logic is safe to attempt on. Same SIMPLE_FONT_SUBTYPES set
   * font-tounicode.service.ts already uses for the identical distinction,
   * duplicated locally rather than imported -- a 4-string Set, and this
   * file already duplicates small, self-contained lookups rather than
   * couple to that file's own class (see e.g. parseToUnicodeCMapValues's
   * own doc comment). An unresolvable font tag (missing /Resources, no
   * matching entry, no /Subtype) reports false -- decline rather than
   * guess, matching every other "can't verify" gate in this same fixer.
   */
  private buildSimpleFontChecker(doc: PDFDocument, pageNumber: number): (fontTag: string) => boolean {
    const SIMPLE_FONT_SUBTYPES = new Set(['/Type1', '/TrueType', '/MMType1', '/Type3']);
    const page = doc.getPage(pageNumber - 1);
    const resourcesRaw = page.node.get(PDFName.of('Resources'));
    const resources = resourcesRaw instanceof PDFRef ? doc.context.lookup(resourcesRaw, PDFDict) : resourcesRaw instanceof PDFDict ? resourcesRaw : null;
    const fontsRaw = resources?.get(PDFName.of('Font'));
    const fonts = fontsRaw instanceof PDFRef ? doc.context.lookup(fontsRaw, PDFDict) : fontsRaw instanceof PDFDict ? fontsRaw : null;

    return (fontTag: string): boolean => {
      const fontRef = fonts?.get(PDFName.of(fontTag.replace(/^\//, '')));
      const fontDict = fontRef instanceof PDFRef ? doc.context.lookup(fontRef, PDFDict) : fontRef instanceof PDFDict ? fontRef : null;
      const subtype = fontDict?.get(PDFName.of('Subtype'))?.toString();
      return subtype !== undefined && SIMPLE_FONT_SUBTYPES.has(subtype);
    };
  }

  /**
   * LINK-MISSING-ANNOTATION fix (Matterhorn 28-011), Slice 3 -- wires
   * slices 1-2's pure content-stream splice (pdf-link-completeness-
   * writer.ts's findUrlOperatorRun/buildLinkCompletenessSplice), AND the
   * same-operand URL splitter (findUrlSubstringRun/buildUrlSubstringSplice,
   * tried as a fallback when the clean path declines), into a real
   * PDFDocument: creates the /Link annotation PAC/veraPDF actually look
   * for, a matching /Link structure element carrying both the URL's own
   * text (via its fresh MCID) and an OBJR back to the annotation, splices
   * that new element into the enclosing paragraph's own /K (replacing its
   * single bare MCID with [original, new /Link, remainder] -- see
   * buildLinkCompletenessSplice's own doc comment for why a remainder MCID
   * is needed at all), and extends BOTH ParentTree mechanisms this needs:
   * the page's own MCID-indexed array (for linkMcid and, if present, the
   * remainder's fresh MCID) via the existing extendParentTree, and the
   * document-wide standalone-object key space (for the annotation's own
   * /StructParent) via the new appendAnnotationParentTreeEntry above.
   *
   * Scoped to real, measured data: a full sweep of
   * Curiel_187961_CSHP.pdf's own 209 real LINK-MISSING-ANNOTATION issues
   * found the URL arrives as a clean, findUrlOperatorRun-locatable run in
   * 135/209 (64.6%) of cases, and findUrlSubstringRun locates a run (with a
   * real, verified-exact splice) for the remaining 74/209 (35.4%) --
   * confirmed live, every one of those 74 produced a /Link span whose own
   * content, precisely re-decoded, is exactly the target URL. Both
   * functions still decline (return null) on a genuinely unsafe shape --
   * a non-simple (CID/Type0) font at a cut point, or a target position
   * landing strictly inside a ligature's own multi-character expansion --
   * rather than guess; see pdf-link-completeness-writer.ts's own header
   * comment for the full breakdown. Also declines when the enclosing
   * content has no MCID of its own (a bare /Artifact) -- no natural
   * struct-tree parent to attach the new /Link under, the same
   * "ambiguous, no natural parent" shape this file already declines
   * elsewhere (reattachTableCell, retagPlacedPdfAsFigure) rather than
   * invent one; not hit by any of the 135 real clean matches above (every
   * one sits inside a real, MCID-bound /P).
   *
   * Everything from the enclosing-tag resolution onward is IDENTICAL
   * regardless of which path produced `splice` -- LinkCompletenessSplice
   * and UrlSubstringSplice are structurally identical
   * ({edits, linkMcid, remainderMcid, enclosingTag, enclosingMcid}), by
   * design, so the rest of this method never needs to know which one ran.
   *
   * Rollback on any failure restores the page's original content bytes,
   * /Annots, and the enclosing element's /K, and clears every newly
   * registered object's /K and /P (deleteElement) -- same discipline as
   * fixArtifactSwallowsContent. One accepted, documented residual: if
   * extendParentTree or appendAnnotationParentTreeEntry (the unconditional
   * last two statements, after everything else has already succeeded)
   * throws, the OTHER of the two may have already committed its own
   * insertion with nothing to explicitly undo it -- left as-is rather than
   * hand-rolling an undo for a tree insert at a known position, since any
   * leftover entry would point at content this rollback already deletes
   * (an inert, never-looked-up trailing slot, not a corruption) and this
   * matches every other fix method in this file, each of which treats its
   * own single extendParentTree call as the true last, no-further-rollback
   * statement in its own try block.
   */
  fixLinkMissingAnnotation(doc: PDFDocument, issue: AuditIssue): FixResult {
    const fail = (error: string): FixResult => ({ issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error });

    if (!issue.pageNumber) return fail('Issue has no pageNumber');
    if (!issue.linkCompletenessData?.url) return fail('Issue has no linkCompletenessData.url');
    if (!issue.boundingBox) return fail('Issue has no boundingBox -- cannot place a Link annotation without one');
    const pageNumber = issue.pageNumber;
    const url = issue.linkCompletenessData.url;
    const bbox = issue.boundingBox;

    let originalContent: string | null;
    try {
      originalContent = decodePageContent(doc, pageNumber);
    } catch (err) {
      return fail(`Could not decode page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!originalContent) return fail(`Page ${pageNumber} has no content stream`);

    const resolveGlyphText = this.buildGlyphTextResolver(doc, pageNumber);
    const existingMcids = pageContentMcids(doc, pageNumber) ?? new Set<number>();
    const nextMcid = existingMcids.size > 0 ? Math.max(...existingMcids) + 1 : 0;

    let splice: LinkCompletenessSplice | UrlSubstringSplice | null = null;
    let method: 'clean' | 'substring' = 'clean';

    const run = findUrlOperatorRun(originalContent, 0, originalContent.length, url, resolveGlyphText);
    if (run) {
      splice = buildLinkCompletenessSplice(originalContent, run, nextMcid);
    } else {
      // Fallback: the URL shares its own text-show operand with other
      // prose (the 35.4% bucket the clean path above declines on by
      // design) -- try the same-operand splitter before giving up.
      const isSimpleFont = this.buildSimpleFontChecker(doc, pageNumber);
      const substringRun = findUrlSubstringRun(originalContent, 0, originalContent.length, url, resolveGlyphText, isSimpleFont);
      if (substringRun) {
        method = 'substring';
        splice = buildUrlSubstringSplice(originalContent, substringRun, nextMcid);
      }
    }

    if (!splice) {
      return fail(
        'Could not locate this URL as a clean run of text-show operators, or safely carve it out of an operand it ' +
        'shares with other prose, on this page -- either already fixed, or a genuinely unsafe shape (a non-simple ' +
        'font at the needed cut point, or a position landing inside a ligature\'s own multi-character expansion) ' +
        'that this fixer declines rather than guesses on -- see pdf-link-completeness-writer.ts'
      );
    }
    if (splice.enclosingMcid === null) {
      return fail(
        'Enclosing content is an untagged /Artifact span (no MCID of its own) -- no natural structure-tree parent ' +
        'to attach the new /Link under; declining rather than guessing'
      );
    }
    const enclosingMcid = splice.enclosingMcid;

    const pageArr = this.resolveParentTreePageArray(doc, pageNumber);
    if (!pageArr) return fail(`No /ParentTree entry found for page ${pageNumber}`);
    const enclosingRef = pageArr.asArray()[enclosingMcid];
    if (!(enclosingRef instanceof PDFRef)) {
      return fail(`Page ${pageNumber}'s /ParentTree has no struct element at MCID ${enclosingMcid}`);
    }
    const enclosingDict = doc.context.lookup(enclosingRef);
    if (!(enclosingDict instanceof PDFDict)) {
      return fail('Enclosing struct element ref does not resolve to a dictionary');
    }
    // Deliberately NOT cross-checking the enclosing struct element's own /S
    // against splice.enclosingTag (the content-stream's own cosmetic BDC
    // tag-name literal) -- tried first, then removed as a real false-
    // positive source, confirmed live on 34/209 of Curiel_187961_CSHP.pdf's
    // own real cases. renameElement (used by fixHeadingHierarchy/
    // fixMultipleH1 to correct a heading-level gap) only ever updates the
    // struct dict's own /S -- it never touches the content stream's BDC tag
    // name, so a heading that's been renamed (e.g. struct /S now /H3, BDC
    // literal still /H6) legitimately disagrees with no actual inconsistency
    // at all: nothing else in this codebase (grepped every validator) ever
    // reads a content-stream tag-name operand for role determination --
    // only a struct element's own /S is spec-authoritative (PDF32000's tag
    // name operand has no defined accessibility semantics beyond marked-
    // content scoping). The /K check right below is the real safety gate:
    // it confirms the struct element pageArr[enclosingMcid] resolves to is,
    // by construction, the UNIQUE element whose own /K still points back at
    // exactly this MCID -- that's sufficient to prove it's the right
    // element to splice into, independent of what its /S happens to say.
    const originalK = enclosingDict.get(PDFName.of('K'));
    // Paragraph-ceiling follow-on (2026-11-06): confirmed live on
    // Curiel_187961_CSHP.pdf that all 209 real issues sit in only 28
    // unique paragraphs, so requiring /K to STILL be a bare scalar meant
    // only the first URL per paragraph could ever be fixed -- every other
    // URL in the same paragraph declined here once the first fix widened
    // /K to an array. The invariant that actually matters is unchanged
    // either way: enclosingMcid must be the UNIQUE entry (a bare number,
    // OR the equally-valid MCR-dict form -- see the array branch below)
    // marking exactly where this content sits in the element's own
    // reading order -- whether /K is still that scalar itself, or (an
    // earlier fix on this same paragraph already ran) one entry inside an
    // array of several. Either way the new /Link (and remainder, if any)
    // splice in immediately after that entry's own position.
    let kidsArrayIndex: number | null = null;
    if (originalK instanceof PDFNumber) {
      if (originalK.asNumber() !== enclosingMcid) {
        return fail(
          `Enclosing struct element's own /K is the bare MCID ${originalK.asNumber()}, not the ${enclosingMcid} ` +
          'the splice was built against -- declining rather than guessing at how to merge with whatever else is there now'
        );
      }
    } else if (originalK instanceof PDFArray) {
      const kArr = originalK.asArray();
      const matchingIndices = kArr.reduce<number[]>((acc, item, i) => {
        const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
        if (resolved instanceof PDFNumber && resolved.asNumber() === enclosingMcid) {
          acc.push(i);
        } else if (resolved instanceof PDFDict) {
          // An MCR (Marked Content Reference) dict -- <</Type /MCR /Pg ref
          // /MCID n>>, PDF32000 14.7.4.4 -- carries the same MCID a bare
          // number would, just in the explicit form some authoring tools
          // (confirmed real: Adobe InDesign's own /Story -> /TX export,
          // Karsaklian_189165's real MCID 1844) use for content whose own
          // page can differ from the struct element's default /Pg.
          // Matching on /MCID alone, no extra /Pg cross-check, mirrors
          // this file's own established structElemHasMcid -- the page
          // this MCID lives on was already pinned by resolveParentTreePageArray
          // resolving `enclosingRef` out of THIS SPECIFIC page's own
          // /ParentTree entry, before this /K check ever runs, so the
          // MCID value alone is already page-disambiguated.
          const mcidRaw = resolved.get(PDFName.of('MCID'));
          const mcidResolved = mcidRaw instanceof PDFRef ? doc.context.lookup(mcidRaw) : mcidRaw;
          if (mcidResolved instanceof PDFNumber && mcidResolved.asNumber() === enclosingMcid) acc.push(i);
        }
        return acc;
      }, []);
      if (matchingIndices.length !== 1) {
        return fail(
          `Enclosing struct element's own /K is an array containing MCID ${enclosingMcid} ` +
          `${matchingIndices.length} time(s) (expected exactly 1) -- declining rather than guessing where to splice`
        );
      }
      kidsArrayIndex = matchingIndices[0];
    } else {
      return fail(
        'Enclosing struct element\'s own /K is neither a bare MCID nor an array containing one -- declining ' +
        'rather than guessing'
      );
    }

    const page = doc.getPage(pageNumber - 1);
    const pageRef = page.ref;
    const originalAnnotsRaw = page.node.get(PDFName.of('Annots'));
    const existingAnnots = originalAnnotsRaw instanceof PDFRef ? doc.context.lookup(originalAnnotsRaw) : originalAnnotsRaw;
    const existingAnnotRefs = existingAnnots instanceof PDFArray ? existingAnnots.asArray() : [];

    const rect = [
      bbox.x,
      bbox.pageHeight - bbox.y - bbox.height,
      bbox.x + bbox.width,
      bbox.pageHeight - bbox.y,
    ];

    const createdRefs: PDFRef[] = [];
    try {
      const annotDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Link'),
        Rect: rect,
        Border: [0, 0, 0],
        A: { S: PDFName.of('URI'), URI: PDFString.of(this.escapeLinkPdfString(url)) },
      }) as PDFDict;
      const annotRef = doc.context.register(annotDict);
      createdRefs.push(annotRef);

      const objrDict = doc.context.obj({ Type: PDFName.of('OBJR'), Obj: annotRef, Pg: pageRef }) as PDFDict;
      const objrRef = doc.context.register(objrDict);
      createdRefs.push(objrRef);

      const linkElemDict = doc.context.obj({
        Type: PDFName.of('StructElem'),
        S: PDFName.of('Link'),
        P: enclosingRef,
        Pg: pageRef,
        K: [PDFNumber.of(splice.linkMcid), objrRef],
      }) as PDFDict;
      const linkRef = doc.context.register(linkElemDict);
      createdRefs.push(linkRef);

      page.node.set(PDFName.of('Annots'), doc.context.obj([...existingAnnotRefs, annotRef]));

      let newContent = originalContent;
      for (const edit of [...splice.edits].sort((a, b) => b.offset - a.offset)) {
        newContent = newContent.slice(0, edit.offset) + edit.text + newContent.slice(edit.offset);
      }
      writePageContent(doc, pageNumber, newContent);

      const newEntries: PDFObject[] = [linkRef];
      if (splice.remainderMcid !== null) newEntries.push(PDFNumber.of(splice.remainderMcid));
      if (kidsArrayIndex !== null) {
        // /K was already an array (a prior fix on this same paragraph) --
        // splice the new entries in right after the existing enclosingMcid
        // entry, preserving reading order, WITHOUT mutating the array
        // object `originalK` itself holds -- so the catch block's plain
        // `enclosingDict.set(..., originalK)` below is still a correct,
        // untouched rollback.
        const existingArr = (originalK as PDFArray).asArray();
        const updatedArr = [
          ...existingArr.slice(0, kidsArrayIndex + 1),
          ...newEntries,
          ...existingArr.slice(kidsArrayIndex + 1),
        ];
        enclosingDict.set(PDFName.of('K'), doc.context.obj(updatedArr));
      } else {
        enclosingDict.set(PDFName.of('K'), doc.context.obj([PDFNumber.of(enclosingMcid), ...newEntries]));
      }

      if (!this.isReachableFromRoot(doc, enclosingRef)) {
        throw new Error('Enclosing struct element is no longer reachable from the structure tree root after splicing -- not committing');
      }

      const parentTreeEntries: Array<{ mcid: number; structElementRef: PDFRef }> = [{ mcid: splice.linkMcid, structElementRef: linkRef }];
      if (splice.remainderMcid !== null) parentTreeEntries.push({ mcid: splice.remainderMcid, structElementRef: enclosingRef });
      this.extendParentTree(doc, pageNumber, parentTreeEntries);

      const structParentKey = this.appendAnnotationParentTreeEntry(doc, pageNumber, linkRef);
      annotDict.set(PDFName.of('StructParent'), PDFNumber.of(structParentKey));
    } catch (err) {
      writePageContent(doc, pageNumber, originalContent);
      if (originalAnnotsRaw !== undefined) page.node.set(PDFName.of('Annots'), originalAnnotsRaw);
      else page.node.delete(PDFName.of('Annots'));
      enclosingDict.set(PDFName.of('K'), originalK);
      for (const ref of createdRefs) this.deleteElement(doc, ref);
      return fail(err instanceof Error ? err.message : String(err));
    }

    return {
      issueId: issue.id,
      success: true,
      before: 'URL-shaped text with no Link annotation',
      after: `Created a /Link annotation + structure element for "${url.slice(0, 80)}"` +
        (method === 'substring' ? ' (carved out of a shared operand via the same-operand splitter)' : ''),
    };
  }
}

export const pdfStructureWriterService = new PdfStructureWriterService();
