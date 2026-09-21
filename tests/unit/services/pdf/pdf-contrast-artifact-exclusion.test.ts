/**
 * Regression coverage for PdfContrastValidator's Artifact-awareness fix
 * (CodeRabbit finding on PR #585): before this fix, getTextContent() was
 * called with no includeMarkedContent, so a text run already wrapped in
 * /Artifact BMC...EMC (e.g. by pdf-structure-writer.service.ts's own
 * fixInvisibleTextArtifact) was invisible to this validator -- it would
 * still measure the run's geometry/pixels and re-report the exact same
 * COLOR-CONTRAST issue on the next re-audit, making a genuinely successful
 * fix look like it made zero progress. This end-to-end test builds a real
 * PDF (two white-on-white text runs, one wrapped in /Artifact) and confirms
 * the wrapped run is excluded from both detection AND background-sampling
 * neighbor-avoidance, while the unwrapped run is still flagged normally --
 * following the same real-render, no-mocking convention already established
 * in pdf-contrast-zero-ink.test.ts and pdf-contrast-detection-background.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

describe('PdfContrastValidator — Artifact-tagged text exclusion', () => {
  it('excludes a text run already wrapped in /Artifact, while still flagging an untouched sibling run', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 700]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    // Two independent white-on-white runs, far enough apart in canvas space
    // (RENDER_SCALE=1.5 * 200pt = 300px) to land in different GRID_CELL_PX
    // (80px) spatial-dedup buckets, so both are independently eligible to
    // be reported.
    page.drawText('Untouched invisible run', { x: 60, y: 550, size: 14, font, color: rgb(1, 1, 1) });
    page.drawText('Already fixed invisible run', { x: 60, y: 250, size: 14, font, color: rgb(1, 1, 1) });
    const doc = await PDFDocument.load(await src.save());

    const raw = decodePageContent(doc, 1)!;
    // pdf-lib hex-encodes the drawn text (Tj operand), so locate the second
    // run by its Tm position operator instead of its (unencoded) string.
    const marker = '1 0 0 1 60 250 Tm';
    const markerPos = raw.indexOf(marker);
    expect(markerPos).toBeGreaterThan(-1);
    const start = raw.lastIndexOf('BT', markerPos);
    const end = raw.indexOf('ET', markerPos) + 'ET'.length;
    const wrapped = raw.slice(0, start) + '/Artifact BMC\n' + raw.slice(start, end) + '\nEMC\n' + raw.slice(end);
    writePageContent(doc, 1, wrapped);

    const buffer = Buffer.from(await doc.save());
    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'artifact-exclusion-test', 'test.pdf', 'custom', ['contrast']);
    const contrastIssues = report.issues.filter(i => i.code === 'COLOR-CONTRAST');

    expect(contrastIssues.length).toBe(1);
    expect(contrastIssues[0].context).toContain('Untouched invisible run');
    expect(contrastIssues.some(i => i.context?.includes('Already fixed invisible run'))).toBe(false);
  });
});
