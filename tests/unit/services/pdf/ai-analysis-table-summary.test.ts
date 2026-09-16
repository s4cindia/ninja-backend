import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';

/**
 * Unit coverage for analyzeTableSummary (the ordinary, non-pageReassigned
 * table-summary drafter -- see ai-analysis-table-summary-render.test.ts for
 * the render-based pageReassigned counterpart).
 *
 * Built to fix a real bug found live against Math_Kim's 58 real remaining
 * TABLE-MISSING-SUMMARY-eligible tables: the original implementation used a
 * freeform-JSON prompt (geminiService.generateText, no responseSchema,
 * maxOutputTokens: 512) -- the exact same MAX_TOKENS-truncation trap already
 * documented and fixed for analyzeFormulaActualText (see
 * FORMULA_ACTUALTEXT_SCHEMA's doc comment). Live measurement: 8/8 real
 * sampled calls hit finishReason MAX_TOKENS with completionTokens ~18-21 but
 * totalTokens ~600-700 -- the model's markdown-fenced preamble consumed the
 * whole visible-output budget before ever reaching the JSON payload, so
 * analyzeTableSummary silently returned null (no thrown error -- parseAiJson
 * itself never logs) for the overwhelming majority of real calls. Fixed via
 * schema-constrained decoding (geminiService.generateWithSchema) + a bigger
 * token budget, the same pattern already proven for Formula ActualText.
 * Real yield after the fix: 15/15 (100%) live-validated via apply +
 * genuine re-audit round-trip against the real downloaded PDF.
 */

// analyzeTableSummary is private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

function buildTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'table_p10_0',
    pageNumber: 10,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 13,
    columnCount: 2,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [
      { row: 0, column: 0, text: 'Question', isHeader: false, rowSpan: 1, colSpan: 1 },
      { row: 0, column: 1, text: 'Answer', isHeader: false, rowSpan: 1, colSpan: 1 },
    ],
    issues: [],
    isAccessible: false,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSchemaResult = (data: unknown, usage?: any) =>
  vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({ data, usage, attempts: 1 } as never);

describe('analyzeTableSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null without calling Gemini when the table has no cells', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');
    const res = await svc.analyzeTableSummary({ id: 'i1' }, buildTable({ cells: [] }), 'apply-to-pdf');
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('drafts a real summary via schema-constrained decoding with a generous token budget', async () => {
    mockSchemaResult(
      { summary: 'Student error-tracking table for six practice questions.', confidence: 0.85, rationale: 'error log table' },
      { promptTokens: 150, completionTokens: 20, totalTokens: 170 }
    );

    const res = await svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'apply-to-pdf');

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-summary');
    expect(res.value).toBe('Student error-tracking table for six practice questions.');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.confidence).toBe(0.85);
    expect(res.rationale).toBe('error log table');
    expect(res.usage).toEqual({ promptTokens: 150, completionTokens: 20 });

    // Regression guard for the actual fix: must request schema-constrained
    // output with a real budget, not the old fragile freeform-JSON prompt.
    const callArgs = vi.mocked(geminiService.generateWithSchema).mock.calls[0];
    expect(callArgs[2]).toMatchObject({ maxOutputTokens: 2048, responseSchema: expect.any(Object) });
  });

  it('sets guidance text only in guidance-only mode', async () => {
    mockSchemaResult({ summary: 'A table.', confidence: 0.7, rationale: 'r' });

    const applyRes = await svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'apply-to-pdf');
    expect(applyRes.guidance).toBeUndefined();

    mockSchemaResult({ summary: 'A table.', confidence: 0.7, rationale: 'r' });
    const guidanceRes = await svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'guidance-only');
    expect(guidanceRes.guidance).toContain('A table.');
  });

  it('falls back to sane defaults when the model omits confidence and rationale', async () => {
    mockSchemaResult({ summary: 'A table.' });

    const res = await svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'apply-to-pdf');

    expect(res).toBeTruthy();
    expect(typeof res.confidence).toBe('number');
    expect(typeof res.rationale).toBe('string');
    expect(res.rationale).not.toContain('undefined');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));

    await expect(svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'apply-to-pdf')).resolves.toBeNull();
  });

  // CodeRabbit review finding on this PR: both table-summary prompts tell
  // the model to cap its answer at 150 characters, but nothing enforced
  // that -- a response that ignored the instruction could still reach
  // persistence and PDF application via setTableSummary. Exercises the REAL
  // schema (not a mocked generateWithSchema) via the underlying
  // generateText call, so this actually proves TableSummaryResult's own
  // max(150) rejects an oversized response rather than trusting the prompt
  // wording alone.
  it('rejects a summary longer than 150 characters via the real schema, exhausting retries to null', async () => {
    const overLong = 'A'.repeat(151);
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ summary: overLong, confidence: 0.8, rationale: 'r' }),
    } as never);

    await expect(svc.analyzeTableSummary({ id: 'i1' }, buildTable(), 'apply-to-pdf')).resolves.toBeNull();
  });
});
