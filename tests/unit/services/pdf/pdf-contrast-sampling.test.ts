/**
 * Regression coverage for PdfContrastValidator's pixel-sampling accuracy —
 * specifically the DARK_SAMPLE_PERCENTILE fix (0.3 -> 0.05).
 *
 * Discovered via Phase B4 integration testing (auditing a real PDF, applying
 * a contrast fix, re-auditing to verify): the previous 30% percentile
 * diluted the "darkest pixels" average with background/anti-aliased pixels
 * whenever true glyph-ink coverage fell below ~30% of the sampled box — true
 * black 14pt regular-weight text (ink coverage measured at ~6%) sampled as
 * ~#a3a3a3 (2.5:1), a false positive severe enough to misflag ordinary body
 * text as failing contrast. This is a real-rendering test (not mocked) —
 * the bug is specifically in the pixel-sampling math, invisible to any test
 * that doesn't actually render.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

async function contrastIssuesFor(size: number, bold: boolean, color: number, text = 'Low contrast text') {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  page.drawText(text, { x: 60, y: 450, size, font, color: rgb(color, color, color) });
  const buffer = Buffer.from(await src.save());
  const report = await pdfAuditService.runAuditFromBuffer(buffer, `sampling-${size}-${bold}-${color}`, 'test.pdf', 'custom', ['contrast']);
  return report.issues.filter(i => i.code === 'COLOR-CONTRAST');
}

describe('PdfContrastValidator pixel-sampling accuracy', () => {
  it('does not flag true black 14pt regular-weight text as low contrast', async () => {
    const issues = await contrastIssuesFor(14, false, 0);
    expect(issues).toEqual([]);
  });

  it('does not flag true black 9pt regular-weight text as low contrast', async () => {
    const issues = await contrastIssuesFor(9, false, 0, 'Low contrast text here now');
    expect(issues).toEqual([]);
  });

  it('still flags genuinely low-contrast text (mid-gray on white)', async () => {
    const issues = await contrastIssuesFor(14, false, 0.6);
    expect(issues.length).toBe(1);
    expect(issues[0].contrastData!.ratio).toBeLessThan(4.5);
  });

  it('still flags genuinely low-contrast text even more severely for near-white on white', async () => {
    const issues = await contrastIssuesFor(14, false, 0.85);
    expect(issues.length).toBe(1);
    expect(issues[0].contrastData!.ratio).toBeLessThan(2);
  });

  // Same dilution bug as above, but pushed further: a table-of-contents
  // dot-leader run (". . . . . . ") spans a wide bbox while its actual ink
  // coverage is far below even the ~6% DARK_SAMPLE_PERCENTILE was tuned
  // against (isolated periods, not full glyphs) -- found via a real trial
  // document where fg sampled as #c0c0c0 on white (1.82:1) for what should
  // be near-black leader dots, and kept failing fix-verification even after
  // the writer escalated to pure black, since verification re-runs this
  // same sampling. sampleDark's backgroundLum-adaptive path (below) is what
  // fixes this specific case.
  it('does not flag true black dot-leader text (sparse ink over a wide bbox) as low contrast', async () => {
    const dotLeader = '. '.repeat(49).trim();
    const issues = await contrastIssuesFor(10, false, 0, dotLeader);
    expect(issues).toEqual([]);
  });

  // A first attempt at this fix (a gap-detection heuristic, since replaced --
  // see sampleDark's doc comment) only partially closed this at 8pt: it
  // shrank the sample but still averaged in enough anti-aliased edge to land
  // around 3.9:1, short of the 4.5:1 bar, on some platforms. The narrower
  // ADAPTIVE_DARK_SAMPLE_PERCENTILE this replaced it with resolves it fully.
  it('does not flag true black dot-leader text even at the smallest common size (8pt)', async () => {
    const dotLeader = '. '.repeat(49).trim();
    const issues = await contrastIssuesFor(8, false, 0, dotLeader);
    expect(issues).toEqual([]);
  });

  // CodeRabbit review finding on the PR that introduced the adaptive
  // percentile above: a single unrelated dark pixel in the sampled box (a
  // stray mark, a bleed from adjacent content, a compression artifact)
  // could dominate the narrow ADAPTIVE_DARK_SAMPLE_PERCENTILE slice and
  // falsely pass text that's genuinely low-contrast throughout. Draws the
  // same mid-gray text as the "still flags genuinely low-contrast" case
  // above, plus one small solid-black mark overlapping its bounding box, to
  // confirm the ink-coverage guard (sampleDark's own doc comment) routes
  // this back to the flat percentile instead of narrowing.
  it('still flags genuinely low-contrast text even with one unrelated dark pixel in its box', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 60, y: 450, size: 14, font, color: rgb(0.6, 0.6, 0.6) });
    page.drawRectangle({ x: 62, y: 451, width: 4, height: 4, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());
    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'sampling-stray-artifact', 'test.pdf', 'custom', ['contrast']);
    const issues = report.issues.filter(i => i.code === 'COLOR-CONTRAST');
    expect(issues.length).toBe(1);
    expect(issues[0].contrastData!.ratio).toBeLessThan(4.5);
  });

});
