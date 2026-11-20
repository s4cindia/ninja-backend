/**
 * Regression coverage for fixHyphenatedLineBreak -- merges a word split by
 * ordinary line-wrap hyphenation ("exam-" / "ple") across two adjacent,
 * already-tagged top-level marked-content spans via an /ActualText
 * override, without touching the page's own text-show operators. See the
 * fixer's own doc comment in pdf-structure-writer.service.ts for the full
 * scope (ActualText-only; does not fix raw text search/extraction).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: `issue-page-${pageNumber ?? 'none'}`,
    source: 'pdf-structure',
    severity: 'moderate',
    code: 'HYPHENATED-LINE-BREAK',
    message: 'Word split across a line-wrap hyphen',
    wcagCriteria: ['1.3.1'],
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    category: 'structure',
    pageNumber,
  } as AuditIssue;
}

/** A minimal font with no /ToUnicode and no /Encoding -- every byte code
 * used in these fixtures is chosen to equal its own ASCII value, so the
 * fixer's Latin-1 fallback (see its own doc comment: "falls back to the
 * byte's own Latin-1 code point on a /ToUnicode miss") resolves it without
 * needing a CMap fixture, unlike the stricter decline-on-miss sibling
 * fixer's own tests. */
async function buildDoc(content: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const fontDict = doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('Helvetica') });
  const fontRef = doc.context.register(fontDict);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: fontRef } }));
  writePageContent(doc, 1, content);
  return doc;
}

describe('PdfStructureWriterService.fixHyphenatedLineBreak', () => {
  it('merges "exam-" / "ple" across two adjacent tagged spans into "example" via ActualText, suppressing the second span', async () => {
    const content =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      'ET\n';
    const doc = await buildDoc(content);
    const before = decodePageContent(doc, 1)!;

    const result = pdfStructureWriterService.fixHyphenatedLineBreak(doc, issueForPage(1));

    expect(result.success).toBe(true);
    expect(result.after).toContain('example');

    const after = decodePageContent(doc, 1)!;
    expect(after).toContain('/P <</ActualText (example) /MCID 1>> BDC');
    expect(after).toContain('/P <</ActualText () /MCID 2>> BDC');
    expect(after).not.toBe(before);
  });

  it('declines when the next span starts with an uppercase letter -- a new sentence/heading, not a word continuation', async () => {
    const content =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(Well-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(Known)Tj\nEMC\n' +
      'ET\n';
    const doc = await buildDoc(content);

    const result = pdfStructureWriterService.fixHyphenatedLineBreak(doc, issueForPage(1));

    expect(result.success).toBe(false);
  });

  it('declines when the hyphen-ending span has no real /MCID (not struct-tree reachable) -- same decline-rather-than-guess posture as every other fixer', async () => {
    const content =
      '/F1 1 Tf\nBT\n' +
      '/Artifact BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      'ET\n';
    const doc = await buildDoc(content);

    const result = pdfStructureWriterService.fixHyphenatedLineBreak(doc, issueForPage(1));

    expect(result.success).toBe(false);
  });

  it('does not pair across an unrelated span sitting between the two fragments', async () => {
    const content =
      '/F1 1 Tf\nBT\n' +
      '/P <</MCID 1>> BDC\n12 0 0 12 72 700 Tm\n(exam-)Tj\nEMC\n' +
      '/Figure <</MCID 9>> BDC\n12 0 0 12 200 700 Tm\nEMC\n' +
      '/P <</MCID 2>> BDC\n12 0 0 12 72 688 Tm\n(ple)Tj\nEMC\n' +
      'ET\n';
    const doc = await buildDoc(content);

    const result = pdfStructureWriterService.fixHyphenatedLineBreak(doc, issueForPage(1));

    expect(result.success).toBe(false);
  });
});
