import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-15-001 routing, added alongside
 * pdf-table.validator.ts's buildTrivialMatchNotTaggedIssue: genuinely
 * tabular LAYOUT-detected content whose matched /Table struct element is
 * trivial (a decorative box, not a real column grid) has no mechanical fix
 * available -- there's no existing table skeleton to promote TD->TH
 * within, unlike TABLE_HEADER_AUTO_FIX_CODES' eligible case -- so this must
 * always route to a deterministic guidance-only suggestion, never fall
 * through dispatchIssue's default `return null` (which would leave 159
 * real Math_Kim issues as unexplained, unfixable criticals).
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

describe('dispatchIssue: MATTERHORN-15-001 routes to a deterministic guidance-only suggestion', () => {
  it('returns a guidance-only table-not-tagged suggestion, with no AI call', async () => {
    const table = buildTable();
    const tableById = new Map([['table_p1_0', table]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('table-not-tagged');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
    expect(res.guidance).toContain('4×3');
    expect(res.guidance).toContain('decorative');
  });

  it('returns null when the referenced table cannot be found', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });
});
