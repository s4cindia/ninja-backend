/**
 * Structure Tag QC Review — per-page structure-element inventory.
 *
 * Backs the operator-facing "Review structure tags" page-by-page QC mode
 * (gated by the Full QC toggle, see resolveFullQC in
 * auto-remediation-loop.service.ts): walks a page's /StructTreeRoot subtree
 * and returns EVERY structure element on that page with its current tag and
 * a top-left-origin bounding box -- not just elements an audit issue
 * already flagged.
 *
 * Deliberately reuses existing geometry primitives rather than inventing a
 * new technique: the same locateMcidBoundingBoxes (mcid-bounding-box.ts)
 * device-space MCID walk that pdf-figure-structtree.validator.ts already
 * uses for Figure bounding boxes, and the same device->top-left flip
 * (`pageHeight - box.maxY`) that validator already performs -- this keeps
 * bbox output on the SAME convention PdfPreviewPanel.tsx already renders
 * for AuditIssue.boundingBox.
 *
 * `elementId` has no persisted identity of its own -- it's the struct
 * element's own PDFRef serialized as "{objectNumber}-{generationNumber}",
 * re-resolved fresh against the current buffer on every request (no
 * in-memory session state), consistent with how every existing structure
 * fixer in pdf-structure-writer.service.ts already re-locates elements per
 * call. This stays stable across a retag, since renameElement only mutates
 * an element's own /S entry and never its ref identity.
 *
 * textSnippet (declared in the response shape, per the design plan) is NOT
 * populated by this first pass -- deriving real text per element requires a
 * separate Tj/TJ-aware content-stream walk this pass didn't build; left as
 * a documented, optional gap rather than a half-built approximation.
 */

import { PDFDocument, PDFDict, PDFArray, PDFRef, PDFName, PDFNumber } from 'pdf-lib';
import { decodePageContent } from './pdf-content-stream-io';
import { locateMcidBoundingBoxes } from './mcid-bounding-box';
import { buildFormXObjectResolver } from './validators/pdf-figure-structtree.validator';

/** The full PDF/UA structure-type vocabulary this feature lets an operator
 * retag into -- the user chose "any legal PDF/UA tag", not a narrowed
 * Matterhorn-relevant subset (design decision, 2026-11-16). Per
 * PDF32000-1:2008 Table 333/334/337 standard structure types. */
export const PDF_UA_STRUCTURE_TAGS = [
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index',
  'NonStruct', 'Private',
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Figure', 'Formula', 'Form', 'Artifact',
] as const;
export type PdfUaStructureTag = typeof PDF_UA_STRUCTURE_TAGS[number];
const VALID_TAGS: ReadonlySet<string> = new Set(PDF_UA_STRUCTURE_TAGS);

export function isValidStructureTag(tag: string): tag is PdfUaStructureTag {
  return VALID_TAGS.has(tag);
}

export interface StructureTagBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

export interface StructureTagElement {
  elementId: string;
  tag: string;
  pageNumber: number;
  bbox: StructureTagBoundingBox;
  /** Not populated by this pass -- see this file's own header comment. */
  textSnippet?: string;
  parentElementId?: string;
}

interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

function getStructTreeRoot(doc: PDFDocument): PDFDict | undefined {
  const raw = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function elementIdForRef(ref: PDFRef): string {
  return `${ref.objectNumber}-${ref.generationNumber}`;
}

/** Builds the page-ref -> {pageNumber, width, height} map every lookup in
 * this file needs, once per call -- mirrors
 * pdf-figure-structtree.validator.ts's own identical pageByRef construction. */
export function buildPageByRef(doc: PDFDocument): Map<string, PageInfo> {
  const pageByRef = new Map<string, PageInfo>();
  doc.getPages().forEach((page, i) => {
    const { width, height } = page.getSize();
    pageByRef.set(page.ref.toString(), { pageNumber: i + 1, width, height });
  });
  return pageByRef;
}

/**
 * Resolves an elementId (as emitted by extractStructureTagsForPage) back to
 * a live PDFRef pointing at a real structure element (has its own /S) in
 * the given document -- returns null for a malformed id, a dangling ref, or
 * a ref that doesn't actually point at a structure element.
 */
export function resolveElementRef(doc: PDFDocument, elementId: string): PDFRef | null {
  const match = /^(\d+)-(\d+)$/.exec(elementId);
  if (!match) return null;
  const ref = PDFRef.of(parseInt(match[1], 10), parseInt(match[2], 10));
  const node = doc.context.lookup(ref);
  if (!(node instanceof PDFDict)) return null;
  return node.get(PDFName.of('S')) !== undefined ? ref : null;
}

/**
 * Resolves which page a structure element lives on by walking its own /Pg
 * (if present) or climbing its required /P parent chain until one is found
 * -- bounded depth (32) as a recursion-safety guard, not a discovered data
 * boundary, mirroring collectLeafMcids's own bound in
 * pdf-structure-writer.service.ts. Needed by the retag endpoint, which only
 * receives an elementId (no page number) in its request body.
 */
export function resolveElementPageNumber(doc: PDFDocument, ref: PDFRef, pageByRef: Map<string, PageInfo>): number | null {
  let current: PDFDict | undefined = (doc.context.lookup(ref) instanceof PDFDict) ? (doc.context.lookup(ref) as PDFDict) : undefined;
  let depth = 0;
  while (current && depth < 32) {
    const pg = current.get(PDFName.of('Pg'));
    if (pg instanceof PDFRef) {
      const info = pageByRef.get(pg.toString());
      if (info) return info.pageNumber;
    }
    const parent = current.get(PDFName.of('P'));
    current = parent instanceof PDFRef && doc.context.lookup(parent) instanceof PDFDict
      ? (doc.context.lookup(parent) as PDFDict)
      : undefined;
    depth++;
  }
  return null;
}

/**
 * Recursively collects every leaf MCID under `node`'s own content that
 * belongs to `ownPageRef` -- a bare MCID number, an MCR dict's /MCID
 * (matching only when its own /Pg, if present, agrees with ownPageRef), OR
 * (recursing further) a nested struct element's own /K -- so an ancestor
 * like Table aggregates every descendant TR/TH/TD's content into one bbox.
 * An OBJR dict (annotation reference, no /K) naturally contributes nothing.
 * Mirrors the MCR-vs-nested-struct-element distinction
 * pdf-structure-writer.service.ts's own subtreeContainsMcid already makes.
 */
function collectMcidsOnPage(doc: PDFDocument, node: unknown, ownPageRef: PDFRef | undefined, depth: number, out: number[]): void {
  if (depth > 8) return;
  const resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;
  if (resolved instanceof PDFArray) {
    for (const item of resolved.asArray()) collectMcidsOnPage(doc, item, ownPageRef, depth + 1, out);
    return;
  }
  if (resolved instanceof PDFNumber) {
    out.push(resolved.asNumber());
    return;
  }
  if (!(resolved instanceof PDFDict)) return;

  const mcidVal = resolved.get(PDFName.of('MCID'));
  const isNestedStructElement = resolved.get(PDFName.of('S')) !== undefined;
  if (mcidVal instanceof PDFNumber && !isNestedStructElement) {
    const pgVal = resolved.get(PDFName.of('Pg'));
    const effectivePageRef = pgVal instanceof PDFRef ? pgVal : ownPageRef;
    if (!ownPageRef || !effectivePageRef || effectivePageRef.toString() === ownPageRef.toString()) {
      out.push(mcidVal.asNumber());
    }
    return;
  }

  const k = resolved.get(PDFName.of('K'));
  if (k !== undefined) collectMcidsOnPage(doc, k, ownPageRef, depth + 1, out);
}

interface PendingElement {
  ref: PDFRef;
  tag: string;
  pageNumber: number;
  parentElementId?: string;
  mcids: number[];
}

/**
 * Walks the ENTIRE struct tree once (same cost precedent as
 * pdf-figure-structtree.validator.ts's own single full-document walk) and
 * returns every structure element whose content resolves onto
 * `targetPageNumber`, each with a real bounding box -- an element with no
 * MCID content at all, or whose MCIDs produce no real drawn geometry
 * (mcid-bounding-box.ts's own "nothing found" contract), is omitted rather
 * than fabricated, matching this codebase's existing convention elsewhere.
 */
export function extractStructureTagsForPage(doc: PDFDocument, targetPageNumber: number): StructureTagElement[] {
  const root = getStructTreeRoot(doc);
  if (!root) return [];

  const pageByRef = buildPageByRef(doc);
  const pageInfoFor = (pgEntry: unknown): PageInfo | undefined =>
    pgEntry instanceof PDFRef ? pageByRef.get(pgEntry.toString()) : undefined;

  const pending: PendingElement[] = [];
  const seen = new Set<string>();

  const visit = (nodeRef: unknown, inheritedPageRef: PDFRef | undefined, parentElementId: string | undefined): void => {
    if (nodeRef instanceof PDFRef) {
      const key = nodeRef.toString();
      if (seen.has(key)) return;
      seen.add(key);
    }
    const node = nodeRef instanceof PDFRef ? doc.context.lookup(nodeRef) : nodeRef;

    if (node instanceof PDFArray) {
      for (const item of node.asArray()) visit(item, inheritedPageRef, parentElementId);
      return;
    }
    if (!(node instanceof PDFDict)) return;

    const pgVal = node.get(PDFName.of('Pg'));
    const ownPageRef = pgVal instanceof PDFRef ? pgVal : inheritedPageRef;

    const sVal = node.get(PDFName.of('S'));
    let ownElementId: string | undefined;
    if (sVal !== undefined && nodeRef instanceof PDFRef) {
      const pageInfo = pageInfoFor(ownPageRef);
      if (pageInfo) {
        const tag = sVal.toString().replace(/^\//, '');
        const mcids: number[] = [];
        const k = node.get(PDFName.of('K'));
        if (k !== undefined) collectMcidsOnPage(doc, k, ownPageRef, 0, mcids);
        ownElementId = elementIdForRef(nodeRef);
        pending.push({ ref: nodeRef, tag, pageNumber: pageInfo.pageNumber, parentElementId, mcids });
      }
    }

    const k = node.get(PDFName.of('K'));
    if (k !== undefined) visit(k, ownPageRef, ownElementId ?? parentElementId);
  };

  visit(root, undefined, undefined);

  const onThisPage = pending.filter(p => p.pageNumber === targetPageNumber && p.mcids.length > 0);
  if (onThisPage.length === 0) return [];

  const content = decodePageContent(doc, targetPageNumber);
  if (!content) return [];

  const allMcids = new Set<number>();
  for (const p of onThisPage) for (const mcid of p.mcids) allMcids.add(mcid);

  const boxes = locateMcidBoundingBoxes(content, allMcids, {
    resolveFormXObject: buildFormXObjectResolver(doc, targetPageNumber),
  });
  const { width: pageWidth, height: pageHeight } = doc.getPage(targetPageNumber - 1).getSize();

  const results: StructureTagElement[] = [];
  for (const p of onThisPage) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const mcid of p.mcids) {
      const box = boxes.get(mcid);
      if (!box) continue;
      if (box.minX < minX) minX = box.minX;
      if (box.minY < minY) minY = box.minY;
      if (box.maxX > maxX) maxX = box.maxX;
      if (box.maxY > maxY) maxY = box.maxY;
    }
    if (minX > maxX || minY > maxY) continue;

    results.push({
      elementId: elementIdForRef(p.ref),
      tag: p.tag,
      pageNumber: p.pageNumber,
      bbox: { x: minX, y: pageHeight - maxY, width: maxX - minX, height: maxY - minY, pageWidth, pageHeight },
      parentElementId: p.parentElementId,
    });
  }
  return results;
}
