/**
 * Tests for PdfStructureParentMismatchValidator -- thin mapping layer over
 * findStructureParentMismatches (see structure-parent-mismatch.test.ts for
 * the real detection-logic coverage). Confirms the AuditIssue shape and
 * the `element` id format fixStructureElementWrongParent re-parses.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfStructureParentMismatchValidator } from '../../../../src/services/pdf/validators/pdf-structure-parent-mismatch.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

function makeLeaf(doc: PDFDocument, tag: string, parentRef: PDFRef, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), P: parentRef, Pg: pageRef, K: PDFNumber.of(mcid) }));
}

describe('PdfStructureParentMismatchValidator', () => {
  it('emits a STRUCTURE-ELEMENT-WRONG-PARENT issue with a re-parseable element id', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const containerARef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const containerBRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const leaf = makeLeaf(doc, 'TX', containerARef, page.ref, 0);
    doc.context.lookup(containerBRef)!.set(PDFName.of('K'), doc.context.obj([leaf]));
    doc.context.lookup(containerARef)!.set(PDFName.of('K'), doc.context.obj([]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([containerARef, containerBRef]) }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfStructureParentMismatchValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('STRUCTURE-ELEMENT-WRONG-PARENT');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toBe(`parent-mismatch_r${leaf.objectNumber}`);
    expect(issue.category).toBe('structure');
    expect(issue.matterhornHow).toBe('--');
    expect(result.metadata.mismatchesFound).toBe(1);
  });

  it('emits no issues when every /P already matches its real parent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const containerRef = doc.context.register(doc.context.obj({ S: PDFName.of('Story') }));
    const leaf = makeLeaf(doc, 'TX', containerRef, page.ref, 0);
    doc.context.lookup(containerRef)!.set(PDFName.of('K'), doc.context.obj([leaf]));

    const rootRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: containerRef }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: rootRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfStructureParentMismatchValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.mismatchesFound).toBe(0);
  });
});
