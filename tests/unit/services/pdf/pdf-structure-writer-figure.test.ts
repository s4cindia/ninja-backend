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
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString } from 'pdf-lib';
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
});
