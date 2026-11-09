import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for TAB-ORDER-NOT-STRUCTURE's dispatch: always
 * routes to a deterministic, rule-based, apply-to-pdf fix -- setting a
 * page's /Tabs entry to /S is a single-key write with no ambiguity, no AI
 * judgment call needed. Same tier as heading-multiple-h1-fix.
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

function tabOrderIssue(): AuditIssue {
  return {
    id: 'tab-order-1',
    source: 'pdf-tab-order',
    severity: 'moderate',
    code: 'TAB-ORDER-NOT-STRUCTURE',
    message: 'Page 4 has 2 annotation(s) but its own /Tabs entry is missing, not /S (structure)',
    pageNumber: 4,
    location: 'Page 4',
    matterhornCheckpoint: '28-008',
    matterhornHow: 'M',
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: TAB-ORDER-NOT-STRUCTURE routing', () => {
  it('returns a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = buildParsed();

    const res = await svc.dispatchIssue(tabOrderIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('tab-order-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });
});
