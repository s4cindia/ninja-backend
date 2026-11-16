/**
 * Tests for findDuplicateFigureTiles -- see duplicate-figure-tiles.ts's own
 * header comment for the S4 QC finding this addresses ("a single image was
 * tagged with two separate Figure tags and contained duplicate alternative
 * text descriptions"). Fixture style mirrors structure-tag-inventory.
 * service.test.ts's own (register bare struct elements, write raw
 * content-stream ops via writePageContent).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef } from 'pdf-lib';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { findDuplicateFigureTiles } from '../../../../src/services/pdf/duplicate-figure-tiles';

async function makeDoc(pageCount = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  return doc;
}

describe('findDuplicateFigureTiles', () => {
  it('groups two adjacent sibling Figures with identical alt text, primary first in document order', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('A photo of a mountain') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('A photo of a mountain') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    // fig1 device box: x 100-170, y 500. fig2: x 170-240, y 500 -- touching fig1's right edge exactly.
    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 170 500 cm 0 0 m 70 0 l S Q EMC'
    );

    const groups = findDuplicateFigureTiles(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0].pageNumber).toBe(1);
    expect(groups[0].parentRef.objectNumber).toBe(divRef.objectNumber);
    expect(groups[0].primaryRef.objectNumber).toBe(fig1.objectNumber);
    expect(groups[0].duplicateRefs.map(r => r.objectNumber)).toEqual([fig2.objectNumber]);
    expect(groups[0].altText).toBe('A photo of a mountain');
  });

  it('does not group two Figures that are far apart, even with identical alt text', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('A chart') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('A chart') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 400 100 cm 0 0 m 70 0 l S Q EMC'
    );

    expect(findDuplicateFigureTiles(doc)).toHaveLength(0);
  });

  it('does not group two adjacent Figures whose alt text differs', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('Left half of diagram') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('Right half of diagram') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 170 500 cm 0 0 m 70 0 l S Q EMC'
    );

    expect(findDuplicateFigureTiles(doc)).toHaveLength(0);
  });

  it('does not group Figures with no alt text at all', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1 }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2 }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 170 500 cm 0 0 m 70 0 l S Q EMC'
    );

    expect(findDuplicateFigureTiles(doc)).toHaveLength(0);
  });

  it('transitively groups a chain of three adjacent tiles into one group', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('Panorama') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('Panorama') }));
    const fig3 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 3, Alt: PDFString.of('Panorama') }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1, fig2, fig3] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    // fig1: x 0-70. fig2: x 70-140 (touches fig1). fig3: x 140-210 (touches fig2, NOT fig1 directly).
    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 0 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 70 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 3>>BDC q 1 0 0 1 140 500 cm 0 0 m 70 0 l S Q EMC'
    );

    const groups = findDuplicateFigureTiles(doc);
    expect(groups).toHaveLength(1);
    expect(groups[0].primaryRef.objectNumber).toBe(fig1.objectNumber);
    expect(groups[0].duplicateRefs.map(r => r.objectNumber)).toEqual([fig2.objectNumber, fig3.objectNumber]);
  });

  it('does not group Figures under different parents', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

    const fig1 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 1, Alt: PDFString.of('Same text') }));
    const fig2 = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 2, Alt: PDFString.of('Same text') }));
    const divA = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig1] }));
    const divB = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: [fig2] }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [divA, divB] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    writePageContent(
      doc, 1,
      '<</MCID 1>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC ' +
      '<</MCID 2>>BDC q 1 0 0 1 170 500 cm 0 0 m 70 0 l S Q EMC'
    );

    expect(findDuplicateFigureTiles(doc)).toHaveLength(0);
  });

  it('is auto-fixable via PdfStructureWriterService.fixDuplicateFigureTiles end to end', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);

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

    const { pdfStructureWriterService } = await import('../../../../src/services/pdf/pdf-structure-writer.service');
    const result = pdfStructureWriterService.fixDuplicateFigureTiles(doc, {
      id: 'issue-1', source: 'pdf-duplicate-figure-tiles', severity: 'moderate', code: 'DUPLICATE-FIGURE-TILES',
      message: 'test', element: `duplicate-figure-tiles_r${fig1.objectNumber}`, pageNumber: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(result.success).toBe(true);

    const divK = (doc.context.lookup(divRef) as PDFDict).get(PDFName.of('K')) as PDFArray;
    expect(divK.size()).toBe(1);
    expect((divK.get(0) as PDFRef).objectNumber).toBe(fig1.objectNumber);

    const fig1K = (doc.context.lookup(fig1) as PDFDict).get(PDFName.of('K')) as PDFArray;
    expect(fig1K.size()).toBe(2);
  });
});
