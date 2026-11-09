/**
 * Tests for findMcidPageMismatches -- see mcid-page-mismatch.ts's own
 * header comment for the real incident this was built for
 * (Karsaklian_189165_9781606497623.pdf, page 54, struct element 531).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFNumber } from 'pdf-lib';
import { findMcidPageMismatches } from '../../../../src/services/pdf/mcid-page-mismatch';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

async function buildDoc(): Promise<{ doc: PDFDocument; page1Ref: PDFRef; page2Ref: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([400, 600]);
  const page2 = doc.addPage([400, 600]);
  // page 1: only real MCID 3.
  writePageContent(doc, 1, '/P <</MCID 3>> BDC (A)Tj EMC\n');
  // page 2: real MCIDs 5 and 10.
  writePageContent(doc, 2, '/P <</MCID 5>> BDC (B)Tj EMC\n/P <</MCID 10>> BDC (C)Tj EMC\n');
  return { doc, page1Ref: page1.ref, page2Ref: page2.ref };
}

function registerStructTree(doc: PDFDocument, elemRef: PDFRef): void {
  const structRoot = doc.context.register(doc.context.obj({
    Type: PDFName.of('StructTreeRoot'),
    K: elemRef,
  }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);
}

describe('findMcidPageMismatches', () => {
  it('flags a bare MCID on its own element\'s /Pg that doesn\'t exist there but exists on exactly one sibling MCR page', async () => {
    const { doc, page1Ref, page2Ref } = await buildDoc();
    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1Ref,
      K: doc.context.obj([
        PDFNumber.of(5), // bare -- implicitly page 1, but 5 doesn't exist there
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2Ref, MCID: PDFNumber.of(10) }),
      ]),
    }));
    registerStructTree(doc, elemRef);

    const results = findMcidPageMismatches(doc);

    expect(results).toHaveLength(1);
    expect(results[0].mcid).toBe(5);
    expect(results[0].wrongPage).toBe(1);
    expect(results[0].correctPage).toBe(2);
    expect(results[0].entryIndex).toBe(0);
    expect(results[0].elementRef.objectNumber).toBe(elemRef.objectNumber);
  });

  it('does not flag a bare MCID that genuinely exists on its own element\'s page', async () => {
    const { doc, page1Ref, page2Ref } = await buildDoc();
    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1Ref,
      K: doc.context.obj([
        PDFNumber.of(3), // correctly placed -- 3 really is on page 1
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2Ref, MCID: PDFNumber.of(10) }),
      ]),
    }));
    registerStructTree(doc, elemRef);

    expect(findMcidPageMismatches(doc)).toHaveLength(0);
  });

  it('declines when the bare MCID does not exist on ANY page (genuinely dangling, not misplaced)', async () => {
    const { doc, page1Ref, page2Ref } = await buildDoc();
    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1Ref,
      K: doc.context.obj([
        PDFNumber.of(999), // doesn't exist anywhere
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2Ref, MCID: PDFNumber.of(10) }),
      ]),
    }));
    registerStructTree(doc, elemRef);

    expect(findMcidPageMismatches(doc)).toHaveLength(0);
  });

  it('declines when the bare MCID exists on more than one sibling page (ambiguous)', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    const page3 = doc.addPage([400, 600]);
    writePageContent(doc, 1, '/P <</MCID 3>> BDC (A)Tj EMC\n');
    writePageContent(doc, 2, '/P <</MCID 5>> BDC (B)Tj EMC\n');
    writePageContent(doc, 3, '/P <</MCID 5>> BDC (D)Tj EMC\n'); // same MCID value, different page

    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1.ref,
      K: doc.context.obj([
        PDFNumber.of(5), // ambiguous -- exists on BOTH page 2 and page 3
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2.ref, MCID: PDFNumber.of(5) }),
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page3.ref, MCID: PDFNumber.of(5) }),
      ]),
    }));
    registerStructTree(doc, elemRef);

    expect(findMcidPageMismatches(doc)).toHaveLength(0);
  });

  it('never flags a bare MCID in a single-page element (no sibling MCR at all)', async () => {
    const { doc, page1Ref } = await buildDoc();
    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('P'),
      Pg: page1Ref,
      K: PDFNumber.of(999), // not on page 1, but no sibling MCR to borrow a page from either
    }));
    registerStructTree(doc, elemRef);

    expect(findMcidPageMismatches(doc)).toHaveLength(0);
  });
});
