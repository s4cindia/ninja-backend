import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for a real routing bug found while investigating why
 * MATTERHORN-15-003 ("irregular table structure" per its own message text)
 * never converged across many trial rounds: pdf-table.validator.ts actually
 * emits it via `table.issues.some(i => i.includes('irregular') ||
 * i.includes('structure'))`, but structure-analyzer.service.ts's
 * validateTableAccessibility (the only place TableInfo.issues is ever
 * populated) never pushes any string containing "irregular" -- the only
 * string containing "structure" is 'Complex table should have a summary
 * describing its structure.', pushed under the exact same
 * `rowCount > 5 && !hasSummary` condition TABLE-MISSING-SUMMARY itself
 * checks. There is no structural-irregularity detector anywhere in this
 * codebase; MATTERHORN-15-003 was a pure duplicate of TABLE-MISSING-SUMMARY
 * misrouted to nowhere (dispatchIssue's default `return null`, since no
 * code set previously included it) by an accident of message phrasing.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-header-gate.test.ts / ai-analysis-table-summary-reassigned-gate.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const CONFIG: AiRemediationConfig = {
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
    rowCount: 8,
    columnCount: 3,
    hasHeaderRow: true,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [{ row: 0, column: 0, text: 'a', isHeader: true, rowSpan: 1, colSpan: 1 }],
    issues: ['Complex table should have a summary describing its structure.'],
    isAccessible: false,
    ...overrides,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'serious',
  code: 'MATTERHORN-15-003',
  message: 'Table on page 1 has irregular structure',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: MATTERHORN-15-003 routes through the table-summary writer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts and can auto-apply a summary for a MATTERHORN-15-003 issue, same as TABLE-MISSING-SUMMARY', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableSummary').mockResolvedValue({
      suggestionType: 'table-summary',
      value: 'A summary',
      confidence: 0.8,
      rationale: 'ok',
      model: 'gemini-flash',
      applyMode: 'apply-to-pdf',
    });

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, table, 'apply-to-pdf');
    expect(res.suggestionType).toBe('table-summary');
  });

  it('still routes a pageReassigned table through the render-based drafter, same as TABLE-MISSING-SUMMARY', async () => {
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

    await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, pageRenderCache);

    expect(renderSpy).toHaveBeenCalledWith(table, fakeParsedPdf, pageRenderCache);
    expect(cellTextSpy).not.toHaveBeenCalled();
  });
});
