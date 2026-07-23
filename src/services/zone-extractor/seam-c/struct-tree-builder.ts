import {
  PDFDocument, PDFName, PDFNumber, PDFRef, PDFArray, PDFDict, PDFRawStream, PDFObject,
  decodePDFRawStream,
} from 'pdf-lib';
import { synthesizeReadingOrder, type OrderableZone } from './reading-order';
import { tagOrderedZones, assembleHierarchy, type StructNode } from './hierarchy';
import { tagContentStream, type ZoneBand } from './content-stream';

// Seam C — Phase 2b/2c: build a /StructTreeRoot from detector zones.
//
// Given an untagged PDFDocument + its detected zones, this:
//   1. synthesizes reading order and assembles the container forest (Phase 1/2a),
//   2. for each page, rewrites the content stream with MCID marked content
//      (Phase 2c), assigning each zone's text a unique MCID,
//   3. writes a StructElem tree whose leaves' /K reference those MCIDs, plus
//      /MarkInfo, /ParentTree and per-page /StructParents.
//
// Coordinate reconciliation: detector bbox is top-left {x,y,w,h}; a page's
// content space is bottom-left, so a zone's device-space band is
// [H-(y+h), H-y] (yBottom..yTop), H = page height.
//
// Scope: the Phase-2 spike targets simple single-column PDFs (see content-stream.ts).

export interface BuildResult {
  elements: number;
  mcids: number;
  pages: number;
}

/** Decode a page's content stream(s) into a single string. */
function pageContent(doc: PDFDocument, pageNode: { get(n: PDFName): PDFObject | undefined }): string {
  const raw = pageNode.get(PDFName.of('Contents'));
  const resolve = (o: PDFObject | undefined): PDFObject | undefined =>
    o instanceof PDFRef ? doc.context.lookup(o) : o;
  const streams: PDFObject[] = [];
  const c = resolve(raw);
  if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) { const s = resolve(c.get(i)); if (s) streams.push(s); }
  else if (c) streams.push(c);

  const parts: string[] = [];
  for (const s of streams) {
    let bytes: Uint8Array | null = null;
    const anyS = s as unknown as { decode?: () => Uint8Array };
    if (typeof anyS.decode === 'function') { try { bytes = anyS.decode(); } catch { /* */ } }
    if (!bytes && s instanceof PDFRawStream) { try { bytes = decodePDFRawStream(s).decode(); } catch { /* */ } }
    if (bytes) parts.push(Buffer.from(bytes).toString('latin1'));
  }
  return parts.join('\n');
}

export function buildStructTreeFromZones(doc: PDFDocument, zones: OrderableZone[]): BuildResult {
  if (zones.length === 0) return { elements: 0, mcids: 0, pages: 0 };

  // Seam C only tags GENUINELY untagged PDFs. Running on a doc that already has a
  // /StructTreeRoot (and existing MCID marked content) would create duplicate /
  // nested MCIDs and two coexisting structure trees. The worker gates on
  // `!isTagged`; this is the defensive backstop.
  if (doc.catalog.get(PDFName.of('StructTreeRoot'))) {
    throw new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot');
  }

  const ordered = synthesizeReadingOrder(zones);
  const tagged = tagOrderedZones(ordered);
  const forest = assembleHierarchy(tagged);

  // zone → its resolved tag/mapping and a stable index
  const zoneMeta = new Map<OrderableZone, { tag: string; isArtifact: boolean; index: number }>();
  tagged.forEach((t, i) => zoneMeta.set(t.zone, { tag: t.tag, isArtifact: !!t.mapping.isArtifact, index: i }));

  const pages = doc.getPages();
  const pageByNumber = new Map<number, number>();     // 1-based zone pageNumber → 0-based doc index
  // detector page numbers are 1-based and align with doc page order
  pages.forEach((_, i) => pageByNumber.set(i + 1, i));

  // ── 2c: tag each page's content stream, collect zone → { pageIdx, mcids }
  const zoneMcids = new Map<number, { pageIdx: number; mcids: number[] }>(); // key = zone index
  const parentTree = new Map<number, PDFRef[]>();     // pageIdx → [elemRef by mcid]

  const zonesByPage = new Map<number, OrderableZone[]>();
  for (const z of zones) {
    const arr = zonesByPage.get(z.pageNumber); if (arr) arr.push(z); else zonesByPage.set(z.pageNumber, [z]);
  }

  for (const [pageNum, pageZones] of zonesByPage) {
    const pageIdx = pageByNumber.get(pageNum);
    if (pageIdx === undefined) continue;
    const page = pages[pageIdx];
    const H = page.getHeight();

    const bands: ZoneBand[] = pageZones.map((z) => {
      const m = zoneMeta.get(z)!;
      return {
        zoneIndex: m.index,
        yTop: H - z.bbox.y,
        yBottom: H - (z.bbox.y + z.bbox.h),
        tag: m.tag,
        isArtifact: m.isArtifact,
      };
    });

    const content = pageContent(doc, page.node);
    const { content: tagged2, assignments } = tagContentStream(content, bands, 0);

    // swap the page's content stream
    const newStream = doc.context.flateStream(Buffer.from(tagged2, 'latin1'));
    const newRef = doc.context.register(newStream);
    page.node.set(PDFName.of('Contents'), newRef);
    page.node.set(PDFName.of('StructParents'), PDFNumber.of(pageIdx));

    for (const a of assignments) {
      const rec = zoneMcids.get(a.zoneIndex);
      if (rec) rec.mcids.push(a.mcid);
      else zoneMcids.set(a.zoneIndex, { pageIdx, mcids: [a.mcid] });
    }
    parentTree.set(pageIdx, []);
  }

  // ── 2b: build the StructElem tree
  const rootObj = doc.context.obj({ Type: PDFName.of('StructTreeRoot') }) as PDFDict;
  const rootRef = doc.context.register(rootObj);
  const docObj = doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Document'), P: rootRef }) as PDFDict;
  const docRef = doc.context.register(docObj);
  rootObj.set(PDFName.of('K'), doc.context.obj([docRef]));

  let elemCount = 1; // Document
  let mcidCount = 0;

  const makeElem = (S: string, parentRef: PDFRef): { ref: PDFRef; dict: PDFDict } => {
    const dict = doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of(S), P: parentRef }) as PDFDict;
    const ref = doc.context.register(dict);
    elemCount++;
    return { ref, dict };
  };

  // Attach a leaf's MCID(s) as /K and register it in the ParentTree.
  const bindLeaf = (leafRef: PDFRef, leafDict: PDFDict, zone: OrderableZone): void => {
    const meta = zoneMeta.get(zone)!;
    const rec = zoneMcids.get(meta.index);
    if (!rec || rec.mcids.length === 0) return;
    const pageRef = pages[rec.pageIdx].ref;
    leafDict.set(PDFName.of('Pg'), pageRef);
    leafDict.set(
      PDFName.of('K'),
      rec.mcids.length === 1 ? PDFNumber.of(rec.mcids[0]) : doc.context.obj(rec.mcids.map((m) => PDFNumber.of(m))),
    );
    const slots = parentTree.get(rec.pageIdx)!;
    for (const m of rec.mcids) { slots[m] = leafRef; mcidCount++; }
  };

  const setKids = (dict: PDFDict, childRefs: PDFRef[]): void => {
    dict.set(PDFName.of('K'), doc.context.obj(childRefs as PDFObject[]));
  };

  // Recursively realize a forest node under `parentRef`; returns the created ref (or null for artifacts).
  const build = (node: StructNode, parentRef: PDFRef): PDFRef | null => {
    switch (node.kind) {
      case 'artifact':
        return null; // content already marked /Artifact; not in the /K flow
      case 'block': {
        const { ref, dict } = makeElem(node.tag, parentRef);
        bindLeaf(ref, dict, node.zone);
        return ref;
      }
      case 'table': {
        // coarse but valid: Table > TR > TD wrapping the region's content
        const table = makeElem('Table', parentRef);
        const tr = makeElem('TR', table.ref);
        const td = makeElem('TD', tr.ref);
        bindLeaf(td.ref, td.dict, node.zone);
        setKids(tr.dict, [td.ref]);
        setKids(table.dict, [tr.ref]);
        return table.ref;
      }
      case 'tocItem': {
        const { ref, dict } = makeElem('TOCI', parentRef);
        bindLeaf(ref, dict, node.zone);
        return ref;
      }
      case 'listItem': {
        const li = makeElem('LI', parentRef);
        const lbody = makeElem('LBody', li.ref);
        bindLeaf(lbody.ref, lbody.dict, node.zone);
        setKids(li.dict, [lbody.ref]);
        return li.ref;
      }
      case 'list': case 'toc': {
        const container = makeElem(node.kind === 'list' ? 'L' : 'TOC', parentRef);
        const kids: PDFRef[] = [];
        for (const child of node.children) { const r = build(child, container.ref); if (r) kids.push(r); }
        setKids(container.dict, kids);
        return container.ref;
      }
    }
  };

  const docKids: PDFRef[] = [];
  for (const node of forest) { const r = build(node, docRef); if (r) docKids.push(r); }
  setKids(docObj, docKids);

  // ── /ParentTree number tree (flat Nums: [key, [refs...], ...])
  const nums: PDFObject[] = [];
  for (const [pageIdx, slots] of [...parentTree.entries()].sort((a, b) => a[0] - b[0])) {
    const arr = slots.map((r) => (r ?? doc.context.obj({})) as PDFObject); // dense over MCIDs
    nums.push(PDFNumber.of(pageIdx), doc.context.obj(arr));
  }
  const parentTreeObj = doc.context.obj({ Nums: doc.context.obj(nums) });
  const parentTreeRef = doc.context.register(parentTreeObj);
  rootObj.set(PDFName.of('ParentTree'), parentTreeRef);
  rootObj.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(pages.length));

  // ── catalog: /StructTreeRoot + /MarkInfo <</Marked true>>
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));

  return { elements: elemCount, mcids: mcidCount, pages: zonesByPage.size };
}
