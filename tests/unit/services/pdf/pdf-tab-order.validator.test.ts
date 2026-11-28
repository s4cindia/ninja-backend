/**
 * Tests for PDF Tab Order Validator
 *
 * Matterhorn 28-008/28-009 (PDF32000-1:2008 §12.5, §14.8.4.2). Confirmed
 * real via a live PAC 2026 report on Karsaklian_189165_9781606497623.pdf
 * (2026-11-09): of 190 pages, exactly 8 have any /Annots at all, and all 8
 * are missing /Tabs entirely.
 *
 * Widened 2026-11-28 (QC F-21): also flags a page with NO annotations at
 * all when it's missing /Tabs=/S, matching Acrobat's own broader "Tab
 * order" check rather than Matterhorn 28-008/28-009's narrower
 * annotation-scoped wording -- see the validator's own header comment.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfTabOrderValidator } from '../../../../src/services/pdf/validators/pdf-tab-order.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

// Every page defaults to /Tabs = /S already correct -- the widened
// validator (2026-11-28) now flags ANY page missing it, annotated or not,
// so each test clears/overrides only the one page it's actually testing
// rather than relying on the other 3 pages happening to go unflagged.
async function buildDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
  }
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
    doc.getPage(1).node.delete(PDFName.of('Tabs'));
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('TAB-ORDER-NOT-STRUCTURE');
    expect(result.issues[0].pageNumber).toBe(2);
    expect(result.issues[0].severity).toBe('moderate');
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
    addDummyAnnot(doc, 2); // page 3 (0-indexed 2) -- already /Tabs = /S by default
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.pagesWithAnnotations).toBe(1);
  });

  it('flags a page with no annotations at all when /Tabs is missing, as a minor-severity issue (QC F-21)', async () => {
    const doc = await buildDoc();
    doc.getPage(0).node.delete(PDFName.of('Tabs')); // page 1: no annots, no /Tabs
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].severity).toBe('minor');
    expect(result.issues[0].matterhornCheckpoint).toBe('28-008');
    expect(result.metadata.pagesWithAnnotations).toBe(0);
  });

  it('does not flag a page with no annotations that already has /Tabs = /S', async () => {
    const doc = await buildDoc(); // page 1: no annots, /Tabs = /S by default
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
  });

  it('flags a page whose /Annots array is present but empty the same as one with none at all', async () => {
    const doc = await buildDoc();
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([]));
    doc.getPage(0).node.delete(PDFName.of('Tabs'));
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfTabOrderValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].severity).toBe('minor');
    expect(result.metadata.pagesWithAnnotations).toBe(0);
  });
});
