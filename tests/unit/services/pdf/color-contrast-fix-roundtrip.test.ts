/**
 * Phase B4 integration test — the full color-contrast-fix round trip.
 *
 * Builds a real PDF with deliberately low-contrast text, runs the real
 * (non-AI) audit pipeline to get a genuine COLOR-CONTRAST issue with
 * contrastData, applies the real writer, then re-audits via
 * pdfReauditService.reauditAndCompare (now fixed to run at the
 * 'comprehensive' scan level — see the accompanying fix in
 * pdf-reaudit.service.ts) to confirm the issue is genuinely resolved with
 * zero regressions, not just that bytes changed.
 *
 * Only prisma.job.findUnique is mocked (reauditAndCompare's one real DB
 * dependency, for loading the "original" job row) — the audit, writer, and
 * re-audit logic all run for real. The test PDF has no images/tables/links/
 * forms/bookmarks, so the real (AI-capable) alt-text validator finds zero
 * images and never calls Gemini — safe to run at 'comprehensive' offline.
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { pdfContrastWriterService } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import { pdfReauditService } from '../../../../src/services/pdf/pdf-reaudit.service';
import prisma from '../../../../src/lib/prisma';

vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: vi.fn() } },
}));

describe('color-contrast-fix round trip (Phase B4 integration)', () => {
  it('resolves the flagged contrast issue with zero regressions after apply + comprehensive re-audit', async () => {
    // 1. Build a real PDF with deliberately low-contrast text (mid-gray on white).
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font, color: rgb(0.6, 0.6, 0.6) });
    const originalBuffer = Buffer.from(await src.save());

    // 2. Real audit, comprehensive — matching what re-audit now runs (see
    // pdf-reaudit.service.ts's fix). A narrower original scan than the
    // re-audit would make unrelated validators' findings look like false
    // "regressions" simply because the original never looked for them.
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      originalBuffer,
      'roundtrip-job',
      'test.pdf',
      'comprehensive'
    );
    const contrastIssue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST');
    expect(contrastIssue).toBeTruthy();
    expect(contrastIssue!.contrastData).toBeTruthy();

    // 3. Apply the real fix.
    const doc = await PDFDocument.load(originalBuffer);
    const fixResult = await pdfContrastWriterService.fixColorContrast(doc, contrastIssue!);
    expect(fixResult.success).toBe(true);
    const remediatedBuffer = Buffer.from(await doc.save());

    // 4. Mock the DB row reauditAndCompare needs to look up the "original" job.
    vi.mocked(prisma.job.findUnique).mockResolvedValue({
      id: 'roundtrip-job',
      output: { auditReport: originalReport },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // 5. Re-audit for real (comprehensive — this is what the fix in
    // pdf-reaudit.service.ts guarantees) and compare.
    const comparison = await pdfReauditService.reauditAndCompare(
      'roundtrip-job',
      remediatedBuffer,
      'test.pdf'
    );

    expect(comparison.success).toBe(true);
    expect(comparison.comparison.resolved.map(i => i.id)).toContain(contrastIssue!.id);
    expect(comparison.comparison.regressions.length).toBe(0);
  }, 20_000);

  it('the writer refuses to apply a fix when correlation is not confident enough', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font, color: rgb(0.6, 0.6, 0.6) });
    const originalBuffer = Buffer.from(await src.save());

    const originalReport = await pdfAuditService.runAuditFromBuffer(
      originalBuffer,
      'roundtrip-job-2',
      'test.pdf',
      'custom',
      ['contrast']
    );
    const contrastIssue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;

    // Corrupt the boundingBox so it points nowhere near the real text.
    const doc = await PDFDocument.load(originalBuffer);
    const fixResult = await pdfContrastWriterService.fixColorContrast(doc, {
      ...contrastIssue,
      boundingBox: { ...contrastIssue.boundingBox!, x: 350, y: 550 },
    });

    expect(fixResult.success).toBe(false);
    expect(fixResult.error).toContain('Could not confidently locate');
  }, 20_000);
});
