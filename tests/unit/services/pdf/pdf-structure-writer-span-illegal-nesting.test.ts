/**
 * Tests for PdfStructureWriterService.fixSpanIllegalNesting -- see
 * span-illegal-nesting.ts's own header comment for the S4 QC finding this
 * addresses ("child Span tags incorrectly placed as parent elements").
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function nestingIssue(objectNumber: number): AuditIssue {
  return {
    id: 'issue-1',
    source: 'pdf-span-illegal-nesting',
    severity: 'serious',
    code: 'SPAN-ILLEGAL-NESTING',
    message: 'test',
    element: `span-illegal-nesting_r${objectNumber}`,
    pageNumber: 1,
  } as AuditIssue;
}

function setStructRoot(doc: PDFDocument, rootKRef: PDFRef): void {
  const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootKRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);
}

describe('PdfStructureWriterService.fixSpanIllegalNesting', () => {
  it('dissolves a Span with one illegal child, promoting it into the Span\'s own single-scalar /K slot', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: pRef }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(pRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);
    setStructRoot(doc, divRef);

    const result = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(result.success).toBe(true);

    const divDict = doc.context.lookup(divRef) as PDFDict;
    const divK = divDict.get(PDFName.of('K'));
    expect(divK instanceof PDFRef && (divK as PDFRef).objectNumber).toBe(pRef.objectNumber);

    const pDict = doc.context.lookup(pRef) as PDFDict;
    expect((pDict.get(PDFName.of('P')) as PDFRef).objectNumber).toBe(divRef.objectNumber);
  });

  it('dissolves a Span with two illegal children into an array, preserving order, and updates both /P entries', async () => {
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

    const result = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(result.success).toBe(true);

    const divK = (doc.context.lookup(divRef) as PDFDict).get(PDFName.of('K')) as PDFArray;
    expect(divK.size()).toBe(2);
    expect((divK.get(0) as PDFRef).objectNumber).toBe(pRef.objectNumber);
    expect((divK.get(1) as PDFRef).objectNumber).toBe(tableRef.objectNumber);

    const pDict = doc.context.lookup(pRef) as PDFDict;
    const tableDict = doc.context.lookup(tableRef) as PDFDict;
    expect((pDict.get(PDFName.of('P')) as PDFRef).objectNumber).toBe(divRef.objectNumber);
    expect((tableDict.get(PDFName.of('P')) as PDFRef).objectNumber).toBe(divRef.objectNumber);
  });

  it('replaces the Span in its parent\'s /K array (not just scalar /K) at its original position, keeping siblings in order', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const beforeRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const afterRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(1), Pg: page.ref }));
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(2), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: h1Ref }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: doc.context.obj([beforeRef, spanRef, afterRef]) }));
    doc.context.lookup(beforeRef)!.set(PDFName.of('P'), divRef);
    doc.context.lookup(afterRef)!.set(PDFName.of('P'), divRef);
    doc.context.lookup(h1Ref)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);
    setStructRoot(doc, divRef);

    const result = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(result.success).toBe(true);

    const divK = (doc.context.lookup(divRef) as PDFDict).get(PDFName.of('K')) as PDFArray;
    const ids = divK.asArray().map(r => (r as PDFRef).objectNumber);
    expect(ids).toEqual([beforeRef.objectNumber, h1Ref.objectNumber, afterRef.objectNumber]);
  });

  it('declines (no mutation) when the violation is not auto-fixable', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: h1Ref }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef })); // parent is itself Block-level
    doc.context.lookup(h1Ref)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);
    setStructRoot(doc, pRef);

    const result = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not auto-fixable');

    const pK = (doc.context.lookup(pRef) as PDFDict).get(PDFName.of('K'));
    expect(pK instanceof PDFRef && (pK as PDFRef).objectNumber).toBe(spanRef.objectNumber);
  });

  it('is idempotent -- re-running after a successful fix finds nothing left to fix', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: pRef }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(pRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);
    setStructRoot(doc, divRef);

    const first = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(first.success).toBe(true);

    const second = pdfStructureWriterService.fixSpanIllegalNesting(doc, nestingIssue(spanRef.objectNumber));
    expect(second.success).toBe(false);
    expect(second.error).toContain('Could not re-confirm');
  });

  it('fails cleanly with no mutation when the issue element id is unrecognized', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const badIssue: AuditIssue = { ...nestingIssue(1), element: 'not-a-valid-id' };
    const result = pdfStructureWriterService.fixSpanIllegalNesting(doc, badIssue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unrecognized element id');
  });
});
