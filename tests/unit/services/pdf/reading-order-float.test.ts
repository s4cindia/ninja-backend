/**
 * Tests for findFloatInterruptions -- see reading-order-float.ts's own
 * header comment for the real incident this was built for
 * (Karsaklian_189165_9781606497623.pdf, S4 Carlisle manual QC Round 2
 * item #2, informally described as "highlight tags... grouped at the end
 * of the document"). The real shape: a two-element /Story wrapper (whose
 * own child -- an /EPI epigraph -- carries the real /Pg) is a top-level
 * sibling of the book's one big flat flow /Story, positioned AFTER it,
 * even though its own content sits on a page the flow container's own
 * direct children already span.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFNumber } from 'pdf-lib';
import { findFloatInterruptions } from '../../../../src/services/pdf/reading-order-float';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

async function buildTwoPageDoc(): Promise<{ doc: PDFDocument; page1Ref: PDFRef; page2Ref: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([400, 600]);
  const page2 = doc.addPage([400, 600]);
  writePageContent(
    doc,
    1,
    '/P <</MCID 0>> BDC (A)Tj EMC\n' +
    '/P <</MCID 1>> BDC (B)Tj EMC\n' +
    '/P <</MCID 2>> BDC (Epigraph)Tj EMC\n' +
    '/P <</MCID 3>> BDC (C)Tj EMC\n'
  );
  writePageContent(doc, 2, '/P <</MCID 4>> BDC (D)Tj EMC\n/P <</MCID 5>> BDC (E)Tj EMC\n');
  return { doc, page1Ref: page1.ref, page2Ref: page2.ref };
}

function makeLeaf(doc: PDFDocument, tag: string, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), Pg: pageRef, K: PDFNumber.of(mcid) }));
}

describe('findFloatInterruptions', () => {
  it('flags a wrapper sibling positioned after the main flow despite its content sitting inside the flow\'s own span', async () => {
    const { doc, page1Ref, page2Ref } = await buildTwoPageDoc();

    const a = makeLeaf(doc, 'P', page1Ref, 0);
    const b = makeLeaf(doc, 'P', page1Ref, 1);
    const c = makeLeaf(doc, 'P', page1Ref, 3);
    const d = makeLeaf(doc, 'P', page2Ref, 4);
    const e = makeLeaf(doc, 'P', page2Ref, 5);
    const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([a, b, c, d, e]) }));

    const epi = makeLeaf(doc, 'EPI', page1Ref, 2);
    const wrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: epi })); // no own /Pg

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([flowRef, wrapperRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findFloatInterruptions(doc);

    expect(results).toHaveLength(1);
    expect(results[0].misplacedRef.objectNumber).toBe(wrapperRef.objectNumber);
    expect(results[0].misplacedS).toBe('Story');
    expect(results[0].containerRef.objectNumber).toBe(flowRef.objectNumber);
    expect(results[0].parentRef.objectNumber).toBe(rootRef.objectNumber);
    expect(results[0].minPage).toBe(1);
    expect(results[0].maxPage).toBe(1);
    expect(results[0].minMcid).toBe(2);
    expect(results[0].maxMcid).toBe(2);
    expect(results[0].anchor).not.toBeNull();
    expect(results[0].anchor!.afterRef.objectNumber).toBe(b.objectNumber);
  });

  it('does not flag when the sibling is already correctly positioned before the flow it would otherwise be contained by', async () => {
    const { doc, page1Ref } = await buildTwoPageDoc();
    const a = makeLeaf(doc, 'P', page1Ref, 0);
    const b = makeLeaf(doc, 'P', page1Ref, 1);
    const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([a, b]) }));

    const epi = makeLeaf(doc, 'EPI', page1Ref, 0);
    const wrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: epi }));

    // wrapper comes FIRST in array order -- never flagged (containment check only
    // ever runs i<j, and a single-page sibling never qualifies as a "container" anyway).
    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([wrapperRef, flowRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findFloatInterruptions(doc)).toHaveLength(0);
  });

  it('does not flag a later sibling whose own range genuinely falls after the flow (e.g. a back-matter section)', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    const page3 = doc.addPage([400, 600]);
    writePageContent(doc, 1, '/P <</MCID 0>> BDC (A)Tj EMC\n');
    writePageContent(doc, 2, '/P <</MCID 1>> BDC (B)Tj EMC\n');
    writePageContent(doc, 3, '/P <</MCID 2>> BDC (Index)Tj EMC\n');

    const a = makeLeaf(doc, 'P', page1.ref, 0);
    const b = makeLeaf(doc, 'P', page2.ref, 1);
    const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([a, b]) }));

    const indexLeaf = makeLeaf(doc, 'IDX1', page3.ref, 2);
    const indexWrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: indexLeaf }));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([flowRef, indexWrapperRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findFloatInterruptions(doc)).toHaveLength(0);
  });

  it('does NOT flag a sibling that is merely adjacent to (not nested inside) the flow\'s own last entry -- deliberately not generalized', async () => {
    // This is the real Karsaklian_189165_9781606497623.pdf Figure@page185
    // shape (a cover-page Figure whose own MCID is exactly one past the
    // flow's own final MCID, same page) -- a real instance, but a looser
    // "exactly adjacent" rule was tried and reverted (see findAnchor's own
    // doc comment): this producer's globally-increasing MCID convention
    // makes that condition trivially true for almost every correctly
    // ordered adjacent pair anywhere in the tree, not just this one real
    // misplaced case. Accepted as an undetected residual rather than
    // risking a flood of false positives.
    const { doc, page1Ref, page2Ref } = await buildTwoPageDoc();
    const a = makeLeaf(doc, 'P', page1Ref, 0);
    const b = makeLeaf(doc, 'P', page2Ref, 1);
    const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([a, b]) }));

    const figure = makeLeaf(doc, 'Figure', page2Ref, 2); // exactly b.mcid(1) + 1, same page as the flow's own last entry
    const figureWrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: figure }));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([flowRef, figureWrapperRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findFloatInterruptions(doc)).toHaveLength(0);
  });

  it('declines (anchor === null) when the misplaced range is nested inside a single flow child rather than between two', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    writePageContent(
      doc,
      1,
      '/P <</MCID 0>> BDC (wide run)Tj EMC\n' +
      '/P <</MCID 1>> BDC (table content carved out of the same run)Tj EMC\n' +
      '/P <</MCID 2>> BDC (more wide run)Tj EMC\n'
    );
    writePageContent(doc, 2, '/P <</MCID 3>> BDC (D)Tj EMC\n');

    // One flow child (wide) whose own /K spans MCIDs 0 AND 2 (skipping 1,
    // which belongs to the misplaced table) -- same shape as the real
    // Karsaklian idx283 /TX mcidRange=2195-2251 case that swallowed the
    // declined standalone-table sibling.
    const wide = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1.ref,
      K: doc.context.obj([PDFNumber.of(0), PDFNumber.of(2)]),
    }));
    const d = makeLeaf(doc, 'P', page2.ref, 3);
    const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([wide, d]) }));

    const tableCell = makeLeaf(doc, 'TD', page1.ref, 1);
    const tableWrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: tableCell }));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([flowRef, tableWrapperRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findFloatInterruptions(doc);
    expect(results).toHaveLength(1);
    expect(results[0].misplacedRef.objectNumber).toBe(tableWrapperRef.objectNumber);
    expect(results[0].anchor).toBeNull();
  });

  it('returns no results for a document with no structure tree', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    expect(findFloatInterruptions(doc)).toHaveLength(0);
  });
});
