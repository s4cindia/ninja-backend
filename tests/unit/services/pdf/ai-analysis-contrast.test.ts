import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { aiAnalysisService, buildSuggestionCacheKey } from '../../../../src/services/pdf/ai-analysis.service';
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

describe('buildSuggestionCacheKey', () => {
  // Real-world regression: a pilot PDF with several independent low-contrast
  // text runs on one page came back 100% guidance-only under apply-to-pdf
  // mode. Root cause was here, not in the correlator — two distinct
  // COLOR-CONTRAST issues on the same page collapsed onto the same
  // suggestion-cache key (page-level, like reading-order/tables), so only
  // the page's first issue ever got a real correlation check; every other
  // issue on that page silently inherited its (possibly failed) result.
  it('gives two distinct contrast issues on the same page distinct keys', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'contrast-a', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'contrast-b', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });

  it('gives the same contrast issue the same key on repeat calls (still cacheable per-issue)', () => {
    const issue: AuditIssue = { ...BASE_ISSUE, id: 'contrast-a', pageNumber: 5 };
    expect(buildSuggestionCacheKey(issue)).toBe(buildSuggestionCacheKey({ ...issue }));
  });

  it('still shares one key across a whole page for genuinely page-level codes', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'ro-a', code: 'READING-ORDER-SUSPECT', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'ro-b', code: 'READING-ORDER-SUSPECT', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(b));
  });

  it('still shares one key across the whole document for document-level codes', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'h-a', code: 'HEADING-SKIP', pageNumber: 2 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'h-b', code: 'HEADING-SKIP', pageNumber: 9 };
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(b));
  });

  it('still keys element-level codes by element, not page', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'alt-a', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-1' };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'alt-b', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-2' };
    const c: AuditIssue = { ...BASE_ISSUE, id: 'alt-c', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-1' };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(c));
  });
});
