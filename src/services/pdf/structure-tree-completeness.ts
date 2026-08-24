/**
 * Structure Tree Completeness Check
 *
 * Both of Ninja's "should we trust the existing structure tree?" gates —
 * the worker's isTagged pre-check and Seam C's own SEAM_C_ALREADY_TAGGED
 * backstop (struct-tree-builder.ts) — answer that question with a pure
 * presence check: does /StructTreeRoot exist at all. Found via a real
 * pilot document that presence check can pass on a tree that is
 * structurally real but semantically empty — every one of its elements
 * tagged as a generic grouping type (/Part, /Div, /Sect) with none of the
 * content-bearing types (/Figure, /P, /H1-6, /Table, ...) that writers
 * like setAltText actually need to attach to. Alt-text apply then fails
 * document-wide with "no Figure elements", which reads as a bug in the
 * writer when the real cause is upstream: nothing to trust was ever tagged
 * in the first place.
 *
 * This module only measures — it never modifies the tree or decides
 * whether to re-tag. Read-only by design, so it's safe to call from
 * anywhere without touching the protected Seam C tagging pipeline.
 */

import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRef } from 'pdf-lib';

// Grouping/container structure types carry no content-type meaning of
// their own — they only organize other elements. A tree built entirely
// from these (plus /Document, the tree's own root wrapper) has nothing an
// alt-text, table-header, or heading-structure writer can attach to.
const GROUPING_ONLY_TYPES = new Set(['Document', 'Part', 'Div', 'Sect', 'Art', 'NonStruct', 'Private']);

export interface StructureTreeCompleteness {
  /** Total structure elements found (any /S value, at any depth). */
  totalElements: number;
  /** Elements whose /S is a real content type, not a grouping-only container. */
  semanticElements: number;
  /** True structure tree exists, but zero elements carry any semantic (non-grouping) tag. */
  isEmptyShell: boolean;
}

/**
 * Walks the full structure tree from its root, classifying every element's
 * /S value as semantic or grouping-only. Returns null when there's no
 * /StructTreeRoot at all — that's a different, already-detected case
 * (isTagged/SEAM_C_ALREADY_TAGGED both check for this), not what this
 * module measures.
 */
export function checkStructureTreeCompleteness(doc: PDFDocument): StructureTreeCompleteness | null {
  const structTreeRootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structTreeRootRef) return null;

  const structTreeRoot = doc.context.lookup(structTreeRootRef);
  if (!(structTreeRoot instanceof PDFDict)) return null;

  let totalElements = 0;
  let semanticElements = 0;
  const visited = new Set<string>();

  function walk(node: unknown, depth: number): void {
    if (depth > 100) return; // defensive — malformed/cyclic trees shouldn't hang this
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
      const s = node.get(PDFName.of('S'));
      if (s) {
        totalElements++;
        if (!GROUPING_ONLY_TYPES.has(s.toString().replace(/^\//, ''))) semanticElements++;
      }
      const kids = node.get(PDFName.of('K'));
      if (kids) walk(kids, depth + 1);
    }
  }

  walk(structTreeRoot, 0);

  return {
    totalElements,
    semanticElements,
    isEmptyShell: totalElements > 0 && semanticElements === 0,
  };
}
