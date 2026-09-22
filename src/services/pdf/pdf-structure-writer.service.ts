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
  PDFObject,
} from 'pdf-lib';
import { AuditIssue } from '../audit/base-audit.service';
import { logger } from '../../lib/logger';
import { pageContentMcids, decodePageContent, writePageContent } from './pdf-content-stream-io';
import { tagUntaggedPaintedPaths } from './pdf-artifact-tagger';
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
import { MIN_APPLY_CONFIDENCE } from './pdf-contrast-writer.service';
import { verifyStillNoDetectableInk } from './color-contrast-verification';
import { tokenize } from '../zone-extractor/seam-c/content-stream';
import type { ParsedPDF } from './pdf-parser.service';

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
   * isn't found in parentRef's /K array, or /K isn't an array at all (a
   * lone-child parent has no meaningful "position" for this to preserve) --
   * matches this file's established "bail rather than guess" convention.
   */
  private insertIntoKidsAfter(doc: PDFDocument, parentRef: PDFRef, afterRef: PDFRef, newRef: PDFRef): void {
    const parent = doc.context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) {
      throw new Error('insertIntoKidsAfter: parent does not resolve to a dictionary');
    }
    const k = parent.get(PDFName.of('K'));
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
   *   today (e.g. via pdfModifierService.setAltText failing for it).
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
      try {
        pageRef = doc.getPage(pageNumber - 1).ref;
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
        const xObjectName = img.imageId.match(/^img_p\d+_\d+_(.+)$/)?.[1];
        if (!xObjectName) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `Could not parse XObject name from imageId "${img.imageId}"` });
          continue;
        }
        const range = locateXObjectInvocation(pageContent, xObjectName);
        if (!range) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: `No unambiguous "/${xObjectName} Do" invocation found on page ${pageNumber}` });
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
        // fully knowable up front. A single-child struct element legitimately
        // has a SCALAR /K per spec (not wrapped in an array) -- insertIntoKidsAfter
        // throws on that shape, and previously did so only AFTER the content
        // stream had already been rewritten (Codex finding on PR #555,
        // confirmed real).
        const parentDict = doc.context.lookup(parentRaw);
        if (!(parentDict instanceof PDFDict)) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor parent does not resolve to a dictionary' });
          continue;
        }
        const parentK = parentDict.get(PDFName.of('K'));
        if (!(parentK instanceof PDFArray)) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor parent /K is not an array -- cannot position relative to a sibling' });
          continue;
        }
        const anchorInArray = parentK.asArray().some(item => item instanceof PDFRef && item.objectNumber === anchor.ref.objectNumber);
        if (!anchorInArray) {
          results.push({ issueId: img.imageId, success: false, before: 'unknown', after: 'unknown', error: 'Anchor not found in its own parent /K array' });
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
      try {
        this.resolveParentTreeNumsArray(doc, pageNumber);
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
        inserted = insertMarkedContentSpans(doc, pageNumber, requests, 'Figure');
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
          const figureObj = doc.context.obj({
            Type: PDFName.of('StructElem'),
            S: PDFName.of('Figure'),
            P: ve.parentRef,
            Pg: pageRef,
            K: PDFNumber.of(mcid),
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

        const rows = this.collectAllRows(doc, table);
        if (rows.length === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table has no TR row to promote headers on',
          });
          continue;
        }

        const cellCounts = rows.map(row =>
          this.findAllChildren(doc, row.dict, 'TD').length + this.findAllChildren(doc, row.dict, 'TH').length
        );
        const mode = this.modeOf(cellCounts.filter(c => c > 0));
        if (mode === null) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'No single typical row shape -- row cell counts are evenly split, refusing to guess',
          });
          continue;
        }

        let headerRowIndex = -1;
        for (let i = 0; i < Math.min(rows.length, MAX_LEADING_ROWS_TO_SKIP); i++) {
          if (cellCounts[i] === mode) { headerRowIndex = i; break; }
        }
        if (headerRowIndex === -1) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No row within the first ${MAX_LEADING_ROWS_TO_SKIP} matches this table's typical (${mode}-cell) row shape`,
          });
          continue;
        }
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
          ? this.retagMultiLevelTableHeaders(doc, rowCells, issue.element ?? issue.id)
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
   * count — otherwise the block is left entirely untouched rather than
   * guessing an ambiguous split (see mapSubColumnsToGroups). Every real
   * block found on Math_Weir_PDF.pdf has exactly one group cell, which
   * trivially "spans" every sub-column with no ambiguity at all; the
   * ColSpan path exists for a different document that might genuinely
   * need it, not for anything observed here.
   */
  private retagMultiLevelTableHeaders(
    doc: PDFDocument,
    rowCells: Array<Array<{ dict: PDFDict; ref: PDFRef; tag: string }>>,
    idPrefix: string,
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

      const subToGroupIndex = this.mapSubColumnsToGroups(doc, groupRow, block);
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
   * cell trivially covers every sub-column — the shape confirmed for every
   * real block found on Math_Weir_PDF.pdf. Multiple group cells are only
   * mapped when every one of them carries an explicit /ColSpan and those
   * spans sum exactly to the sub-column count; any other multi-group case
   * (missing ColSpan, or spans that don't add up) is genuinely ambiguous
   * and returns null rather than guessing a split.
   */
  private mapSubColumnsToGroups(
    doc: PDFDocument,
    groupRow: Array<{ dict: PDFDict }>,
    block: { groupIndices: number[]; subIndices: number[] },
  ): number[] | null {
    const subCount = block.subIndices.length;
    if (block.groupIndices.length === 1) return new Array(subCount).fill(0);

    const spans = block.groupIndices.map(gi => this.readColSpanForFix(doc, groupRow[gi].dict));
    if (spans.some(sp => sp === null || sp <= 0)) return null;
    const nonNullSpans = spans as number[];
    const total = nonNullSpans.reduce((a, b) => a + b, 0);
    if (total !== subCount) return null;

    const mapping: number[] = [];
    nonNullSpans.forEach((span, groupIdx) => {
      for (let k = 0; k < span; k++) mapping.push(groupIdx);
    });
    return mapping;
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
   * entry. /Artifact is a standard STRUCTURE type only in this namespace
   * (in PDF 1.7/ISO 32000-1, /Artifact is solely a content-stream
   * marked-content tag, a different mechanism entirely) -- CodeRabbit
   * finding on PR #547, confirmed live: Math_Kim declares no /Namespaces
   * at all (a plain PDF 1.7 document), so an unnamespaced "/S /Artifact"
   * struct element would be non-standard there. PDF 2.0 explicitly
   * supports introducing this namespace incrementally into an
   * otherwise-1.7 tree, binding only the specific elements that need it --
   * ISO/TS 32005:2023 requires the DOCUMENT itself to be versioned as PDF
   * 2.0 (via the catalog /Version, avoiding a header rewrite for an
   * incremental update like this one) whenever that namespace is actually
   * used, not just the individual namespace entry -- CodeRabbit finding on
   * PR #547: pdf-lib always writes a %PDF-1.7 header, so without this a
   * saved file would advertise 1.7 while containing a 2.0-only /Artifact
   * structure type. Set every time this runs (idempotent -- same value
   * each call), not only on first creation, since an already-existing
   * namespace being reused still means the document uses it.
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
   * Rejects (throws on) two /ParentTree shapes rather than handling them,
   * both intentionally out of scope until live validation (Slice 2d)
   * actually hits one: a page's existing /ParentTree value being something
   * OTHER than an array (e.g. a lone dict/ref for a page that historically
   * used exactly one MCID -- promoting it to array form is unverified
   * guesswork), and a hierarchical /Kids number tree at the /ParentTree
   * root (this codebase doesn't currently produce or need to read one;
   * walking /Kids to the correct leaf is real, separate work).
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
      // node with actual key-value pairs), never both. Blindly adding an
      // empty /Nums here when /Kids is already present would (a) never
      // find any real existing page mapping, since those live under /Kids,
      // not here, and (b) produce an invalid node carrying both keys.
      // Walking /Kids to find the correct leaf is real, separate work --
      // this codebase doesn't currently produce or need to read a
      // hierarchical tree anywhere (Math_Kim's own /ParentTree is
      // confirmed flat/Nums-only), so bail rather than guess, matching
      // this method's other unsupported-shape checks (CodeRabbit/Codex
      // finding on PR #551, confirmed real).
      if (parentTreeDict.get(PDFName.of('Kids'))) {
        throw new Error(
          'extendParentTree: /StructTreeRoot /ParentTree uses a hierarchical /Kids number tree -- unsupported.'
        );
      }
      numsArr = doc.context.obj([]) as unknown as PDFArray;
      parentTreeDict.set(PDFName.of('Nums'), numsArr);
    }

    return { numsArr, pageKey };
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

      const nsRef = this.getOrCreatePdf2Namespace(doc, structRoot);

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

          // Retag the spuriously-paired trivial box to /Artifact, same
          // operations markTableAsArtifact performs (renameElement + PDF2
          // namespace binding + clearing now-meaningless /K children). This
          // is not just cleanup: structure-analyzer.service.ts's
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
          // shape. Retagging removes the box from the walk's /Table count
          // entirely (net-zero change to the page's tally at that tree
          // position), restoring correct FIFO alignment for every other
          // same-page table. Also the semantically correct outcome, not a
          // workaround: MATTERHORN-15-001 is genuinely tabular LAYOUT content
          // spuriously paired with a decorative box (PR #546) -- that box is
          // exactly what MATTERHORN-15-005's existing fix already retags,
          // so it no longer sits around as an untouched leftover here either.
          const targetDict = doc.context.lookup(targetRef);
          if (targetDict instanceof PDFDict) {
            this.renameElement(doc, targetRef, 'Artifact');
            targetDict.set(PDFName.of('NS'), nsRef);
            targetDict.delete(PDFName.of('K'));
          }

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
          validEntries.forEach((ve, i) => {
            const r = pageResults[i];
            if (!r.success) return;
            const tableRef = pageTableRefsByEntry.get(ve.entryIndex);
            const tableDict = tableRef ? doc.context.lookup(tableRef) : undefined;
            if (tableDict instanceof PDFDict) {
              this.renameElement(doc, tableRef!, 'Artifact');
              tableDict.set(PDFName.of('NS'), nsRef);
              // Same "descendants become unreachable garbage, not literally
              // removed from the file" semantics deleteElement already
              // documents -- the TR/TH/TD/Span children below still exist
              // as registered objects but are no longer reachable from a
              // struct element real readers will walk.
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
   * Also addresses a second real finding from the same review round: the
   * target element's own TR/TD children no longer make structural sense
   * once it becomes an Artifact (they were only ever decorative box
   * padding -- that's this whole fix's premise). Cleared via the same
   * "descendants become unreachable, not literally removed from the file"
   * semantics deleteElement already documents, rather than leaving a
   * dangling Table-shaped subtree under a role that no longer describes it.
   *
   * Not independently verified against a real PDF/UA validator -- veraPDF
   * is unavailable in this environment (see pdf-audit.service.ts's own
   * fallback). The same veraPDF pass already wired into the staging audit
   * pipeline will re-check this once deployed, matching how every other
   * structural fix in this file gets its real-world confirmation.
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

    const anyTarget = targets.some(t => t.target);
    const nsRef = anyTarget ? this.getOrCreatePdf2Namespace(doc, structRoot) : null;

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

        this.renameElement(doc, target.ref, 'Artifact');
        target.dict.set(PDFName.of('NS'), nsRef!);
        target.dict.delete(PDFName.of('K')); // TR/TD children no longer make sense under Artifact

        results.push({
          issueId: issue.id,
          success: true,
          before: 'Tagged as Table (decorative box, no real column grid)',
          after: 'Retagged as Artifact',
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
      const ambientColor = findPrecedingColor(content, btStart);
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
        let text = '';
        let sawHex = false;
        for (const s of pendingStrings) {
          if (s.t === 's') text += this.decodePrintableAsciiOnly(s.v);
          else sawHex = true;
        }
        const trimmed = text.trim();
        const display = trimmed.length > 0 ? `"${trimmed}"` : (sawHex ? '[symbol]' : null);
        if (display) {
          const isSmaller = baselineScale !== null && curScale !== null && curScale / baselineScale < SCALE_RATIO_THRESHOLD;
          const label = curY > Y_THRESHOLD ? 'raised'
            : curY < -Y_THRESHOLD ? 'lowered'
            : isSmaller ? 'smaller-script'
            : 'main';
          fragments.push(`[${label}] ${display}`);
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
}

export const pdfStructureWriterService = new PdfStructureWriterService();
