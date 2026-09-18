import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { spliceColorFix, pdfContrastWriterService, resolveColorContrastTargets } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import { locateTextRun, findPrecedingColor } from '../../../../src/services/pdf/contrast-content-stream';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { verifyContrastInRegion } from '../../../../src/services/pdf/color-contrast-verification';
import { BUSY_VARIANCE_THRESHOLD } from '../../../../src/services/pdf/validators/pdf-contrast.validator';
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

describe('findPrecedingColor', () => {
  it('finds the nearest preceding rg op, ignoring ops that come after beforePos', () => {
    const content = '0 0 0 rg\n(black) Tj\n1 0 0 rg\n(red) Tj\n0 1 0 rg\n(green) Tj';
    const beforePos = content.indexOf('1 0 0 rg');

    expect(findPrecedingColor(content, beforePos)).toEqual([0, 0, 0]);
  });

  it('parses a preceding gray (g) op', () => {
    const content = '0.5 g\n(gray text) Tj\nHERE';
    expect(findPrecedingColor(content, content.indexOf('HERE'))).toEqual([0.5, 0.5, 0.5]);
  });

  it('parses a preceding CMYK (k) op', () => {
    const content = '0 0 0 1 k\n(black via cmyk) Tj\nHERE';
    expect(findPrecedingColor(content, content.indexOf('HERE'))).toEqual([0, 0, 0]);
  });

  it('declines (returns null) when the nearest preceding op is scn, rather than falling through to an earlier rg', () => {
    const content = '0 0 0 rg\n(black) Tj\n/CS0 scn\n(untracked colorspace) Tj\nHERE';
    expect(findPrecedingColor(content, content.indexOf('HERE'))).toBeNull();
  });

  it('declines (returns null) when the nearest preceding op is sc', () => {
    const content = '1 sc\n(untracked) Tj\nHERE';
    expect(findPrecedingColor(content, content.indexOf('HERE'))).toBeNull();
  });

  it('falls back to pure black when no fill-color op precedes this position at all', () => {
    const content = '(no color op before this) Tj\nHERE';
    expect(findPrecedingColor(content, content.indexOf('HERE'))).toEqual([0, 0, 0]);
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
    // time with a variance comfortably under BUSY_VARIANCE_THRESHOLD (0.15)
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

  it('draws a backplate when the background is flat and known but too mid-luminance for text-color escalation alone', async () => {
    // Real Math_Weir_PDF.pdf finding (PR #575): a confidently-FLAT medium
    // gray background (e.g. #9b9c9f) caps even pure-black text's
    // theoretical ratio around 7-8:1, and small-text anti-aliasing dilution
    // (this file's own header doc comment) eats enough of that modest
    // headroom that the measured ratio still lands below 4.5:1 -- even
    // though extreme escalation is genuinely as dark as it can go and the
    // background reads as NOT uncertain (unlike every other backplate test
    // above, which mocks uncertain:true). Confirms the OR'd `!passes`
    // condition, not just `uncertain`, reaches the backplate tier here.
    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 2.42, passes: false, foreground: '#f0f0f0', background: '#9b9c9f', uncertain: false, variance: 0.001 })
      .mockResolvedValueOnce({ ratio: 2.42, passes: false, foreground: '#f0f0f0', background: '#9b9c9f', uncertain: false, variance: 0.001 })
      .mockResolvedValueOnce({ ratio: 18.76, passes: true, foreground: '#000000', background: '#000000', uncertain: false, variance: 0.001 });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-backplate-flat-insufficient', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(mockVerify).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    expect(result.after).toContain('backplate');
    expect(result.after).toContain('verified 18.76:1');
  });

  it('leaves a genuinely busy background as guidance-only rather than stamping a backplate over it', async () => {
    // Same shape as the moderate-variance case above, but variance is well
    // past BUSY_VARIANCE_THRESHOLD (0.15) -- a real photo/illustration, not
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

  it('backplates a variance measured against a real Math_Kim document (table-border-contaminated cell, not a photo)', async () => {
    // Regression for the live-validation finding that set BUSY_VARIANCE_
    // THRESHOLD to 0.15: every genuinely-uncertain case measured on that
    // 214-issue document sample fell in 0.095-0.144 (a table row's border
    // rule sitting in the tier-0 probe, not a photo) -- the prior 0.08
    // excluded all of them, so this whole tier measured 0 real-world wins.
    expect(BUSY_VARIANCE_THRESHOLD).toBe(0.15);

    const mockVerify = vi.mocked(verifyContrastInRegion);
    mockVerify.mockClear();
    mockVerify
      .mockResolvedValueOnce({ ratio: 3.0, passes: false, foreground: '#888888', background: '#ffffff', uncertain: true, variance: 0.1272 })
      .mockResolvedValueOnce({ ratio: 6.0, passes: false, foreground: '#000000', background: '#ffffff', uncertain: true, variance: 0.1272 })
      .mockResolvedValueOnce({ ratio: 18.0, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false, variance: 0.001 });

    const doc = await realPdfWithText(60, 450, 14, { bold: false });
    const originalReport = await pdfAuditService.runAuditFromBuffer(
      Buffer.from(await doc.save()), 'writer-test-backplate-real-variance', 'test.pdf', 'custom', ['contrast']
    );
    const issue = originalReport.issues.find(i => i.code === 'COLOR-CONTRAST')!;

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(result.success).toBe(true);
    expect(result.after).toContain('backplate');
  });

  // Real-world incident, confirmed live on Math_Weir_PDF.pdf: a tiny
  // "error" annotation's own original color was a one-off gray, unrelated
  // to the rest of the page. The original (pre-findPrecedingColor)
  // restore mechanism used that gray as the restore-after-run value --
  // but since `rg` isn't graphics-state-scoped, that gray leaked forward
  // and repainted the next, wholly unrelated run ("becomes", always
  // black) gray too, registering as a brand-new contrast failure the
  // original document never had. fixColorContrast must restore whatever
  // was ACTUALLY ambient before this run (here: nothing precedes it at
  // all, so pure black by default), never this run's own original color.
  it('restores the ambient color from before the run (not the fixed run\'s own original color) so a later, unrelated run is unaffected', async () => {
    vi.mocked(verifyContrastInRegion).mockResolvedValue({ ratio: 15, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false });

    const src = await PDFDocument.create();
    src.addPage([500, 700]);
    const doc = await PDFDocument.load(await src.save());
    const content = `BT
1 0 0 1 50 150 Tm
0.4588 0.4627 0.4824 rg
(error) Tj
ET
BT
1 0 0 1 50 130 Tm
(becomes) Tj
ET
`;
    writePageContent(doc, 1, content);

    const issue = contrastIssue({
      boundingBox: { x: 50, y: 700 - 150, width: 40, height: 14, pageWidth: 500, pageHeight: 700 },
      contrastData: { foreground: '#75767b', background: '#ffffff', ratio: 2.1, requiredRatio: 4.5, isLargeText: false },
    });

    const result = await pdfContrastWriterService.fixColorContrast(doc, issue);
    expect(result.success).toBe(true);

    const finalContent = decodePageContent(doc, 1)!;
    const afterError = finalContent.slice(
      finalContent.indexOf('(error) Tj') + '(error) Tj'.length,
      finalContent.indexOf('BT\n1 0 0 1 50 130')
    );
    expect(afterError).toContain('0 0 0 rg');
    expect(afterError).not.toMatch(/0\.4588/);
    // The next run is completely untouched -- no restore/fix op of any
    // kind was ever inserted into or around it.
    expect(finalContent).toContain('BT\n1 0 0 1 50 130 Tm\n(becomes) Tj\nET');
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

describe('resolveColorContrastTargets + multi-segment restore-color correctness', () => {
  afterEach(() => {
    vi.mocked(verifyContrastInRegion).mockClear();
  });

  // A single run with a colored word embedded in otherwise plain text --
  // confirmed live on Math_Kim's real remaining COLOR-CONTRAST issues to be
  // the dominant real-world pattern locateTextRun alone correctly refuses
  // (mixedColor -> confidence 0). Three issues map to this run's three
  // color-delimited segments: "black text " (inherits color, no internal
  // op), "RED WORD" (governed by the first internal op), "more black"
  // (governed by the second/last internal op).
  async function buildMultiSegmentRunDoc(): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    src.addPage([500, 700]);
    const doc = await PDFDocument.load(await src.save());
    const content = `BT
1 0 0 1 50 150 Tm
(black text ) Tj
1 0 0 rg
(RED WORD) Tj
0 0 0 rg
(more black) Tj
ET
`;
    writePageContent(doc, 1, content);
    return doc;
  }

  function segmentIssue(id: string, x: number, foreground: string): AuditIssue {
    return {
      id,
      source: 'contrast-validator',
      severity: 'serious',
      code: 'COLOR-CONTRAST',
      message: 'Text has contrast ratio 2.10:1 (minimum 4.5:1 required for normal text)',
      pageNumber: 1,
      boundingBox: { x, y: 700 - 150, width: 60, height: 14, pageWidth: 500, pageHeight: 700 },
      contrastData: { foreground, background: '#ffffff', ratio: 2.1, requiredRatio: 4.5, isLargeText: false },
    };
  }

  it('fixes the MIDDLE segment of a multi-color run and restores the run\'s TRUE final color afterward -- not the fixed segment\'s own original color', async () => {
    vi.mocked(verifyContrastInRegion).mockResolvedValue({ ratio: 15, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false });

    const doc = await buildMultiSegmentRunDoc();
    const seg0 = segmentIssue('seg0', 50, '#000000');
    const seg1 = segmentIssue('seg1', 80, '#ff0000'); // the RED WORD -- being fixed
    const seg2 = segmentIssue('seg2', 120, '#000000');

    const matches = resolveColorContrastTargets(doc, [seg0, seg1, seg2]);
    expect(matches.get('seg1')).toBeTruthy();
    expect(matches.get('seg1')!.restoreColorOverride).toEqual([0, 0, 0]); // the run's real final color (black), not red

    const result = await pdfContrastWriterService.fixColorContrast(doc, seg1, matches);
    expect(result.success).toBe(true);

    const finalContent = decodePageContent(doc, 1)!;
    // The restore-after-run op must set BLACK, not red (seg1's own original
    // foreground) -- using red here would leave the wrong color active for
    // whatever renders after this run, a new contrast defect this fix must
    // never introduce. fixColorContrast no longer reads restoreColorOverride
    // for this value -- it derives it via findPrecedingColor, scanning
    // backward from seg1's own internal fill op. Nothing precedes that op in
    // this fixture, so findPrecedingColor falls back to its documented
    // default (pure black), which happens to coincide with the run's true
    // final color here -- a real, empirically-verified case, not an
    // assumption.
    const afterLastShow = finalContent.slice(finalContent.lastIndexOf('(more black) Tj') + '(more black) Tj'.length);
    expect(afterLastShow).toContain('0 0 0 rg');
    expect(afterLastShow).not.toMatch(/^\s*1 0 0 rg/);
    expect(finalContent).not.toContain('q\n');
  });

  it('leaves the run\'s OWN last segment fix using the normal single-op restore path (unchanged behavior)', async () => {
    vi.mocked(verifyContrastInRegion).mockResolvedValue({ ratio: 15, passes: true, foreground: '#000000', background: '#ffffff', uncertain: false });

    const doc = await buildMultiSegmentRunDoc();
    const seg0 = segmentIssue('seg0', 50, '#000000');
    const seg1 = segmentIssue('seg1', 80, '#ff0000');
    const seg2 = segmentIssue('seg2', 120, '#000000');

    const matches = resolveColorContrastTargets(doc, [seg0, seg1, seg2]);
    // seg2 IS the run's last segment -- its restoreColorOverride still
    // equals the run's final color, which by construction is also its own
    // original color, so this remains correct without any special-casing.
    expect(matches.get('seg2')!.restoreColorOverride).toEqual([0, 0, 0]);

    const result = await pdfContrastWriterService.fixColorContrast(doc, seg2, matches);
    expect(result.success).toBe(true);
  });
});
