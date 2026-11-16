/**
 * Tests for PdfDuplicateFigureTilesValidator -- thin mapping layer over
 * findDuplicateFigureTiles (see duplicate-figure-tiles.test.ts for the real
 * detection-logic coverage).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { pdfDuplicateFigureTilesValidator } from '../../../../src/services/pdf/validators/pdf-duplicate-figure-tiles.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

describe('PdfDuplicateFigureTilesValidator', () => {
  it('emits a DUPLICATE-FIGURE-TILES issue with a re-parseable element id', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('A photo of a mountain') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('A photo of a mountain') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 170 500 cm 0 0 m 70 0 l S Q EMC'
    );

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfDuplicateFigureTilesValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('DUPLICATE-FIGURE-TILES');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toBe(`duplicate-figure-tiles_r${fig1.objectNumber}`);
    expect(issue.category).toBe('images');
    expect(issue.matterhornCheckpoint).toBe('13-006');
    expect(result.metadata.groupsFound).toBe(1);
    expect(result.metadata.duplicateFiguresFound).toBe(1);
  });

  it('emits no issues when there are no duplicate tiles', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('A chart') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(doc, 1, '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC');

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfDuplicateFigureTilesValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.groupsFound).toBe(0);
  });
});
