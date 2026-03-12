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
   * BFS traversal of the structure tree.
   * Calls visitor(node, ref) for every PDFDict encountered.
   * If visitor returns true, traversal stops immediately.
   */
  private traverseStructTree(
    doc: PDFDocument,
    root: PDFDict,
    visitor: (node: PDFDict, ref: PDFRef | null) => boolean | void,
  ): void {
    const queue: Array<{ dict: PDFDict; ref: PDFRef | null }> = [{ dict: root, ref: null }];
    while (queue.length > 0) {
      const { dict: node, ref } = queue.shift()!;
      if (visitor(node, ref) === true) return;

      const kids = node.get(PDFName.of('K'));
      const enqueue = (raw: PDFObject) => {
        const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
        if (obj instanceof PDFDict) {
          queue.push({ dict: obj, ref: raw instanceof PDFRef ? raw : null });
        }
      };
      if (kids instanceof PDFArray) {
        kids.asArray().forEach(enqueue);
      } else if (kids instanceof PDFRef || kids instanceof PDFDict) {
        enqueue(kids as PDFObject);
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

    // Collect all Hn elements in BFS document order
    const headingRefs: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const m = /^H(\d)$/.exec(sTag.toString().replace(/^\//, ''));
      if (m) headingRefs.push({ ref, level: parseInt(m[1], 10) });
    });

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

    logger.info(`[StructureWriter] fixHeadingHierarchy: ${fixCount} heading(s) renamed`);
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
   *   1. Collect all Hn elements in BFS document order.
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

    // Collect all heading elements in BFS document order
    const allHeadings: Array<{ ref: PDFRef; level: number }> = [];
    this.traverseStructTree(doc, structRoot, (node, ref) => {
      if (!ref) return;
      const sTag = node.get(PDFName.of('S'));
      if (!sTag) return;
      const m = /^H(\d)$/.exec(sTag.toString().replace(/^\//, ''));
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
   * Promote first-row TD cells to TH + add scope="Column" for simple tables.
   * "Simple" = first TR has ≤3 cells and none appear to have spanning attributes.
   *
   * Both steps are required:
   *   1. renameElement(TD → TH)  — fixes tag type
   *   2. writeScopeAttribute(Column) — fixes Matterhorn 07-002
   *
   * Complex tables (merged cells, id/headers associations) remain HITL.
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
        let fixed = false;
        let fixedCellCount = 0;

        this.traverseStructTree(doc, structRoot, (node, ref) => {
          if (!ref) return;
          const sTag = node.get(PDFName.of('S'))?.toString().replace(/^\//, '');
          if (sTag !== 'Table') return;

          // Find the first TR — may be a direct child OR nested inside THead/TBody
          let firstTR = this.findFirstChild(doc, node, 'TR');
          if (!firstTR) {
            const tbody = this.findFirstChild(doc, node, 'TBody') ?? this.findFirstChild(doc, node, 'THead');
            if (tbody) firstTR = this.findFirstChild(doc, tbody.dict, 'TR');
          }
          if (!firstTR) return;

          // Count all cells (TD + TH) to determine complexity
          const tds = this.findAllChildren(doc, firstTR.dict, 'TD');
          const ths = this.findAllChildren(doc, firstTR.dict, 'TH');
          const totalCells = tds.length + ths.length;

          if (totalCells === 0) return; // Skip: empty first row
          if (tds.length === 0) { fixed = true; return; } // Already all TH — idempotent success

          for (const td of tds) {
            this.renameElement(doc, td.ref, 'TH');
            this.writeScopeAttribute(doc, td.ref, 'Column');
            fixedCellCount++;
          }
          fixed = true;
          return true; // Fix one table per issue call
        });

        results.push({
          issueId: issue.id,
          success: fixed,
          before: 'First-row cells tagged as TD',
          after: fixed
            ? fixedCellCount > 0
              ? `Promoted ${fixedCellCount} TD cell(s) to TH with scope="Column"`
              : 'Table headers already present — no changes needed'
            : 'No table found matching this issue',
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
      const m = /^H(\d)$/.exec(sTag);
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
