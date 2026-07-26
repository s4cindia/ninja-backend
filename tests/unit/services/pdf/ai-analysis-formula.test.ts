import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// analyzeFormulaActualText / renderRegionToBase64 are private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const ISSUE: AuditIssue = {
  id: 'pdf-formula-1',
  source: 'pdf-formula',
  severity: 'serious',
  code: 'FORMULA-MISSING-ACTUALTEXT',
  message: 'Formula on page 1 has no text alternative (ActualText)',
  pageNumber: 1,
  element: 'formula_p1_mc0',
  boundingBox: { x: 80, y: 120, width: 240, height: 60, pageWidth: 400, pageHeight: 600 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gemini = (text: string, usage?: any) =>
  vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({ text, usage } as never);

describe('analyzeFormulaActualText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts ActualText from the formula region (tagged → apply-to-pdf, needs review)', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"latex":"E = mc^2","actualText":"E equals m c squared"}', { promptTokens: 10, completionTokens: 5 });

    const res = await svc.analyzeFormulaActualText(ISSUE, {}, true);
    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('formula-actualtext');
    expect(res.value).toBe('E equals m c squared');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.requiresManualReview).toBe(true);
    expect(res.guidance).toContain('E = mc^2'); // LaTeX shown to the reviewer
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('downgrades to guidance-only when the PDF is untagged', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"actualText":"x squared"}');
    const res = await svc.analyzeFormulaActualText(ISSUE, {}, false);
    expect(res.value).toBe('x squared');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('returns null when the model yields no actualText', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"latex":"x"}');
    expect(await svc.analyzeFormulaActualText(ISSUE, {}, true)).toBeNull();
  });

  it('returns null when the region cannot be rendered', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue(null);
    const spy = vi.spyOn(geminiService, 'analyzeImage');
    const res = await svc.analyzeFormulaActualText(ISSUE, {}, true);
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // no wasted vision call
  });

  it('returns null (not a rejected promise) when the vision call throws', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('429 rate limit'));
    await expect(svc.analyzeFormulaActualText(ISSUE, {}, true)).resolves.toBeNull();
  });
});
