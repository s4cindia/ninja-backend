import { describe, it, expect } from 'vitest';
import { aiAnalysisService, buildSuggestionCacheKey, buildIssueFingerprint } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for CITATION-MISSING-LINK's dispatch: routes to the
 * deterministic apply-to-pdf fix whenever citationData is present
 * (fixCitationLink's own resolveCitationDestination is the REAL gate, at
 * apply time -- this dispatch is optimistic, same shape as
 * LINK_MISSING_ANNOTATION_CODES/CROSS_REFERENCE_MISSING_LINK_CODES), but
 * never generates a suggestion with no citationData at all.
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

function citationIssue(citationData?: AuditIssue['citationData']): AuditIssue {
  return {
    id: 'citation-link-1',
    source: 'link-completeness-validator',
    severity: 'moderate',
    code: 'CITATION-MISSING-LINK',
    message: 'test citation',
    pageNumber: 1,
    location: 'Page 1',
    citationData,
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: CITATION-MISSING-LINK routing', () => {
  it('routes to the deterministic rule-based apply-to-pdf fix when citationData is present', async () => {
    const parsed = buildParsed();
    const issue = citationIssue({ authorText: 'Karsaklian', year: '2017', fullText: '(Karsaklian 2017)' });

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('citation-link-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('does not generate any suggestion when the issue has no citationData', async () => {
    const parsed = buildParsed();
    const issue = citationIssue(undefined);

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });
});

describe('buildSuggestionCacheKey/buildIssueFingerprint: CITATION-MISSING-LINK', () => {
  it('keys the suggestion cache per-issue (not per-page), same collision shape as CROSS-REFERENCE-MISSING-LINK', () => {
    const a: AuditIssue = citationIssue({ authorText: 'Johne', year: '1999', fullText: '(Johne 1999)' });
    a.id = 'citation-a';
    const b: AuditIssue = citationIssue({ authorText: 'Simonite', year: '2014', fullText: '(Simonite 2014)' });
    b.id = 'citation-b';
    b.pageNumber = a.pageNumber;

    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });

  it('fingerprints two distinct citations on the same page by their own boundingBox, not the shared page number', () => {
    const a: AuditIssue = citationIssue({ authorText: 'Johne', year: '1999', fullText: '(Johne 1999)' });
    a.boundingBox = { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 };
    const b: AuditIssue = citationIssue({ authorText: 'Simonite', year: '2014', fullText: '(Simonite 2014)' });
    b.boundingBox = { x: 100, y: 200, width: 150, height: 10, pageWidth: 612, pageHeight: 792 };

    expect(buildIssueFingerprint(a)).not.toBe(buildIssueFingerprint(b));
  });
});
