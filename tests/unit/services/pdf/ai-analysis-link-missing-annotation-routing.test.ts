import { describe, it, expect } from 'vitest';
import { aiAnalysisService, buildSuggestionCacheKey } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for LINK-MISSING-ANNOTATION's dispatch routing --
 * Slice 4 of the fixer (Matterhorn 28-011). Deterministic, rule-based
 * apply-to-pdf fix: no AI judgment needed, the validator already extracted
 * and validated the URL -- fixLinkMissingAnnotation itself is the real
 * gate (see pdf-structure-writer-link-missing-annotation.test.ts), not any
 * decision made here.
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

function linkMissingIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'link-completeness-1',
    source: 'link-completeness-validator',
    severity: 'serious',
    code: 'LINK-MISSING-ANNOTATION',
    message: 'Text reads as a hyperlink ("https://example.com/citation") but has no underlying Link annotation',
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber: 85,
    linkCompletenessData: { url: 'https://example.com/citation' },
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
    ...overrides,
  } as AuditIssue;
}

describe('dispatchIssue: LINK-MISSING-ANNOTATION routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix, no AI call involved', async () => {
    const parsed = { isTagged: true, pages: [{}] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(linkMissingIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('link-missing-annotation-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('declines (returns null) when the issue has no linkCompletenessData.url', async () => {
    const parsed = { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
    const issue = linkMissingIssue();
    delete issue.linkCompletenessData;

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });
});

describe('buildSuggestionCacheKey: LINK-MISSING-ANNOTATION', () => {
  // Real data (Curiel_187961_CSHP.pdf): page 85 has 3 independent
  // LINK-MISSING-ANNOTATION issues, page 102 has 6 -- confirms the
  // per-issue cache key added alongside this dispatch, not the default
  // per-page one every other PLACEDPDF/ARTIFACT-style deterministic code
  // uses (those genuinely don't need it: at most one of each per page).
  it('gives two distinct issues on the same page distinct keys', () => {
    const a = linkMissingIssue({ id: 'a' });
    const b = linkMissingIssue({ id: 'b' });
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });
});
