import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for CROSS-REFERENCE-MISSING-LINK's dispatch: routes
 * to the deterministic apply-to-pdf fix for chapter/section/page/pg/p
 * keywords (fixCrossReferenceLink's own resolveCrossReferenceDestination is
 * the REAL gate, at apply time -- this dispatch is optimistic, same shape
 * as LINK_MISSING_ANNOTATION_CODES), but never even generates a suggestion
 * for figure/fig/table (no resolution path exists for those at all).
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

function crossRefIssue(keyword: string, number: string, fullText: string): AuditIssue {
  return {
    id: 'cross-ref-1',
    source: 'link-completeness-validator',
    severity: 'moderate',
    code: 'CROSS-REFERENCE-MISSING-LINK',
    message: `test ${fullText}`,
    pageNumber: 1,
    location: 'Page 1',
    crossReferenceData: { keyword, number, fullText },
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: CROSS-REFERENCE-MISSING-LINK routing', () => {
  it.each(['chapter', 'section', 'page', 'pg', 'p'])(
    'routes "%s" keyword to the deterministic rule-based apply-to-pdf fix',
    async (keyword) => {
      const parsed = buildParsed();

      const res = await svc.dispatchIssue(crossRefIssue(keyword, '3', `see ${keyword} 3`), parsed, CONFIG, new Map(), new Map(), new Map());

      expect(res).not.toBeNull();
      expect(res.suggestionType).toBe('cross-reference-link-fix');
      expect(res.applyMode).toBe('apply-to-pdf');
      expect(res.model).toBe('rule-based');
      expect(res.confidence).toBe(1.0);
    }
  );

  it.each(['figure', 'fig', 'table'])(
    'does not generate any suggestion for "%s" keyword -- no resolution path exists',
    async (keyword) => {
      const parsed = buildParsed();

      const res = await svc.dispatchIssue(crossRefIssue(keyword, '2', `see ${keyword} 2`), parsed, CONFIG, new Map(), new Map(), new Map());

      expect(res).toBeNull();
    }
  );
});
