import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-07-001/07-002's dispatch routing --
 * pdfa11y-sourced (ViewerPreferences/DisplayDocTitle missing, or present
 * but false). Always routes to a deterministic, rule-based, apply-to-pdf
 * fix -- a single ViewerPreferences boolean set, same tier as
 * pdfua-identifier/tab-order-fix.
 *
 * Deliberately NOT 'MATTERHORN-01-002' -- see setDisplayDocTitle's own doc
 * comment (pdf-modifier.service.ts) for why that code (used in a few older
 * comments/constants elsewhere) is an unrelated Matterhorn condition.
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

function displayDocTitleIssue(code: string, matterhornCheckpoint: string): AuditIssue {
  return {
    id: `pdfa11y-${matterhornCheckpoint}`,
    source: 'pdfa11y',
    severity: 'serious',
    code,
    message: 'ViewerPreferences dictionary of the Catalog dictionary does not contain a DisplayDocTitle entry.',
    matterhornCheckpoint,
    matterhornHow: 'M',
    category: 'pdf-ua',
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

describe('dispatchIssue: MATTERHORN-07-001/07-002 (DisplayDocTitle) routing', () => {
  it('routes MATTERHORN-07-001 (missing) to a deterministic rule-based apply-to-pdf fix', async () => {
    const res = await svc.dispatchIssue(
      displayDocTitleIssue('MATTERHORN-07-001', '07-001'),
      buildParsed(),
      CONFIG,
      new Map(),
      new Map(),
      new Map()
    );

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('display-doc-title-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('routes MATTERHORN-07-002 (present but false) to the same fix', async () => {
    const res = await svc.dispatchIssue(
      displayDocTitleIssue('MATTERHORN-07-002', '07-002'),
      buildParsed(),
      CONFIG,
      new Map(),
      new Map(),
      new Map()
    );

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('display-doc-title-fix');
  });
});
