/**
 * Tests for PdfStructureWriterService.fixStructureElementWrongParent -- see
 * structure-parent-mismatch.ts's own header comment for the real incident
 * (Karsaklian_189165_9781606497623.pdf round 15: 49 instances caught by an
 * independent PAC/veraPDF re-check, root-caused to
 * fixReadingOrderFloatInterruption's own missing /P update).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function mismatchIssue(objectNumber: number): AuditIssue {
  return {
    id: 'issue-1',
    source: 'pdf-structure-parent-mismatch',
    severity: 'serious',
    code: 'STRUCTURE-ELEMENT-WRONG-PARENT',
    message: 'test',
    element: `parent-mismatch_r${objectNumber}`,
    pageNumber: 1,
  } as AuditIssue;
}

function makeLeaf(doc: PDFDocument, tag: string, parentRef: PDFRef, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), P: parentRef, Pg: pageRef, K: PDFNumber.of(mcid) }));
}

async function buildMismatchedDoc(): Promise<{ doc: PDFDocument; containerARef: PDFRef; containerBRef: PDFRef; leaf: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const containerARef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
  const containerBRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
  const leaf = makeLeaf(doc, 'TX', containerARef, page.ref, 0); // declares A as parent
  doc.context.lookup(containerBRef)!.set(PDFName.of('K'), doc.context.obj([leaf])); // but actually sits in B's /K
  doc.context.lookup(containerARef)!.set(PDFName.of('K'), doc.context.obj([]));

  const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([containerARef, containerBRef]) }));
  const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

  return { doc, containerARef, containerBRef, leaf };
}

describe('PdfStructureWriterService.fixStructureElementWrongParent', () => {
  it('corrects /P to match the dict that actually contains the element in /K', async () => {
    const { doc, containerBRef, leaf } = await buildMismatchedDoc();

    const result = pdfStructureWriterService.fixStructureElementWrongParent(doc, mismatchIssue(leaf.objectNumber));

    expect(result.success).toBe(true);
    expect(result.after).toContain(String(containerBRef.objectNumber));

    const leafDict = doc.context.lookup(leaf) as PDFDict;
    expect((leafDict.get(PDFName.of('P')) as PDFRef).objectNumber).toBe(containerBRef.objectNumber);
  });

  it('does not touch the /K arrays of either container -- only the element\'s own /P', async () => {
    const { doc, containerARef, containerBRef, leaf } = await buildMismatchedDoc();

    pdfStructureWriterService.fixStructureElementWrongParent(doc, mismatchIssue(leaf.objectNumber));

    const aK = (doc.context.lookup(containerARef) as PDFDict).get(PDFName.of('K')) as PDFArray;
    const bK = (doc.context.lookup(containerBRef) as PDFDict).get(PDFName.of('K')) as PDFArray;
    expect(aK.size()).toBe(0);
    expect(bK.size()).toBe(1);
    expect((bK.get(0) as PDFRef).objectNumber).toBe(leaf.objectNumber);
  });

  it('is idempotent -- re-running after a successful fix finds nothing left to fix', async () => {
    const { doc, leaf } = await buildMismatchedDoc();
    const first = pdfStructureWriterService.fixStructureElementWrongParent(doc, mismatchIssue(leaf.objectNumber));
    expect(first.success).toBe(true);

    const second = pdfStructureWriterService.fixStructureElementWrongParent(doc, mismatchIssue(leaf.objectNumber));
    expect(second.success).toBe(false);
    expect(second.error).toContain('Could not re-confirm');
  });

  it('fails cleanly with no mutation when the issue element id is unrecognized', async () => {
    const { doc } = await buildMismatchedDoc();
    const badIssue: AuditIssue = { ...mismatchIssue(1), element: 'not-a-valid-id' };
    const result = pdfStructureWriterService.fixStructureElementWrongParent(doc, badIssue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unrecognized element id');
  });
});
