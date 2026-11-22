import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for HEADER-FOOTER-VARYING-TAGGED-AS-CONTENT's
 * dispatch -- see header-footer-varying-content.ts's own header comment for
 * the real incident (Karsaklian_189165_9781606497623.pdf). Unlike
 * TOC-STRUCTURE-MISSING's 1.0 (an exact, provably-unique per-row MCID
 * match), this routes at confidence 0.75: the underlying signal is a
 * recurrence heuristic (position + distinct-variant-count + page-
 * contiguity), not an exact match, and the fix DELETES a struct element
 * rather than renaming/reparenting one -- see ai-analysis.service.ts's own
 * no-auto-apply exclusion list, which this suggestionType is also added to
 * for the same reason as 'alt-text-decorative'.
 */

// dispatchIssue is private; exercise via cast, same pattern as every other
// *-routing.test.ts in this suite.
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

function varyingIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'header-footer-content-1',
    source: 'pdf-header-footer-content',
    severity: 'minor',
    code: 'HEADER-FOOTER-VARYING-TAGGED-AS-CONTENT',
    message: 'A recurring, per-chapter-varying header text ("become a marketing negotiator") is tagged as real content on 67 pages instead of being marked as a PDF Artifact',
    category: 'structure',
    location: 'Document-wide (header region, varies per chapter/section, recurs on 67 pages)',
    element: 'become a marketing negotiator',
    context: 'Region: header; Pages: 22, 24, 26',
    matterhornCheckpoint: '01-001',
    matterhornHow: 'H',
    ...overrides,
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: HEADER-FOOTER-VARYING-TAGGED-AS-CONTENT routing', () => {
  it('routes to header-footer-varying-artifact-fix, a rule-based apply-to-pdf fix requiring manual review at confidence 0.75', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(varyingIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('header-footer-varying-artifact-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    // 0.75, not TOC-STRUCTURE-MISSING's 1.0 -- a recurrence heuristic, not
    // an exact, provably-unique match, and the fix deletes a struct
    // element rather than renaming/reparenting one.
    expect(res.confidence).toBe(0.75);
    expect(res.requiresManualReview).toBe(true);
  });

  it('returns null when the issue has no context', async () => {
    const parsed = buildParsed();
    const issue = varyingIssue();
    delete (issue as { context?: unknown }).context;

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });

  it('returns null when the issue has no element', async () => {
    const parsed = buildParsed();
    const issue = varyingIssue();
    delete (issue as { element?: unknown }).element;

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });
});
