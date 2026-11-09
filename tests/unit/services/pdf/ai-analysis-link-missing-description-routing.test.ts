import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult, PdfPage } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for MATTERHORN-28-004's dispatch routing -- pdfa11y-
 * sourced (UA-28-025): a Link annotation with neither a /Contents entry nor
 * an /Alt on its enclosing structure element. Unlike LINK_CODES'
 * LINK-NOT-DESCRIPTIVE/etc (whose issue.context already carries "Link
 * text:"/"URL:" in a format analyzeLinkText's regex can extract), pdfa11y's
 * own context is a struct_path -- analyzeLinkText falls back to resolving
 * the real annotation via pdfModifierService.findLinksMissingContents,
 * declining (null) whenever that isn't exactly 1 candidate, same "refuse to
 * guess" discipline as every positional match in this file.
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

function buildPage(): PdfPage {
  return {
    pageNumber: 4,
    width: 612,
    height: 792,
    rotation: 0,
    content: [{ text: 'See the enrollment form for details.', position: { x: 50, y: 100, width: 200, height: 20 } }],
    images: [],
    links: [],
    formFields: [],
    headings: [],
    tables: [],
    lists: [],
  } as unknown as PdfPage;
}

function buildParsed(): PdfParseResult {
  return {
    isTagged: true,
    pages: [{}, {}, {}, buildPage()],
    parsedPdf: { pdfLibDoc: {} },
  } as unknown as PdfParseResult;
}

function pdfa11yLinkIssue(): AuditIssue {
  return {
    id: 'pdfa11y-28-004',
    source: 'pdfa11y',
    severity: 'serious',
    code: 'MATTERHORN-28-004',
    message: 'An annotation, other than of subtype Widget, does not have a Contents entry and does not have an alternative description (in the form of an Alt entry in the enclosing structure element).',
    matterhornCheckpoint: '28-004',
    matterhornHow: 'M',
    category: 'pdf-ua',
    pageNumber: 4,
    context: '/Document/Sect[1]/Link[1]',
  } as AuditIssue;
}

describe('dispatchIssue: MATTERHORN-28-004 routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves the sole undescribed Link annotation and drafts a description via AI', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(pdfModifierService, 'findLinksMissingContents').mockReturnValue([{}] as any);
    vi.spyOn(pdfModifierService, 'getLinkUri').mockReturnValue('https://example.com/enroll');
    vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
      data: { suggestedText: 'Enrollment form', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 5 },
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await svc.dispatchIssue(pdfa11yLinkIssue(), buildParsed(), CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('link-text');
    expect(res.value).toBe('Enrollment form');
    expect(res.applyMode).toBe('guidance-only');
    expect(pdfModifierService.findLinksMissingContents).toHaveBeenCalledWith(expect.anything(), 4);
  });

  it('declines when zero undescribed Link annotations resolve on the page', async () => {
    vi.spyOn(pdfModifierService, 'findLinksMissingContents').mockReturnValue([]);

    const res = await svc.dispatchIssue(pdfa11yLinkIssue(), buildParsed(), CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });

  it('declines when more than one undescribed Link annotation resolves on the page (ambiguous)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(pdfModifierService, 'findLinksMissingContents').mockReturnValue([{}, {}] as any);

    const res = await svc.dispatchIssue(pdfa11yLinkIssue(), buildParsed(), CONFIG, new Map(), new Map(), new Map());
    expect(res).toBeNull();
  });

  it('is disabled when linkTextMode is disabled', async () => {
    const res = await svc.dispatchIssue(
      pdfa11yLinkIssue(),
      buildParsed(),
      { ...CONFIG, linkTextMode: 'disabled' },
      new Map(),
      new Map(),
      new Map()
    );
    expect(res).toBeNull();
  });
});
