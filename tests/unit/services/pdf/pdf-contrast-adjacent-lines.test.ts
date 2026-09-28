/**
 * Regression coverage for PdfContrastValidator's spatial-dedup fix: two
 * vertically-adjacent DISTINCT lines (one ordinary line-height apart) must
 * both be independently sampled, not merged into one dedup bucket.
 *
 * Real incident, confirmed live on Curiel_187961_CSHP.pdf: a two-line
 * wrapped list item in a "Check Point" callout box. Line 1 ("What types of
 * abuse and neglect...") stayed at its original near-white-on-light-grey
 * color (measured ratio ~1.06 -- catastrophically failing WCAG 1.4.3's
 * 4.5:1), while line 2 (the wrapped continuation, "of abuse could she have
 * assessed?") had already been fixed to black (ratio ~15). Both lines'
 * canvas-space boxes landed in the SAME old fixed 80px grid cell (one
 * line-height, ~15pt/22.5px at RENDER_SCALE=1.5, is well inside an 80px/
 * 53pt cell), so the old dedup only ever sampled whichever pdfjs enumerated
 * first for that cell and silently skipped the other -- permanently, since
 * every subsequent re-audit hit the exact same collision. Two separate
 * fresh re-audits of the real document both reported ZERO contrast issues
 * despite line 1 being visibly unreadable in the rendered PDF.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

describe('PdfContrastValidator — adjacent-line spatial dedup', () => {
  it('independently flags a failing line even when an already-passing line sits one line-height away', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    // 18pt apart (typical single-spaced leading for 14pt text) -- comfortably
    // inside the old 80px/53pt grid cell, exactly reproducing the real
    // incident's geometry.
    page.drawText('Passing black line above', { x: 60, y: 450, size: 14, font, color: rgb(0, 0, 0) });
    page.drawText('Failing near-white line below', { x: 60, y: 432, size: 14, font, color: rgb(0.85, 0.85, 0.85) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'adjacent-lines-test', 'test.pdf', 'custom', ['contrast']);
    const contrastIssues = report.issues.filter(i => i.code === 'COLOR-CONTRAST');

    expect(contrastIssues.length).toBe(1);
    expect(contrastIssues[0].context).toContain('Failing near-white line below');
  });
});
