import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { fontToUnicodeService } from '../../../../src/services/pdf/font-tounicode.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { WINANSI_CODE_TO_UNICODE, glyphNameToUnicode, baseEncodingTable, isValidScalar } from '../../../../src/services/pdf/font-encodings';

function setPartialCMap(doc: PDFDocument, font: PDFDict, cmapBody: string): void {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <ff>',
    'endcodespacerange',
    cmapBody,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const ref = doc.context.register(doc.context.stream(cmap));
  font.set(PDFName.of('ToUnicode'), ref);
}

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
    expect(glyphNameToUnicode('uniD800')).toBeUndefined(); // lone surrogate is not a scalar
  });

  it('exposes Standard/MacRoman base tables and validates scalars', () => {
    expect(baseEncodingTable('/StandardEncoding')![0x27]).toBe(0x2019); // quoteright, not apostrophe
    expect(baseEncodingTable('/StandardEncoding')![0x41]).toBe(0x41); // 'A'
    expect(baseEncodingTable('/MacRomanEncoding')![0x80]).toBe(0xc4); // Ä
    expect(baseEncodingTable('/MacExpertEncoding')).toBeUndefined(); // symbolic → PUA
    expect(isValidScalar(0xd800)).toBe(false); // surrogate
    expect(isValidScalar(0x110000)).toBe(false); // above range
    expect(isValidScalar(0x1d538)).toBe(true); // astral is fine
    expect(isValidScalar(0)).toBe(true); // U+0000 is a valid scalar
    expect(isValidScalar(1.5)).toBe(false); // non-integer
    expect(glyphNameToUnicode('uni0000')).toBe(0); // resolves, no longer forced to PUA
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

  it('honours /Differences precedence and emits astral codepoints as UTF-16BE surrogate pairs', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('AB', { x: 20, y: 100, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());

    // Redefine code 65 → an astral glyph, code 66 → a name not in the AGL subset.
    const fontDict = findFont(reloaded)!;
    fontDict.set(
      PDFName.of('Encoding'),
      reloaded.context.obj({
        BaseEncoding: PDFName.of('WinAnsiEncoding'),
        Differences: reloaded.context.obj([65, PDFName.of('u1D538'), 66, PDFName.of('Omega')]),
      }),
    );

    fontToUnicodeService.synthesizeToUnicode(reloaded);
    const cmap = decodeToUnicode(reloaded, fontDict);

    expect(cmap).toContain('<41> <d835dd38>'); // U+1D538 as a surrogate pair, not <1d538>
    // code 66 was explicitly redefined to Omega (unresolved) — must NOT fall back
    // to the WinAnsi base ('B' = <0042>); it gets a PUA value instead.
    expect(cmap).toContain('<42> <e042>');
    expect(cmap).not.toContain('<42> <0042>');
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

describe('fontToUnicodeService.extendPartialToUnicode', () => {
  // Real incident, confirmed live on Math_Weir_PDF.pdf: pdfa11y's UA-10-002
  // ("/ToUnicode CMap exists but doesn't cover every rendered code") fires
  // when a font's own CMap covers SOME but not all the codes it actually
  // shows. synthesizeToUnicode above explicitly skips any font that
  // already has a CMap; this is the writer for that different gap.
  it("adds an entry for a rendered code the font's existing CMap doesn't cover, leaving the existing entry untouched", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('AB', { x: 20, y: 100, size: 12, font }); // renders codes 0x41 ('A') and 0x42 ('B')
    const reloaded = await PDFDocument.load(await doc.save());
    const fontDict = findFont(reloaded)!;

    // Simulate a real-world partial CMap: only 'A' (0x41) is covered.
    setPartialCMap(reloaded, fontDict, '1 beginbfchar\n<41> <0041>\nendbfchar');

    const result = fontToUnicodeService.extendPartialToUnicode(reloaded);
    expect(result.fontsExtended).toBe(1);
    expect(result.codesAdded).toBe(1);

    const cmap = decodeToUnicode(reloaded, fontDict);
    expect(cmap).toContain('<41> <0041>'); // original entry preserved, byte-for-byte
    expect(cmap).toContain('<42> <0042>'); // newly added, inferred via WinAnsi base encoding
  });

  it('does nothing when the existing CMap already covers every rendered code', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('A', { x: 20, y: 100, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());
    const fontDict = findFont(reloaded)!;
    setPartialCMap(reloaded, fontDict, '1 beginbfchar\n<41> <0041>\nendbfchar');

    const result = fontToUnicodeService.extendPartialToUnicode(reloaded);
    expect(result.fontsExtended).toBe(0);
    expect(result.codesAdded).toBe(0);
  });

  it('leaves a font with NO existing /ToUnicode untouched -- that is synthesizeToUnicode\'s own job, not this one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('A', { x: 20, y: 100, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());
    const fontDict = findFont(reloaded)!;
    expect(fontDict.has(PDFName.of('ToUnicode'))).toBe(false);

    const result = fontToUnicodeService.extendPartialToUnicode(reloaded);
    expect(result.fontsExtended).toBe(0);
    expect(fontDict.has(PDFName.of('ToUnicode'))).toBe(false);
  });

  it('scans codes shown via TJ arrays, not just plain Tj', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // A throwaway draw call just to get pdf-lib to register the font in
    // this page's own /Resources/Font -- drawText with kerning-sensitive
    // text commonly emits TJ, but pdf-lib's own choice of Tj vs TJ isn't
    // guaranteed, so the content stream is overwritten below to be certain
    // this exercises the TJ path specifically.
    page.drawText('x', { x: 0, y: 0, size: 12, font });
    const reloaded = await PDFDocument.load(await doc.save());
    const fontDict = findFont(reloaded)!;
    const fontName = (reloaded.getPage(0).node.Resources()!.get(PDFName.of('Font')) as PDFDict)
      .keys()[0].decodeText().replace(/^\//, '');
    writePageContent(reloaded, 1, `BT /${fontName} 12 Tf 20 100 Td [(A)-20(B)] TJ ET`);
    setPartialCMap(reloaded, fontDict, '1 beginbfchar\n<41> <0041>\nendbfchar');

    const result = fontToUnicodeService.extendPartialToUnicode(reloaded);
    expect(result.fontsExtended).toBe(1);
    expect(result.codesAdded).toBe(1);
    expect(decodeToUnicode(reloaded, fontDict)).toContain('<42> <0042>');
  });
});
