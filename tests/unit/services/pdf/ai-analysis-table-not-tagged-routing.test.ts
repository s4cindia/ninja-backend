import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-15-001 routing. Originally (PR #546)
 * this always routed to a deterministic guidance-only suggestion -- no
 * mechanical fix existed, since there was no existing table skeleton to
 * promote TD->TH within. PR #552 (Slice 2d of the MATTERHORN-15-001
 * from-scratch retagger) shipped pdfStructureWriterService.
 * buildTableFromLayout, which builds a real Table/TR/TH/TD/Span skeleton
 * around the actual grid content (live-validated at 94.8% real success,
 * Slice 2e) -- so this now routes to a deterministic apply-to-pdf
 * suggestion instead, never falling through dispatchIssue's default
 * `return null` (which would leave real issues as unexplained, unfixable
 * criticals).
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-matterhorn-15-003-routing.test.ts.
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
    rowCount: 4,
    columnCount: 3,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [],
    issues: [],
    isAccessible: false,
    structureMatched: true,
    structureRowCount: 1,
    structureCellCount: 1,
    isGenuinelyTabularDespiteTrivialMatch: true,
    ...overrides,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'critical',
  code: 'MATTERHORN-15-001',
  message: 'Table-like content on page 1 (4×3) is not tagged as a table',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: MATTERHORN-15-001 routes to a deterministic apply-to-pdf suggestion', () => {
  it('returns a deterministic rule-based table-from-layout-fix suggestion, with no AI call', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('table-from-layout-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.guidance).toContain('4×3');
    expect(res.guidance).toContain('decorative');
  });

  /**
   * Regression for a real CodeRabbit finding on PR #554: analyzeTableNotTagged
   * unconditionally returned applyMode: 'apply-to-pdf', ignoring
   * config.tableFixMode entirely -- a tenant/request configured for
   * guidance-only table fixes would still get this new structural-retagging
   * suggestion auto-applied. Mirrors the same wouldAutoApply check
   * analyzeTableSummary's own call site already uses.
   */
  it('falls back to guidance-only when tableFixMode is guidance-only, still routing to table-from-layout-fix', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const guidanceOnlyConfig: AiRemediationConfig = { ...CONFIG, tableFixMode: 'guidance-only' };

    const res = await svc.dispatchIssue(ISSUE, parsed, guidanceOnlyConfig, new Map(), tableById, new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('table-from-layout-fix');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('treats summaries-to-pdf-headers-as-guidance the same as apply-to-pdf, matching the established tableFixMode convention', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const summariesConfig: AiRemediationConfig = { ...CONFIG, tableFixMode: 'summaries-to-pdf-headers-as-guidance' };

    const res = await svc.dispatchIssue(ISSUE, parsed, summariesConfig, new Map(), tableById, new Map());

    expect(res).not.toBeNull();
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('returns null when the referenced table cannot be found', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });
});
