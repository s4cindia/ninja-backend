/**
 * Tests for PdfSpanIllegalNestingValidator -- thin mapping layer over
 * findSpanIllegalNestingViolations (see span-illegal-nesting.test.ts for the
 * real detection-logic coverage). Confirms the AuditIssue shape, the two
 * codes (auto-fixable vs manual), and the `element` id format
 * fixSpanIllegalNesting re-parses.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { pdfSpanIllegalNestingValidator } from '../../../../src/services/pdf/validators/pdf-span-illegal-nesting.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

describe('PdfSpanIllegalNestingValidator', () => {
  it('emits a SPAN-ILLEGAL-NESTING issue with a re-parseable element id for the auto-fixable case', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: pRef }));
    const divRef = doc.context.register(doc.context.obj({ S: PDFName.of('Div'), K: spanRef }));
    doc.context.lookup(pRef)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), divRef);

    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: divRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfSpanIllegalNestingValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('SPAN-ILLEGAL-NESTING');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toBe(`span-illegal-nesting_r${spanRef.objectNumber}`);
    expect(issue.category).toBe('structure');
    expect(issue.matterhornCheckpoint).toBe('01-006');
    expect(result.metadata.violationsFound).toBe(1);
    expect(result.metadata.autoFixable).toBe(1);
  });

  it('emits the -MANUAL code when the violation is not auto-fixable', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const h1Ref = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: PDFNumber.of(0), Pg: page.ref }));
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: h1Ref }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef }));
    doc.context.lookup(h1Ref)!.set(PDFName.of('P'), spanRef);
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);

    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: pRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfSpanIllegalNestingValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('SPAN-ILLEGAL-NESTING-MANUAL');
    expect(result.metadata.autoFixable).toBe(0);
  });

  it('emits no issues for a document with no illegal Span nesting', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const spanRef = doc.context.register(doc.context.obj({ S: PDFName.of('Span'), K: PDFNumber.of(0), Pg: page.ref }));
    const pRef = doc.context.register(doc.context.obj({ S: PDFName.of('P'), K: spanRef }));
    doc.context.lookup(spanRef)!.set(PDFName.of('P'), pRef);

    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: pRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfSpanIllegalNestingValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.violationsFound).toBe(0);
  });
});
