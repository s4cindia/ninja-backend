/**
 * Regression coverage for buildFigureFromImage: builds a real /Figure struct
 * element + MCID + /ParentTree wiring for a genuinely-untagged image, using
 * figure-content-tagger.ts's locateXObjectInvocation/findNearestMcidForPosition
 * to find the image's real Do-invocation and a nearby already-tagged struct
 * element to anchor placement near via the existing insertIntoKidsAfter.
 *
 * Every synthetic fixture here draws REAL text + a REAL embedded image via
 * pdf-lib, then tags ONLY the text (via Seam-C's buildStructTreeFromZones,
 * the same real from-scratch tagger used elsewhere in this codebase's own
 * test suite) so the image is left genuinely untagged -- the exact real-world
 * shape this method targets (confirmed live: 54/224 real Math_Kim images).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFNumber, PDFNull } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

function decodeContent(doc: PDFDocument): string {
  return decodePageContent(doc, 1) ?? '';
}

function tagOf(dict: unknown): string | undefined {
  return dict instanceof PDFDict ? dict.get(PDFName.of('S'))?.toString().replace(/^\//, '') : undefined;
}

/** Builds a real page: tagged paragraph text (via buildStructTreeFromZones) + one untagged embedded image. Saves to a real temp file so pdfParserService.parse can load it (findNearestMcidForPosition needs a real ParsedPDF/pdfjs handle). */
async function buildDocWithTaggedTextAndUntaggedImage(): Promise<{
  doc: PDFDocument;
  parsedPdf: Awaited<ReturnType<typeof pdfParserService.parse>>;
  xObjectName: string;
  tmpPath: string;
}> {
  const src = await PDFDocument.create();
  const srcPage = src.addPage([400, 600]);
  srcPage.drawText('Nearby paragraph text', { x: 50, y: 500, size: 14 });
  const img = await src.embedPng(PNG);
  srcPage.drawImage(img, { x: 50, y: 100, width: 100, height: 80 });
  const doc = await PDFDocument.load(await src.save());

  const zones: OrderableZone[] = [
    { pageNumber: 1, bbox: { x: 0, y: 0, w: 400, h: 300 }, zoneType: 'paragraph' },
  ];
  const built = buildStructTreeFromZones(doc, zones);
  expect(built.elements).toBeGreaterThan(0);

  const xObjectName = decodeContent(doc).match(/\/([\w.#+-]+)\s+Do\b/)?.[1];
  expect(xObjectName).toBeTruthy();

  const buffer = Buffer.from(await doc.save());
  const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-writer-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  const parsedPdf = await pdfParserService.parse(tmpPath);

  return { doc, parsedPdf, xObjectName: xObjectName!, tmpPath };
}

/**
 * Same shape as buildDocWithTaggedTextAndUntaggedImage but the image is
 * REUSED: one Resources/XObject entry, invoked via `Do` TWICE at different
 * positions/sizes -- the exact real-world shape confirmed as the root
 * cause of S4 Carlisle's "Duplicate figure tags and alt text" defect.
 * drawImage always allocates a fresh resource name per call (confirmed
 * empirically -- even drawing the SAME embedded PDFImage object twice
 * gives two DIFFERENT names, not a shared one), so the second invocation
 * is built by hand: draw once normally, then append a second `cm`+`Do`
 * sequence reusing that one resource's own name directly into the content
 * stream. Both placements are left untagged.
 */
async function buildDocWithTaggedTextAndReusedImage(): Promise<{
  doc: PDFDocument;
  parsedPdf: Awaited<ReturnType<typeof pdfParserService.parse>>;
  xObjectName: string;
  tmpPath: string;
}> {
  const src = await PDFDocument.create();
  const srcPage = src.addPage([400, 600]);
  srcPage.drawText('Nearby paragraph text', { x: 50, y: 500, size: 14 });
  const img = await src.embedPng(PNG);
  srcPage.drawImage(img, { x: 50, y: 300, width: 40, height: 30 }); // first (and, so far, only) placement
  const doc = await PDFDocument.load(await src.save());

  const zones: OrderableZone[] = [
    { pageNumber: 1, bbox: { x: 0, y: 0, w: 400, h: 600 }, zoneType: 'paragraph' },
  ];
  const built = buildStructTreeFromZones(doc, zones);
  expect(built.elements).toBeGreaterThan(0);

  const taggedContent = decodeContent(doc);
  const xObjectName = taggedContent.match(/\/([\w.#+-]+)\s+Do\b/)?.[1]!;
  expect(xObjectName).toBeTruthy();

  // Manually append a SECOND invocation of the SAME XObject resource, at a
  // different position/size -- drawImage always allocates a FRESH resource
  // name per call (confirmed empirically: even reusing the same embedded
  // PDFImage object across two drawImage calls gives two DIFFERENT names,
  // not a shared one), so a genuinely reused XObject (one Resources/XObject
  // entry, invoked via `Do` twice) has to be built this way instead.
  // Position/size (x=200,y=100,w=60,h=50) matches what the test below
  // passes as this second entry's own img.position.
  writePageContent(doc, 1, `${taggedContent}\nq 60 0 0 50 200 100 cm /${xObjectName} Do Q\n`);

  const content = decodeContent(doc);
  const names = [...content.matchAll(/\/([\w.#+-]+)\s+Do\b/g)].map(m => m[1]);
  expect(names.length).toBe(2);
  expect(names[0]).toBe(names[1]); // same resource, two invocations -- confirms the reused-XObject shape

  const buffer = Buffer.from(await doc.save());
  const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-writer-reused-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  const parsedPdf = await pdfParserService.parse(tmpPath);

  return { doc, parsedPdf, xObjectName, tmpPath };
}

/** Finds the tagged paragraph's own ref + its parent's ref, walking from structRoot. */
function findParaAndParent(doc: PDFDocument, root: PDFDict): { paraRef: PDFRef; parentRef: PDFRef } {
  let paraRef: PDFRef | null = null;
  let parentRef: PDFRef | null = null;
  const findPara = (node: unknown, parent: PDFRef | null): void => {
    if (!(node instanceof PDFDict)) return;
    const k = node.get(PDFName.of('K'));
    const kids = k instanceof PDFArray ? k.asArray() : [k];
    for (const kid of kids) {
      if (kid instanceof PDFRef) {
        const resolved = doc.context.lookup(kid);
        if (tagOf(resolved) === 'P') { paraRef = kid; parentRef = parent; }
        findPara(resolved, kid);
      }
    }
  };
  findPara(root, null);
  if (!paraRef || !parentRef) throw new Error('tagged paragraph or its parent not found in struct tree');
  return { paraRef, parentRef };
}

/**
 * Same shape as buildDocWithTaggedTextAndUntaggedImage but with TWO
 * untagged images, both nearest the SAME single tagged paragraph -- the
 * shared-anchor scenario Codex/CodeRabbit flagged on PR #555. Embeds the
 * PNG twice (not one embed drawn twice) so pdf-lib registers two DISTINCT
 * XObject resources, each invoked once -- this fixture is specifically for
 * the shared-anchor/reading-order scenario, not the reused-XObject
 * (same name invoked twice) scenario, which the occurrence-indexed
 * fixtures below (buildDocWithTaggedTextAndReusedImage) cover instead now
 * that locateXObjectInvocation/mcidForXObject accept an occurrence
 * parameter and no longer have to bail on that ambiguity.
 */
async function buildDocWithTaggedTextAndTwoUntaggedImages(): Promise<{
  doc: PDFDocument;
  parsedPdf: Awaited<ReturnType<typeof pdfParserService.parse>>;
  xObjectNameA: string;
  xObjectNameB: string;
  tmpPath: string;
}> {
  const src = await PDFDocument.create();
  const srcPage = src.addPage([400, 600]);
  srcPage.drawText('Nearby paragraph text', { x: 50, y: 500, size: 14 });
  const imgA = await src.embedPng(PNG);
  const imgB = await src.embedPng(PNG);
  srcPage.drawImage(imgA, { x: 50, y: 400, width: 20, height: 20 });
  srcPage.drawImage(imgB, { x: 150, y: 400, width: 20, height: 20 });
  const doc = await PDFDocument.load(await src.save());

  const zones: OrderableZone[] = [
    { pageNumber: 1, bbox: { x: 0, y: 0, w: 400, h: 300 }, zoneType: 'paragraph' },
  ];
  const built = buildStructTreeFromZones(doc, zones);
  expect(built.elements).toBeGreaterThan(0);

  const content = decodeContent(doc);
  const names = [...content.matchAll(/\/([\w.#+-]+)\s+Do\b/g)].map(m => m[1]);
  expect(names.length).toBe(2);
  const [xObjectNameA, xObjectNameB] = names;

  const buffer = Buffer.from(await doc.save());
  const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-writer-shared-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  const parsedPdf = await pdfParserService.parse(tmpPath);

  return { doc, parsedPdf, xObjectNameA, xObjectNameB, tmpPath };
}

describe('PdfStructureWriterService.buildFigureFromImage', () => {
  it('builds a real Figure for a genuinely-untagged image and it resolves correctly afterward', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;

      // Confirm genuinely untagged before the fix.
      const before = await pdfModifierService.setAltText(doc, imageId, 'placeholder');
      expect(before.success).toBe(false);

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      // Now setAltText should resolve and write /Alt onto the NEW Figure.
      const after = await pdfModifierService.setAltText(doc, imageId, 'A test image');
      expect(after.success).toBe(true);

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      let figureAlt: string | null = null;
      let figureCount = 0;
      const walk = (node: unknown): void => {
        if (!(node instanceof PDFDict)) return;
        if (tagOf(node) === 'Figure') {
          figureCount++;
          const alt = node.get(PDFName.of('Alt'));
          if (alt instanceof PDFString) figureAlt = alt.decodeText();
        }
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
      };
      walk(root);
      expect(figureCount).toBe(1);
      expect(figureAlt).toBe('A test image');
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('writes /A/BBox onto the new Figure, converted from top-left-origin position to bottom-left-origin PDF points', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      let figureDict: PDFDict | null = null;
      const walk = (node: unknown): void => {
        if (!(node instanceof PDFDict)) return;
        if (tagOf(node) === 'Figure') figureDict = node;
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
      };
      walk(root);
      expect(figureDict).toBeTruthy();

      const a = doc.context.lookup(figureDict!.get(PDFName.of('A'))) as PDFDict;
      expect(a).toBeTruthy();
      expect(a.get(PDFName.of('O'))?.toString()).toBe('/Layout');
      expect(a.get(PDFName.of('Placement'))?.toString()).toBe('/Block');

      const bbox = doc.context.lookup(a.get(PDFName.of('BBox'))) as PDFArray;
      const values = bbox.asArray().map(n => (n as PDFNumber).asNumber());
      // Page is 600pt tall; image position {x:50, y:100, w:100, h:80}
      // (top-left-origin) -> BBox [llx, lly, urx, ury] (bottom-left-origin):
      // llx=50, lly=600-(100+80)=420, urx=50+100=150, ury=600-100=500.
      expect(values).toEqual([50, 420, 150, 500]);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('places the new Figure near the resolved anchor via insertIntoKidsAfter, not appended blindly at the end', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;

      // Find the tagged paragraph's own ref + parent before the fix, to
      // confirm the new Figure lands adjacent to it afterward.
      let paraRef: PDFRef | null = null;
      let parentRef: PDFRef | null = null;
      const findPara = (node: unknown, parent: PDFRef | null): void => {
        if (!(node instanceof PDFDict)) return;
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) {
          if (kid instanceof PDFRef) {
            const resolved = doc.context.lookup(kid);
            if (tagOf(resolved) === 'P') { paraRef = kid; parentRef = parent; }
            findPara(resolved, kid);
          }
        }
      };
      findPara(root, null);
      expect(paraRef).toBeTruthy();
      expect(parentRef).toBeTruthy();

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);

      const parentDict = doc.context.lookup(parentRef!) as PDFDict;
      const kidsArr = (parentDict.get(PDFName.of('K')) as PDFArray).asArray();
      const paraIdx = kidsArr.findIndex(k => k instanceof PDFRef && k.objectNumber === (paraRef as unknown as PDFRef).objectNumber);
      expect(paraIdx).toBeGreaterThanOrEqual(0);
      const nextTag = tagOf(doc.context.lookup(kidsArr[paraIdx + 1]));
      expect(nextTag).toBe('Figure');
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('fails honestly (does not throw, does not corrupt content) when the XObject name cannot be parsed from the imageId', async () => {
    const { doc, parsedPdf, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId: 'not-a-valid-image-id', pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(false);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('fails honestly when there is no structure tree root at all', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    const img = await src.embedPng(PNG);
    srcPage.drawImage(img, { x: 50, y: 100, width: 100, height: 80 });
    const doc = await PDFDocument.load(await src.save());
    const xObjectName = decodeContent(doc).match(/\/([\w.#+-]+)\s+Do\b/)?.[1]!;

    const buffer = Buffer.from(await doc.save());
    const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-writer-notree-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const parsedPdf = await pdfParserService.parse(tmpPath);
    try {
      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId: `img_p1_0_${xObjectName}`, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/structure tree/i);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for a real Codex/CodeRabbit finding on PR #555: when two
   * images resolve to the SAME nearest anchor, each insertion previously
   * recomputed that anchor's own index and spliced immediately after IT --
   * so content order [A,B] produced structure order [anchor,B,A], reversing
   * reading order. Fixed by chaining each subsequent same-anchor insertion
   * after the PREVIOUSLY inserted Figure, processing entries in content-
   * range order.
   */
  it('preserves reading order when two images share the same nearest anchor, not reversing them', async () => {
    const { doc, parsedPdf, xObjectNameA, xObjectNameB, tmpPath } = await buildDocWithTaggedTextAndTwoUntaggedImages();
    try {
      // Index 0 for BOTH -- xObjectNameA and xObjectNameB are two DISTINCT
      // XObject resources, each invoked exactly once, so each is its own
      // name's occurrence 0 (see ImageInfo's own doc comment in
      // image-extractor.service.ts: the index is per-name, not a shared
      // page-wide counter).
      const imageIdA = `img_p1_0_${xObjectNameA}`;
      const imageIdB = `img_p1_0_${xObjectNameB}`;

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId: imageIdA, pageNumber: 1, position: { x: 50, y: 400, width: 20, height: 20 } },
        { imageId: imageIdB, pageNumber: 1, position: { x: 150, y: 400, width: 20, height: 20 } },
      ]);
      expect(results.every(r => r.success)).toBe(true);

      await pdfModifierService.setAltText(doc, imageIdA, 'Image A');
      await pdfModifierService.setAltText(doc, imageIdB, 'Image B');

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const { paraRef, parentRef } = findParaAndParent(doc, root);
      const parentDict = doc.context.lookup(parentRef) as PDFDict;
      const kidsArr = (parentDict.get(PDFName.of('K')) as PDFArray).asArray();
      const paraIdx = kidsArr.findIndex(k => k instanceof PDFRef && k.objectNumber === paraRef.objectNumber);
      expect(paraIdx).toBeGreaterThanOrEqual(0);

      const firstFigure = doc.context.lookup(kidsArr[paraIdx + 1]) as PDFDict;
      const secondFigure = doc.context.lookup(kidsArr[paraIdx + 2]) as PDFDict;
      expect(tagOf(firstFigure)).toBe('Figure');
      expect(tagOf(secondFigure)).toBe('Figure');
      const firstAlt = firstFigure.get(PDFName.of('Alt'));
      const secondAlt = secondFigure.get(PDFName.of('Alt'));
      // Content order (A's Do invocation appears before B's, since A was
      // drawn/positioned first) must match structure order -- NOT reversed.
      expect(firstAlt instanceof PDFString ? firstAlt.decodeText() : null).toBe('Image A');
      expect(secondAlt instanceof PDFString ? secondAlt.decodeText() : null).toBe('Image B');
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for the confirmed root cause of "alt text describes
   * completely unrelated content" / S4 Carlisle's "Duplicate figure tags
   * and alt text" defect (Karsaklian_189165_9781606497623.pdf): a REUSED
   * XObject resource (the same embedded image invoked twice on one page,
   * at different positions -- a normal, common authoring pattern) used to
   * make locateXObjectInvocation bail entirely (ambiguous: more than one
   * `/xobj Do` match, no way to know which one a caller meant), so
   * buildFigureFromImage could never build a Figure for EITHER occurrence.
   * Fixed via the occurrence parameter (locateXObjectInvocation,
   * mcidForXObject) threaded through from ImageInfo.index -- see those
   * functions' own doc comments. Two occurrences of the SAME xObjectName
   * must now each get their OWN correctly-built, correctly-positioned
   * Figure, not conflated into one and not swapped.
   */
  it('builds two independent, correctly-positioned Figures for two occurrences of a REUSED XObject, not conflating or swapping them', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndReusedImage();
    try {
      const imageIdFirst = `img_p1_0_${xObjectName}`;
      const imageIdSecond = `img_p1_1_${xObjectName}`;
      const positionFirst = { x: 50, y: 300, width: 40, height: 30 };
      const positionSecond = { x: 200, y: 100, width: 60, height: 50 };

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId: imageIdFirst, pageNumber: 1, position: positionFirst },
        { imageId: imageIdSecond, pageNumber: 1, position: positionSecond },
      ]);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);

      await pdfModifierService.setAltText(doc, imageIdFirst, 'First placement');
      await pdfModifierService.setAltText(doc, imageIdSecond, 'Second placement');

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const figures: PDFDict[] = [];
      const walk = (node: unknown): void => {
        if (!(node instanceof PDFDict)) return;
        if (tagOf(node) === 'Figure') figures.push(node);
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
      };
      walk(root);
      // TWO distinct Figure struct elements, not one (conflated) and not
      // more than two (duplicated).
      expect(figures.length).toBe(2);

      const altOf = (d: PDFDict): string => {
        const a = d.get(PDFName.of('Alt'));
        return a instanceof PDFString ? a.decodeText() : 'None';
      };
      const bboxOf = (d: PDFDict): number[] => {
        const a = doc.context.lookup(d.get(PDFName.of('A'))) as PDFDict;
        const bbox = doc.context.lookup(a.get(PDFName.of('BBox'))) as PDFArray;
        return bbox.asArray().map(n => (n as PDFNumber).asNumber());
      };

      const byAlt = new Map(figures.map(f => [altOf(f), f]));
      expect(byAlt.has('First placement')).toBe(true);
      expect(byAlt.has('Second placement')).toBe(true);

      // Each Figure's own /A/BBox matches ITS OWN invocation's real
      // position, converted to bottom-left-origin PDF points -- not
      // swapped, not both carrying the same (first) position.
      // Page height 600: llx=x, lly=600-(y+h), urx=x+w, ury=600-y.
      expect(bboxOf(byAlt.get('First placement')!)).toEqual([50, 270, 90, 300]);
      expect(bboxOf(byAlt.get('Second placement')!)).toEqual([200, 450, 260, 500]);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for a real Codex finding on PR #555, later SUPERSEDED: the
   * anchor's parent's /K being a SCALAR (a real, valid single-child struct
   * element shape per spec, not wrapped in an array) used to make
   * insertIntoKidsAfter throw -- previously this only surfaced AFTER
   * insertMarkedContentSpans had already rewritten the content stream,
   * leaving a real BDC/EMC+MCID sequence with no owning struct element
   * despite the reported failure, so it was moved to a preflight. Later
   * confirmed live as a real, not just theoretical, gap: 6 of
   * Karsaklian_189165_9781606497623's own 156 real actualtext-missing-mcid-fix
   * candidates permanently declined on exactly this shape -- insertIntoKidsAfter/
   * insertIntoKidsBefore now promote a matching scalar /K to a real array
   * instead of declining (safe by construction: the scalar IS, by
   * definition, this parent's one and only child), and this preflight was
   * updated to agree (kContainsChild, shared with the insertion methods
   * themselves).
   */
  it('promotes the anchor\'s parent\'s scalar (non-array) /K to a real array rather than declining', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const { paraRef, parentRef } = findParaAndParent(doc, root);

      // Force a real, valid single-child shape: parent's /K becomes a bare
      // ref instead of an array wrapping one.
      const parentDict = doc.context.lookup(parentRef) as PDFDict;
      parentDict.set(PDFName.of('K'), paraRef);

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);

      // Parent's /K is now a real array: the original scalar child first,
      // the new Figure spliced in right after it (insertIntoKidsAfter's
      // own anchor-after semantics), not reordered or replaced.
      const parentKAfter = parentDict.get(PDFName.of('K'));
      expect(parentKAfter).toBeInstanceOf(PDFArray);
      const kidsAfter = (parentKAfter as PDFArray).asArray();
      expect(kidsAfter).toHaveLength(2);
      expect((kidsAfter[0] as PDFRef).objectNumber).toBe(paraRef.objectNumber);
      expect(tagOf(doc.context.lookup(kidsAfter[1]))).toBe('Figure');
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for real Codex/CodeRabbit findings on PR #555: a late
   * /ParentTree commit failure (a contiguity mismatch the shape-only
   * preflight can't see, since it depends on the actual MCIDs
   * insertMarkedContentSpans assigns) previously only cleaned up the
   * struct-tree side (deleteElement) -- the page's real BDC/EMC+MCID marks
   * stayed in the content stream, unlike buildTableFromLayout's own
   * analogous residual risk (issue #553), TRUE full rollback is cheap here:
   * this writer does exactly ONE content-stream rewrite per page, so
   * restoring the captured pre-mutation content undoes the whole page's
   * insertion at once.
   */
  it('rolls back the page\'s ENTIRE content-stream mutation (byte-identical), not just struct-tree cleanup, when the final ParentTree commit fails', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;

      // The fixture's own /ParentTree is left exactly as buildStructTreeFromZones
      // produced it (one real entry, for the tagged paragraph's own MCID 0) --
      // now the authoritative source buildFigureFromImage's minNextMcid floor
      // reads from, so a STALE (longer) array can no longer be used to force a
      // mismatch (that scenario is exactly what this fix resolves correctly
      // instead of failing -- see pdf-structure-writer-figure.test.ts's own
      // "allocates the new Figure's MCID from the real /ParentTree array
      // length" test). Forcing a genuine mismatch now requires the OTHER
      // direction: a content-stream MCID reference higher than anything
      // actually registered in /ParentTree (an orphaned/dangling reference,
      // not tracked anywhere) -- pageContentMcids' scan alone still can't see
      // past this, so insertMarkedContentSpans allocates MCID 6, but the real
      // array's own length (1) means extendParentTree expects MCID 1 -- a
      // genuine contiguity mismatch even with the real-array floor in place.
      const original = decodeContent(doc);
      writePageContent(doc, 1, `${original}\n/Span <</MCID 5>> BDC\nq Q\nEMC\n`);

      const before = decodeContent(doc);
      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(false);

      const after = decodeContent(doc);
      expect(after).toBe(before);

      let figureCount = 0;
      const walk = (node: unknown): void => {
        if (!(node instanceof PDFDict)) return;
        if (tagOf(node) === 'Figure') figureCount++;
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
      };
      walk(root);
      expect(figureCount).toBe(0);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for a real CodeRabbit finding on PR #555: structElemHasMcid
   * only matched DIRECT /K values -- this pdf-lib version (^1.17.1) does
   * not auto-resolve PDFRefs on .get(), so an indirect /K (a real, valid
   * PDF shape) was silently missed, causing findStructElementByMcid to fail
   * to find a real anchor that DID reference the target MCID.
   */
  it('finds the anchor even when its own /K is an indirect reference, not a direct value', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const { paraRef } = findParaAndParent(doc, root);
      const paraDict = doc.context.lookup(paraRef) as PDFDict;
      const directMcid = paraDict.get(PDFName.of('K'));
      expect(directMcid).toBeInstanceOf(PDFNumber);

      // Rewrite /K to an INDIRECT reference to the same MCID value.
      const indirectMcidRef = doc.context.register(directMcid as PDFNumber);
      paraDict.set(PDFName.of('K'), indirectMcidRef);

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for a real failure cluster on a real document
   * (Karsaklian_189165_9781606497623): an alt-text-decorative suggestion
   * permanently failed to apply with the misleading error "No Figure
   * element at page 74, index 2" -- misleading because the true cause was
   * never in setAltText at all. ensureFigureForImages's own doc comment
   * says a buildFigureFromImage failure "is not surfaced here -- setAltText's
   * own existing 'No Figure element' error reports it naturally
   * per-suggestion afterward", and that's exactly what happened:
   * buildFigureFromImage's /ParentTree preflight (resolveParentTreeNumsArray)
   * threw on the document's real hierarchical /Kids tree, silently failing
   * the build, so setAltText's later lookup found nothing to target and
   * reported its own generic, unrelated-looking error. Fixed as a direct
   * consequence of resolveParentTreeNumsArray/findParentTreeLeafNums now
   * walking /Kids instead of declining -- confirmed live against the real
   * PDF (see the investigation script's "REAL end-to-end buildFigureFromImage
   * call" output: this exact image now succeeds, building MCID 2542) --
   * this test locks that same fix in as a synthetic regression.
   */
  it('builds a Figure even when the page\'s /ParentTree is a hierarchical /Kids tree (not just a flat root /Nums)', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;

      const page = doc.getPages()[0];
      const structParentsRaw = page.node.get(PDFName.of('StructParents'));
      const pageKey = structParentsRaw instanceof PDFNumber ? structParentsRaw.asNumber() : 0;

      // Re-wrap the existing flat /Nums into an equivalent single-leaf
      // hierarchical tree -- same real shape confirmed on Karsaklian_189165
      // (several /Limits-bounded leaves under a /Kids root), just with one
      // leaf instead of five, since this fixture only has one tagged page.
      const existingParentTreeRef = root.get(PDFName.of('ParentTree')) as PDFRef;
      const existingParentTreeDict = doc.context.lookup(existingParentTreeRef) as PDFDict;
      const existingNums = existingParentTreeDict.get(PDFName.of('Nums'));
      const leafRef = doc.context.register(doc.context.obj({
        Nums: existingNums,
        Limits: doc.context.obj([PDFNumber.of(pageKey), PDFNumber.of(pageKey)]),
      }));
      const hierarchicalParentTreeRef = doc.context.register(doc.context.obj({
        Kids: doc.context.obj([leafRef]),
      }));
      root.set(PDFName.of('ParentTree'), hierarchicalParentTreeRef);

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);

      // The new entry must land inside the LEAF's /Nums, not a new root /Nums.
      const leafDict = doc.context.lookup(leafRef) as PDFDict;
      const leafNums = leafDict.get(PDFName.of('Nums')) as PDFArray;
      const flat = leafNums.asArray();
      expect((flat[0] as PDFNumber).asNumber()).toBe(pageKey);
      const valueArr = flat[1] as PDFArray;
      expect(valueArr.asArray().length).toBeGreaterThan(0);
      const newFigureRef = valueArr.asArray()[valueArr.asArray().length - 1] as PDFRef;
      expect(tagOf(doc.context.lookup(newFigureRef))).toBe('Figure');
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  /**
   * Regression for a second, real failure on the same document
   * (Karsaklian_189165_9781606497623.pdf, page 74, 2026-11-09): once the
   * /Kids-tree issue above was fixed, an alt-text-decorative suggestion for
   * a DIFFERENT image on the same page still failed with "No Figure element
   * at page 74, index 2". Root cause this time: a struct element can occupy
   * a /ParentTree slot without ever writing a literal "/MCID n" BDC span
   * into the content stream (confirmed real: the document's own
   * ACTUALTEXT-MISSING-MCID fixer had already extended the page's
   * /ParentTree to 2559 entries, but only 2557 of those MCIDs appeared as
   * literal text) -- buildFigureFromImage's content-stream-only scan
   * computed "next MCID = 2557" and extendParentTree's own contiguity guard
   * correctly refused the mismatch rather than silently corrupting the
   * array. Reproduced synthetically here by pushing extra entries directly
   * onto the page's real /ParentTree array (simulating a slot used by
   * something that left no content-stream trace) and confirming
   * buildFigureFromImage now allocates starting from the array's real
   * length, not the content-stream-derived (lower) count.
   */
  it('allocates the new Figure\'s MCID from the real /ParentTree array length, not just the content-stream MCID scan', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const { paraRef } = findParaAndParent(doc, root);

      const page = doc.getPages()[0];
      const structParentsRaw = page.node.get(PDFName.of('StructParents'));
      const pageKey = structParentsRaw instanceof PDFNumber ? structParentsRaw.asNumber() : 0;

      const parentTreeRef = root.get(PDFName.of('ParentTree')) as PDFRef;
      const parentTreeDict = doc.context.lookup(parentTreeRef) as PDFDict;
      const numsArr = doc.context.lookup(parentTreeDict.get(PDFName.of('Nums'))) as PDFArray;
      const flat = numsArr.asArray();
      let pageArr: PDFArray | null = null;
      for (let i = 0; i < flat.length; i += 2) {
        if ((flat[i] as PDFNumber).asNumber() === pageKey) {
          pageArr = doc.context.lookup(flat[i + 1] as PDFRef) as PDFArray;
          break;
        }
      }
      expect(pageArr).toBeTruthy();

      // Simulate two slots claimed by something that never wrote a matching
      // literal "/MCID n" BDC span -- the content-stream scan alone can't
      // see these, only the array's real length reflects them.
      pageArr!.push(paraRef);
      pageArr!.push(paraRef);
      const realLength = pageArr!.size();

      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(true);
      expect(results[0].after).toContain(`MCID ${realLength}`);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);
});

describe('PdfStructureWriterService.retagDecorativeFigureAsArtifact', () => {
  it('retags a buildFigureFromImage-created Figure to /Artifact: struct element removed, /ParentTree slot nulled, content stream rewritten', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;

      const buildResults = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(buildResults[0].success).toBe(true);

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      let figureRef: PDFRef | null = null;
      let parentRef: PDFRef | null = null;
      const findFigure = (node: unknown, parent: PDFRef | null): void => {
        if (!(node instanceof PDFDict)) return;
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) {
          if (kid instanceof PDFRef) {
            const resolved = doc.context.lookup(kid);
            if (tagOf(resolved) === 'Figure') { figureRef = kid; parentRef = parent; }
            findFigure(resolved, kid);
          }
        }
      };
      findFigure(root, null);
      expect(figureRef).toBeTruthy();
      expect(parentRef).toBeTruthy();
      const mcid = ((doc.context.lookup(figureRef!) as PDFDict).get(PDFName.of('K')) as PDFNumber).asNumber();

      const retagResult = pdfStructureWriterService.retagDecorativeFigureAsArtifact(doc, 'issue-1', imageId);
      expect(retagResult.success).toBe(true);

      // No longer in its former parent's /K.
      const parentDict = doc.context.lookup(parentRef!) as PDFDict;
      const parentK = parentDict.get(PDFName.of('K')) as PDFArray;
      expect(parentK.asArray().some(r => r instanceof PDFRef && r.objectNumber === figureRef!.objectNumber)).toBe(false);

      // The struct element itself no longer carries /K or /P.
      const figureDict = doc.context.lookup(figureRef!) as PDFDict;
      expect(figureDict.get(PDFName.of('K'))).toBeUndefined();
      expect(figureDict.get(PDFName.of('P'))).toBeUndefined();

      // Content stream: the /Figure <</MCID n>>BDC opening is now /Artifact BMC.
      const content = decodeContent(doc);
      expect(content).not.toMatch(/\/Figure\s*<<[^>]*BDC/);
      expect(content).toContain('/Artifact BMC');

      // /ParentTree's own slot for this MCID is nulled, not removed --
      // the array itself must keep its length so no later-appended MCID's
      // position shifts.
      const parentTreeRef = root.get(PDFName.of('ParentTree')) as PDFRef;
      const parentTreeDict = doc.context.lookup(parentTreeRef) as PDFDict;
      const numsArr = parentTreeDict.get(PDFName.of('Nums')) as PDFArray;
      const flat = numsArr.asArray();
      const pageValueArr = flat[1] as PDFArray;
      expect(pageValueArr.get(mcid)).toBe(PDFNull);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('declines (no mutation) when the Figure /K is not a single bare MCID', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);

      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      let figureRef: PDFRef | null = null;
      const findFigure = (node: unknown): void => {
        if (!(node instanceof PDFDict)) return;
        const k = node.get(PDFName.of('K'));
        const kids = k instanceof PDFArray ? k.asArray() : [k];
        for (const kid of kids) {
          if (kid instanceof PDFRef) {
            const resolved = doc.context.lookup(kid);
            if (tagOf(resolved) === 'Figure') figureRef = kid;
            findFigure(resolved);
          }
        }
      };
      findFigure(root);
      expect(figureRef).toBeTruthy();
      // Promote /K to an array -- the richer, pre-existing-document shape
      // this fix is deliberately scoped to decline for.
      const figureDict = doc.context.lookup(figureRef!) as PDFDict;
      const mcid = (figureDict.get(PDFName.of('K')) as PDFNumber).asNumber();
      figureDict.set(PDFName.of('K'), doc.context.obj([PDFNumber.of(mcid)]));

      const contentBefore = decodeContent(doc);
      const result = pdfStructureWriterService.retagDecorativeFigureAsArtifact(doc, 'issue-1', imageId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('single bare MCID');
      expect(decodeContent(doc)).toBe(contentBefore);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);
});
