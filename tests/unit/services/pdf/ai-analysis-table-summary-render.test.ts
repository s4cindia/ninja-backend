import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';

/**
 * Unit coverage for analyzeTableSummaryFromRender, the render-based
 * table-summary drafter for pageReassigned tables (see
 * ai-analysis-table-summary-reassigned-gate.test.ts for the dispatch-level
 * routing coverage). Isolates renderPageToBase64/analyzeImage interaction:
 * caching by page number, guidance/rationale content, and failure handling.
 */

// analyzeTableSummaryFromRender / renderPageToBase64 are private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

function buildTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'table_p7_0',
    pageNumber: 7,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 40,
    columnCount: 2,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [],
    issues: ['Complex table should have a summary describing its structure.'],
    isAccessible: false,
    pageReassigned: true,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gemini = (text: string, usage?: any) =>
  vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({ text, usage } as never);

describe('analyzeTableSummaryFromRender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts a guidance-only summary from a full-page render of the table\'s real page', async () => {
    const table = buildTable();
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"Editorial style glossary with terms and definitions.","confidence":0.82,"rationale":"long 2-column glossary table"}', {
      promptTokens: 40,
      completionTokens: 12,
    });

    const res = await svc.analyzeTableSummaryFromRender(table, {}, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-summary');
    expect(res.value).toBe('Editorial style glossary with terms and definitions.');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.guidance).toContain('Editorial style glossary');
    expect(res.rationale).toContain('long 2-column glossary table');
    expect(res.rationale).toContain('full-page render'); // flags the drafting method to the reviewer
    expect(res.usage).toEqual({ promptTokens: 40, completionTokens: 12 });
  });

  // Regression for the follow-up fix that unlocks auto-apply for the common
  // case: a pageReassigned table whose real page has exactly one /Table
  // element carries no ambiguity about which table the model described, so
  // there's no reason to force guidance-only the way a genuinely
  // multi-table page still must.
  it('auto-applies when the real page has exactly one table and the config allows it', async () => {
    const table = buildTable({ tablesOnRealPage: 1 });
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"A table.","confidence":0.8,"rationale":"r"}');

    const res = await svc.analyzeTableSummaryFromRender(table, {}, new Map(), 'apply-to-pdf');

    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('stays guidance-only when the real page has more than one table, even under an apply-to-pdf config', async () => {
    const table = buildTable({ tablesOnRealPage: 2 });
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"A table.","confidence":0.8,"rationale":"r"}');

    const res = await svc.analyzeTableSummaryFromRender(table, {}, new Map(), 'apply-to-pdf');

    expect(res.applyMode).toBe('guidance-only');
  });

  it('stays guidance-only for a single-table page when the config would not otherwise auto-apply', async () => {
    const table = buildTable({ tablesOnRealPage: 1 });
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"A table.","confidence":0.8,"rationale":"r"}');

    const res = await svc.analyzeTableSummaryFromRender(table, {}, new Map(), 'guidance-only');

    expect(res.applyMode).toBe('guidance-only');
  });

  it('reuses a cached render for the same page instead of rendering twice', async () => {
    const table = buildTable({ pageNumber: 12 });
    const renderSpy = vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"A table.","confidence":0.5,"rationale":"r"}');
    const cache = new Map();

    await svc.analyzeTableSummaryFromRender(table, {}, cache);
    await svc.analyzeTableSummaryFromRender(table, {}, cache);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(cache.has(12)).toBe(true);
  });

  it('returns null when the page cannot be rendered, without calling the vision model', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(null);
    const visionSpy = vi.spyOn(geminiService, 'analyzeImage');

    const res = await svc.analyzeTableSummaryFromRender(buildTable(), {}, new Map());

    expect(res).toBeNull();
    expect(visionSpy).not.toHaveBeenCalled();
  });

  it('returns null when the model yields no summary', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"confidence":0.5,"rationale":"no summary field"}');

    expect(await svc.analyzeTableSummaryFromRender(buildTable(), {}, new Map())).toBeNull();
  });

  // CodeRabbit review finding on this PR's first version: naively
  // string-interpolating a missing rationale surfaced the literal text
  // "undefined" to the reviewer, and confidence (a required, non-optional
  // AiSuggestionResult field) was passed through as `undefined` outright
  // when the model's JSON omitted it -- both real, since the model can
  // return a usable summary without necessarily including either field.
  it('falls back to sane defaults when the model omits confidence and rationale', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    gemini('{"summary":"A table."}'); // no confidence, no rationale

    const res = await svc.analyzeTableSummaryFromRender(buildTable(), {}, new Map());

    expect(res).toBeTruthy();
    expect(typeof res.confidence).toBe('number');
    expect(res.rationale).not.toContain('undefined');
    expect(res.rationale).toContain('full-page render');
  });

  it('returns null (not a rejected promise) when the vision call throws', async () => {
    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue('ZmFrZQ==');
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('429 rate limit'));

    await expect(svc.analyzeTableSummaryFromRender(buildTable(), {}, new Map())).resolves.toBeNull();
  });
});
