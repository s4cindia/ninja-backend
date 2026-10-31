import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for PLACEDPDF-NOT-TAGGED's dispatch routing --
 * always a deterministic, rule-based apply-to-pdf fix. No AI judgment is
 * needed: the tag's own properties reference never carries a real /MCID
 * (see pdf-artifact-tagger.ts's findPlacedPdfSpans), so retagging is a
 * structural fact, not a content judgment call.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-untagged-content-routing.test.ts.
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

function placedPdfIssue(pageNumber: number | undefined = 1): AuditIssue {
  return {
    id: 'pdf-structure-1',
    source: 'pdf-structure',
    severity: 'serious',
    code: 'PLACEDPDF-NOT-TAGGED',
    message: '/PlacedPDF region(s) carry no real MCID and are unreachable from the structure tree',
    pageNumber,
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

describe('dispatchIssue: PLACEDPDF-NOT-TAGGED routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix, no AI call involved', async () => {
    const parsed = { isTagged: true, pages: [{}] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(placedPdfIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('placedpdf-retag-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('still returns the deterministic fix even without a pageNumber (the writer itself declines that case)', async () => {
    const parsed = { isTagged: true, pages: [{}] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(placedPdfIssue(undefined), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('placedpdf-retag-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
  });
});
