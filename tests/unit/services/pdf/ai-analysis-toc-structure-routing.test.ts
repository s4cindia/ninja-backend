import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for TOC-STRUCTURE-MISSING's dispatch. Unlike
 * ROLEMAP-INDEX-FLATTENED (0.9 -- see ai-analysis-index-structure-
 * routing.test.ts), this routes to pdfStructureWriterService.
 * fixTocStructure at confidence 1.0: ISO 32000-1 Table 333 defines a
 * normative /TOC > /TOCI shape (no unspecified-internal-shape residual the
 * way /Index's own invented-but-reasonable v1 shape has), and every
 * applied instance passed fixTocStructure's own per-row exact-MCID-match
 * gate -- see that method's own doc comment for the full defect and
 * algorithm this closes.
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

function tocStructureIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'toc-structure-1',
    source: 'pdf-toc-validator',
    severity: 'moderate',
    code: 'TOC-STRUCTURE-MISSING',
    message: 'Page 7: this Table of Contents is not tagged with the standard /TOC and /TOCI structure types',
    category: 'structure',
    location: 'Page 7',
    matterhornCheckpoint: '09-006',
    matterhornHow: 'M',
    pageNumber: 7,
    ...overrides,
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: TOC-STRUCTURE-MISSING routing', () => {
  it('routes to the dedicated toc-structure-fix, a deterministic rule-based apply-to-pdf fix at confidence 1.0', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(tocStructureIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('toc-structure-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    // 1.0, not ROLEMAP-INDEX-FLATTENED's 0.9 -- Table 333 defines a
    // normative shape, and the per-row MCID-match gate leaves no
    // interpretive residual the way Index's own invented shape does.
    expect(res.confidence).toBe(1.0);
  });

  it('returns null when the issue has no pageNumber', async () => {
    const parsed = buildParsed();
    const issue = tocStructureIssue();
    delete (issue as { pageNumber?: unknown }).pageNumber;

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });
});
