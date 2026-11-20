/**
 * Regression coverage for PdfHyphenatedLineBreakValidator -- confirms it
 * reports one HYPHENATED-LINE-BREAK issue per pair findHyphenatedLineBreaksOnPage
 * finds, across every page, and that a page with no pairs contributes none.
 * See pdf-structure-writer-hyphenated-line-break.test.ts for the
 * detection/fix heuristic itself -- this file only exercises the thin
 * validator wrapper around it.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfHyphenatedLineBreakValidator } from '../../../../src/services/pdf/validators/pdf-hyphenated-line-break.validator';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

async function buildParsedPdf(pageContents: string[]): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  const fontDict = doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('Helvetica') });
  const fontRef = doc.context.register(fontDict);
  for (const content of pageContents) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: fontRef } }));
  }
  for (let i = 0; i < pageContents.length; i++) {
    writePageContent(doc, i + 1, pageContents[i]);
  }
  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

describe('PdfHyphenatedLineBreakValidator', () => {
  it('reports one HYPHENATED-LINE-BREAK issue for a page with one hyphenated pair', async () => {
    const page1 =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      'ET\n';
    const parsedPdf = await buildParsedPdf([page1]);

    const result = await pdfHyphenatedLineBreakValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'HYPHENATED-LINE-BREAK', pageNumber: 1 });
    expect(result.issues[0].message).toContain('example');
    expect(result.metadata.pairsFound).toBe(1);
  });

  it('reports two issues for a page with two non-overlapping hyphenated pairs', async () => {
    const page1 =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      '/P <</MCID 3>> BDC\n12 0 0 12 72 670 Tm\n(anoth-)Tj\nEMC\n' +
      '/P <</MCID 4>> BDC\n12 0 0 12 72 658 Tm\n(er)Tj\nEMC\n' +
      'ET\n';
    const parsedPdf = await buildParsedPdf([page1]);

    const result = await pdfHyphenatedLineBreakValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(2);
    expect(result.issues.every(i => i.code === 'HYPHENATED-LINE-BREAK')).toBe(true);
  });

  it('reports nothing for a page with no hyphenated line breaks', async () => {
    const page1 =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(ordinary text)Tj\nEMC\n' +
      'ET\n';
    const parsedPdf = await buildParsedPdf([page1]);

    const result = await pdfHyphenatedLineBreakValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.pairsFound).toBe(0);
  });

  it('scans every page independently, reporting pairs from each', async () => {
    const page1 =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      'ET\n';
    const page2 = '/F1 1 Tf\nBT\n/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(ordinary text)Tj\nEMC\nET\n';
    const parsedPdf = await buildParsedPdf([page1, page2]);

    const result = await pdfHyphenatedLineBreakValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(1);
  });
});
