/**
 * Regression coverage for fixArtifactActualTextSibling -- retags a real
 * letter an authoring tool mis-marked /Artifact beside an already-tagged
 * /Span <</ActualText>> sibling. Confirmed live on
 * Karsaklian_189165_9781606497623: Adobe InDesign's own running-header
 * export splits a word letter-by-letter, and the letters whose decorative/
 * swash glyph substitution it couldn't resolve back to Unicode at export
 * time got /Artifact instead of the ActualText fallback its OTHER letters
 * correctly got (991 occurrences, 156 pages). Pure content-stream
 * reclassification -- unlike every other fixer in this file, never touches
 * the structure tree, /ParentTree, or any struct element, since
 * /Span <</ActualText>> is confirmed real on this exact document to carry
 * no /MCID at all.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: `issue-page-${pageNumber ?? 'none'}`,
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ARTIFACT-HIDES-ACTUALTEXT-SIBLING',
    message: 'Letter(s) marked /Artifact beside an already-tagged ActualText sibling',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    category: 'structure',
    pageNumber,
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

/** Real shape confirmed live on page 12: the running-header word
 * "Description", "D" and "O" mis-marked /Artifact, "ESCRIPTI" and "N"
 * correctly tagged /Span <</ActualText>>. A real font with a real
 * /ToUnicode CMap covering D/O/d/o/N/n is registered so the fix can
 * actually resolve the bytes, not just locate them. */
async function buildDescriptionDoc(): Promise<{ doc: PDFDocument; fontTag: string }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);

  // A minimal real Type1 font dict with a real /ToUnicode CMap stream --
  // single-byte codes equal to the real letters themselves (D=0x44,
  // O=0x4f -> lowercase o, mid-word, matching the real document), same
  // shape+convention as this file's own LINK-MISSING-ANNOTATION ligature
  // test (doc.context.stream(...), not pdf-lib's own flate helper).
  const cmapText = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n2 beginbfchar\n<44> <0044>\n<4f> <006f>\nendbfchar\nendcmap\nend\nend';
  const toUnicodeRef = doc.context.register(doc.context.stream(cmapText));
  const fontDict = doc.context.obj({
    Type: PDFName.of('Font'),
    Subtype: PDFName.of('Type1'),
    BaseFont: PDFName.of('GoudyStd'),
    ToUnicode: toUnicodeRef,
  });
  const fontRef = doc.context.register(fontDict);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

  const content =
    '/T1_0 1 Tf\n' +
    '/Artifact <</O /Layout >>BDC \nBT\n8 0 0 8 87 608.9656 Tm\n(D)Tj\n EMC ' +
    '/Span<</ActualText<FEFF00650073006300720069007000740069>>> BDC \n(ESCRIPTI)Tj\n' +
    'EMC /Artifact BMC  \n(O)Tj\n EMC ' +
    '/Span<</ActualText<FEFF006E>>> BDC \n(N)Tj\nEMC\nET\n';
  writePageContent(doc, 1, content);

  return { doc, fontTag: '/T1_0' };
}

describe('PdfStructureWriterService.fixArtifactActualTextSibling', () => {
  it('retags the real Karsaklian_189165 "Description" shape -- D and O -- as /Span <</ActualText>>, leaving the already-tagged siblings untouched', async () => {
    const { doc } = await buildDescriptionDoc();
    const before = decodePageContent(doc, 1)!;

    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(true);
    expect(result.after).toContain('Do');

    const after = decodePageContent(doc, 1)!;
    expect(after).toContain('/Span <</ActualText (D)>> BDC');
    expect(after).toContain('/Span <</ActualText (o)>> BDC');
    // The already-tagged siblings are byte-for-byte untouched.
    expect(after).toContain('/Span<</ActualText<FEFF00650073006300720069007000740069>>> BDC');
    expect(after).toContain('/Span<</ActualText<FEFF006E>>> BDC');
    // No /Artifact survives from this word.
    expect(after).not.toContain('/Artifact');
    expect(after).not.toBe(before);
  });

  it('is idempotent -- running it again on the already-fixed page finds nothing left to do', async () => {
    const { doc } = await buildDescriptionDoc();
    pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));

    const second = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already fixed|moved/i);
  });

  it('declines (does not guess) when the active font has no /ToUnicode entry for the Artifact-wrapped byte, leaving the content stream completely untouched', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    // A font with NO /ToUnicode at all.
    const fontDict = doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('GoudyStd') });
    const fontRef = doc.context.register(fontDict);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const content =
      '/T1_0 1 Tf\n/Artifact BMC \n(D)Tj\nEMC /Span<</ActualText<0065>>> BDC \n(e)Tj\nEMC\n';
    writePageContent(doc, 1, content);
    const before = decodePageContent(doc, 1)!;

    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ToUnicode/i);
    expect(decodePageContent(doc, 1)).toBe(before);
  });

  // Real, confirmed pattern (WPVP_180188_9798986469300_txt.pdf, 2026-11-10):
  // two different fonts (/TT1, /TT0) each had a /ToUnicode CMap with no
  // entry for byte 149 (0x95) -- CP1252's bullet character. Both declared
  // WinAnsiEncoding, so the byte's own code-point identity under that
  // confirmed encoding is a fact, not a guess, even though the sibling-
  // detection logic this fixer targets is specifically about decorative
  // glyph SUBSTITUTION (the drawn glyph can differ; the character identity
  // can't, once the encoding is confirmed).
  it('resolves byte 149 as U+2022 BULLET when the active font explicitly declares WinAnsiEncoding, even with no /ToUnicode entry for it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fontDict = doc.context.obj({
      Type: PDFName.of('Font'),
      Subtype: PDFName.of('Type1'),
      BaseFont: PDFName.of('GoudyStd'),
      Encoding: PDFName.of('WinAnsiEncoding'),
    });
    const fontRef = doc.context.register(fontDict);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const bulletByte = String.fromCharCode(0x95);
    const content =
      `/T1_0 1 Tf\n/Artifact BMC \n(${bulletByte})Tj\nEMC /Span<</ActualText<0065>>> BDC \n(e)Tj\nEMC\n`;
    writePageContent(doc, 1, content);

    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(true);
    expect(result.after).toContain('•');

    // Written as a UTF-16BE hex string (<FEFF...>), not a plain literal --
    // U+2022 doesn't fit in a single Latin-1 byte.
    const after = decodePageContent(doc, 1)!;
    expect(after).toContain('/Span <</ActualText <FEFF2022>>> BDC');
  });

  it('still declines on byte 149 when the font has no explicit /Encoding entry -- an implicit/built-in encoding is not a confirmed WinAnsiEncoding declaration', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fontDict = doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('GoudyStd') });
    const fontRef = doc.context.register(fontDict);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const byte149 = String.fromCharCode(0x95);
    const content =
      `/T1_0 1 Tf\n/Artifact BMC \n(${byte149})Tj\nEMC /Span<</ActualText<0065>>> BDC \n(e)Tj\nEMC\n`;
    writePageContent(doc, 1, content);
    const before = decodePageContent(doc, 1)!;

    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ToUnicode/i);
    expect(decodePageContent(doc, 1)).toBe(before);
  });

  it('resolves byte 149 as i-dieresis (U+00EF), NOT bullet, when the font explicitly declares MacRomanEncoding -- confirms the fallback reads the font\'s OWN declared encoding rather than assuming WinAnsi/CP1252 universally', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fontDict = doc.context.obj({
      Type: PDFName.of('Font'),
      Subtype: PDFName.of('Type1'),
      BaseFont: PDFName.of('GoudyStd'),
      Encoding: PDFName.of('MacRomanEncoding'),
    });
    const fontRef = doc.context.register(fontDict);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const byte149 = String.fromCharCode(0x95);
    const content =
      `/T1_0 1 Tf\n/Artifact BMC \n(${byte149})Tj\nEMC /Span<</ActualText<0065>>> BDC \n(e)Tj\nEMC\n`;
    writePageContent(doc, 1, content);

    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(true);
    expect(result.after).toContain('ï');
    expect(result.after).not.toContain('•');
  });

  it('declines cleanly when the page has no content stream at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(1));
    expect(result.success).toBe(false);
  });

  it('declines when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const result = pdfStructureWriterService.fixArtifactActualTextSibling(doc, issueForPage(undefined));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pageNumber/i);
  });
});
