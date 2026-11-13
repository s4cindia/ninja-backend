/**
 * Tests for PdfReadingOrderFloatValidator -- thin mapping layer over
 * findFloatInterruptions (see reading-order-float.test.ts for the real
 * detection-logic coverage). Confirms the AuditIssue shape, the
 * auto-fixable vs MANUAL code split, and the `element` id format the
 * fixer re-parses.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfReadingOrderFloatValidator } from '../../../../src/services/pdf/validators/pdf-reading-order-float.validator';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

function makeLeaf(doc: PDFDocument, tag: string, pageRef: PDFRef, mcid: number): PDFRef {
  return doc.context.register(doc.context.obj({ S: PDFName.of(tag), Pg: pageRef, K: PDFNumber.of(mcid) }));
}

describe('PdfReadingOrderFloatValidator', () => {
  it('emits an auto-fixable READING-ORDER-FLOAT-INTERRUPTION issue with a re-parseable element id', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    writePageContent(
      doc,
      1,
      '/P <</MCID 0>> BDC (A)Tj EMC\n/P <</MCID 1>> BDC (B)Tj EMC\n/P <</MCID 2>> BDC (Epigraph)Tj EMC\n/P <</MCID 3>> BDC (C)Tj EMC\n'
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

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfReadingOrderFloatValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('READING-ORDER-FLOAT-INTERRUPTION');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toBe(`float-interruption_r${wrapperRef.objectNumber}`);
    expect(issue.matterhornCheckpoint).toBe('09-001');
    expect(issue.matterhornHow).toBe('H');
    expect(issue.category).toBe('reading-order');
    expect(result.metadata.autoFixable).toBe(1);
  });

  it('emits the MANUAL code (no auto-fix) when there is no unambiguous splice point', async () => {
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

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfReadingOrderFloatValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('READING-ORDER-FLOAT-INTERRUPTION-MANUAL');
    expect(result.metadata.autoFixable).toBe(0);
  });

  it('finds no issues when there is no interruption', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    writePageContent(doc, 1, '/P <</MCID 0>> BDC (A)Tj EMC\n');
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfReadingOrderFloatValidator.validate(parsedPdf);
    expect(result.issues).toHaveLength(0);
  });
});
