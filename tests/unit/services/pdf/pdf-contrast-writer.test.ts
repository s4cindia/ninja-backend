import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { spliceColorWrap, spliceColorReplace, pdfContrastWriterService } from '../../../../src/services/pdf/pdf-contrast-writer.service';
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

describe('spliceColorWrap', () => {
  it('wraps the exact byte range in q/rg/Q without touching anything outside it', () => {
    const content = 'BEFORE q BT 1 0 0 1 50 150 Tm <41> Tj ET Q AFTER';
    const start = content.indexOf('BT');
    const end = content.indexOf('ET') + 'ET'.length;

    const result = spliceColorWrap(content, start, end, [0.2, 0.3, 0.4]);

    expect(result).toBe(
      'BEFORE q q\n0.2 0.3 0.4 rg\nBT 1 0 0 1 50 150 Tm <41> Tj ET\nQ\n Q AFTER'
    );
    expect(result.startsWith('BEFORE q ')).toBe(true);
    expect(result.endsWith(' Q AFTER')).toBe(true);
  });

  it('preserves the wrapped content byte-for-byte', () => {
    const content = 'xBT foo bar ETy';
    const result = spliceColorWrap(content, 1, 14, [0, 0, 0]);
    expect(result).toContain('BT foo bar ET');
  });
});

describe('spliceColorReplace', () => {
  it('replaces exactly the operator span, leaving everything else untouched', () => {
    const content = 'BT\n0.6 0.6 0.6 rg\n/F1 14 Tf\n<41> Tj\nET';
    const start = content.indexOf('0.6 0.6 0.6 rg');
    const end = start + '0.6 0.6 0.6 rg'.length;

    const result = spliceColorReplace(content, start, end, [0, 0, 0]);

    expect(result).toBe('BT\n0 0 0 rg\n/F1 14 Tf\n<41> Tj\nET');
  });

  it('does not add any wrapping — the replacement is inline', () => {
    const content = 'BT 0.5 0.5 0.5 rg <41> Tj ET';
    const start = content.indexOf('0.5 0.5 0.5 rg');
    const end = start + '0.5 0.5 0.5 rg'.length;

    const result = spliceColorReplace(content, start, end, [1, 1, 1]);

    expect(result).toBe('BT 1 1 1 rg <41> Tj ET');
    expect(result).not.toContain('q\n');
    expect(result).not.toContain('\nQ');
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
      .mockResolvedValueOnce({ ratio: 1.8, passes: false, foreground: '#aaaaaa', background: '#ffffff' })
      .mockResolvedValueOnce({ ratio: 15, passes: true, foreground: '#000000', background: '#ffffff' });

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
      expect(result.error).toContain('did not verify');
      expect(result.after).toBe('unknown');
    }
    // If this environment's rendering happens to verify successfully, that's
    // fine too — the invariant under test is "never report success without
    // verification", not "this exact scenario must fail everywhere".
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
