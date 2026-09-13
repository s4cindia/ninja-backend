import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { TABLE_LIKELY_FORMULA_CODE } from '../../../../src/services/pdf/validators/pdf-table.validator';
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

  // Regression test for a real-world bug found on a math-heavy trial document:
  // gemini-3.6-flash is a reasoning model whose invisible "thinking" tokens
  // count against maxOutputTokens before any visible text is emitted. At the
  // original maxOutputTokens: 256 (plain analyzeImage + manual JSON.parse,
  // no responseSchema), every one of 117 real formulas on that document hit
  // finishReason MAX_TOKENS and got truncated to a handful of characters --
  // and parseAiJson's own catch swallows the failure silently, so this
  // presented as "zero fixes applied, zero errors logged, every round" with
  // nothing pointing at the cause. Verified live against the real document:
  // 0/8 sample formulas produced a usable response at maxOutputTokens 256-600
  // even with a schema; 8/8 succeeded at 2048. This test pins the two knobs
  // that fix it -- constrained decoding (responseSchema, which also
  // eliminates the markdown-fenced/conversational preamble Gemini otherwise
  // prepends) and a token budget large enough to survive invisible thinking
  // tokens -- so a future edit can't silently drop either one.
  it('uses schema-constrained decoding with a large enough token budget to survive a reasoning model\'s invisible thinking tokens', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    const spy = gemini('{"actualText":"x squared"}');

    await svc.analyzeFormulaActualText(ISSUE, {}, true);

    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0][3];
    expect(options.responseSchema).toBeTruthy();
    expect(options.maxOutputTokens).toBeGreaterThanOrEqual(2048);
  });

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

  it('allows apply-to-pdf but stays lower-confidence for a table-redirected issue on a tagged PDF', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"actualText":"x squared plus one"}');

    const redirectedIssue: AuditIssue = { ...ISSUE, code: TABLE_LIKELY_FORMULA_CODE };
    const res = await svc.analyzeFormulaActualText(redirectedIssue, {}, true);

    // Now that pdfModifierService.setActualText's write path is hardened
    // (elementTypes override, no silent wrong-element fallback), a
    // redirected suggestion is applicable like a genuine formula one —
    // still flagged distinctly via confidence/guidance for the reviewer.
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.confidence).toBe(0.5);
    expect(res.guidance).toContain('tagged as a Table, not a Formula');
    expect(res.rationale).toContain('heuristically redirected from a table classification');
  });

  it('stays guidance-only for a table-redirected issue on an untagged PDF', async () => {
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"actualText":"x squared plus one"}');

    const redirectedIssue: AuditIssue = { ...ISSUE, code: TABLE_LIKELY_FORMULA_CODE };
    const res = await svc.analyzeFormulaActualText(redirectedIssue, {}, false);

    expect(res.applyMode).toBe('guidance-only');
    expect(res.confidence).toBe(0.5);
  });
});
