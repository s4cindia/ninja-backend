import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for a CodeRabbit finding on the PR that added
 * consumeNextTable's page-reassignment fix (structure-analyzer.service.ts):
 * once a globally-fallback-matched table's page/id become findable, ANY
 * dispatch path keyed by that same id -- not just table-header-fix, which
 * this specific fix was scoped for -- can now reach it, including
 * table-summary, which (unlike table-header-fix's mechanical TD->TH
 * promotion) drafts AI text FROM table.cells and can auto-apply it. A
 * pageReassigned table's cells still describe the page it was ORIGINALLY
 * (wrongly) detected on, not the struct element's real page it's now
 * correctly locatable at -- so auto-applying that drafted text risked a
 * plausible-sounding but page-mismatched summary landing silently on a real
 * table.
 *
 * dispatchIssue's TABLE_SUMMARY_CODES branch originally just forced
 * guidance-only for any pageReassigned table. A follow-up replaced that
 * with analyzeTableSummaryFromRender: rather than draft from known-stale
 * cell text, it renders the table's REAL page (table.pageNumber, which
 * findTargetTable/#532 can locate correctly even though the cells can't be
 * trusted) and asks a vision model to describe the table directly --
 * always still guidance-only, since a rendered page can hold more than one
 * table and nothing confirms the model described the specific one
 * issue.element points at.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-header-gate.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const AUTO_APPLY_CONFIG: AiRemediationConfig = {
  tableFixMode: 'apply-to-pdf',
  altTextMode: 'apply-to-pdf',
  listMode: 'auto-resolve-decorative',
  languageMode: 'apply-to-pdf',
  colorContrastMode: 'guidance-only',
  linkTextMode: 'guidance-only',
  formFieldMode: 'guidance-only',
  bookmarkMode: 'guidance-only',
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

function buildTable(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 3,
    columnCount: 2,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [{ row: 0, column: 0, text: 'a', isHeader: false, rowSpan: 1, colSpan: 1 }],
    issues: ['Complex table lacks summary or caption.'],
    isAccessible: false,
    ...overrides,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-summary-1',
  source: 'pdf-table',
  severity: 'serious',
  code: 'TABLE-MISSING-SUMMARY',
  message: 'Complex table on page 1 lacks summary or caption',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: table-summary drafting for a page-reassigned table', () => {
  afterEach(() => vi.restoreAllMocks());

  it('auto-applies normally for an ordinary (non-reassigned) table under an apply-to-pdf config', async () => {
    const tableById = new Map([['table_p1_0', buildTable()]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableSummary').mockResolvedValue({
      suggestionType: 'table-summary',
      value: 'A summary',
      confidence: 0.8,
      rationale: 'ok',
      model: 'gemini-flash',
      applyMode: 'apply-to-pdf',
    });

    await svc.dispatchIssue(ISSUE, parsed, AUTO_APPLY_CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, tableById.get('table_p1_0'), 'apply-to-pdf');
  });

  it('routes a pageReassigned table through the render-based drafter, not the cell-text one', async () => {
    const table = buildTable({ pageReassigned: true });
    const tableById = new Map([['table_p1_0', table]]);
    const fakeParsedPdf = { pdfjsDoc: {} };
    const parsed = { isTagged: true, pages: [], parsedPdf: fakeParsedPdf } as unknown as PdfParseResult;
    const cellTextSpy = vi.spyOn(svc, 'analyzeTableSummary');
    const renderSpy = vi.spyOn(svc, 'analyzeTableSummaryFromRender').mockResolvedValue({
      suggestionType: 'table-summary',
      value: 'A summary',
      guidance: 'Add table summary: "A summary"',
      confidence: 0.8,
      rationale: 'ok',
      model: 'gemini-flash',
      applyMode: 'guidance-only',
    });
    const pageRenderCache = new Map();

    await svc.dispatchIssue(ISSUE, parsed, AUTO_APPLY_CONFIG, new Map(), tableById, pageRenderCache);

    expect(renderSpy).toHaveBeenCalledWith(table, fakeParsedPdf, pageRenderCache);
    expect(cellTextSpy).not.toHaveBeenCalled();
  });

  it('returns null for a pageReassigned table when no parsedPdf is available to render', async () => {
    const table = buildTable({ pageReassigned: true });
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult; // no parsedPdf
    const renderSpy = vi.spyOn(svc, 'analyzeTableSummaryFromRender');

    const result = await svc.dispatchIssue(ISSUE, parsed, AUTO_APPLY_CONFIG, new Map(), tableById, new Map());

    expect(result).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
  });
});
