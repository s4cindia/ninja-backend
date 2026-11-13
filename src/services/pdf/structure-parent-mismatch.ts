/**
 * Structure-Element-Wrong-Parent Detection
 *
 * Real incident (Karsaklian_189165_9781606497623.pdf, round 15 -- the first
 * remediation round run after PR #821's float-interruption fix went live):
 * an independent PAC/veraPDF re-check flagged 49 instances of "Structure
 * element refers to a different parent than the actual parent" that this
 * codebase's own audit had zero coverage for. Root-caused directly: when
 * fixReadingOrderFloatInterruption relocates a struct element within the
 * /K tree (removeFromKids + insertIntoKidsAfter), it updated the /K arrays
 * correctly but never updated the relocated element's own /P back-
 * reference -- so the element's real tree position (found by walking /K
 * from the root) and its own stated /P disagreed. Confirmed via a direct
 * tree walk of the real remediated file: all 49 mismatches were exactly
 * the objects that fix had moved, across several Full Auto Mode rounds
 * (accumulating well beyond any single round's own count, since the same
 * missing update repeated every round). Fixed at the source (see
 * fixReadingOrderFloatInterruption's own doc comment), but that fix alone
 * doesn't retroactively repair a document already remediated before it
 * shipped -- this detector exists so the normal audit/apply cycle heals
 * any already-affected document, and so ANY future reparenting bug
 * (regardless of which fixer causes it) gets caught the same way, rather
 * than relying solely on an independent third-party PAC re-check to notice.
 *
 * Always unambiguously auto-fixable: there is exactly one correct value for
 * a struct element's /P -- whatever dict's own /K array actually, currently
 * contains it. No judgment call, unlike most of this file's siblings.
 *
 * findStructureParentMismatches is the single source of truth -- shared by
 * pdf-structure-parent-mismatch.validator.ts (maps each result to an
 * AuditIssue) and PdfStructureWriterService.fixStructureElementWrongParent
 * (re-runs this same function fresh at apply time), matching
 * reading-order-float.ts's own established convention for this codebase.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';

export interface StructureParentMismatch {
  /** The struct element whose own /P disagrees with its real tree position. */
  ref: PDFRef;
  tag: string;
  /** What the element's own /P currently says (always a real ref -- a missing/non-ref /P is a different, unrelated issue). */
  declaredParentRef: PDFRef;
  /** The dict that actually, currently contains ref in its own /K array. */
  actualParentRef: PDFRef;
  actualParentS: string;
  /** Best-effort representative page, for display only -- null when no MCID/Pg is reachable in this element's own subtree. */
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

export function findStructureParentMismatches(doc: PDFDocument): StructureParentMismatch[] {
  const structRoot = getStructTreeRoot(doc);
  const structRootRaw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!structRoot || !(structRootRaw instanceof PDFRef)) return [];

  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  const results: StructureParentMismatch[] = [];
  const visited = new Set<string>(); // cycle guard, keyed by "parentKey>childKey" is unnecessary -- a malformed tree with a true cycle back to an ancestor is bailed on via this per-node visit guard

  /** Strict chain only (own /Pg, else whatever a real ancestor /Pg already
   *  resolved to) -- the only form safe to propagate down as `inheritedPage`,
   *  since it reflects genuine page information, not a best-effort guess. */
  function ownOrInheritedPage(dict: PDFDict, inheritedPage: number | null): number | null {
    const pgRaw = dict.get(PDFName.of('Pg'));
    if (pgRaw instanceof PDFRef) {
      const p = pageByRef.get(pgRaw.toString());
      if (p !== undefined) return p;
    }
    return inheritedPage;
  }

  /** Display-only page for ONE specific mismatch record -- same as above,
   *  plus a last-resort descendant scan. Never propagated to other nodes:
   *  a fallback guess for THIS element says nothing about any sibling's
   *  own real page. */
  function displayPage(dict: PDFDict, inheritedPage: number | null): number | null {
    const strict = ownOrInheritedPage(dict, inheritedPage);
    if (strict !== null) return strict;
    return findAnyDescendantPage(dict, 0);
  }

  /** A thin wrapper (e.g. a Story with no /Pg of its own, just one child
   *  carrying it) has no inherited page either -- descend into its own
   *  subtree far enough to find one, for display purposes only. Capped
   *  depth, not memoized: only reached for the rare mismatch whose own
   *  chain of ancestors-so-far never had a /Pg at all. */
  function findAnyDescendantPage(dict: PDFDict, depth: number): number | null {
    if (depth > 20) return null;
    const kRaw = dict.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    const children: PDFRef[] = [];
    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) if (item instanceof PDFRef) children.push(item);
    } else if (kRaw instanceof PDFRef) {
      children.push(kRaw);
    }
    for (const childRef of children) {
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
    const kRaw = parentDict.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    const children: PDFRef[] = [];
    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) if (item instanceof PDFRef) children.push(item);
    } else if (kRaw instanceof PDFRef) {
      children.push(kRaw);
    }

    for (const childRef of children) {
      const childDict = doc.context.lookup(childRef);
      if (!(childDict instanceof PDFDict)) continue;
      const sRaw = childDict.get(PDFName.of('S'));
      if (sRaw === undefined) continue; // an MCR/OBJR dict, not a struct element -- no /P to check

      const pRaw = childDict.get(PDFName.of('P'));
      if (pRaw instanceof PDFRef && pRaw.objectNumber !== parentRef.objectNumber) {
        results.push({
          ref: childRef,
          tag: nameStr(sRaw) ?? 'Unknown',
          declaredParentRef: pRaw,
          actualParentRef: parentRef,
          actualParentS: nameStr(parentDict.get(PDFName.of('S'))) ?? 'Unknown',
          page: displayPage(childDict, ownPage),
        });
      }

      walk(childRef, childDict, ownPage);
    }
  }

  walk(structRootRaw, structRoot, null);
  return results;
}
