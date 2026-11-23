/**
 * QC brief Theme B2 (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * dispatchIssue's gate in front of buildFormulaTranscript. Real incident --
 * buildFormulaTranscript's own only refusal is a Do/sh/EI operator in the
 * span, so a vector-drawn diagram (fill/line ops only, several widely-
 * spaced text-run labels, no embedded image) sailed through it and was
 * misread as inline math notation (Fig 7.1's axis labels "5"/"10" became
 * "subscript"/"superscript"). This gate adds a bbox-size check
 * (pdfConfig.formulaTranscriptMax{Height,Width}Pt) and a shape check
 * (getFormulaTranscriptShapeSignals' own yRange, against
 * pdfConfig.formulaTranscriptMaxYRangePt) before accepting a transcript.
 *
 * decodePageContent is mocked to return a controlled raw content string
 * directly (same strings pdf-structure-writer-build-formula-transcript.
 * test.ts already exercises) -- this isolates the GATE decision from
 * needing a real pdf-lib document with a real content stream.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

vi.mock('../../../../src/services/pdf/pdf-content-stream-io', () => ({
  decodePageContent: vi.fn(),
}));
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

const INLINE_FORMULA_CONTENT = `/Figure <</MCID 5 >>BDC
BT
11 0 0 11 283.84 686.71 Tm
(P)Tj
2.406 2.023 Td
(XL)Tj
ET
EMC
`;

const VECTOR_DIAGRAM_CONTENT = `/Figure <</MCID 5 >>BDC
BT
11 0 0 11 100 700 Tm
(Have to 10)Tj
0 -40 Td
(Able to 5)Tj
0 -40 Td
(Want to 10)Tj
ET
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

describe('dispatchIssue: formula-transcript size/shape gate (Theme B2)', () => {
  afterEach(() => vi.clearAllMocks());

  it('accepts a small, single-baseline inline expression -- takes the formula-transcript path', async () => {
    vi.mocked(decodePageContent).mockReturnValue(INLINE_FORMULA_CONTENT);
    vi.mocked(geminiService.generateWithSchema).mockResolvedValue({
      data: { altText: 'X subscript i, n', confidence: 0.9, rationale: 'r' },
      usage: { promptTokens: 1, completionTokens: 1 },
    } as never);
    const issue = figureIssue({ boundingBox: { x: 0, y: 0, width: 50, height: 15, pageWidth: 600, pageHeight: 800 } });

    const res = await svc.dispatchIssue(issue, buildParsed(), CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text-formula-transcript');
  });

  it('refuses a large bbox even with a small-looking yRange -- falls through, not the formula-transcript path', async () => {
    vi.mocked(decodePageContent).mockReturnValue(INLINE_FORMULA_CONTENT);
    const issue = figureIssue({ boundingBox: { x: 0, y: 0, width: 300, height: 15, pageWidth: 600, pageHeight: 800 } });

    const res = await svc.dispatchIssue(issue, buildParsed(), CONFIG, new Map(), new Map(), new Map());

    // Falls through to the image/page-render path, which returns null here
    // (no image in imageById and fallbackToPageRender has nothing to render
    // from a stubbed pdfLibDoc) -- the assertion that matters is that
    // generateWithSchema (the formula-transcript AI call) was never reached.
    expect(res).toBeNull();
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });

  it('refuses a small bbox whose text runs are widely spaced (a diagram\'s axis/quadrant labels, not one inline expression)', async () => {
    vi.mocked(decodePageContent).mockReturnValue(VECTOR_DIAGRAM_CONTENT);
    const issue = figureIssue({ boundingBox: { x: 0, y: 0, width: 50, height: 20, pageWidth: 600, pageHeight: 800 } });

    const res = await svc.dispatchIssue(issue, buildParsed(), CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });

  it('declines (falls through) rather than guesses when the issue has no boundingBox at all', async () => {
    vi.mocked(decodePageContent).mockReturnValue(INLINE_FORMULA_CONTENT);
    const issue = figureIssue(); // no boundingBox

    const res = await svc.dispatchIssue(issue, buildParsed(), CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
    expect(geminiService.generateWithSchema).not.toHaveBeenCalled();
  });
});
