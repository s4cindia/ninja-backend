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

// Matches H1-H9 — pdf-lib's own PDFName round-trips heading tags as plain
// "H<digit>" strings once the leading "/" is stripped, same convention
// fixHeadingHierarchy uses to parse them. "H0" is deliberately excluded: it
// is not a valid PDF/UA structure type (H, H1-H6, informally H1-H9), unlike
// the bare "/H" tag which this regex also correctly excludes (not a digit).
const HEADING_TYPE_RE = /^H[1-9]$/;

export interface StructureTreeCompleteness {
  /** Total structure elements found (any /S value, at any depth). */
  totalElements: number;
  /** Elements whose /S is a real content type, not a grouping-only container. */
  semanticElements: number;
  /** Elements whose /S is H1-H9 (any heading level), at any depth. */
  headingElements: number;
  /** True structure tree exists, but zero elements carry any semantic (non-grouping) tag. */
  isEmptyShell: boolean;
  /**
   * True structure tree exists with SOME semantic content (isEmptyShell is
   * false) but carries zero heading tags anywhere. semanticElements lumps
   * every content type together, so a tree can clear the isEmptyShell bar on
   * a couple of Figure/P tags while having nothing fixHeadingHierarchy can
   * attach to. Confirmed on a real pilot document: 11 semantic elements (1
   * Figure, 10 P), 0 of any Hn type, across an 805-page book the heuristic
   * detector found 143 H1s in by scanning visible text/font size directly —
   * headings were simply never tagged, even though a handful of other
   * content was.
   *
   * Mutually exclusive with isEmptyShell by construction (requires
   * semanticElements > 0, which isEmptyShell requires to be 0).
   *
   * Same accepted tradeoff as isEmptyShell: a document that legitimately has
   * no headings (e.g. a single-page flyer, or a P-only document with no
   * section structure at all) will also read as isHeadingShell — there is
   * no way to distinguish "headings exist but weren't tagged" from
   * "headings genuinely don't exist" from the structure tree alone. The
   * retag decision this feeds happens before the accessibility audit runs
   * (accessibility.processor.ts), so no heuristic heading-detection signal
   * is available yet to cross-check against; doing so would require
   * reordering the pipeline (audit before retag), which is out of scope
   * here. In practice this is low-risk because prepareDocumentForRetag's
   * own all-or-nothing bail means a false-positive retag trigger can only
   * ever leave the tree unchanged or better, never worse.
   */
  isHeadingShell: boolean;
}

/**
 * Reads /StructTreeRoot's own /RoleMap, if any: a dict of custom tag name ->
 * standard tag name (PDF32000-1:2008 §14.7.4.3). A document that tags its
 * headings as a custom role (e.g. /Title -> /H1) would otherwise have them
 * invisible to both GROUPING_ONLY_TYPES and HEADING_TYPE_RE, which only ever
 * see the raw /S value. Small and duplicated locally rather than imported
 * from tagged-pdf-extractor.ts's own buildRoleMap — that module belongs to
 * an unrelated zone-extraction subsystem, and this file's own header already
 * establishes the project's preference for keeping structure-tree-walking
 * helpers isolated per-feature over cross-module coupling.
 */
function buildRoleMap(structTreeRoot: PDFDict, doc: PDFDocument): Map<string, string> {
  const roleMap = new Map<string, string>();
  const rmRaw = structTreeRoot.get(PDFName.of('RoleMap'));
  const rm = rmRaw instanceof PDFRef ? doc.context.lookup(rmRaw) : rmRaw;
  if (!(rm instanceof PDFDict)) return roleMap;

  for (const [key, value] of rm.entries()) {
    const customTag = key instanceof PDFName ? key.decodeText() : String(key);
    const stdTag = value instanceof PDFName ? value.decodeText() : null;
    if (stdTag) roleMap.set(customTag, stdTag);
  }
  return roleMap;
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

  const roleMap = buildRoleMap(structTreeRoot, doc);

  let totalElements = 0;
  let semanticElements = 0;
  let headingElements = 0;
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
        const rawType = s.toString().replace(/^\//, '');
        const type = roleMap.get(rawType) ?? rawType;
        totalElements++;
        if (!GROUPING_ONLY_TYPES.has(type)) semanticElements++;
        if (HEADING_TYPE_RE.test(type)) headingElements++;
      }
      const kids = node.get(PDFName.of('K'));
      if (kids) walk(kids, depth + 1);
    }
  }

  walk(structTreeRoot, 0);

  return {
    totalElements,
    semanticElements,
    headingElements,
    isEmptyShell: totalElements > 0 && semanticElements === 0,
    isHeadingShell: semanticElements > 0 && headingElements === 0,
  };
}
