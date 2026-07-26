import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef, StandardFonts, decodePDFRawStream, PDFRawStream } from 'pdf-lib';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';

// 1×1 PNG (base64 → bytes without Buffer, which isn't in the test tsconfig scope)
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

function decodeContent(doc: PDFDocument): string {
  const streamObj = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')));
  const bytes = streamObj instanceof PDFRawStream
    ? decodePDFRawStream(streamObj).decode()
    : (streamObj as unknown as { decode(): Uint8Array }).decode();
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

describe('setAltText — MCID-exact figure targeting', () => {
  it('writes /Alt onto the Figure whose MCID marks the target image', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    const img = await src.embedPng(PNG);
    srcPage.drawImage(img, { x: 100, y: 400, width: 200, height: 100 }); // center (200,450) device
    // save + reload so the image Do is flushed into a real content stream
    const doc = await PDFDocument.load(await src.save());

    // one figure zone covering the image (device band [360,480] ∋ 450; x [80,320] ∋ 200)
    const zones: OrderableZone[] = [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 120 }, zoneType: 'figure' }];
    const built = buildStructTreeFromZones(doc, zones);
    expect(built.elements).toBeGreaterThan(0);

    // the image's XObject name, from the (now MCID-marked) content stream
    const xobj = decodeContent(doc).match(/\/([\w.#+-]+)\s+Do\b/)?.[1];
    expect(xobj).toBeTruthy();

    const res = await pdfModifierService.setAltText(doc, `img_p1_0_${xobj}`, 'A red apple on a table');
    expect(res.success).toBe(true);

    // the Figure StructElem now carries the alt
    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    let figureAlt: string | null = null;
    const walk = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Figure') {
        const alt = node.get(PDFName.of('Alt'));
        if (alt instanceof PDFString) figureAlt = alt.decodeText();
      }
      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
    };
    walk(root);
    expect(figureAlt).toBe('A red apple on a table');
  });

  it('writes /ActualText onto a Formula element (MCID-exact)', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('E = mc2', { x: 100, y: 450, size: 14, font }); // baseline 450
    const doc = await PDFDocument.load(await src.save());

    // formula zone covering the text (device band [420,480] ∋ 450; x [80,320] ∋ 100)
    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }]);

    const res = await pdfModifierService.setActualText(doc, 'formula_p1_mc0', 'E equals m c squared');
    expect(res.success).toBe(true);

    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    let actual: string | null = null;
    const walk = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Formula') {
        const a = node.get(PDFName.of('ActualText'));
        if (a instanceof PDFString) actual = a.decodeText();
      }
      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
    };
    walk(root);
    expect(actual).toBe('E equals m c squared');
  });
});
