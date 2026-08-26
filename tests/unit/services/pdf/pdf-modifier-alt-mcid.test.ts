import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRef, PDFNumber, StandardFonts, decodePDFRawStream, PDFRawStream } from 'pdf-lib';
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

  it('picks the right formula by MCID when several share a page, leaving the other untouched', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('E = mc2', { x: 100, y: 450, size: 14, font });
    page.drawText('a2 + b2 = c2', { x: 100, y: 200, size: 14, font });
    const doc = await PDFDocument.load(await src.save());

    buildStructTreeFromZones(doc, [
      { pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' },
      { pageNumber: 1, bbox: { x: 80, y: 370, w: 240, h: 60 }, zoneType: 'formula' },
    ]);

    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    const formulaMcids: number[] = [];
    const findMcids = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Formula') {
        const k = node.get(PDFName.of('K'));
        if (k instanceof PDFNumber) formulaMcids.push(k.asNumber());
      }
      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) findMcids(doc.context.lookup(kid));
    };
    findMcids(root);
    expect(formulaMcids.length).toBe(2);
    const [firstMcid, secondMcid] = formulaMcids;

    const res = await pdfModifierService.setActualText(doc, `formula_p1_mc${secondMcid}`, 'a squared plus b squared equals c squared');
    expect(res.success).toBe(true);

    const actualsByMcid = new Map<number, string>();
    const walk = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Formula') {
        const k = node.get(PDFName.of('K'));
        const a = node.get(PDFName.of('ActualText'));
        if (k instanceof PDFNumber) actualsByMcid.set(k.asNumber(), a instanceof PDFString ? a.decodeText() : 'None');
      }
      const kk = node.get(PDFName.of('K'));
      const kids = kk instanceof PDFArray ? kk.asArray() : [kk];
      for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
    };
    walk(root);
    expect(actualsByMcid.get(secondMcid)).toBe('a squared plus b squared equals c squared');
    expect(actualsByMcid.get(firstMcid)).toBe('None');
  });

  it('fails instead of guessing when the MCID does not match any formula on the page', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('E = mc2', { x: 100, y: 450, size: 14, font });
    const doc = await PDFDocument.load(await src.save());

    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }]);

    // mc99 does not exist — the old code fell back to formulasOnPage[0] and
    // silently wrote to it; this must now fail explicitly instead.
    const res = await pdfModifierService.setActualText(doc, 'formula_p1_mc99', 'wrong reading');
    expect(res.success).toBe(false);

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
    expect(actual).toBeNull(); // the real formula on the page was left alone
  });

  it('fails instead of guessing when the target page has no formulas but another page does', async () => {
    const src = await PDFDocument.create();
    const page1 = src.addPage([400, 600]);
    src.addPage([400, 600]); // page 2: no formula zone
    const font = await src.embedFont(StandardFonts.Helvetica);
    page1.drawText('E = mc2', { x: 100, y: 450, size: 14, font });
    const doc = await PDFDocument.load(await src.save());

    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }]);

    // Old code's last-resort fallback (formulas[targetIndex] ?? formulas[0])
    // searched across ALL pages once page 2 came up empty, and would have
    // silently written page 1's formula instead. Must fail explicitly now.
    const res = await pdfModifierService.setActualText(doc, 'formula_p2_mc0', 'wrong page');
    expect(res.success).toBe(false);

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
    expect(actual).toBeNull();
  });

  it('fails instead of guessing on an out-of-range positional index', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('E = mc2', { x: 100, y: 450, size: 14, font });
    const doc = await PDFDocument.load(await src.save());

    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }]);

    const res = await pdfModifierService.setActualText(doc, 'formula_p1_5', 'wrong index');
    expect(res.success).toBe(false);
  });

  it('rejects an id that does not match the expected formula id format', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('E = mc2', { x: 100, y: 450, size: 14, font });
    const doc = await PDFDocument.load(await src.save());

    // A real structure tree exists, so this exercises the id-format check
    // specifically, not the earlier "no structure tree" bailout.
    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 60 }, zoneType: 'formula' }]);

    const res = await pdfModifierService.setActualText(doc, 'not-a-formula-id', 'text');
    expect(res.success).toBe(false);
    expect(res.error).toContain('does not match the expected');
  });

  it('searches a caller-supplied element type instead of Formula when elementTypes is passed', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    const img = await src.embedPng(PNG);
    srcPage.drawImage(img, { x: 100, y: 400, width: 200, height: 100 });
    const doc = await PDFDocument.load(await src.save());

    // Tag as a Figure, not a Formula — the default Formula-only search must
    // fail, while passing elementTypes for Figure must succeed.
    buildStructTreeFromZones(doc, [{ pageNumber: 1, bbox: { x: 80, y: 120, w: 240, h: 120 }, zoneType: 'figure' }]);

    const defaultSearch = await pdfModifierService.setActualText(doc, 'formula_p1_mc0', 'ignored');
    expect(defaultSearch.success).toBe(false);

    const widened = await pdfModifierService.setActualText(
      doc,
      'formula_p1_mc0',
      'a red apple on a table',
      new Set(['Figure', 'figure']),
    );
    expect(widened.success).toBe(true);

    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    let actual: string | null = null;
    const walk = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Figure') {
        const a = node.get(PDFName.of('ActualText'));
        if (a instanceof PDFString) actual = a.decodeText();
      }
      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) walk(doc.context.lookup(kid));
    };
    walk(root);
    expect(actual).toBe('a red apple on a table');
  });
});
