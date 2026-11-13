import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for STRUCTURE-ELEMENT-WRONG-PARENT's dispatch
 * routing -- see structure-parent-mismatch.ts's own header comment for the
 * real incident. Deterministic, rule-based apply-to-pdf fix: exactly one
 * correct /P value, no AI judgment needed.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-placedpdf-routing.test.ts.
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

function parentMismatchIssue(): AuditIssue {
  return {
    id: 'structure-parent-mismatch-1',
    source: 'pdf-structure-parent-mismatch',
    severity: 'serious',
    code: 'STRUCTURE-ELEMENT-WRONG-PARENT',
    message: 'test',
    category: 'structure',
    pageNumber: 55,
    element: 'parent-mismatch_r531',
  } as AuditIssue;
}

describe('dispatchIssue: STRUCTURE-ELEMENT-WRONG-PARENT routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix, no AI call involved', async () => {
    const parsed = { isTagged: true, pages: [{}] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(parentMismatchIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('structure-parent-mismatch-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });
});
