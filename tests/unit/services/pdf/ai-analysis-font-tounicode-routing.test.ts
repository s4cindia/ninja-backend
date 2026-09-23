import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-10-001's dispatch: pdfa11y's own
 * UA-10-002 ("/ToUnicode CMap exists but doesn't cover every rendered
 * code") is a genuinely different defect shape from FONT-TOUNICODE-MISSING
 * (no CMap at all) -- confirmed real on Math_Weir_PDF.pdf (font
 * 'BOXDSW+MathematicalPiLTStd-4'). Routes to fontToUnicodeService's own
 * append-only extendPartialToUnicode, never the wholesale-replace
 * synthesizeToUnicode FONT-TOUNICODE-MISSING uses.
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

const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

function issue(code: string): AuditIssue {
  return {
    id: 'x-1',
    source: 'pdfa11y',
    severity: 'serious',
    code,
    message: 'irrelevant for this test',
  };
}

describe('dispatchIssue: font ToUnicode routing', () => {
  it('routes MATTERHORN-10-001 (partial CMap) to font-tounicode-extend-fix, apply-to-pdf', async () => {
    const res = await svc.dispatchIssue(issue('MATTERHORN-10-001'), parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res.suggestionType).toBe('font-tounicode-extend-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
  });

  it('still routes FONT-TOUNICODE-MISSING (no CMap at all) to the separate synthesis-fix, not extend-fix', async () => {
    const res = await svc.dispatchIssue(issue('FONT-TOUNICODE-MISSING'), parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res.suggestionType).toBe('font-tounicode-synthesis-fix');
  });
});
