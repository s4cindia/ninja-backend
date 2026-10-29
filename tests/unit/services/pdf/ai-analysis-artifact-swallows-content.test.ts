import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/**
 * Regression coverage for analyzeArtifactSwallowsContent (ARTIFACT-SWALLOWS-
 * CONTENT): the AI-assisted boundary-determination step for a producer-
 * authored top-level /Artifact span that wrongly swallows real, never-
 * tagged content (see pdf-artifact-tagger.ts's findOversizedArtifactSpans
 * for the full detection/forensic trail). Safety net under test: Gemini is
 * asked to pick an INDEX into a numbered list extracted directly from the
 * page's own bytes, not to re-type anything -- an out-of-range index (or a
 * failed call) must drop the WHOLE page to guidance-only, never partially
 * trust an unverifiable answer.
 */

// analyzeArtifactSwallowsContent is private; exercise via cast, same
// pattern as ai-analysis-formula.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const REAL_TEXT = 'Real content opens here';
const FILLER = Array.from({ length: 20 }, (_, i) => `(filler ${i})Tj\n`).join('');
// 2 header ops + 20 filler + 1 real = 23 text runs, comfortably over the
// 15-op default threshold -- same fixture shape as the writer's own tests.
const PAGE_CONTENT = `/Artifact BMC\nBT\n(5)Tj\n(Running Head)Tj\n${FILLER}(${REAL_TEXT})Tj\nET\nEMC\n`;
const REAL_TEXT_INDEX = 22; // 2 header runs (0,1) + 20 filler runs (2..21) + real run at 22

async function buildParsedPdf(content: string): Promise<ParsedPDF> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writePageContent(doc, 1, content);
  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

function issueForPage(pageNumber: number | undefined): AuditIssue {
  return {
    id: 'pdf-structure-artifact-1',
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ARTIFACT-SWALLOWS-CONTENT',
    message: 'Oversized /Artifact span likely swallowing real content',
    pageNumber,
    location: pageNumber ? `Page ${pageNumber}` : 'Document',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGemini = (data: any, usage?: any) =>
  vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({ data, usage, attempts: 1 } as never);

describe('analyzeArtifactSwallowsContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a verified apply-to-pdf fix when the AI picks an in-range index', async () => {
    const parsedPdf = await buildParsedPdf(PAGE_CONTENT);
    const spy = mockGemini({ firstRealContentIndex: REAL_TEXT_INDEX, confidence: 0.95 }, { promptTokens: 50, completionTokens: 5 });

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0][2];
    expect(options.responseSchema).toBeTruthy(); // schema-constrained decoding, same MAX_TOKENS-safety convention as every other AI call in this file

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-fix');
    expect(res.value).toBe(JSON.stringify([REAL_TEXT]));
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.requiresManualReview).toBe(true);
    // Capped at 0.85 even though the model reported 0.95 -- never fully
    // trusts AI judgment at face value.
    expect(res.confidence).toBe(0.85);
    expect(res.usage).toEqual({ promptTokens: 50, completionTokens: 5 });
  });

  it('drops to guidance-only when the AI returns an out-of-range index, rather than guessing', async () => {
    const parsedPdf = await buildParsedPdf(PAGE_CONTENT);
    mockGemini({ firstRealContentIndex: 9999, confidence: 0.9 });

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBeLessThan(0.5);
    expect(res.rationale).toContain('out-of-range');
  });

  it('drops to guidance-only when the AI returns a negative index', async () => {
    const parsedPdf = await buildParsedPdf(PAGE_CONTENT);
    mockGemini({ firstRealContentIndex: -1, confidence: 0.9 });

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(res.applyMode).toBe('guidance-only');
  });

  it('drops to guidance-only when the Gemini call itself fails', async () => {
    const parsedPdf = await buildParsedPdf(PAGE_CONTENT);
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('503 overloaded'));

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(res).not.toBeNull();
    expect(res.applyMode).toBe('guidance-only');
    expect(res.rationale).toContain('503 overloaded');
  });

  it('returns null when the page has no oversized Artifact span (already fixed or moved)', async () => {
    const parsedPdf = await buildParsedPdf('/P <</MCID 0 >>BDC\n(Just a normal page)Tj\nEMC\n');
    const spy = vi.spyOn(geminiService, 'generateWithSchema');

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // no wasted AI call
  });

  it('returns null when the issue has no pageNumber', async () => {
    const parsedPdf = await buildParsedPdf(PAGE_CONTENT);
    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(undefined), parsedPdf);
    expect(res).toBeNull();
  });

  it('calls Gemini once per oversized span on the page, combining them into one ordered value array', async () => {
    const twoSpanContent = PAGE_CONTENT + PAGE_CONTENT; // two identical oversized spans
    const parsedPdf = await buildParsedPdf(twoSpanContent);
    const spy = mockGemini({ firstRealContentIndex: REAL_TEXT_INDEX, confidence: 0.9 });

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.value).toBe(JSON.stringify([REAL_TEXT, REAL_TEXT]));
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('drops the WHOLE page to guidance-only if even one of several spans fails verification', async () => {
    const twoSpanContent = PAGE_CONTENT + PAGE_CONTENT;
    const parsedPdf = await buildParsedPdf(twoSpanContent);
    let call = 0;
    vi.spyOn(geminiService, 'generateWithSchema').mockImplementation(async () => {
      call++;
      return {
        data: call === 1 ? { firstRealContentIndex: REAL_TEXT_INDEX, confidence: 0.9 } : { firstRealContentIndex: 9999, confidence: 0.9 },
        attempts: 1,
      } as never;
    });

    const res = await svc.analyzeArtifactSwallowsContent(issueForPage(1), parsedPdf);

    expect(res.applyMode).toBe('guidance-only');
    expect(res.suggestionType).toBe('artifact-unwrap-review');
  });
});
