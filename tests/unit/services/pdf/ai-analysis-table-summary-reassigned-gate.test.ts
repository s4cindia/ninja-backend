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
 * table. dispatchIssue's TABLE_SUMMARY_CODES branch now forces
 * guidance-only for any pageReassigned table, regardless of tableFixMode.
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

describe('dispatchIssue: table-summary downgrades to guidance-only for a page-reassigned table', () => {
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

  it('forces guidance-only for a pageReassigned table even under an apply-to-pdf config', async () => {
    const table = buildTable({ pageReassigned: true });
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableSummary').mockResolvedValue({
      suggestionType: 'table-summary',
      value: 'A summary',
      guidance: 'Add table summary: "A summary"',
      confidence: 0.8,
      rationale: 'ok',
      model: 'gemini-flash',
      applyMode: 'guidance-only',
    });

    await svc.dispatchIssue(ISSUE, parsed, AUTO_APPLY_CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, table, 'guidance-only');
  });
});
