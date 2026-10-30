import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
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
 * analyzeArtifactSwallowsContent requires. A page whose complex span really
 * is pure decorative graphics (confirmed live on Farrar_2E_Comp_188910.pdf:
 * 7 of its 16 complex pages) has nothing to free, so it still declines to
 * manual review, unchanged from before this routing split existed.
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

  it('still routes a purely decorative complex span to guidance-only manual review', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}${GRID_LINE}EMC\n`;
    const parsed = await buildParsed(content);

    const res = await svc.dispatchIssue(complexArtifactIssue(), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBeLessThan(CONFIG.confidenceThreshold);
  });

  it('falls back to guidance-only when the issue has no pageNumber', async () => {
    const content = `/Artifact BMC\n${PATH_FILLER}(Term A)Tj\nEMC\n`;
    const parsed = await buildParsed(content);
    const issue = { ...complexArtifactIssue(), pageNumber: undefined };

    const res = await svc.dispatchIssue(issue, parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('artifact-unwrap-review');
    expect(res.applyMode).toBe('guidance-only');
  });
});
