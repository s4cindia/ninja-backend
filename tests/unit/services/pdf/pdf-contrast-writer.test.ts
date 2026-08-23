import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { spliceColorWrap, pdfContrastWriterService } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

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

describe('PdfContrastWriterService.fixColorContrast', () => {
  async function realPdfWithText(x: number, y: number, size: number): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x, y, size, font });
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
      boundingBox: { x: 100, y: 600 - 450, width: 100, height: 14, pageWidth: 400, pageHeight: 600 },
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

  it('rewrites the flagged text color and reports before/after', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const issue = contrastIssue();

    const result = pdfContrastWriterService.fixColorContrast(doc, issue);

    expect(result.success).toBe(true);
    expect(result.before).toContain('#999999');
    expect(result.after).toContain('#ffffff');
    // Achieved ratio clears the required 4.5:1 (plus the B0 safety margin).
    const achieved = parseFloat(/\(([\d.]+):1\)/.exec(result.after)![1]);
    expect(achieved).toBeGreaterThanOrEqual(4.5);

    const content = decodePageContent(doc, 1)!;
    expect(content).toMatch(/q\n[\d.]+ [\d.]+ [\d.]+ rg\nBT/);
    expect(content).toContain('Tj'); // original text-show op preserved
  });

  it('survives a save/reload cycle with the corrected color intact', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    pdfContrastWriterService.fixColorContrast(doc, contrastIssue());

    const reloaded = await PDFDocument.load(await doc.save());
    const content = decodePageContent(reloaded, 1)!;
    expect(content).toMatch(/q\n[\d.]+ [\d.]+ [\d.]+ rg\nBT/);
  });

  it('fails gracefully when the issue has no contrastData', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const result = pdfContrastWriterService.fixColorContrast(doc, contrastIssue({ contrastData: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('contrastData');
  });

  it('fails gracefully when no text is near the target point', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const issue = contrastIssue({
      boundingBox: { x: 300, y: 600 - 50, width: 100, height: 14, pageWidth: 400, pageHeight: 600 },
    });
    const result = pdfContrastWriterService.fixColorContrast(doc, issue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not confidently locate');
  });

  it('fails gracefully on a rotated page', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font });
    page.setRotation(degrees(90));
    const doc = await PDFDocument.load(await src.save());

    const result = pdfContrastWriterService.fixColorContrast(doc, contrastIssue());
    expect(result.success).toBe(false);
    expect(result.error).toContain('rotated');
  });

  it('fails gracefully when pageNumber is out of range', async () => {
    const doc = await realPdfWithText(100, 450, 14);
    const result = pdfContrastWriterService.fixColorContrast(doc, contrastIssue({ pageNumber: 99 }));
    expect(result.success).toBe(false);
  });
});
