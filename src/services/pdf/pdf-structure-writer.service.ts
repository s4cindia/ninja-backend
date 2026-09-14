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
import { pageContentMcids } from './pdf-content-stream-io';

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
   * Per Matterhorn Protocol 07-002: TH elements MUST have a /Scope attribute.
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

    // Collect all Hn elements in document (reading) order
    const headingRefs: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const m = /^H([1-9])$/.exec(sTag.toString().replace(/^\//, ''));
      if (m) headingRefs.push({ ref, level: parseInt(m[1], 10) });
    });

    // A structure tree with zero Hn elements means there is nothing this
    // method can ever fix, no matter how many HEADING-SKIP issues detection
    // reports — detection uses a separate text/font-size heuristic that
    // scans visible content directly, entirely independent of the tag tree
    // (see structure-tree-completeness.ts's isHeadingShell, which exists to
    // catch and retag exactly this case upstream). Bailing to failure here
    // too, rather than reporting success, is a deliberate second line of
    // defense: it stays honest even if that upstream check didn't run, was
    // bypassed, or the tree became heading-empty some other way. Reporting
    // success on a 0-Hn tree previously meant every one of these issues got
    // silently marked resolved every round on documents whose headings were
    // simply never tagged in the first place.
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

    // Collect all heading elements in document (reading) order
    const allHeadings: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const m = /^H([1-9])$/.exec(sTag.toString().replace(/^\//, ''));
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
   * Promote first-row TD cells to TH + add scope="Column" for simple tables.
   * "Simple" = first TR has ≤3 cells and none appear to have spanning attributes.
   *
   * Both steps are required:
   *   1. renameElement(TD → TH)  — fixes tag type
   *   2. writeScopeAttribute(Column) — fixes Matterhorn 07-002
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
   * @param issues - TABLE-MISSING-HEADERS AuditIssues (simple tables only)
   */
  fixSimpleTableHeaders(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
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
        const target = this.findTargetTable(doc, structRoot, issue.element);
        if (!target) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: `No Table element found matching "${issue.element}"`,
          });
          continue;
        }
        const table = target.dict;

        // Find the first TR — may be a direct child OR nested inside THead/TBody
        let firstTR = this.findFirstChild(doc, table, 'TR');
        if (!firstTR) {
          const tbody = this.findFirstChild(doc, table, 'TBody') ?? this.findFirstChild(doc, table, 'THead');
          if (tbody) firstTR = this.findFirstChild(doc, tbody.dict, 'TR');
        }
        if (!firstTR) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table has no TR row to promote headers on',
          });
          continue;
        }

        // Count all cells (TD + TH) to determine complexity
        const tds = this.findAllChildren(doc, firstTR.dict, 'TD');
        const ths = this.findAllChildren(doc, firstTR.dict, 'TH');
        const totalCells = tds.length + ths.length;

        if (totalCells === 0) {
          results.push({
            issueId: issue.id, success: false,
            before: 'unknown', after: 'unknown',
            error: 'Target table\'s first row is empty',
          });
          continue;
        }

        if (tds.length === 0) {
          results.push({
            issueId: issue.id,
            success: true,
            before: 'First-row cells tagged as TD',
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
          before: 'First-row cells tagged as TD',
          after: `Promoted ${fixedCellCount} TD cell(s) to TH with scope="Column"`,
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
  extendParentTree(doc: PDFDocument, pageNumber: number, entries: Array<{ mcid: number; structElementRef: PDFRef }>): void {
    if (entries.length === 0) return;

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
   */
  markTableAsArtifact(doc: PDFDocument, issues: AuditIssue[]): FixResult[] {
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
      target: this.findTargetTable(doc, structRoot, issue.element),
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

    // Collect headings in document order
    const headings: Array<{
      level: number;
      title: string;
      pageIndex: number;
      fallback: boolean;
    }> = [];

    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
      if (!sTag) return;
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
}

export const pdfStructureWriterService = new PdfStructureWriterService();
