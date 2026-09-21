/**
 * Regression coverage for fixInvisibleTextArtifact (Matterhorn 01-005-
 * adjacent fix): wraps a SPECIFIC text run -- one whose measured ink color
 * exactly matches its background -- in /Artifact BMC … EMC, located the
 * same way pdf-contrast-writer.service.ts's own fixColorContrast locates a
 * run (contrast-content-stream.ts's locateTextRun, from the issue's own
 * boundingBox). Confirmed real on Math_Weir_PDF.pdf: 55 of 88 real
 * COLOR-CONTRAST issues (identified by the ABSENCE of contrastData) are
 * print-production slug-line text that should never have been in the
 * accessible reading order at all.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// Same shape as contrast-content-stream.test.ts's own twoLineStream (a
// verified-reliable pdf-lib output shape: q BT … Tm … Tj … ET Q).
const SLUG_LINE_STREAM = `q
BT
1 1 1 rg
/F1 8 Tf
1 0 0 1 250 493 Tm
<4539343732> Tj
ET
Q
`;

function invisibleTextIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'contrast-1',
    source: 'contrast-validator',
    severity: 'serious',
    code: 'COLOR-CONTRAST',
    message: 'Text on page 1 has no visually distinguishable ink from its background',
    wcagCriteria: ['1.4.3'],
    location: 'Page 1 at (250, 347)',
    category: 'contrast',
    pageNumber: 1,
    // pageHeight - boundingBox.y must equal the Tm's own baselineY (493) --
    // matches pdf-contrast-writer.service.ts's own {x, baselineY} derivation.
    boundingBox: { x: 250, y: 792 - 493, width: 165, height: 8, pageWidth: 612, pageHeight: 792 },
    // Deliberately NO contrastData -- the exact signal that distinguishes
    // this case from a real, measurable low-contrast defect.
    ...overrides,
  } as AuditIssue;
}

describe('fixInvisibleTextArtifact', () => {
  it('locates the invisible text run by its boundingBox and wraps it in /Artifact BMC…EMC', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    const results = pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('marked as /Artifact');
    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('/Artifact BMC');
    expect(fixed).not.toContain('/Artifact BDC'); // bare tag, matching pdf-artifact-tagger.ts's own convention
    expect(fixed).toContain('<4539343732> Tj'); // the text itself is untouched, only wrapped
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ pageNumber: undefined })]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('pageNumber or boundingBox');
  });

  it('fails cleanly when the issue has no boundingBox', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const results = pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ boundingBox: undefined })]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('pageNumber or boundingBox');
  });

  it('fails cleanly when no text run matches the given position (already fixed, or moved)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    // Way outside locateTextRun's own tolerance for this content.
    const results = pdfStructureWriterService.fixInvisibleTextArtifact(
      doc, [invisibleTextIssue({ boundingBox: { x: 500, y: 700, width: 10, height: 8, pageWidth: 612, pageHeight: 792 } })],
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Could not locate');
  });

  it('never alters the run\'s own text content or positioning -- only inserts marked-content tags', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    writePageContent(doc, 1, SLUG_LINE_STREAM);

    pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue()]);

    const fixed = decodePageContent(doc, 1)!;
    expect(fixed).toContain('1 0 0 1 250 493 Tm');
    expect(fixed).toContain('1 1 1 rg'); // fill color left exactly as-is -- no recoloring attempt
  });

  it('targets the correct page among several, leaving the others untouched', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    writePageContent(doc, 1, 'q BT 1 1 1 rg /F1 8 Tf 1 0 0 1 10 10 Tm <41> Tj ET Q\n');
    writePageContent(doc, 2, SLUG_LINE_STREAM);

    const results = pdfStructureWriterService.fixInvisibleTextArtifact(doc, [invisibleTextIssue({ pageNumber: 2 })]);

    expect(results[0].success).toBe(true);
    expect(decodePageContent(doc, 1)).not.toContain('/Artifact'); // untouched
    expect(decodePageContent(doc, 2)).toContain('/Artifact BMC');
  });
});
