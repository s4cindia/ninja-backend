import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

/**
 * Detection's own background sampling (PdfContrastValidator.validatePageContrast)
 * used a single fixed 5px strip directly above the text (sampleAverage) until
 * this fix, wiring in the same tiered/flat-variance search
 * (sampleBackgroundRobust) already proven for fix-time verification
 * (PR #513/#514). See color-contrast-verification.test.ts's two "KNOWN
 * LIMITATION" tests for the case this fix does NOT resolve (a solid band
 * wide/tall enough to swallow the entire tier-0 probe uniformly -- flat, so
 * it wins even under the new search, with no hint available at detection
 * time to disambiguate). This file covers the case it DOES fix: a
 * contaminating element that only partially overlaps the probe strip,
 * producing real variance the old naive average had no way to detect or
 * route around.
 */
describe('PdfContrastValidator detection — robust background sampling', () => {
  it('correctly finds the true white background past a rectangle that only partially overlaps the naive probe strip', async () => {
    // Empirically confirmed (temporarily reverting to the old sampleAverage
    // call and re-running this exact fixture) that the naive method reads
    // background '#989898' here (ratio 1.02, fg≈bg) -- blended from
    // straddling the dark rectangle and the true white page background in
    // one flat average, unable to tell "this strip is contaminated" from
    // "this strip is genuine background". The fix correctly rejects the
    // straddling (high-variance) tier-0 candidate and finds true white.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawRectangle({ x: 95, y: 465, width: 200, height: 1.5, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast target line', { x: 100, y: 450, size: 14, font, color: rgb(0.6, 0.6, 0.6) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'detection-partial-overlap', 'test.pdf', 'custom', ['contrast']);
    const issue = report.issues.find(i => i.code === 'COLOR-CONTRAST');

    expect(issue).toBeTruthy();
    expect(issue!.contrastData!.background).toBe('#ffffff');
    expect(issue!.contrastData!.ratio).toBeGreaterThan(2.5); // not the contaminated ~1.02
  });
});
