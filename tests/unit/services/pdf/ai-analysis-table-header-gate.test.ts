import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TableInfo } from '../../../../src/services/pdf/structure-analyzer.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-formula.test.ts / ai-analysis-contrast.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const CONFIG: AiRemediationConfig = {
  tableFixMode: 'summaries-to-pdf-headers-as-guidance',
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

function buildTable(columnCount: number): TableInfo {
  return {
    id: 'table_p1_0',
    pageNumber: 1,
    position: { x: 0, y: 0, width: 100, height: 100 },
    rowCount: 3,
    columnCount,
    hasHeaderRow: false,
    hasHeaderColumn: false,
    hasSummary: false,
    cells: [],
    issues: ['Table has no header cells (TH). Add row or column headers.'],
    isAccessible: false,
  };
}

const ISSUE: AuditIssue = {
  id: 'pdf-table-1',
  source: 'pdf-table',
  severity: 'serious',
  code: 'MATTERHORN-15-002',
  message: 'Data table on page 1 has no headers',
  pageNumber: 1,
  element: 'table_p1_0',
  boundingBox: { x: 0, y: 0, width: 100, height: 100, pageWidth: 400, pageHeight: 600 },
};

describe('dispatchIssue: table-header-fix rule-based column-count gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the rule-based fix for a tagged table right at the SIMPLE_TABLE_MAX_COLUMNS boundary (6 columns)', async () => {
    const tableById = new Map([['table_p1_0', buildTable(6)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-fix');
    expect(res.model).toBe('rule-based');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('falls through to AI review for a tagged table just past the boundary (7 columns)', async () => {
    const tableById = new Map([['table_p1_0', buildTable(7)]]);
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue({
      suggestionType: 'table-header-fix',
      guidance: 'AI-drafted',
      confidence: 0.6,
      rationale: 'complex table, needs review',
      model: 'gemini',
      applyMode: 'guidance-only',
    });

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalledWith(ISSUE, tableById.get('table_p1_0'));
    expect(res.model).toBe('gemini');
  });

  it('still gates untagged PDFs to AI review regardless of column count', async () => {
    const tableById = new Map([['table_p1_0', buildTable(2)]]);
    const parsed = { isTagged: false, pages: [] } as unknown as PdfParseResult;
    const analyzeSpy = vi.spyOn(svc, 'analyzeTableHeaders').mockResolvedValue(null);

    await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), tableById, new Map());

    expect(analyzeSpy).toHaveBeenCalled();
  });
});
