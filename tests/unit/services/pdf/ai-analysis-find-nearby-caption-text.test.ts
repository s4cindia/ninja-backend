/**
 * QC brief Theme B3 (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * findNearbyCaptionText -- best-effort lookup of a Caption sibling's own
 * text, used by the short-alt-baseline rejection filter to decline a
 * drafted alt text that just echoes the printed caption verbatim. Uses a
 * real pdf-lib document (same convention as duplicate-figure-tiles.test.ts)
 * rather than mocking PDFDict, since `instanceof PDFDict` can't be faked
 * with a plain mock object.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { findNearbyCaptionText } from '../../../../src/services/pdf/ai-analysis.service';

const FIGURE_BBOX = { x: 100, y: 400, width: 200, height: 150, pageWidth: 612, pageHeight: 792 };

async function makeDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc;
}

describe('findNearbyCaptionText', () => {
  it('returns null outright when the issue has no boundingBox', async () => {
    const doc = await makeDoc();
    expect(findNearbyCaptionText(doc, 1, undefined)).toBeNull();
  });

  it('returns the Caption\'s own text when one sits directly below the Figure with a small gap', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const captionRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Caption'), Pg: page.ref, K: 7, Alt: PDFString.of('unused') })
    );
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [captionRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
    // Directly below the figure (figure bottom at y=400, caption top at
    // y=385 in this test's own convention -- a small gap), horizontally aligned.
    writePageContent(doc, 1, '<</MCID 7>>BDC BT 11 0 0 11 110 385 Tm (Figure 5.2: The BATNA box) Tj ET EMC');

    expect(findNearbyCaptionText(doc, 1, FIGURE_BBOX)).toBe('Figure 5.2: The BATNA box');
  });

  it('returns null when no Caption-tagged element exists on the page at all', async () => {
    const doc = await makeDoc();
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));

    expect(findNearbyCaptionText(doc, 1, FIGURE_BBOX)).toBeNull();
  });

  it('returns null when a Caption exists but is horizontally far from the Figure', async () => {
    const doc = await makeDoc();
    const page = doc.getPage(0);
    const captionRef = doc.context.register(
      doc.context.obj({ S: PDFName.of('Caption'), Pg: page.ref, K: 7 })
    );
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [captionRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
    writePageContent(doc, 1, '<</MCID 7>>BDC BT 11 0 0 11 500 385 Tm (Unrelated caption) Tj ET EMC');

    expect(findNearbyCaptionText(doc, 1, FIGURE_BBOX)).toBeNull();
  });
});
