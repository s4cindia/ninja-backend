import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { aiAnalysisService, buildSuggestionCacheKey } from '../../../../src/services/pdf/ai-analysis.service';
import { resolveColorContrastTargets } from '../../../../src/services/pdf/pdf-contrast-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { TextRunMatch } from '../../../../src/services/pdf/contrast-content-stream';

// analyzeColorContrast is private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const EMPTY_MATCHES = new Map<string, TextRunMatch | null>();

const BASE_ISSUE: AuditIssue = {
  id: 'contrast-1',
  source: 'contrast-validator',
  severity: 'serious',
  code: 'COLOR-CONTRAST',
  message: 'Text has contrast ratio 2.10:1 (minimum 4.5:1 required for normal text)',
  pageNumber: 3,
};

describe('analyzeColorContrast', () => {
  it('turns the validator-measured contrastData into a deterministic, high-confidence suggestion', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#777777',
        background: '#ffffff',
        ratio: 2.1,
        requiredRatio: 4.5,
        isLargeText: false,
      },
    };

    const res = svc.analyzeColorContrast(issue, EMPTY_MATCHES, 'guidance-only');

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(0.95);
    expect(res.guidance).toContain('4.5:1');
    expect(res.guidance).toContain('#777777');
    expect(res.guidance).toContain('#ffffff');
    expect(res.rationale).toContain('2.1:1');
  });

  it('uses the large-text threshold when contrastData.isLargeText is true', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#999999',
        background: '#ffffff',
        ratio: 2.6,
        requiredRatio: 3.0,
        isLargeText: true,
      },
    };

    const res = svc.analyzeColorContrast(issue, EMPTY_MATCHES, 'guidance-only');
    expect(res.guidance).toContain('3:1');
    expect(res.guidance).toContain('large text');
  });

  it('returns null when the issue has no contrastData (never calls Gemini)', () => {
    const res = svc.analyzeColorContrast(BASE_ISSUE, EMPTY_MATCHES, 'guidance-only');
    expect(res).toBeNull();
  });
});

describe('dispatchIssue: COLOR-CONTRAST without contrastData routes to invisible-text-artifact-fix, not analyzeColorContrast', () => {
  // Confirmed real on Math_Weir_PDF.pdf: pdf-contrast.validator.ts never
  // populates contrastData for its own "single uniform color" (genuinely
  // invisible text) detection path -- there's no real foreground/
  // background pair to report a ratio for. That absence is the exact
  // signal dispatchIssue uses to route to the deterministic Artifact-
  // tagging fix instead of a color-ratio suggestion.
  const NO_CONTRAST_DATA_ISSUE: AuditIssue = {
    ...BASE_ISSUE,
    message: 'Text on page 3 has no visually distinguishable ink from its background',
    boundingBox: { x: 100, y: 200, width: 50, height: 8, pageWidth: 612, pageHeight: 792 },
  };

  it('ALWAYS returns guidance-only, even when colorContrastMode is apply-to-pdf', async () => {
    // CodeRabbit finding on PR #585, confirmed real: the SAME "no
    // contrastData" shape also represents a genuinely different, unrelated
    // problem -- an embedded-font rendering failure hiding REAL content,
    // which pdf-contrast.validator.ts's own triage already marks 'manual'
    // for exactly this reason. Auto-Artifact-tagging real content because
    // its rendering is merely broken would be strictly worse than leaving
    // it flagged, so this suggestion never auto-applies regardless of
    // config, unlike the sibling color-contrast-fix.
    const parsed = { isTagged: true, pages: [] } as unknown as import('../../../../src/services/pdf/pdf-comprehensive-parser.service').PdfParseResult;
    const config = { colorContrastMode: 'apply-to-pdf' } as unknown as import('../../../../src/services/pdf/ai-analysis.service').AiRemediationConfig;

    const res = await svc.dispatchIssue(NO_CONTRAST_DATA_ISSUE, parsed, config, new Map(), new Map(), new Map(), new Map());

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('invisible-text-artifact-fix');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
    expect(res.requiresManualReview).toBe(true);
  });

  it('stays guidance-only when colorContrastMode is already guidance-only', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as import('../../../../src/services/pdf/pdf-comprehensive-parser.service').PdfParseResult;
    const config = { colorContrastMode: 'guidance-only' } as unknown as import('../../../../src/services/pdf/ai-analysis.service').AiRemediationConfig;

    const res = await svc.dispatchIssue(NO_CONTRAST_DATA_ISSUE, parsed, config, new Map(), new Map(), new Map(), new Map());

    expect(res.suggestionType).toBe('invisible-text-artifact-fix');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('returns null (respects the existing disabled gate) when colorContrastMode is disabled, same as any other contrast issue', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as import('../../../../src/services/pdf/pdf-comprehensive-parser.service').PdfParseResult;
    const config = { colorContrastMode: 'disabled' } as unknown as import('../../../../src/services/pdf/ai-analysis.service').AiRemediationConfig;

    const res = await svc.dispatchIssue(NO_CONTRAST_DATA_ISSUE, parsed, config, new Map(), new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });

  it('still routes a REAL contrastData-bearing issue through analyzeColorContrast, not the new artifact fix', async () => {
    const issueWithData: AuditIssue = { ...BASE_ISSUE, contrastData: { foreground: '#777777', background: '#ffffff', ratio: 2.1, requiredRatio: 4.5, isLargeText: false } };
    const parsed = { isTagged: true, pages: [] } as unknown as import('../../../../src/services/pdf/pdf-comprehensive-parser.service').PdfParseResult;
    const config = { colorContrastMode: 'apply-to-pdf' } as unknown as import('../../../../src/services/pdf/ai-analysis.service').AiRemediationConfig;

    const res = await svc.dispatchIssue(issueWithData, parsed, config, new Map(), new Map(), new Map(), new Map());

    expect(res.suggestionType).toBe('color-contrast');
  });
});

describe('analyzeColorContrast — apply-to-pdf eligibility (Phase B3)', () => {
  async function buildDoc(x: number, y: number, size: number, rotate = 0): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    if (rotate) page.setRotation(degrees(rotate));
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Low contrast text', { x, y, size, font });
    return PDFDocument.load(await src.save());
  }

  function contrastIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
    return {
      ...BASE_ISSUE,
      pageNumber: 1,
      boundingBox: { x: 100, y: 600 - 450, width: 100, height: 14, pageWidth: 400, pageHeight: 600 },
      contrastData: {
        foreground: '#999999',
        background: '#ffffff',
        ratio: 2.1,
        requiredRatio: 4.5,
        isLargeText: false,
      },
      ...overrides,
    };
  }

  it('emits a color-contrast-fix suggestion when the text run is confidently located', async () => {
    const doc = await buildDoc(100, 450, 14);
    const issue = contrastIssue();
    const matches = resolveColorContrastTargets(doc, [issue]);

    const res = svc.analyzeColorContrast(issue, matches, 'apply-to-pdf');

    expect(res.suggestionType).toBe('color-contrast-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(res.confidence).toBeGreaterThanOrEqual(0.80);
    expect(res.confidence).toBeLessThanOrEqual(0.95);
    expect(res.guidance).toContain(res.value);
  });

  it('falls back to guidance-only when no text is near the flagged position', async () => {
    const doc = await buildDoc(100, 450, 14);
    const issue = contrastIssue({
      boundingBox: { x: 300, y: 600 - 50, width: 100, height: 14, pageWidth: 400, pageHeight: 600 },
    });
    const matches = resolveColorContrastTargets(doc, [issue]);

    const res = svc.analyzeColorContrast(issue, matches, 'apply-to-pdf');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('falls back to guidance-only on a rotated page', async () => {
    const doc = await buildDoc(100, 450, 14, 90);
    const issue = contrastIssue();
    const matches = resolveColorContrastTargets(doc, [issue]);

    const res = svc.analyzeColorContrast(issue, matches, 'apply-to-pdf');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });

  it('stays guidance-only when mode is guidance-only, even if the text would be locatable', async () => {
    const doc = await buildDoc(100, 450, 14);
    const issue = contrastIssue();
    const matches = resolveColorContrastTargets(doc, [issue]);

    const res = svc.analyzeColorContrast(issue, matches, 'guidance-only');
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
  });
});

describe('buildSuggestionCacheKey', () => {
  // Real-world regression: a pilot PDF with several independent low-contrast
  // text runs on one page came back 100% guidance-only under apply-to-pdf
  // mode. Root cause was here, not in the correlator — two distinct
  // COLOR-CONTRAST issues on the same page collapsed onto the same
  // suggestion-cache key (page-level, like reading-order/tables), so only
  // the page's first issue ever got a real correlation check; every other
  // issue on that page silently inherited its (possibly failed) result.
  it('gives two distinct contrast issues on the same page distinct keys', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'contrast-a', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'contrast-b', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });

  it('gives the same contrast issue the same key on repeat calls (still cacheable per-issue)', () => {
    const issue: AuditIssue = { ...BASE_ISSUE, id: 'contrast-a', pageNumber: 5 };
    expect(buildSuggestionCacheKey(issue)).toBe(buildSuggestionCacheKey({ ...issue }));
  });

  it('still shares one key across a whole page for genuinely page-level codes', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'ro-a', code: 'READING-ORDER-SUSPECT', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'ro-b', code: 'READING-ORDER-SUSPECT', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(b));
  });

  it('still shares one key across the whole document for document-level codes', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'h-a', code: 'HEADING-SKIP', pageNumber: 2 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'h-b', code: 'HEADING-SKIP', pageNumber: 9 };
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(b));
  });

  it('still keys element-level codes by element, not page', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'alt-a', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-1' };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'alt-b', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-2' };
    const c: AuditIssue = { ...BASE_ISSUE, id: 'alt-c', code: 'MATTERHORN-13-001', pageNumber: 5, element: 'img-1' };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
    expect(buildSuggestionCacheKey(a)).toBe(buildSuggestionCacheKey(c));
  });

  // Same collision as the contrast regression above, found in PR #511 review:
  // link and form-field issues also carry no `element`, so two distinct
  // generic links (or two distinct unlabeled fields) on the same page used
  // to share a key -- the second one's suggestion silently inherited the
  // first one's AI-drafted value, so approving both wrote the same text to
  // two different links/fields.
  it('gives two distinct link-text issues on the same page distinct keys', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'link-a', code: 'LINK-GENERIC-TEXT', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'link-b', code: 'LINK-GENERIC-TEXT', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });

  it('gives two distinct form-field issues on the same page distinct keys', () => {
    const a: AuditIssue = { ...BASE_ISSUE, id: 'form-a', code: 'FORM-FIELD-NO-LABEL', pageNumber: 5 };
    const b: AuditIssue = { ...BASE_ISSUE, id: 'form-b', code: 'FORM-FIELD-NO-LABEL', pageNumber: 5 };
    expect(buildSuggestionCacheKey(a)).not.toBe(buildSuggestionCacheKey(b));
  });
});
