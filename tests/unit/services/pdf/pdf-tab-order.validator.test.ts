/**
 * Tests for PDF Tab Order Validator
 *
 * Matterhorn 28-008/28-009 (PDF32000-1:2008 §12.5, §14.8.4.2). Confirmed
 * real via a live PAC 2026 report on Karsaklian_189165_9781606497623.pdf
 * (2026-11-09): of 190 pages, exactly 8 have any /Annots at all, and all 8
 * are missing /Tabs entirely.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfTabOrderValidator } from '../../../../src/services/pdf/validators/pdf-tab-order.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

async function buildDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]); // page 1: no annotations
  doc.addPage([612, 792]); // page 2: has an annotation, no /Tabs
  doc.addPage([612, 792]); // page 3: has an annotation, /Tabs already /S
  doc.addPage([612, 792]); // page 4: has an annotation, /Tabs set to /R (wrong value)
  return doc;
}

function addDummyAnnot(doc: PDFDocument, pageIndex: number): void {
  const page = doc.getPage(pageIndex);
  const annotDict = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] });
  const annotRef = doc.context.register(annotDict);
  page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}

describe('PdfTabOrderValidator', () => {
  it('flags a page with annotations and no /Tabs entry at all as 28-008', async () => {
    const doc = await buildDoc();
    addDummyAnnot(doc, 1); // page 2 (0-indexed 1)
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('TAB-ORDER-NOT-STRUCTURE');
    expect(result.issues[0].pageNumber).toBe(2);
    expect(result.issues[0].matterhornCheckpoint).toBe('28-008');
    expect(result.metadata.pagesWithAnnotations).toBe(1);
  });

  it('flags a page with annotations and /Tabs set to something other than /S as 28-009', async () => {
    const doc = await buildDoc();
    addDummyAnnot(doc, 3); // page 4 (0-indexed 3)
    doc.getPage(3).node.set(PDFName.of('Tabs'), PDFName.of('R'));
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(4);
    expect(result.issues[0].matterhornCheckpoint).toBe('28-009');
  });

  it('does not flag a page with annotations that already has /Tabs = /S', async () => {
    const doc = await buildDoc();
    addDummyAnnot(doc, 2); // page 3 (0-indexed 2)
    doc.getPage(2).node.set(PDFName.of('Tabs'), PDFName.of('S'));
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.pagesWithAnnotations).toBe(1);
  });

  it('does not flag a page with no annotations at all, regardless of /Tabs', async () => {
    const doc = await buildDoc(); // page 1 has no annots
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.pagesWithAnnotations).toBe(0);
  });

  it('does not flag a page whose /Annots array is present but empty', async () => {
    const doc = await buildDoc();
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([]));
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.pagesWithAnnotations).toBe(0);
  });
});
