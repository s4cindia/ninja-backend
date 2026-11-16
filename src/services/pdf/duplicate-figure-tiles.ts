/**
 * Duplicate Figure Tile Detection
 *
 * S4 QC Round 3 finding on Karsaklian_189165_9781606497623.pdf (2026-11-17):
 * "In some instances, a single image was tagged with two separate Figure
 * tags and contained duplicate alternative text descriptions." PR #809
 * already fixed ONE mechanism behind this shape (a reused XObject
 * resource's 2nd/3rd on-page occurrence resolving to the wrong MCID/Figure
 * -- see image-extractor.service.ts/pdf-modifier.service.ts's own
 * mcidForXObject). This is the OTHER, still-open mechanism, documented but
 * never fixed (see memory: a single semantic image composited from
 * multiple XObject tiles, via buildFigureFromImage, gets one /Figure per
 * tile rather than one /Figure for the whole image -- "honestly flagged as
 * a byproduct, not a designed outcome").
 *
 * Rather than touching buildFigureFromImage or image-extractor.service.ts
 * upstream (risking the many other things that already consume their
 * output), this detects and heals the symptom directly in an
 * already-tagged struct tree -- the same "retroactively heals any
 * already-affected document" posture as structure-parent-mismatch.ts.
 *
 * Detection requires BOTH signals S4's own finding names together, kept
 * deliberately conservative to avoid merging two genuinely different,
 * merely adjacent figures (e.g. a two-panel spread):
 *   1. Same immediate struct-tree parent, same page.
 *   2. Bounding boxes adjacent or overlapping (within a small tolerance --
 *      tiles of one image sit edge-to-edge or slightly overlapping).
 *   3. Identical, non-empty /Alt text -- an author/AI describing two
 *      genuinely different images essentially never produces byte-
 *      identical alt text; this is the strongest signal this really is
 *      one image, duplicated.
 *
 * Reuses extractStructureTagsForPage (structure-tag-inventory.service.ts,
 * this session's own Structure Tag QC Review feature) for page-filtered
 * Figure bounding boxes rather than re-deriving MCID geometry -- same
 * "don't invent a new technique" posture that file's own header documents.
 *
 * findDuplicateFigureTiles is the single source of truth -- shared by
 * pdf-duplicate-figure-tiles.validator.ts (maps each result to an
 * AuditIssue) and PdfStructureWriterService.fixDuplicateFigureTiles
 * (re-runs this same function fresh at apply time).
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } from 'pdf-lib';
import { extractStructureTagsForPage, resolveElementRef } from './structure-tag-inventory.service';
import type { StructureTagBoundingBox } from './structure-tag-inventory.service';

const ADJACENCY_TOLERANCE_PT = 3;

export interface DuplicateFigureTileGroup {
  pageNumber: number;
  parentRef: PDFRef;
  parentS: string | undefined;
  /** First in the parent's real /K order -- the surviving Figure. */
  primaryRef: PDFRef;
  /** The other Figures in this group -- merged into primary, then removed. */
  duplicateRefs: PDFRef[];
  altText: string;
}

function readAltText(dict: PDFDict): string | null {
  const raw = dict.get(PDFName.of('Alt'));
  if (raw instanceof PDFString || raw instanceof PDFHexString) {
    const text = raw.decodeText().trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** Axis-aligned-bounding-box adjacency/overlap test, in the same top-left-
 *  origin convention structure-tag-inventory.service.ts's own bbox already
 *  uses. Expanding `a` by `tolerance` on every side before intersecting
 *  treats a near-touching gap (tile seams are rarely byte-exact) the same
 *  as a genuine overlap, without needing a separate "touching" test. */
function boxesAdjacentOrOverlapping(a: StructureTagBoundingBox, b: StructureTagBoundingBox, tolerance: number): boolean {
  const aMinX = a.x - tolerance, aMaxX = a.x + a.width + tolerance;
  const aMinY = a.y - tolerance, aMaxY = a.y + a.height + tolerance;
  const bMinX = b.x, bMaxX = b.x + b.width;
  const bMinY = b.y, bMaxY = b.y + b.height;
  return aMinX < bMaxX && aMaxX > bMinX && aMinY < bMaxY && aMaxY > bMinY;
}

function getStructTreeRoot(doc: PDFDocument): { ref: PDFRef; dict: PDFDict } | undefined {
  const raw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  if (!(raw instanceof PDFRef)) return undefined;
  const resolved = doc.context.lookup(raw);
  return resolved instanceof PDFDict ? { ref: raw, dict: resolved } : undefined;
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

/** Maps every /Figure struct element's own ref -> its real, current parent
 *  (walked from the tree, not trusted via /P), for the whole document. */
function findFigureParents(doc: PDFDocument): Map<string, { parentRef: PDFRef; parentDict: PDFDict }> {
  const root = getStructTreeRoot(doc);
  const result = new Map<string, { parentRef: PDFRef; parentDict: PDFDict }>();
  if (!root) return result;

  const visited = new Set<string>();
  function walk(parentRef: PDFRef, parentDict: PDFDict): void {
    const key = parentRef.toString();
    if (visited.has(key)) return;
    visited.add(key);
    for (const childRef of childRefsOf(doc, parentDict)) {
      const childDict = doc.context.lookup(childRef);
      if (!(childDict instanceof PDFDict)) continue;
      const sRaw = childDict.get(PDFName.of('S'));
      if (sRaw === undefined) continue;
      if (sRaw.toString().replace(/^\//, '') === 'Figure') {
        result.set(childRef.toString(), { parentRef, parentDict });
      }
      walk(childRef, childDict);
    }
  }
  walk(root.ref, root.dict);
  return result;
}

export function findDuplicateFigureTiles(doc: PDFDocument): DuplicateFigureTileGroup[] {
  const figureParents = findFigureParents(doc);
  if (figureParents.size === 0) return [];

  const results: DuplicateFigureTileGroup[] = [];
  const pageCount = doc.getPageCount();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const figuresOnPage = extractStructureTagsForPage(doc, pageNumber).filter(e => e.tag === 'Figure');
    if (figuresOnPage.length < 2) continue;

    interface Entry {
      ref: PDFRef;
      bbox: StructureTagBoundingBox;
      altText: string | null;
      parentKey: string;
      parentRef: PDFRef;
      parentDict: PDFDict;
    }
    const entries: Entry[] = [];
    for (const f of figuresOnPage) {
      const ref = resolveElementRef(doc, f.elementId);
      if (!ref) continue;
      const parentInfo = figureParents.get(ref.toString());
      if (!parentInfo) continue;
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      entries.push({
        ref,
        bbox: f.bbox,
        altText: readAltText(dict),
        parentKey: parentInfo.parentRef.toString(),
        parentRef: parentInfo.parentRef,
        parentDict: parentInfo.parentDict,
      });
    }

    const parentIdx = entries.map((_, i) => i);
    const find = (i: number): number => (parentIdx[i] === i ? i : (parentIdx[i] = find(parentIdx[i])));
    const union = (i: number, j: number): void => {
      const a = find(i), b = find(j);
      if (a !== b) parentIdx[a] = b;
    };

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        if (a.parentKey !== b.parentKey) continue;
        if (!a.altText || !b.altText || a.altText !== b.altText) continue;
        if (!boxesAdjacentOrOverlapping(a.bbox, b.bbox, ADJACENCY_TOLERANCE_PT)) continue;
        union(i, j);
      }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < entries.length; i++) {
      const root = find(i);
      const list = groups.get(root) ?? [];
      list.push(i);
      groups.set(root, list);
    }

    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      const groupEntries = indices.map(i => entries[i]);
      const parentRef = groupEntries[0].parentRef;
      const parentDict = groupEntries[0].parentDict;
      const orderedChildKeys = childRefsOf(doc, parentDict).map(r => r.toString());
      groupEntries.sort((x, y) => orderedChildKeys.indexOf(x.ref.toString()) - orderedChildKeys.indexOf(y.ref.toString()));

      const parentSRaw = parentDict.get(PDFName.of('S'));
      results.push({
        pageNumber,
        parentRef,
        parentS: parentSRaw ? parentSRaw.toString().replace(/^\//, '') : undefined,
        primaryRef: groupEntries[0].ref,
        duplicateRefs: groupEntries.slice(1).map(e => e.ref),
        altText: groupEntries[0].altText!,
      });
    }
  }

  return results;
}
