/**
 * Tests for findStructureParentMismatches -- see structure-parent-mismatch.ts's
 * own header comment for the real incident (Karsaklian_189165_9781606497623.pdf
 * round 15: 49 instances caught by an independent PAC/veraPDF re-check,
 * root-caused to fixReadingOrderFloatInterruption's missing /P update).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFNumber } from 'pdf-lib';
import { findStructureParentMismatches } from '../../../../src/services/pdf/structure-parent-mismatch';

function makeLeaf(doc: PDFDocument, tag: string, parentRef: PDFRef, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), P: parentRef, Pg: pageRef, K: PDFNumber.of(mcid) }));
}

describe('findStructureParentMismatches', () => {
  it('flags an element whose own /P disagrees with the dict that actually contains it in /K', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);

    // Build two sibling containers; create the leaf declaring itself a
    // child of containerA's /P, then actually place it in containerB's /K
    // -- exactly the shape fixReadingOrderFloatInterruption's missing /P
    // update produced (correct /K move, stale /P left behind).
    const containerARef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const containerBRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const leaf = makeLeaf(doc, 'TX', containerARef, page.ref, 0);
    doc.context.lookup(containerBRef)!.set(PDFName.of('K'), doc.context.obj([leaf]));
    doc.context.lookup(containerARef)!.set(PDFName.of('K'), doc.context.obj([]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([containerARef, containerBRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findStructureParentMismatches(doc);

    expect(results).toHaveLength(1);
    expect(results[0].ref.objectNumber).toBe(leaf.objectNumber);
    expect(results[0].tag).toBe('TX');
    expect(results[0].declaredParentRef.objectNumber).toBe(containerARef.objectNumber);
    expect(results[0].actualParentRef.objectNumber).toBe(containerBRef.objectNumber);
    expect(results[0].actualParentS).toBe('Story');
    expect(results[0].page).toBe(1);
  });

  it('does not flag an element whose /P correctly matches its real parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const containerRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const leaf = makeLeaf(doc, 'TX', containerRef, page.ref, 0);
    doc.context.lookup(containerRef)!.set(PDFName.of('K'), doc.context.obj([leaf]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: containerRef }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findStructureParentMismatches(doc)).toHaveLength(0);
  });

  it('inherits a representative page from an ancestor or descendant when the mismatched element has no /Pg of its own', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const containerARef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const containerBRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    // The misplaced element itself has no /Pg -- only its own child does.
    // grandchild's own /P must correctly point at `wrapper` (its REAL
    // parent) -- only `wrapper` itself is the intentional mismatch here.
    const wrapper = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), P: containerARef }));
    const grandchild = makeLeaf(doc, 'TX', wrapper, page.ref, 0);
    doc.context.lookup(wrapper)!.set(PDFName.of('K'), grandchild);
    doc.context.lookup(containerBRef)!.set(PDFName.of('K'), doc.context.obj([wrapper]));
    doc.context.lookup(containerARef)!.set(PDFName.of('K'), doc.context.obj([]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([containerARef, containerBRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const results = findStructureParentMismatches(doc);
    expect(results).toHaveLength(1);
    expect(results[0].ref.objectNumber).toBe(wrapper.objectNumber);
    expect(results[0].page).toBe(1);
  });

  it('does not flag an MCR/OBJR dict entry in /K (no /S, not a real struct element)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const containerRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const mcrRef = doc.context.register(doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(0) }));
    doc.context.lookup(containerRef)!.set(PDFName.of('K'), doc.context.obj([mcrRef]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: containerRef }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    expect(findStructureParentMismatches(doc)).toHaveLength(0);
  });
});
