import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

/**
 * Regression coverage for ARTIFACT-SWALLOWS-CONTENT-COMPLEX's dispatch
 * split: a page whose complex (path-paint-op-containing) oversized Artifact
 * span ALSO has real text interleaved with the decorative drawing gets a
 * deterministic rule-based apply-to-pdf fix -- findRealTextSegmentsInSpan
 * never has to judge the drawing itself, only the text, which is why this
 * doesn't need the AI-assisted confirmation the SIMPLE case's
 * analyzeArtifactSwallowsContent requires. A page with no real text at all
 * routes to Tier 2 (analyzeComplexArtifactAsFigure, an AI vision call per
 * span) -- by construction, every such page reaching this dispatch already
 * passed pdf-structure.validator.ts's own Tier 1 geometric suppression
 * (no curves, or a curve recurring across enough pages), so Tier 2 only
 * ever sees the genuine residual.
 */

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-untagged-content-routing.test.ts.
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

const GRID_LINE = '0 0 m\n100 0 l\nS\n';
const PATH_FILLER = Array.from({ length: 17 }, () => GRID_LINE).join(''); // 17 path-paint ops, zero text

// Tier 2's rendering step needs a genuine (non-degenerate) bounding box --
// GRID_LINE alone is a perfectly horizontal stroke (zero height), so these
// combine a horizontal AND a vertical rule per cell, same as a real table
// grid's own row+column ruling lines.
const GRID_LINE_V = '0 0 m\n0 20 l\nS\n';
const PATH_FILLER_2D = Array.from({ length: 9 }, () => GRID_LINE + GRID_LINE_V).join(''); // 18 path-paint ops, non-zero width AND height

function complexArtifactIssue(): AuditIssue {
  return {
    id: 'pdf-structure-1',
    source: 'pdf-structure',
    severity: 'serious',
    code: 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX',
    message: 'Oversized /Artifact span(s) likely swallowing real content, including vector graphics',
    pageNumber: 1,
    location: 'Page 1',
    matterhornCheckpoint: '01-005',
    matterhornHow: 'M',
  } as AuditIssue;
}

async function buildParsed(content: string): Promise<PdfParseResult> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writePageContent(doc, 1, content);
  return { isTagged: true, pages: [{}], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;
}

describe('dispatchIssue: ARTIFACT-SWALLOWS-CONTENT-COMPLEX routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a deterministic rule-based apply-to-pdf fix when real text is interleaved with decorative drawing', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}(Term A)Tj\n${GRID_LINE}(Term B)Tj\nEMC\n`;
    const parsed = await buildParsed(content);

    const res = await svc.dispatchIssue(complexArtifactIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-complex-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('Tier 2: routes a purely decorative complex span (AI vision says "no") to guidance-only manual review, enriched with the model\'s own reasoning', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER_2D}EMC\n`;
    const parsed = await buildParsed(content);
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isMeaningfulDiagram": false, "description": "a grid of ruling lines", "confidence": 0.9}',
    } as never);

    const res = await svc.dispatchIssue(complexArtifactIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBeLessThan(CONFIG.confidenceThreshold);
    expect(res.guidance).toContain('a grid of ruling lines');
    expect(res.model).toBe('gemini-flash');
  });

  it('Tier 2: retags as a real /Figure when AI vision confirms a meaningful diagram', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER_2D}EMC\n`;
    const parsed = await buildParsed(content);
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isMeaningfulDiagram": true, "description": "a labeled bar chart", "confidence": 0.8}',
    } as never);

    const res = await svc.dispatchIssue(complexArtifactIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-complex-figure-fix');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBeLessThanOrEqual(0.7); // probabilistic AI judgment, never 1.0
    expect(res.guidance).toContain('a labeled bar chart');
    const confirmed = JSON.parse(res.value);
    expect(confirmed).toHaveLength(1);
  });

  it('Tier 2: falls back to guidance-only (not a rejected promise) when the vision call itself fails', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER_2D}EMC\n`;
    const parsed = await buildParsed(content);
    vi.spyOn(svc, 'renderRegionToBase64').mockResolvedValue('ZmFrZQ==');
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('429 rate limit'));

    const res = await svc.dispatchIssue(complexArtifactIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
  });

  it('falls back to guidance-only when the issue has no pageNumber, without attempting any vision call', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}(Term A)Tj\nEMC\n`;
    const parsed = await buildParsed(content);
    const issue = { ...complexArtifactIssue(), pageNumber: undefined };
    const visionSpy = vi.spyOn(geminiService, 'analyzeImage');

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(visionSpy).not.toHaveBeenCalled();
  });
});
