import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFBool, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildStructTreeFromZones } from '../../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import { serializeStructTreeAsync } from '../../../../../src/services/zone-extractor/struct-tree-serializer';
import type { OrderableZone } from '../../../../../src/services/zone-extractor/seam-c/reading-order';
import type { CanonicalZoneType } from '../../../../../src/services/zone-extractor/types';

const H = 600;
// Draw a single-column page; each line's baseline is chosen so its zone band contains it.
async function makeUntaggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([450, H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, y: number, size = 12): void => page.drawText(text, { x: 50, y, size, font });
  draw('Chapter One', 560, 18);   // heading
  draw('First paragraph text.', 520);
  draw('Second paragraph text.', 490);
  draw('First list item', 450);
  draw('Second list item', 430);
  return doc.save();
}

const z = (zoneType: CanonicalZoneType, y: number, h: number): OrderableZone => ({
  pageNumber: 1, bbox: { x: 50, y, w: 400, h }, zoneType,
});

// zones in top-left convention; device band = [H-(y+h), H-y] must contain each baseline
const ZONES: OrderableZone[] = [
  z('section-header', 30, 20),  // band [550,570] ∋ 560
  z('paragraph', 70, 20),       // band [510,530] ∋ 520
  z('paragraph', 100, 20),      // band [480,500] ∋ 490
  z('list-item', 140, 18),      // band [442,460] ∋ 450
  z('list-item', 160, 18),      // band [422,440] ∋ 430
];

describe('buildStructTreeFromZones (end-to-end)', () => {
  it('tags an untagged single-column PDF and the tree round-trips', async () => {
    const untagged = await makeUntaggedPdf();

    // load as we would a received PDF, then build the tree
    const doc = await PDFDocument.load(untagged);
    const result = buildStructTreeFromZones(doc, ZONES);
    expect(result.pages).toBe(1);
    expect(result.mcids).toBe(5);       // one MCID per zone
    const tagged = await doc.save();

    // catalog markers
    const reloaded = await PDFDocument.load(tagged);
    const catalog = reloaded.catalog;
    expect(catalog.get(PDFName.of('StructTreeRoot'))).toBeTruthy();
    const markInfo = reloaded.context.lookup(catalog.get(PDFName.of('MarkInfo'))) as PDFDict;
    expect(markInfo.get(PDFName.of('Marked'))).toBe(PDFBool.True);

    // content stream carries MCID marked content
    const page = reloaded.getPage(0);
    const streamObj = reloaded.context.lookup(page.node.get(PDFName.of('Contents')));
    const bytes = streamObj instanceof PDFRawStream
      ? decodePDFRawStream(streamObj).decode()
      : (streamObj as unknown as { decode(): Uint8Array }).decode();
    let cs = '';
    for (let i = 0; i < bytes.length; i++) cs += String.fromCharCode(bytes[i]);
    expect(cs).toContain('/H1 <</MCID 0>> BDC');
    expect(cs).toContain('BDC');
    expect((cs.match(/EMC/g) || []).length).toBe(5);

    // round-trip the /StructTreeRoot back to a tag tree via the repo's own reader
    const { tree } = await serializeStructTreeAsync(tagged as unknown as Parameters<typeof serializeStructTreeAsync>[0]);
    expect(tree).toHaveLength(1);
    const document = tree[0];
    expect(document.tag).toBe('Document');
    const top = (document.children || []).map((c) => c.tag);
    expect(top).toEqual(['H1', 'P', 'P', 'L']);

    // leaves carry their MCID; the list nests L > LI > LBody
    const [h1, p1] = document.children!;
    expect(h1.mcids).toEqual([0]);
    expect(p1.mcids).toEqual([1]);
    const list = document.children![3];
    expect((list.children || []).map((c) => c.tag)).toEqual(['LI', 'LI']);
    const firstLi = list.children![0];
    expect((firstLi.children || []).map((c) => c.tag)).toEqual(['LBody']);
    expect(firstLi.children![0].mcids).toEqual([3]);
  });

  it('refuses a PDF that already has a /StructTreeRoot (no double-tagging)', async () => {
    const doc = await PDFDocument.load(await makeUntaggedPdf());
    buildStructTreeFromZones(doc, ZONES);                 // now tagged
    expect(() => buildStructTreeFromZones(doc, ZONES)).toThrow(/ALREADY_TAGGED/);
  });

  it('is a no-op for a PDF with no zones', async () => {
    const doc = await PDFDocument.load(await makeUntaggedPdf());
    const result = buildStructTreeFromZones(doc, []);
    expect(result).toEqual({ elements: 0, mcids: 0, pages: 0 });
    expect(doc.catalog.get(PDFName.of('StructTreeRoot'))).toBeFalsy();
  });
});
