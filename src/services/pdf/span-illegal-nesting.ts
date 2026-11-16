/**
 * Span-As-Parent Illegal Nesting Detection
 *
 * S4 QC Round 3 finding on Karsaklian_189165_9781606497623.pdf (2026-11-17,
 * "Not Resolved" since an earlier round): "child Span tags incorrectly
 * placed as parent elements." Per ISO 32000-1 Table 332 (the PDF/UA-1
 * structure-type categories) /Span is an INLINE-level element -- its legal
 * content is text and other inline-level content, never a Grouping,
 * Block-level, or Illustration element. A /Span that directly contains a
 * /P, a heading, a /Table, a /Figure etc. is exactly the shape S4 flagged:
 * the producer (commonly InDesign/Word on export) used Span purely for
 * inline character styling and nested real block content inside it by
 * mistake, rather than placing that content as a proper sibling.
 *
 * S4's R2 QC (PRs #809-824) never covered this -- confirmed via exhaustive
 * grep across src/services/pdf/** for "Span.*parent"/"illegal"/"nesting"/
 * "hierarchy": no validator anywhere checks struct-tree parent/child TYPE
 * legality. pdf-structure-parent-mismatch.validator.ts looks similar by
 * name but checks something unrelated (a child's /P back-reference vs its
 * real tree position -- referential integrity, not type legality).
 *
 * Scope, deliberately narrow (same "auto-fix the clean case, flag the rest"
 * posture as every other partial fixer in this codebase):
 *   - Only /Span is checked (not the other inline-level types -- Quote,
 *     Note, Reference, BibEntry, Code, Link, Annot -- since S4's own
 *     finding named Span specifically; extending to the others is a
 *     separate decision, not bundled in here on a guess).
 *   - autoFixable only when EVERY one of the Span's own children is an
 *     illegal (Grouping/Block-level/Illustration) struct element -- i.e.
 *     dissolving the Span strands no legitimate inline content. A Span
 *     with a MIX of illegal and legitimate children (real inline text/
 *     MCR content alongside a wrongly-nested block element) is still
 *     flagged, for visibility, but never auto-fixed: splitting the Span's
 *     own content is a judgment call, not a mechanical operation.
 *   - autoFixable also requires the Span's OWN actual parent to be a type
 *     that can legally hold the dissolved children directly (a Grouping
 *     type, or the StructTreeRoot itself) -- otherwise dissolving the Span
 *     would just relocate the illegality one level up (e.g. a /P
 *     containing a /Span containing an /H1: promoting the /H1 to be a
 *     direct child of /P is equally illegal, since /P is Block-level too).
 *     That shape is flagged, not auto-fixed.
 *
 * findSpanIllegalNestingViolations is the single source of truth -- shared
 * by pdf-span-illegal-nesting.validator.ts (maps each result to an
 * AuditIssue) and PdfStructureWriterService.fixSpanIllegalNesting (re-runs
 * this same function fresh at apply time), matching structure-parent-
 * mismatch.ts's own established convention for this codebase.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';

/** ISO 32000-1 Table 332 structure-type categories (relevant subset -- see
 *  this file's own header for why only Span is actually checked today). */
const GROUPING_TYPES = new Set(['Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private']);
const BLOCK_LEVEL_TYPES = new Set(['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot']);
const ILLUSTRATION_TYPES = new Set(['Figure', 'Formula', 'Form']);
const ILLEGAL_AS_SPAN_CHILD = new Set([...GROUPING_TYPES, ...BLOCK_LEVEL_TYPES, ...ILLUSTRATION_TYPES]);

export interface SpanIllegalNestingViolation {
  spanRef: PDFRef;
  /** The Span's real, current parent (walked from the tree, not trusted via /P). */
  parentRef: PDFRef;
  /** undefined when the parent is the StructTreeRoot itself (no /S). */
  parentS: string | undefined;
  /** The Span's own illegal (Grouping/Block-level/Illustration) struct children, in document order. */
  illegalChildRefs: PDFRef[];
  illegalChildTags: string[];
  /** True only when the Span has no OTHER (legitimate) children beside the illegal ones, AND parentS allows holding them directly. */
  autoFixable: boolean;
  page: number | null;
}

function getStructTreeRoot(doc: PDFDocument): PDFDict | undefined {
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function nameStr(n: ReturnType<PDFDict['get']>): string | undefined {
  return n ? n.toString().replace(/^\//, '') : undefined;
}

function childRefsOf(doc: PDFDocument, dict: PDFDict): PDFRef[] {
  const kRaw = dict.get(PDFName.of('K'));
  const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
  const refs: PDFRef[] = [];
  if (kResolved instanceof PDFArray) {
    for (const item of kResolved.asArray()) if (item instanceof PDFRef) refs.push(item);
  } else if (kRaw instanceof PDFRef) {
    refs.push(kRaw);
  }
  return refs;
}

export function findSpanIllegalNestingViolations(doc: PDFDocument): SpanIllegalNestingViolation[] {
  const structRoot = getStructTreeRoot(doc);
  const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structRoot || !(structRootRaw instanceof PDFRef)) return [];

  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  const results: SpanIllegalNestingViolation[] = [];
  const visited = new Set<string>();

  function ownOrInheritedPage(dict: PDFDict, inheritedPage: number | null): number | null {
    const pgRaw = dict.get(PDFName.of('Pg'));
    if (pgRaw instanceof PDFRef) {
      const p = pageByRef.get(pgRaw.toString());
      if (p !== undefined) return p;
    }
    return inheritedPage;
  }

  function findAnyDescendantPage(dict: PDFDict, depth: number): number | null {
    if (depth > 20) return null;
    for (const childRef of childRefsOf(doc, dict)) {
      const childDict = doc.context.lookup(childRef);
      if (!(childDict instanceof PDFDict)) continue;
      const pgRaw = childDict.get(PDFName.of('Pg'));
      if (pgRaw instanceof PDFRef) {
        const p = pageByRef.get(pgRaw.toString());
        if (p !== undefined) return p;
      }
      const deeper = findAnyDescendantPage(childDict, depth + 1);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  function walk(parentRef: PDFRef, parentDict: PDFDict, inheritedPage: number | null): void {
    const key = parentRef.toString();
    if (visited.has(key)) return;
    visited.add(key);

    const ownPage = ownOrInheritedPage(parentDict, inheritedPage);
    const children = childRefsOf(doc, parentDict);

    for (const childRef of children) {
      const childDict = doc.context.lookup(childRef);
      if (!(childDict instanceof PDFDict)) continue;
      const sRaw = childDict.get(PDFName.of('S'));
      if (sRaw === undefined) {
        walk(childRef, childDict, ownPage);
        continue;
      }
      const tag = nameStr(sRaw);

      if (tag === 'Span') {
        const spanChildren = childRefsOf(doc, childDict);
        const illegalChildRefs: PDFRef[] = [];
        const illegalChildTags: string[] = [];
        let hasLegitimateChild = false;

        for (const spanChildRef of spanChildren) {
          const spanChildDict = doc.context.lookup(spanChildRef);
          const spanChildS = spanChildDict instanceof PDFDict ? nameStr(spanChildDict.get(PDFName.of('S'))) : undefined;
          if (spanChildS && ILLEGAL_AS_SPAN_CHILD.has(spanChildS)) {
            illegalChildRefs.push(spanChildRef);
            illegalChildTags.push(spanChildS);
          } else {
            hasLegitimateChild = true;
          }
        }

        if (illegalChildRefs.length > 0) {
          const parentS = nameStr(parentDict.get(PDFName.of('S')));
          const parentIsLegalContainer = parentDict === structRoot || GROUPING_TYPES.has(parentS ?? '');
          results.push({
            spanRef: childRef,
            parentRef,
            parentS,
            illegalChildRefs,
            illegalChildTags,
            autoFixable: !hasLegitimateChild && parentIsLegalContainer,
            page: (() => {
              const strict = ownOrInheritedPage(childDict, ownPage);
              return strict !== null ? strict : findAnyDescendantPage(childDict, 0);
            })(),
          });
        }
      }

      walk(childRef, childDict, ownPage);
    }
  }

  walk(structRootRaw, structRoot, null);
  return results;
}
