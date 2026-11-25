/**
 * Rule 2 (Theme C p90 Figure, 2026-11-25): dispatchIssue's gate for a
 * Figure whose own MCID span -- content directly inside it, excluding
 * anything nested inside a child struct element or Artifact -- has no
 * image or vector content at all. Real incident: T4's own page-90
 * Figure opens, then immediately opens a nested /Artifact BMC whose
 * matching EMC doesn't close until after a real image Do and a page's
 * worth of vector-art strokes, so nothing is actually exposed as the
 * Figure's own -- yet the page-render/crop vision path had nothing real
 * to look at and invented a different description each run. This gate
 * grounds the alt text in the region's own text instead (literal, or
 * AI-drafted with a word-overlap guard), and declines entirely when
 * there's no text to ground on either.
 *
 * decodePageContent is mocked to return a controlled raw content string
 * directly, same pattern as ai-analysis-formula-transcript-gate-routing.
 * test.ts -- but mcidHasImageOrVectorContent/extractMcidText are left as
 * their REAL implementation (via importActual), so this test also
 * exercises their nested-marked-content exclusion end to end, not just
 * the dispatch branching around them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

vi.mock('../../../../src/services/pdf/pdf-content-stream-io', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/services/pdf/pdf-content-stream-io')>(
    '../../../../src/services/pdf/pdf-content-stream-io'
  );
  return { ...actual, decodePageContent: vi.fn() };
});
vi.mock('../../../../src/services/ai/gemini.service', () => ({
  geminiService: { generateWithSchema: vi.fn() },
}));

import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import { geminiService } from '../../../../src/services/ai/gemini.service';

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

const SHORT_TEXT_ONLY_CONTENT = `/Figure <</MCID 5 >>BDC
BT
(Placenta Uterus Umbilical cord Cervix Vagina)Tj
ET
EMC
`;

const LONG_TEXT_ONLY_CONTENT = `/Figure <</MCID 5 >>BDC
BT
(This diagram labels the stages of fetal development across all three trimesters of a typical human pregnancy, from conception through to full term delivery, with annotations for each major organ system)Tj
ET
EMC
`;

const EMPTY_CONTENT = `/Figure <</MCID 5 >>BDC
q
1 1 1 1 re
W n
Q
EMC
`;

// Real shape, T4's own page-90 Figure (MCID 8 in the real document;
// renumbered to 5 here to match this file's own issue fixture): the
// outer Figure opens, then immediately opens a nested /Artifact BMC
// whose own EMC doesn't appear until AFTER a real image Do and vector
// strokes -- none of that is exposed as this Figure's own content.
const NESTED_ARTIFACT_WRAPPING_REAL_CONTENT = `/Figure <</MCID 5 >>BDC
q 357 11 224 306 re W n
/Artifact BMC
(credit line stamp)Tj
q 1 0 0 1 0 0 cm 0 0 m 10 10 l S Q
/Im0 Do
EMC
Q
EMC
`;

function figureIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'pdf-figure-structtree-1',
    source: 'pdf-figure-structtree',
    severity: 'critical',
    code: 'MATTERHORN-13-001',
    message: 'Figure "figure_p1_mc5" on page 1 has no alternative text',
    category: 'alt-text',
    pageNumber: 1,
    element: 'figure_p1_mc5',
    ...overrides,
  } as AuditIssue;
}

function buildParsed(): PdfParseResult {
  return { parsedPdf: { pdfLibDoc: {} }, pages: [{}] } as unknown as PdfParseResult;
}

async function dispatch(issue: AuditIssue) {
  return svc.dispatchIssue(issue, buildParsed(), CONFIG, new Map(), new Map(), new Map(), new Map(), 'job-1', 'tenant-1', 'original.pdf');
}

describe('dispatchIssue: text-only Figure grounded alt text (Rule 2)', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the region\'s own text directly, with no AI call, when it is short enough to use as-is', async () => {
    vi.mocked(decodePageContent).mockReturnValue(SHORT_TEXT_ONLY_CONTENT);

    const res = await dispatch(figureIssue());

    expect(res).not.toBeNull();
    expect(res!.suggestionType).toBe('alt-text-grounded-text-only-literal');
    expect(res!.value).toBe('Placenta Uterus Umbilical cord Cervix Vagina');
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });

  it('drafts via AI for longer grounding text, and accepts a result that overlaps it', async () => {
    vi.mocked(decodePageContent).mockReturnValue(LONG_TEXT_ONLY_CONTENT);
    vi.mocked(geminiService.generateWithSchema).mockResolvedValue({
      data: { altText: 'Diagram of fetal development stages across pregnancy trimesters', confidence: 0.85, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 5 },
    } as never);

    const res = await dispatch(figureIssue());

    expect(res).not.toBeNull();
    expect(res!.suggestionType).toBe('alt-text-grounded-text-only');
    expect(res!.value).toBe('Diagram of fetal development stages across pregnancy trimesters');
  });

  it('rejects an AI result with no word overlap with its own grounding text, falling back to the text itself', async () => {
    vi.mocked(decodePageContent).mockReturnValue(LONG_TEXT_ONLY_CONTENT);
    vi.mocked(geminiService.generateWithSchema).mockResolvedValue({
      data: { altText: 'A smiling golden retriever puppy playing in a grassy park', confidence: 0.9, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 5 },
    } as never);

    const res = await dispatch(figureIssue());

    expect(res).not.toBeNull();
    expect(res!.suggestionType).toBe('alt-text-grounded-text-only-literal');
    expect(res!.value).toContain('fetal development');
  });

  it('declines entirely (returns null) when the region has neither image/vector content nor any text', async () => {
    vi.mocked(decodePageContent).mockReturnValue(EMPTY_CONTENT);

    const res = await dispatch(figureIssue());

    expect(res).toBeNull();
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });

  /**
   * The real T4 page-90 shape, end to end: a nested /Artifact BMC (late
   * EMC) wraps the only real image/vector content inside this Figure's
   * own span. Before the pdf-content-stream-io.ts nested-exclusion fix,
   * mcidHasImageOrVectorContent would have reported true here (the raw
   * Do/S operators are textually present in the outer span), sending
   * this straight to the vision/page-render path below instead of this
   * gate. With the fix, nothing is exposed as this Figure's own, so this
   * declines rather than guessing.
   */
  it('declines for a Figure whose only real content is nested inside an Artifact span (the real T4 page-90 shape)', async () => {
    vi.mocked(decodePageContent).mockReturnValue(NESTED_ARTIFACT_WRAPPING_REAL_CONTENT);

    const res = await dispatch(figureIssue());

    expect(res).toBeNull();
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });
});
