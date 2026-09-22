/**
 * Regression coverage for pdf-font-tounicode.validator.ts: detects a simple
 * font (Type1/TrueType/MMType1/Type3) actually referenced by some page's
 * own /Resources that carries no /ToUnicode CMap (Matterhorn CP10-001).
 * Confirmed real on Math_Weir_PDF.pdf (round 7 PAC report): 705 of 1080
 * real font objects, spread across many pages, produced 858 "Characters in
 * a text object cannot be mapped to Unicode" findings.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfFontToUnicodeValidator } from '../../../../src/services/pdf/validators/pdf-font-tounicode.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

async function buildDoc(fonts: Array<{ subtype: string; hasToUnicode: boolean; referenced?: boolean }>): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);

  const fontRefs = fonts.map(f => {
    const dict: Record<string, unknown> = { Type: PDFName.of('Font'), Subtype: PDFName.of(f.subtype) };
    if (f.hasToUnicode) {
      dict.ToUnicode = doc.context.register(doc.context.stream('/CIDInit /ProcSet findresource begin'));
    }
    return doc.context.register(doc.context.obj(dict));
  });

  const fontDictEntries: Record<string, unknown> = {};
  fonts.forEach((f, i) => {
    if (f.referenced !== false) fontDictEntries[`F${i}`] = fontRefs[i];
  });
  const fontDictRef = doc.context.register(doc.context.obj(fontDictEntries));
  const resourcesRef = doc.context.register(doc.context.obj({ Font: fontDictRef }));
  page.node.set(PDFName.of('Resources'), resourcesRef);

  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

describe('PdfFontToUnicodeValidator', () => {
  it('flags a document with a referenced Type1 font missing /ToUnicode', async () => {
    const parsedPdf = await buildDoc([{ subtype: 'Type1', hasToUnicode: false }]);

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('FONT-TOUNICODE-MISSING');
    expect(result.issues[0].matterhornCheckpoint).toBe('10-001');
    expect(result.metadata).toEqual({ totalFontsReferenced: 1, fontsMissingToUnicode: 1 });
  });

  it('does not flag a document where every referenced font already has /ToUnicode', async () => {
    const parsedPdf = await buildDoc([{ subtype: 'Type1', hasToUnicode: true }, { subtype: 'TrueType', hasToUnicode: true }]);

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalFontsReferenced: 2, fontsMissingToUnicode: 0 });
  });

  it('counts multiple missing fonts into a single document-level issue, not one issue per font', async () => {
    const parsedPdf = await buildDoc([
      { subtype: 'Type1', hasToUnicode: false },
      { subtype: 'TrueType', hasToUnicode: false },
      { subtype: 'Type1', hasToUnicode: true },
    ]);

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.metadata.fontsMissingToUnicode).toBe(2);
    expect(result.issues[0].message).toContain('2 font(s)');
  });

  it('does not flag a Type0/CIDFont missing /ToUnicode -- out of scope for the synthesis fix', async () => {
    const parsedPdf = await buildDoc([{ subtype: 'Type0', hasToUnicode: false }]);

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
  });

  it('does not flag a font object that exists in the file but is never referenced by any page\'s own /Resources', async () => {
    const parsedPdf = await buildDoc([{ subtype: 'Type1', hasToUnicode: false, referenced: false }]);

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalFontsReferenced: 0, fontsMissingToUnicode: 0 });
  });

  it('returns no issues when the document has no pages at all', async () => {
    const doc = await PDFDocument.create();
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfFontToUnicodeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ totalFontsReferenced: 0, fontsMissingToUnicode: 0 });
  });
});
