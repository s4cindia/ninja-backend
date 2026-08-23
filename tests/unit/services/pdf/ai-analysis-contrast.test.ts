import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// analyzeColorContrast is private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const BASE_ISSUE: AuditIssue = {
  id: 'contrast-1',
  source: 'contrast-validator',
  severity: 'serious',
  code: 'COLOR-CONTRAST',
  message: 'Text has contrast ratio 2.10:1 (minimum 4.5:1 required for normal text)',
  pageNumber: 3,
};

describe('analyzeColorContrast', () => {
  it('turns the validator-measured contrastData into a deterministic, high-confidence suggestion', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#777777',
        background: '#ffffff',
        ratio: 2.1,
        requiredRatio: 4.5,
        isLargeText: false,
      },
    };

    const res = svc.analyzeColorContrast(issue, {} as PdfParseResult, 'guidance-only');

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(0.95);
    expect(res.guidance).toContain('4.5:1');
    expect(res.guidance).toContain('#777777');
    expect(res.guidance).toContain('#ffffff');
    expect(res.rationale).toContain('2.1:1');
  });

  it('uses the large-text threshold when contrastData.isLargeText is true', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#999999',
        background: '#ffffff',
        ratio: 2.6,
        requiredRatio: 3.0,
        isLargeText: true,
      },
    };

    const res = svc.analyzeColorContrast(issue, {} as PdfParseResult, 'guidance-only');
    expect(res.guidance).toContain('3:1');
    expect(res.guidance).toContain('large text');
  });

  it('returns null when the issue has no contrastData (never calls Gemini)', () => {
    const res = svc.analyzeColorContrast(BASE_ISSUE, {} as PdfParseResult, 'guidance-only');
    expect(res).toBeNull();
  });
});

describe('analyzeColorContrast — apply-to-pdf eligibility (Phase B3)', () => {
  async function buildParsed(x: number, y: number, size: number): Promise<PdfParseResult> {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x, y, size, font });
    const pdfLibDoc = await PDFDocument.load(await src.save());
    return {
      metadata: {} as PdfParseResult['metadata'],
      pages: [{ pageNumber: 1, rotation: 0 } as PdfParseResult['pages'][0]],
      parsedPdf: { pdfLibDoc } as PdfParseResult['parsedPdf'],
    } as unknown as PdfParseResult;
  }

  function contrastIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
    return {
      ...BASE_ISSUE,
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

  it('emits a color-contrast-fix suggestion when the text run is confidently located', async () => {
    const parsed = await buildParsed(100, 450, 14);
    const res = svc.analyzeColorContrast(contrastIssue(), parsed, 'apply-to-pdf');

    expect(res.suggestionType).toBe('color-contrast-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.confidence).toBeGreaterThanOrEqual(0.80);
    expect(res.confidence).toBeLessThanOrEqual(0.95);
    expect(res.guidance).toContain(res.value);
  });

  it('falls back to guidance-only when no text is near the flagged position', async () => {
    const parsed = await buildParsed(100, 450, 14);
    const issue = contrastIssue({
      boundingBox: { x: 300, y: 600 - 50, width: 100, height: 14, pageWidth: 400, pageHeight: 600 },
    });

    const res = svc.analyzeColorContrast(issue, parsed, 'apply-to-pdf');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('falls back to guidance-only on a rotated page', async () => {
    const parsed = await buildParsed(100, 450, 14);
    parsed.pages[0].rotation = 90;

    const res = svc.analyzeColorContrast(contrastIssue(), parsed, 'apply-to-pdf');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('stays guidance-only when mode is guidance-only, even if the text would be locatable', async () => {
    const parsed = await buildParsed(100, 450, 14);
    const res = svc.analyzeColorContrast(contrastIssue(), parsed, 'guidance-only');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });
});
