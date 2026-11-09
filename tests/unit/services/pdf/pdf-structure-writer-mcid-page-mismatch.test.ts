/**
 * Tests for PdfStructureWriterService.fixMcidPageMismatch -- see
 * mcid-page-mismatch.ts's own header comment for the real incident this
 * fixes (Karsaklian_189165_9781606497623.pdf, page 54, struct element 531).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRef } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function mismatchIssue(wrongPage: number, mcid: number): AuditIssue {
  return {
    id: 'issue-1',
    source: 'pdf-mcid-page-mismatch',
    severity: 'serious',
    code: 'MCID-PAGE-MISMATCH',
    message: 'test',
    element: `mcid-mismatch_p${wrongPage}_mc${mcid}`,
    pageNumber: wrongPage,
  } as AuditIssue;
}

async function buildMismatchedDoc(): Promise<{ doc: PDFDocument; elemRef: PDFRef; page1Ref: PDFRef; page2Ref: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([400, 600]);
  const page2 = doc.addPage([400, 600]);
  writePageContent(doc, 1, '/P <</MCID 3>> BDC (A)Tj EMC\n');
  writePageContent(doc, 2, '/P <</MCID 5>> BDC (B)Tj EMC\n/P <</MCID 10>> BDC (C)Tj EMC\n');

  const elemRef = doc.context.register(doc.context.obj({
    S: PDFName.of('TX'),
    Pg: page1.ref,
    K: doc.context.obj([
      PDFNumber.of(5), // bare -- should be an MCR dict pointing to page 2
      doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2.ref, MCID: PDFNumber.of(10) }),
    ]),
  }));
  const structRoot = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: elemRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRoot);

  return { doc, elemRef, page1Ref: page1.ref, page2Ref: page2.ref };
}

describe('PdfStructureWriterService.fixMcidPageMismatch', () => {
  it('wraps the bare MCID into an MCR dict declaring the correct page, leaving the rest of /K untouched', async () => {
    const { doc, elemRef, page2Ref } = await buildMismatchedDoc();

    const result = pdfStructureWriterService.fixMcidPageMismatch(doc, mismatchIssue(1, 5));

    expect(result.success).toBe(true);
    expect(result.after).toContain('page 2');

    const elemDict = doc.context.lookup(elemRef) as PDFDict;
    const kArr = elemDict.get(PDFName.of('K')) as PDFArray;
    const firstEntry = doc.context.lookup(kArr.get(0) as PDFRef | PDFDict) as PDFDict;
    expect(firstEntry.get(PDFName.of('MCID'))?.toString()).toBe('5');
    expect((firstEntry.get(PDFName.of('Pg')) as PDFRef).objectNumber).toBe(page2Ref.objectNumber);
    expect(firstEntry.get(PDFName.of('Type'))?.toString()).toBe('/MCR');

    // The sibling MCR entry at index 1 is untouched.
    const secondEntry = doc.context.lookup(kArr.get(1) as PDFRef | PDFDict) as PDFDict;
    expect(secondEntry.get(PDFName.of('MCID'))?.toString()).toBe('10');
  });

  it('fails cleanly with no mutation when the issue element id is unrecognized', async () => {
    const { doc } = await buildMismatchedDoc();
    const badIssue: AuditIssue = { ...mismatchIssue(1, 5), element: 'not-a-valid-id' };
    const result = pdfStructureWriterService.fixMcidPageMismatch(doc, badIssue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unrecognized element id');
  });

  it('fails cleanly when the mismatch can no longer be re-confirmed (already fixed)', async () => {
    const { doc } = await buildMismatchedDoc();
    const first = pdfStructureWriterService.fixMcidPageMismatch(doc, mismatchIssue(1, 5));
    expect(first.success).toBe(true);

    // Re-running the same fix now finds nothing left to fix.
    const second = pdfStructureWriterService.fixMcidPageMismatch(doc, mismatchIssue(1, 5));
    expect(second.success).toBe(false);
    expect(second.error).toContain('Could not re-confirm');
  });
});
