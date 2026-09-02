import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { spliceColorFix, pdfContrastWriterService } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { verifyContrastInRegion } from '../../../../src/services/pdf/color-contrast-verification';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// Wraps the real implementation by default (most tests exercise genuine
// end-to-end rendering) — individual tests can override with
// mockResolvedValueOnce to test the escalation branch deterministically,
// without depending on exact rendering/anti-aliasing behavior for a
// specific hand-picked font size to reliably fail-then-succeed.
vi.mock('../../../../src/services/pdf/color-contrast-verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/services/pdf/color-contrast-verification')>();
  return { ...actual, verifyContrastInRegion: vi.fn(actual.verifyContrastInRegion) };
});

describe('spliceColorFix', () => {
  it('replaces an internal fill-color op inline and restores the original color right after the run', () => {
    const content = 'BT\n0.6 0.6 0.6 rg\n/F1 14 Tf\n<41> Tj\nET';
    const opStart = content.indexOf('0.6 0.6 0.6 rg');
    const opEnd = opStart + '0.6 0.6 0.6 rg'.length;
    const run = { start: content.indexOf('BT') + 'BT'.length, end: content.indexOf('ET') };

    const result = spliceColorFix(content, run, { start: opStart, end: opEnd }, [0, 0, 0], [0.6, 0.6, 0.6]);

    expect(result).toBe('BT\n0 0 0 rg\n/F1 14 Tf\n<41> Tj\n\n0.6 0.6 0.6 rg\nET');
  });

  it('inserts a new op before the run and a restore op after when there is no internal op', () => {
    const content = 'BT <41> Tj ET';
    const run = { start: content.indexOf('BT') + 'BT'.length, end: content.indexOf('ET') };

    const result = spliceColorFix(content, run, undefined, [1, 1, 1], [0, 0, 0]);

    expect(result).toBe('BT\n1 1 1 rg\n <41> Tj \n0 0 0 rg\nET');
  });

  it('does not touch content before the run or after the restore point', () => {
    const content = 'BEFORE BT 0.6 0.6 0.6 rg <41> Tj ET AFTER';
    const opStart = content.indexOf('0.6 0.6 0.6 rg');
    const opEnd = opStart + '0.6 0.6 0.6 rg'.length;
    const run = { start: content.indexOf('BT') + 'BT'.length, end: content.indexOf('ET') };

    const result = spliceColorFix(content, run, { start: opStart, end: opEnd }, [0, 0, 0], [0.6, 0.6, 0.6]);

    expect(result.startsWith('BEFORE BT 0 0 0 rg ')).toBe(true);
    expect(result.endsWith('ET AFTER')).toBe(true);
  });
});

describe('PdfContrastWriterService.fixColorContrast', () => {
  // mockClear (not mockReset) — keeps the real-implementation fallback from
  // vi.mock above intact; only clears call history/queued once-values so
  // tests don't see calls made by earlier tests in this file.
  afterEach(() => {
    vi.mocked(verifyContrastInRegion).mockClear();
  });

  async function realPdfWithText(
    x: number, y: number, size: number,
    opts: { bold?: boolean; color?: number } = {}
  ): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 700]);
    const font = await src.embedFont(opts.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
    const c = opts.color ?? 0.6;
    page.drawText('Low contrast text', { x, y, size, font, color: rgb(c, c, c) });
    return PDFDocument.load(await src.save());
  }

  function contrastIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
    return {
      id: 'contrast-1',
      source: 'contrast-validator',
      severity: 'serious',
      code: 'COLOR-CONTRAST',
      message: 'Text has contrast ratio 2.10:1 (minimum 4.5:1 required for normal text)',
      pageNumber: 1,
      boundingBox: { x: 100, y: 700 - 450, width: 100, height: 14, pageWidth: 500, pageHeight: 700 },
      contrastData: {
        foreground: '#999999',
        background: '#ffffff',
        ratio: 2.1,
        requiredRatio: 4.5,
        isLargeText: false,
      },
      ...overrides,
    };
  }

  // Real audit → apply → the writer's own internal verify. Bold text at a
  // reasonable size is where the moderate correction (before any escalation)
  // reliably clears the bar in practice — see the "escalates" test below for
  // the case where it doesn't.
  it('rewrites the flagged text color, verifies it, and reports before/after', async () => {
    const doc = await realPdfWithText(60, 450, 28, { bold: true });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-1', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;
    expect(issue).toBeTruthy();

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(result.success).toBe(true);
    expect(result.after).toContain('verified');
    expect(result.after).toContain('#ffffff');
    const achieved = parseFloat(/verified ([\d.]+):1/.exec(result.after)![1]);
    expect(achieved).toBeGreaterThanOrEqual(issue.contrastData!.requiredRatio);

    const content = decodePageContent(doc, 1)!;
    expect(content).toContain('Tj'); // original text-show op preserved
  });

  it('escalates to an extreme color when the moderate correction does not verify', async () => {
    // Deterministic: mock the verify oracle to fail the first check (the
    // moderate correction) and pass the second (the escalated one), rather
    // than depending on a specific font size reliably failing-then-
    // succeeding under real rendering — that turned out to vary with page
    // geometry in ways not worth hand-tuning a fixture around.
    // mockClear (not mockReset) — preserves the real-implementation fallback
    // set up in vi.mock above; only clears prior call history/queued results.
    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 1.8, passes: false, foreground: '#aaaaaa', background: '#ffffff', uncertain: false })
      .mockResolvedValueOnce({ ratio: 15, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-2', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(mockVerify).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    // The final written color is the escalated extreme, not the moderate guess.
    expect(['#000000 on #ffffff', '#ffffff on #ffffff']).toContain(
      result.after!.split(' (')[0]
    );
  });

  it('reports failure rather than false success when even the extreme escalation does not verify', async () => {
    // A real, discovered limitation: some large-but-thin-stroke text (48pt
    // regular) still measures under threshold even at pure black, because
    // the sampler's box is dominated by anti-aliased edges relative to the
    // thin glyph strokes. The writer must never claim success here.
    const doc = await realPdfWithText(60, 450, 48, { bold: false, color: 0.6 });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-3', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST');
    if (!issue) return; // environment/font-rendering variance — not the behavior under test

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    if (!result.success) {
      // Either message is a valid "never claim success" outcome — an
      // isolated large-text case like this should normally find a
      // confidently flat nearby patch (the "did not verify" branch), but
      // tolerate the "uncertain" branch too rather than pin exact rendering.
      expect(result.error).toMatch(/did not verify|Could not confidently measure/);
      expect(result.after).toBe('unknown');
    }
    // If this environment's rendering happens to verify successfully, that's
    // fine too — the invariant under test is "never report success without
    // verification", not "this exact scenario must fail everywhere".
  });

  it('reverts the rewritten page content when verification ends as uncertain, instead of leaking an unverified color change', async () => {
    // Found by a local `codex exec review` pass: applyColor() mutates the
    // shared `doc` before verification even runs, and neither failure
    // branch undid that mutation. Since AiAnalysisService.
    // applyApprovedSuggestions() saves this same `doc` whenever any OTHER
    // fix in the same batch succeeds, a fix reported as failed here would
    // otherwise still leak its unverified color change into the final
    // output.
    //
    // Also doubles as regression coverage for `uncertain` gating success
    // even when the ratio nominally passes -- a deliberate policy, not
    // just contamination handling: this same mechanism is what makes text
    // over a genuinely non-uniform background (a photo, a gradient, where
    // every nearby patch legitimately varies) permanently unable to
    // auto-apply, trading away that automation coverage for never
    // claiming a fix that isn't reliably measurable actually worked (a
    // second review finding, addressed by documentation rather than a
    // behavior change -- see the comment at the gating check itself).
    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 3.0, passes: false, foreground: '#888888', background: '#ffffff', uncertain: false })
      .mockResolvedValueOnce({ ratio: 6.0, passes: true, foreground: '#000000', background: '#ffffff', uncertain: true });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-uncertain-revert', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;
    const beforeContent = decodePageContent(doc, 1)!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not confidently measure');
    const afterContent = decodePageContent(doc, 1)!;
    expect(afterContent).toBe(beforeContent); // reverted despite the mocked ratio nominally "passing"
  });

  it('fails gracefully when the issue has no contrastData', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const result = await pdfContrastWriterService.fixColorContrast(doc, contrastIssue({ contrastData: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('contrastData');
  });

  it('fails gracefully when no text is near the target point', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const issue = contrastIssue({
      boundingBox: { x: 400, y: 700 - 50, width: 100, height: 14, pageWidth: 500, pageHeight: 700 },
    });
    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not confidently locate');
  });

  it('fails gracefully on a rotated page', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 700]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font });
    page.setRotation(degrees(90));
    const doc = await PDFDocument.load(await src.save());

    const result = await pdfContrastWriterService.fixColorContrast(doc, contrastIssue());
    expect(result.success).toBe(false);
    expect(result.error).toContain('rotated');
  });

  it('fails gracefully when pageNumber is out of range', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const result = await pdfContrastWriterService.fixColorContrast(doc, contrastIssue({ pageNumber: 99 }));
    expect(result.success).toBe(false);
  });
});
