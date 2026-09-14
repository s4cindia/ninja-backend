import { describe, it, expect, vi } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-15-005's dispatch split: a trivial
 * (<=1 row, <=1 cell) real struct match is decisive ground truth (confirmed
 * decorative -- any genuinely-tabular case would already have been routed to
 * TABLE_NOT_TAGGED_CODES/MATTERHORN-15-001 instead), so it gets a
 * deterministic rule-based apply-to-pdf suggestion instead of the AI/
 * guidance-only analyzeTableLayout path. A MATTERHORN-15-005 reached purely
 * via detectLayoutTable's fuzzier column/row/size heuristics (no trivial
 * struct match) still goes through the AI path, since there's no ground-truth
 * confirmation for those.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-not-tagged-routing.test.ts / ai-analysis-matterhorn-15-003-routing.test.ts.
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
    rowCount: 3,
    columnCount: 2,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [],
    issues: [],
    isAccessible: false,
    structureMatched: true,
    structureRowCount: 1,
    structureCellCount: 1,
    ...overrides,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'moderate',
  code: 'MATTERHORN-15-005',
  message: 'Layout table on page 1 should be marked as artifact (3x2)',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: MATTERHORN-15-005 routes to a deterministic fix only for a confirmed trivial struct match', () => {
  it('returns a deterministic rule-based table-artifact-fix suggestion for a trivial struct match', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('table-artifact-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
  });

  it('falls back to the AI/guidance-only path when there is no trivial struct match (fuzzy heuristic only)', async () => {
    const table = buildTable({
      structureMatched: false,
      structureRowCount: undefined,
      structureCellCount: undefined,
      columnCount: 1, // detectLayoutTable's own "single column" heuristic, not a struct-tree confirmation
    });
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableLayout').mockResolvedValue({
      suggestionType: 'table-layout',
      guidance: 'Mark this table as a presentation artifact.',
      confidence: 0.7,
      rationale: 'heuristic',
      model: 'gemini-flash',
      applyMode: 'guidance-only',
    });

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, table);
    expect(res.suggestionType).toBe('table-layout');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('returns null when the referenced table cannot be found', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });
});
