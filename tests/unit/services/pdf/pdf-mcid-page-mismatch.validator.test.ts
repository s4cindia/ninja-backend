/**
 * Tests for PdfMcidPageMismatchValidator -- thin mapping layer over
 * findMcidPageMismatches (see mcid-page-mismatch.test.ts for the real
 * detection-logic coverage). Confirms the AuditIssue shape, especially
 * the `element` id format the fixer re-parses.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfMcidPageMismatchValidator } from '../../../../src/services/pdf/validators/pdf-mcid-page-mismatch.validator';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

describe('PdfMcidPageMismatchValidator', () => {
  it('emits one MCID-PAGE-MISMATCH issue per real mismatch, with a re-parseable element id', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    const page2 = doc.addPage([400, 600]);
    writePageContent(doc, 1, '/P <</MCID 3>> BDC (A)Tj EMC\n');
    writePageContent(doc, 2, '/P <</MCID 5>> BDC (B)Tj EMC\n/P <</MCID 10>> BDC (C)Tj EMC\n');

    const elemRef = doc.context.register(doc.context.obj({
      S: PDFName.of('TX'),
      Pg: page1.ref,
      K: doc.context.obj([
        PDFNumber.of(5),
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2.ref, MCID: PDFNumber.of(10) }),
      ]),
    }));
    const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: elemRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfMcidPageMismatchValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('MCID-PAGE-MISMATCH');
    expect(issue.pageNumber).toBe(1);
    expect(issue.element).toBe('mcid-mismatch_p1_mc5');
    expect(issue.message).toContain('page 2');
  });

  it('finds no issues when nothing is mismatched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    writePageContent(doc, 1, '/P <</MCID 3>> BDC (A)Tj EMC\n');
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfMcidPageMismatchValidator.validate(parsedPdf);
    expect(result.issues).toHaveLength(0);
  });
});
