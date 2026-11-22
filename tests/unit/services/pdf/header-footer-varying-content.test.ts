/**
 * Tests for findVaryingHeaderFooterCandidates -- see
 * header-footer-varying-content.ts's own header comment for the real
 * incident this was built for (Karsaklian_189165_9781606497623.pdf: a
 * per-chapter running head, letter-by-letter MCID-tagged, nested as a
 * struct-element child of an unrelated list item's /Lbl).
 *
 * Page size [400, 600] throughout, matching reading-order-float.test.ts's
 * own convention -- header band starts at y=528 (600 - 600*0.12), footer
 * band ends at y=60 (600*0.10).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { findVaryingHeaderFooterCandidates } from '../../../../src/services/pdf/header-footer-varying-content';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

function span(mcid: number, x: number, y: number, text: string): string {
  return `/Span <</MCID ${mcid}>> BDC\nBT\n1 0 0 1 ${x} ${y} Tm\n(${text})Tj\nET\nEMC\n`;
}

describe('findVaryingHeaderFooterCandidates', () => {
  it('reconstructs full text across multiple MCIDs in order, within the header band', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    writePageContent(doc, 1, span(0, 50, 550, 'Chap') + span(1, 90, 550, 'ter 1'));

    const candidateRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Span'),
      Pg: page.ref,
      K: doc.context.obj([PDFNumber.of(0), PDFNumber.of(1)]),
    }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: candidateRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findVaryingHeaderFooterCandidates(doc);
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Chapter 1');
    expect(results[0].region).toBe('header');
    expect(results[0].page).toBe(1);
    expect(results[0].mcids).toEqual([0, 1]);
  });

  it('disqualifies a struct element whose /K mixes a bare MCID with a nested struct-element child, but still finds that child as its own candidate', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    writePageContent(doc, 1, span(2, 50, 550, 'parent-own-mcid') + span(3, 50, 540, 'Nested'));

    const childRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Span'),
      Pg: page.ref,
      K: PDFNumber.of(3),
    }));
    const parentRef = doc.context.register(doc.context.obj({
      S: PDFName.of('Lbl'),
      Pg: page.ref,
      K: doc.context.obj([PDFNumber.of(2), childRef]),
    }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: parentRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findVaryingHeaderFooterCandidates(doc);
    expect(results).toHaveLength(1);
    expect(results[0].ref.objectNumber).toBe(childRef.objectNumber);
    expect(results[0].text).toBe('Nested');
  });

  it('does not produce a candidate for a struct element whose content sits outside both the header and footer band', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    writePageContent(doc, 1, span(0, 50, 300, 'Body text'));

    const candidateRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), Pg: page.ref, K: PDFNumber.of(0) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: candidateRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findVaryingHeaderFooterCandidates(doc)).toHaveLength(0);
  });

  it('recognizes the footer band symmetrically', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    writePageContent(doc, 1, span(0, 50, 30, 'Footer text'));

    const candidateRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), Pg: page.ref, K: PDFNumber.of(0) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: candidateRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findVaryingHeaderFooterCandidates(doc);
    expect(results).toHaveLength(1);
    expect(results[0].region).toBe('footer');
  });

  it('skips a struct element with no /Pg at all (no page to resolve)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const candidateRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: PDFNumber.of(0) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: candidateRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findVaryingHeaderFooterCandidates(doc)).toHaveLength(0);
  });

  it('returns no results for a document with no structure tree', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    expect(findVaryingHeaderFooterCandidates(doc)).toHaveLength(0);
  });

  it('skips a bare-MCID-only element whose assembled text is empty after trimming', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    // Draws real geometry (so a bounding box would otherwise be found) but
    // its only text-show operand is pure whitespace -- isolates the
    // "assembled text is empty after trim" guard from the separate "no
    // geometry at all" case the other tests already cover implicitly.
    writePageContent(doc, 1, span(0, 50, 550, ' '));

    const candidateRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), Pg: page.ref, K: PDFNumber.of(0) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: candidateRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findVaryingHeaderFooterCandidates(doc)).toHaveLength(0);
  });
});
