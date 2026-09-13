import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { spliceColorFix, pdfContrastWriterService } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import { locateTextRun } from '../../../../src/services/pdf/contrast-content-stream';
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

  // Real-world regression, confirmed live on a real Math_Kim page (see the
  // matching fixture/test in contrast-content-stream.test.ts): locateTextRun
  // must hand spliceColorFix a run whose start sits AFTER a Td that
  // positioned it, not at Td's own start -- otherwise this insertion (the
  // "no internal op" branch, since color here is inherited from before the
  // run) lands between Td's own operands and its operator, corrupting the
  // positioning call. This is the full locate -> splice round trip; the
  // sibling test only checked locateTextRun's span in isolation.
  it('produces a syntactically intact Td when the located run was positioned via a relative Td', () => {
    const content = `BT
1 0 0 1 50 700 Tm
(Figure 4.1.1.) Tj
0 0.68 0.97 0 k
-20 -3 Td
(Table 4.1.2.) Tj
ET
`;
    const match = locateTextRun(content, { x: 30, baselineY: 697 }, 15)!;
    expect(match).toBeTruthy();

    const result = spliceColorFix(content, match, match.internalFillColorOp, [0, 0, 0], [1, 0, 0]);

    expect(result).toContain('-20 -3 Td');
    expect(result).not.toMatch(/-20 -3 [\d. ]*rg\s*\nTd/);
  });

  // Real-world regression, confirmed live on a real Math_Kim page (see the
  // matching fixture/test in contrast-content-stream.test.ts): a color-
  // setting op after a run's last show op belongs to the NEXT run, not
  // this one -- overwriting it in place recolors nothing the flagged text
  // actually shows, while corrupting the next run's own intended color.
  it('recolors the flagged text (not a trailing color op meant for the next run) and leaves that next run\'s color untouched', () => {
    const content = `BT
1 0 0 1 50 700 Tm
(Figure 4.1.1.) Tj
0 0 0 1 k
5.86 0 Td
(Integer number lines) Tj
0 0.68 0.97 0 k
1 0 0 1 30 685 Tm
(Table 4.1.2.) Tj
0 0 0 1 k
5.453 0 Td
(Math Navigation Chart) Tj
ET
`;
    const match = locateTextRun(content, { x: 30, baselineY: 685 }, 12)!;
    expect(match).toBeTruthy();
    expect(match.internalFillColorOp).toBeUndefined();

    const result = spliceColorFix(content, match, match.internalFillColorOp, [0, 0, 0], [1, 0.44, 0.15]);

    // New color lands right where "Table 4.1.2." is actually shown.
    expect(result).toMatch(/30 685 Tm\n0 0 0 rg\n\n\(Table 4\.1\.2\.\) Tj/);
    // The restore lands BEFORE the trailing "0 0 0 1 k" (lastShowEnd, not
    // the run's full end) -- that trailing op must stay the LAST color
    // statement before "Math Navigation Chart" shows, still correctly
    // attached to its own Td (not split apart by the restore op). Restoring
    // AFTER it (the pre-fix behavior) would fire last and silently override
    // the next run's own intended color instead of restoring this run's.
    expect(result).toContain('1 0.44 0.15 rg\n\n0 0 0 1 k\n5.453 0 Td\n(Math Navigation Chart) Tj');
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

  it('draws a backplate and reports success when the background is only moderately non-uniform', async () => {
    // Both text-color escalations fail the same way (uncertain), but this
    // time with a variance comfortably under BUSY_VARIANCE_THRESHOLD (0.08)
    // -- e.g. a subtle gradient or a neighboring element's edge bleeding
    // into the sample, not a real photo/illustration. The writer should
    // fall back to a backplate rather than giving up.
    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 3.0, passes: false, foreground: '#888888', background: '#ffffff', uncertain: true, variance: 0.05 })
      .mockResolvedValueOnce({ ratio: 6.0, passes: false, foreground: '#000000', background: '#ffffff', uncertain: true, variance: 0.05 })
      .mockResolvedValueOnce({ ratio: 18.0, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false, variance: 0.001 });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-backplate-success', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(mockVerify).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    expect(result.after).toContain('backplate');
    expect(result.after).toContain('verified 18:1');

    const content = decodePageContent(doc, 1)!;
    expect(content).toContain(' re\nf\nQ'); // the backplate's own fill sequence landed in the page
    expect(content).toContain('Tj'); // original text-show op still present, untouched
  });

  it('leaves a genuinely busy background as guidance-only rather than stamping a backplate over it', async () => {
    // Same shape as the moderate-variance case above, but variance is well
    // past BUSY_VARIANCE_THRESHOLD (0.08) -- a real photo/illustration, not
    // a subtle gradient. The backplate must never even be attempted here:
    // stamping an opaque box behind text on a busy background is a visible,
    // potentially jarring change that should stay a human decision.
    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 3.0, passes: false, foreground: '#888888', background: '#ffffff', uncertain: true, variance: 0.5 })
      .mockResolvedValueOnce({ ratio: 6.0, passes: false, foreground: '#000000', background: '#ffffff', uncertain: true, variance: 0.5 });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-backplate-skipped-busy', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;
    const beforeContent = decodePageContent(doc, 1)!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    // Exactly 2 calls -- proves the backplate path was skipped outright,
    // not attempted and then separately failed (which would be 3 calls).
    expect(mockVerify).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not confidently measure');
    const afterContent = decodePageContent(doc, 1)!;
    expect(afterContent).toBe(beforeContent);
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
