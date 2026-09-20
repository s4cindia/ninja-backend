import { describe, it, expect, afterEach, vi } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for a real CodeRabbit finding on PR #582: the
 * table-header-scope-fix dispatch branch unconditionally returned
 * applyMode: 'apply-to-pdf', ignoring a tenant/trial configured for
 * guidance-only table fixes -- unlike the sibling table-header-fix/
 * table-header-fix-column branches, which already respect tableFixMode via
 * headerApplyMode (see ai-analysis-table-header-gate.test.ts's own
 * "downgrades both header suggestion types to guidance-only" case, fixed
 * for the same reason on PR #560).
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-header-gate.test.ts.
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

const ISSUE: AuditIssue = {
  id: 'pdf-table-header-scope-1',
  source: 'pdf-table-header-scope',
  severity: 'serious',
  code: 'TABLE-HEADER-MISSING-SCOPE',
  message: 'Table table_p1_0 on page 1 has 2 header cell(s) with no /Scope attribute',
  pageNumber: 1,
  element: 'table_p1_0',
  matterhornCheckpoint: '15-003',
  matterhornHow: 'M',
};

describe('dispatchIssue: table-header-scope-fix respects tableFixMode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies to the PDF when tableFixMode is apply-to-pdf', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-scope-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('applies to the PDF when tableFixMode is summaries-to-pdf-headers-as-guidance (matches the sibling header-fix branches\' own convention)', async () => {
    const config: AiRemediationConfig = { ...CONFIG, tableFixMode: 'summaries-to-pdf-headers-as-guidance' };
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, config, new Map(), new Map(), new Map());

    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('downgrades to guidance-only when tableFixMode is guidance-only', async () => {
    const config: AiRemediationConfig = { ...CONFIG, tableFixMode: 'guidance-only' };
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(ISSUE, parsed, config, new Map(), new Map(), new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('table-header-scope-fix');
    expect(res.applyMode).toBe('guidance-only');
  });
});
