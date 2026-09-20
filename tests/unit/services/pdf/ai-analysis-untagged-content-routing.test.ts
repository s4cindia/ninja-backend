import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for UNTAGGED-CONTENT's dispatch split: a page whose
 * untagged painted-path runs are ALL straight lines/rectangles gets a
 * deterministic rule-based apply-to-pdf fix (pdf-artifact-tagger.ts's own
 * detection alone proves that shape is decorative on every real instance
 * found so far). A page with any curve-based run (UNTAGGED-CONTENT-COMPLEX,
 * emitted by pdf-structure.validator.ts when findUntaggedPathRuns reports
 * hasCurves) routes to manual review instead -- CodeRabbit finding,
 * confirmed real: detecting a path is untagged never proves it's decorative,
 * and a curve is this codebase's best available signal that a shape might
 * be genuine illustrative content (chart/map/diagram/logo) rather than a
 * crop mark or table-shading rectangle.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-artifact-routing.test.ts / ai-analysis-table-not-tagged-routing.test.ts.
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

function untaggedContentIssue(code: string): AuditIssue {
  return {
    id: 'pdf-structure-1',
    source: 'pdf-structure',
    severity: 'moderate',
    code,
    message: '2 vector-graphics region(s) on this page are neither tagged as real content nor marked as an artifact',
    pageNumber: 1,
    location: 'Page 1',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

describe('dispatchIssue: UNTAGGED-CONTENT vs UNTAGGED-CONTENT-COMPLEX', () => {
  it('returns a deterministic rule-based apply-to-pdf fix for the straight-line-only code', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(untaggedContentIssue('UNTAGGED-CONTENT'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('untagged-content-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('routes the curve-containing code to guidance-only manual review, never apply-to-pdf', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(untaggedContentIssue('UNTAGGED-CONTENT-COMPLEX'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('untagged-content-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBeLessThan(0.75); // below CONFIG.confidenceThreshold -- never auto-applies even if something upstream mis-routes it
  });
});
