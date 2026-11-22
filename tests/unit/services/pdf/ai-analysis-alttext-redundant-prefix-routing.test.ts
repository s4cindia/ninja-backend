/**
 * Regression coverage for ALT-TEXT-REDUNDANT-PREFIX's dispatch --
 * previously had NO dispatch entry at all (every instance fell through to
 * this file's generic guidance-only default), not a narrow-pattern bug like
 * several other codes fixed this session. Deterministic: strips a literal,
 * case-insensitive match against pdf-alttext.validator.ts's own
 * REDUNDANT_ALT_TEXT_PREFIXES list from the start of the image's existing
 * alt text -- no AI judgment call needed.
 */
import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';

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

function issueFor(elementId = 'img_p1_0_Im0'): AuditIssue {
  return {
    id: 'pdf-alttext-redundant-1',
    source: 'pdf-alttext',
    severity: 'minor',
    code: 'ALT-TEXT-REDUNDANT-PREFIX',
    message: 'Image on page 1 has redundant prefix in alt text',
    category: 'alt-text',
    element: elementId,
    pageNumber: 1,
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { isTagged: true, pages: [{}] } as unknown as PdfParseResult;
}

function imageByIdWithAltText(elementId: string, altText: string | undefined): Map<string, ImageInfo> {
  const map = new Map<string, ImageInfo>();
  map.set(elementId, { altText } as unknown as ImageInfo);
  return map;
}

describe('dispatchIssue: ALT-TEXT-REDUNDANT-PREFIX routing', () => {
  it('strips a redundant prefix and routes to a deterministic rule-based apply-to-pdf fix', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', 'Image of: a cat sleeping on a windowsill');

    const res = await svc.dispatchIssue(issueFor(), parsed, CONFIG, imageById, new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text-strip-prefix');
    expect(res.value).toBe('a cat sleeping on a windowsill');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('matches case-insensitively and strips trailing punctuation left by the prefix', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', 'PICTURE OF - a red bicycle');

    const res = await svc.dispatchIssue(issueFor(), parsed, CONFIG, imageById, new Map(), new Map());

    expect(res.value).toBe('a red bicycle');
  });

  it('respects guidance-only altTextMode', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', 'Image of a cat');
    const guidanceOnlyConfig: AiRemediationConfig = { ...CONFIG, altTextMode: 'guidance-only' };

    const res = await svc.dispatchIssue(issueFor(), parsed, guidanceOnlyConfig, imageById, new Map(), new Map());

    expect(res.applyMode).toBe('guidance-only');
  });

  it('declines when the image has no alt text to work with', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', undefined);

    const res = await svc.dispatchIssue(issueFor(), parsed, CONFIG, imageById, new Map(), new Map());

    expect(res).toBeNull();
  });

  it('declines when the current alt text no longer actually has a redundant prefix (document changed since the issue was raised)', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', 'A cat sleeping on a windowsill');

    const res = await svc.dispatchIssue(issueFor(), parsed, CONFIG, imageById, new Map(), new Map());

    expect(res).toBeNull();
  });

  it('declines when stripping the prefix would leave nothing behind', async () => {
    const parsed = buildParsed();
    const imageById = imageByIdWithAltText('img_p1_0_Im0', 'Image of.');

    const res = await svc.dispatchIssue(issueFor(), parsed, CONFIG, imageById, new Map(), new Map());

    expect(res).toBeNull();
  });
});
