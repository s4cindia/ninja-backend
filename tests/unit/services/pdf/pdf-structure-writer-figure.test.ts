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
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
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
 * XObject resources -- locateXObjectInvocation bails on an ambiguous
 * (multiply-invoked) name, so this fixture needs two real, separately
 * named XObjects to exercise the per-image resolution at all.
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
      const imageIdA = `img_p1_0_${xObjectNameA}`;
      const imageIdB = `img_p1_1_${xObjectNameB}`;

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
   * Regression for a real Codex finding on PR #555: insertIntoKidsAfter
   * throws if the anchor's parent's /K is a SCALAR (a real, valid
   * single-child struct element shape per spec, not wrapped in an array) --
   * previously this only surfaced AFTER insertMarkedContentSpans had
   * already rewritten the content stream, leaving a real BDC/EMC+MCID
   * sequence with no owning struct element despite the reported failure.
   * Now preflighted before any mutation.
   */
  it('fails cleanly with NO content-stream mutation when the anchor\'s parent has a scalar (non-array) /K', async () => {
    const { doc, parsedPdf, xObjectName, tmpPath } = await buildDocWithTaggedTextAndUntaggedImage();
    try {
      const imageId = `img_p1_0_${xObjectName}`;
      const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
      const { paraRef, parentRef } = findParaAndParent(doc, root);

      // Force a real, valid single-child shape: parent's /K becomes a bare
      // ref instead of an array wrapping one.
      const parentDict = doc.context.lookup(parentRef) as PDFDict;
      parentDict.set(PDFName.of('K'), paraRef);

      const before = decodeContent(doc);
      const results = await pdfStructureWriterService.buildFigureFromImage(doc, parsedPdf, [
        { imageId, pageNumber: 1, position: { x: 50, y: 100, width: 100, height: 80 } },
      ]);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/not an array/i);

      const after = decodeContent(doc);
      expect(after).toBe(before);
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

      const page = doc.getPages()[0];
      const structParentsRaw = page.node.get(PDFName.of('StructParents'));
      const pageKey = structParentsRaw instanceof PDFNumber ? structParentsRaw.asNumber() : 0;

      // A valid array-shaped /ParentTree (passes resolveParentTreeNumsArray's
      // preflight) whose page entry already has 3 entries -- but the tagged
      // paragraph itself only uses MCID 0, so insertMarkedContentSpans will
      // allocate the new Figure's MCID starting at 1 (pageContentMcids'
      // next-available), not the 3 this stale array's own length implies,
      // guaranteeing extendParentTree's contiguity check rejects the commit
      // (same construction as buildTableFromLayout's own analogous
      // regression test -- there the content stream truly had zero existing
      // MCIDs, so a 1-entry stale array was enough; here the paragraph's own
      // real MCID 0 means the stale array must be deliberately longer than
      // "real next MCID + 1" to force a genuine mismatch).
      const staleEntryArray = doc.context.obj([
        doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
        doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
        doc.context.register(doc.context.obj({ S: PDFName.of('Span') })),
      ]);
      const numsArr = doc.context.obj([PDFNumber.of(pageKey), staleEntryArray]);
      const parentTreeRef = doc.context.register(doc.context.obj({ Nums: numsArr }));
      root.set(PDFName.of('ParentTree'), parentTreeRef);

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
});
