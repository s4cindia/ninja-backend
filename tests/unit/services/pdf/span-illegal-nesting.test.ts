/**
 * Tests for findSpanIllegalNestingViolations -- see span-illegal-nesting.ts's
 * own header comment for the S4 QC finding this addresses ("child Span tags
 * incorrectly placed as parent elements").
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFNumber } from 'pdf-lib';
import { findSpanIllegalNestingViolations } from '../../../../src/services/pdf/span-illegal-nesting';

function setStructRoot(doc: PDFDocument, rootKRef: PDFRef): void {
  const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootKRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);
}

describe('findSpanIllegalNestingViolations', () => {
  it('flags a Span whose sole child is a /P, auto-fixable when its own parent is a Grouping type', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);

    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: pRef }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(pRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);

    setStructRoot(doc, divRef);

    const results = findSpanIllegalNestingViolations(doc);
    expect(results).toHaveLength(1);
    expect(results[0].spanRef.objectNumber).toBe(spanRef.objectNumber);
    expect(results[0].parentRef.objectNumber).toBe(divRef.objectNumber);
    expect(results[0].parentS).toBe('Div');
    expect(results[0].illegalChildTags).toEqual(['P']);
    expect(results[0].autoFixable).toBe(true);
    expect(results[0].page).toBe(1);
  });

  it('is auto-fixable when the Span sits directly under the StructTreeRoot', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: h1Ref }));

    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: spanRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findSpanIllegalNestingViolations(doc);
    expect(results).toHaveLength(1);
    expect(results[0].autoFixable).toBe(true);
  });

  it('is NOT auto-fixable when the Span\'s real parent is itself Block-level (promoting would just relocate the violation)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: h1Ref }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef }));
    doc.context.lookup(h1Ref)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);

    setStructRoot(doc, pRef);

    const results = findSpanIllegalNestingViolations(doc);
    expect(results).toHaveLength(1);
    expect(results[0].parentS).toBe('P');
    expect(results[0].autoFixable).toBe(false);
  });

  it('is NOT auto-fixable when the Span mixes an illegal block child with legitimate MCR content', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(0), Pg: page.ref }));
    const mcrRef = doc.context.register(doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(1) }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: doc.context.obj([h1Ref, mcrRef]) }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(h1Ref)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);

    setStructRoot(doc, divRef);

    const results = findSpanIllegalNestingViolations(doc);
    expect(results).toHaveLength(1);
    expect(results[0].illegalChildTags).toEqual(['H1']);
    expect(results[0].autoFixable).toBe(false);
  });

  it('flags and reports multiple illegal children on one Span, in document order', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const tableRef = doc.context.register(doc.context.obj({ S: PDFName.of('Table'), K: PDFNumber.of(1), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: doc.context.obj([pRef, tableRef]) }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(pRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(tableRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);

    setStructRoot(doc, divRef);

    const results = findSpanIllegalNestingViolations(doc);
    expect(results).toHaveLength(1);
    expect(results[0].illegalChildTags).toEqual(['P', 'Table']);
    expect(results[0].autoFixable).toBe(true);
  });

  it('does not flag a Span containing only legitimate inline/MCR content', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const mcrRef = doc.context.register(doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(0) }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: mcrRef }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef }));
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);

    setStructRoot(doc, pRef);

    expect(findSpanIllegalNestingViolations(doc)).toHaveLength(0);
  });

  it('does not flag a Span that legitimately contains another inline element (e.g. Code)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const codeRef = doc.context.register(doc.context.obj({ S: PDFName.of('Code'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: codeRef }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef }));
    doc.context.lookup(codeRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);

    setStructRoot(doc, pRef);

    expect(findSpanIllegalNestingViolations(doc)).toHaveLength(0);
  });
});
