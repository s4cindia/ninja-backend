import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';

/**
 * Unit coverage for analyzeTableHeaders and analyzeTableLayout -- the AI
 * fallback drafters for tables PR #560's rule-based orientation fix declines
 * to touch (ambiguous orientation, no regular header row in the first few
 * rows, or >6 columns) and for layout-vs-data classification, respectively.
 *
 * Built to fix the same MAX_TOKENS-truncation trap already documented and
 * fixed for analyzeFormulaActualText/analyzeTableSummary/alt-text (see
 * TABLE_HEADERS_SCHEMA's doc comment): both functions used a freeform-JSON
 * prompt (geminiService.generateText, no responseSchema, maxOutputTokens:
 * 512). Live measurement against Math_Kim's real remaining fallback tables:
 * 15/15 sampled analyzeTableHeaders calls returned null, and a raw-response
 * capture on 4 of them confirmed finishReason MAX_TOKENS every time
 * (completionTokens ~19-21, totalTokens ~607-618) -- the model's markdown-
 * fenced preamble consumed the whole visible-output budget before ever
 * reaching the JSON payload. Fixed via schema-constrained decoding
 * (geminiService.generateWithSchema) + a bigger token budget, the same
 * pattern already proven three times this session. analyzeTableLayout has
 * the identical freeform/512-token shape immediately adjacent in the file
 * and was fixed alongside it rather than left as a known-remaining instance
 * of the same bug.
 *
 * Note: both functions are hardcoded applyMode: 'guidance-only' regardless
 * of Gemini's answer -- this fix improves the quality of human-reviewable
 * guidance for these fallback/ambiguous cases, not auto-resolved issue
 * counts (unlike the table-summary/alt-text fixes, which do reach
 * apply-to-pdf).
 */

// analyzeTableHeaders/analyzeTableLayout are private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

function buildTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'table_p27_2',
    pageNumber: 27,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 5,
    columnCount: 3,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [
      { row: 0, column: 0, text: '', isHeader: false, rowSpan: 1, colSpan: 1 },
      { row: 0, column: 1, text: 'Go to Bridge Lessons', isHeader: false, rowSpan: 1, colSpan: 1 },
      { row: 0, column: 2, text: 'Go to Bridge Practice', isHeader: false, rowSpan: 1, colSpan: 1 },
    ],
    issues: [],
    isAccessible: false,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSchemaResult = (data: unknown, usage?: any) =>
  vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({ data, usage, attempts: 1 } as never);

describe('analyzeTableHeaders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts guidance via schema-constrained decoding with a generous token budget', async () => {
    mockSchemaResult(
      { headerRow: ['', 'Go to Bridge Lessons', 'Go to Bridge Practice'], guidance: 'Mark row 0 as the header row.', confidence: 0.8, rationale: 'nav table' },
      { promptTokens: 590, completionTokens: 24, totalTokens: 614 }
    );

    const res = await svc.analyzeTableHeaders({ id: 'i1' }, buildTable());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-headers');
    expect(res.guidance).toBe('Mark row 0 as the header row.');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.confidence).toBe(0.8);
    expect(res.rationale).toBe('nav table');
    expect(res.usage).toEqual({ promptTokens: 590, completionTokens: 24 });

    // Regression guard for the actual fix: must request schema-constrained
    // output with a real budget, not the old fragile freeform-JSON prompt.
    const callArgs = vi.mocked(geminiService.generateWithSchema).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ maxOutputTokens: 2048, responseSchema: expect.any(Object) });
  });

  it('falls back to a headerRow-derived guidance string when the model omits guidance', async () => {
    mockSchemaResult({ headerRow: ['A', 'B'], confidence: 0.6, rationale: 'r' });

    const res = await svc.analyzeTableHeaders({ id: 'i1' }, buildTable());

    expect(res.guidance).toBe('Header row: A, B');
  });

  it('falls back to "no clear header row" when the model omits both guidance and headerRow', async () => {
    mockSchemaResult({ confidence: 0.4, rationale: 'r' });

    const res = await svc.analyzeTableHeaders({ id: 'i1' }, buildTable());

    expect(res.guidance).toBe('No clear header row detected');
  });

  it('always stays guidance-only regardless of the model output', async () => {
    mockSchemaResult({ headerRow: ['A'], guidance: 'g', confidence: 0.9, rationale: 'r' });

    const res = await svc.analyzeTableHeaders({ id: 'i1' }, buildTable());

    expect(res.applyMode).toBe('guidance-only');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));

    await expect(svc.analyzeTableHeaders({ id: 'i1' }, buildTable())).resolves.toBeNull();
  });
});

describe('analyzeTableLayout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts guidance via schema-constrained decoding with a generous token budget', async () => {
    mockSchemaResult(
      { isLayout: false, confidence: 0.75, reasoning: 'contains real tabular data', guidance: 'Ensure it has proper headers and summary.' },
      { promptTokens: 590, completionTokens: 22, totalTokens: 612 }
    );

    const res = await svc.analyzeTableLayout({ id: 'i1' }, buildTable());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-layout');
    expect(res.guidance).toBe('Ensure it has proper headers and summary.');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.confidence).toBe(0.75);
    expect(res.rationale).toBe('contains real tabular data');

    const callArgs = vi.mocked(geminiService.generateWithSchema).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ maxOutputTokens: 2048, responseSchema: expect.any(Object) });
  });

  it('falls back to a default guidance string keyed off isLayout when the model omits guidance', async () => {
    mockSchemaResult({ isLayout: true, confidence: 0.5, reasoning: 'r' });

    const layoutRes = await svc.analyzeTableLayout({ id: 'i1' }, buildTable());
    expect(layoutRes.guidance).toContain('Role: Artifact');

    mockSchemaResult({ isLayout: false, confidence: 0.5, reasoning: 'r' });
    const dataRes = await svc.analyzeTableLayout({ id: 'i1' }, buildTable());
    expect(dataRes.guidance).toContain('proper headers and summary');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));

    await expect(svc.analyzeTableLayout({ id: 'i1' }, buildTable())).resolves.toBeNull();
  });
});
