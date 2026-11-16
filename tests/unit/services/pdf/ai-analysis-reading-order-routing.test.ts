/**
 * Regression coverage for READING_ORDER_CODES' dispatch routing.
 *
 * Before this fix, this Set listed four codes (MATTERHORN-09-004,
 * READING-ORDER-SUSPECT, READING-ORDER-COLUMN, READING-ORDER-RTOL) that
 * pdf-structure.validator.ts's validateReadingOrder() never actually emits
 * -- it emits MATTERHORN-12-001, READING-ORDER-COLUMNS, READING-ORDER-VISUAL,
 * READING-ORDER-TABLE, and READING-ORDER-ISSUE instead. The mismatch meant
 * analyzeReadingOrder() -- fully implemented, reachable code -- was never
 * actually dispatched to for any real reading-order issue. S4 QC R3 triage
 * (2026-11-17) found this; this test locks in the fix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult, PdfPage } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

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

function buildPage(): PdfPage {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    rotation: 0,
    content: [
      { text: 'Right column text', position: { x: 320, y: 100, width: 200, height: 12 } },
      { text: 'Left column text', position: { x: 40, y: 100, width: 200, height: 12 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any,
    images: [],
    links: [],
    formFields: [],
    headings: [],
    tables: [],
    lists: [],
  };
}

function issueFor(code: string): AuditIssue {
  return {
    id: 'reading-order-1',
    source: 'pdf-structure',
    severity: 'moderate',
    code,
    message: 'Document reading order may not be logical',
    pageNumber: 1,
    location: 'Page 1',
    matterhornCheckpoint: '12-001',
    matterhornHow: 'H',
  } as AuditIssue;
}

function buildParsed(page: PdfPage): PdfParseResult {
  return { isTagged: true, pages: [page] } as unknown as PdfParseResult;
}

describe('dispatchIssue: reading-order routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['MATTERHORN-12-001', 'READING-ORDER-COLUMNS', 'READING-ORDER-VISUAL', 'READING-ORDER-TABLE', 'READING-ORDER-ISSUE'])(
    'dispatches %s to analyzeReadingOrder instead of returning null',
    async (code) => {
      vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
        data: { suggestedOrder: ['Left column text', 'Right column text'], confidence: 0.8, guidance: 'Read left column before right column.' },
        usage: { promptTokens: 10, completionTokens: 5 },
        attempts: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const page = buildPage();
      const parsed = buildParsed(page);
      const res = await svc.dispatchIssue(issueFor(code), parsed, CONFIG, new Map(), new Map(), new Map());

      expect(res).not.toBeNull();
      expect(res.suggestionType).toBe('reading-order');
      expect(res.applyMode).toBe('guidance-only');
      expect(res.guidance).toBe('Read left column before right column.');
    }
  );

  it('the four previously-listed dead codes no longer short-circuit silently -- they are simply unrecognized, same as any other unmapped code', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');
    const page = buildPage();
    const parsed = buildParsed(page);

    const res = await svc.dispatchIssue(issueFor('READING-ORDER-SUSPECT'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
