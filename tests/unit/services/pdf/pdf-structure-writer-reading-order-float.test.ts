/**
 * Tests for PdfStructureWriterService.fixReadingOrderFloatInterruption --
 * see reading-order-float.ts's own header comment for the real incident
 * this fixes (Karsaklian_189165_9781606497623.pdf, S4 Carlisle manual QC
 * Round 2 item #2).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function floatIssue(objectNumber: number): AuditIssue {
  return {
    id: 'issue-1',
    source: 'pdf-reading-order-float',
    severity: 'serious',
    code: 'READING-ORDER-FLOAT-INTERRUPTION',
    message: 'test',
    element: `float-interruption_r${objectNumber}`,
    pageNumber: 1,
  } as AuditIssue;
}

function makeLeaf(doc: PDFDocument, tag: string, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), Pg: pageRef, K: PDFNumber.of(mcid) }));
}

async function buildMisplacedDoc(): Promise<{
  doc: PDFDocument; rootRef: PDFRef; flowRef: PDFRef; wrapperRef: PDFRef; bRef: PDFRef; cRef: PDFRef;
}> {
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
  writePageContent(doc, 2, '/P <</MCID 4>> BDC (D)Tj EMC\n');

  const a = makeLeaf(doc, 'P', page1.ref, 0);
  const b = makeLeaf(doc, 'P', page1.ref, 1);
  const c = makeLeaf(doc, 'P', page1.ref, 3);
  const d = makeLeaf(doc, 'P', page2.ref, 4);
  const flowRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: doc.context.obj([a, b, c, d]) }));

  const epi = makeLeaf(doc, 'EPI', page1.ref, 2);
  const wrapperRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story'), K: epi }));

  const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([flowRef, wrapperRef]) }));
  const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

  return { doc, rootRef, flowRef, wrapperRef, bRef: b, cRef: c };
}

describe('PdfStructureWriterService.fixReadingOrderFloatInterruption', () => {
  it('relocates the misplaced wrapper into the flow container, between its confirmed neighbors', async () => {
    const { doc, rootRef, flowRef, wrapperRef, bRef, cRef } = await buildMisplacedDoc();

    const result = pdfStructureWriterService.fixReadingOrderFloatInterruption(doc, floatIssue(wrapperRef.objectNumber));

    expect(result.success).toBe(true);
    expect(result.after).toContain('Relocated');

    // Root no longer holds the wrapper directly.
    const rootDict = doc.context.lookup(rootRef) as PDFDict;
    const rootK = rootDict.get(PDFName.of('K')) as PDFArray;
    expect(rootK.size()).toBe(1);
    expect((rootK.get(0) as PDFRef).objectNumber).toBe(flowRef.objectNumber);

    // Flow container now holds [a, b, wrapper, c, d] -- wrapper spliced
    // immediately after b (its confirmed left neighbor) and before c.
    const flowDict = doc.context.lookup(flowRef) as PDFDict;
    const flowK = flowDict.get(PDFName.of('K')) as PDFArray;
    const kRefs = flowK.asArray().map(r => (r as PDFRef).objectNumber);
    const bIdx = kRefs.indexOf(bRef.objectNumber);
    const cIdx = kRefs.indexOf(cRef.objectNumber);
    const wrapperIdx = kRefs.indexOf(wrapperRef.objectNumber);
    expect(wrapperIdx).toBe(bIdx + 1);
    expect(cIdx).toBe(wrapperIdx + 1);

    // The wrapper's own subtree (the EPI leaf and its MCID) is untouched.
    const wrapperDict = doc.context.lookup(wrapperRef) as PDFDict;
    const epiRef = wrapperDict.get(PDFName.of('K')) as PDFRef;
    const epiDict = doc.context.lookup(epiRef) as PDFDict;
    expect(epiDict.get(PDFName.of('S'))?.toString()).toBe('/EPI');
    expect(epiDict.get(PDFName.of('K'))?.toString()).toBe('2');
  });

  it('is idempotent -- re-running after a successful fix finds nothing left to fix', async () => {
    const { doc, wrapperRef } = await buildMisplacedDoc();
    const first = pdfStructureWriterService.fixReadingOrderFloatInterruption(doc, floatIssue(wrapperRef.objectNumber));
    expect(first.success).toBe(true);

    const second = pdfStructureWriterService.fixReadingOrderFloatInterruption(doc, floatIssue(wrapperRef.objectNumber));
    expect(second.success).toBe(false);
    expect(second.error).toContain('Could not re-confirm');
  });

  it('fails cleanly with no mutation when the issue element id is unrecognized', async () => {
    const { doc } = await buildMisplacedDoc();
    const badIssue: AuditIssue = { ...floatIssue(1), element: 'not-a-valid-id' };
    const result = pdfStructureWriterService.fixReadingOrderFloatInterruption(doc, badIssue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unrecognized element id');
  });

  it('declines (no mutation) when the re-confirmed interruption has no anchor', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    writePageContent(
      doc,
      1,
      '/P <</MCID 0>> BDC (wide)Tj EMC\n/P <</MCID 1>> BDC (carved out)Tj EMC\n/P <</MCID 2>> BDC (wide)Tj EMC\n'
    );
    writePageContent(doc, 2, '/P <</MCID 3>> BDC (D)Tj EMC\n');

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

    const result = pdfStructureWriterService.fixReadingOrderFloatInterruption(doc, floatIssue(tableWrapperRef.objectNumber));
    expect(result.success).toBe(false);
    expect(result.error).toContain('No unambiguous splice point');

    // Confirm no mutation happened: root still holds both original children.
    const rootDict = doc.context.lookup(rootRef) as PDFDict;
    const rootK = rootDict.get(PDFName.of('K')) as PDFArray;
    expect(rootK.size()).toBe(2);
  });
});
