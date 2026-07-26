import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { fontToUnicodeService } from '../../../../src/services/pdf/font-tounicode.service';
import { WINANSI_CODE_TO_UNICODE, glyphNameToUnicode } from '../../../../src/services/pdf/font-encodings';

function decodeToUnicode(doc: PDFDocument, font: PDFDict): string {
  const ref = font.get(PDFName.of('ToUnicode'));
  const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  const bytes = stream instanceof PDFRawStream
    ? decodePDFRawStream(stream).decode()
    : (stream as unknown as { decode(): Uint8Array }).decode();
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function findFont(doc: PDFDocument): PDFDict | undefined {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font') return obj;
  }
  return undefined;
}

describe('font-encodings data', () => {
  it('maps WinAnsi codes to Unicode (ASCII identity + CP1252 specials + Latin-1)', () => {
    expect(WINANSI_CODE_TO_UNICODE[0x41]).toBe(0x41); // 'A'
    expect(WINANSI_CODE_TO_UNICODE[0x20]).toBe(0x20); // space
    expect(WINANSI_CODE_TO_UNICODE[0x80]).toBe(0x20ac); // euro
    expect(WINANSI_CODE_TO_UNICODE[0x92]).toBe(0x2019); // right single quote
    expect(WINANSI_CODE_TO_UNICODE[0xe9]).toBe(0xe9); // é (Latin-1)
    expect(WINANSI_CODE_TO_UNICODE[0x81]).toBe(0); // unassigned → PUA fallback in caller
  });

  it('resolves glyph names algorithmically and via the AGL subset', () => {
    expect(glyphNameToUnicode('A')).toBe(0x41);
    expect(glyphNameToUnicode('bullet')).toBe(0x2022);
    expect(glyphNameToUnicode('uni2211')).toBe(0x2211); // n-ary summation
    expect(glyphNameToUnicode('u1D538')).toBe(0x1d538);
    expect(glyphNameToUnicode('one.oldstyle')).toBe(0x31); // suffix stripped
    expect(glyphNameToUnicode('braceex')).toBeUndefined(); // TeX name not in AGL → PUA
  });
});

describe('fontToUnicodeService.synthesizeToUnicode', () => {
  it('adds a /ToUnicode CMap to a font that lacks one, mapping WinAnsi correctly', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Ab', { x: 20, y: 100, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());

    const fontDict = findFont(reloaded)!;
    expect(fontDict.has(PDFName.of('ToUnicode'))).toBe(false);

    const res = fontToUnicodeService.synthesizeToUnicode(reloaded);
    expect(res.fontsProcessed).toBe(1);

    expect(fontDict.has(PDFName.of('ToUnicode'))).toBe(true);
    const cmap = decodeToUnicode(reloaded, fontDict);
    expect(cmap).toContain('beginbfchar');
    expect(cmap).toContain('<41> <0041>'); // 'A'
    expect(cmap).toContain('<62> <0062>'); // 'b'
    // an unassigned WinAnsi code gets a PUA fallback (never left unmapped)
    expect(cmap).toContain('<81> <e081>');
  });

  it('is idempotent — a font that already has /ToUnicode is skipped', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('x', { x: 20, y: 100, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());

    expect(fontToUnicodeService.synthesizeToUnicode(reloaded).fontsProcessed).toBe(1);
    // second pass finds nothing to do
    const second = fontToUnicodeService.synthesizeToUnicode(reloaded);
    expect(second.fontsProcessed).toBe(0);
    expect(second.fontsSkipped).toBeGreaterThanOrEqual(1);
  });
});
