/**
 * Regression coverage for dispatchIssue's alt-text-glyph pre-check: a
 * MATTERHORN-13-001 issue from pdf-figure-structtree.validator.ts's own
 * struct-tree walk (identified by its "figure_p{page}_mc{mcid}" element
 * id) tries the deterministic single-glyph extraction FIRST, before
 * falling through to the existing image-based AI-vision path. Confirmed
 * real and live on Math_Weir_PDF.pdf: 219 of 437 missing-alt Figures
 * (50.1%) are a lone inline math variable ("V", "X", "d") an AI vision
 * model has nothing meaningful to describe in an 8x11-point crop of.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

// dispatchIssue is private; exercise via cast, same pattern as
// ai-analysis-table-not-tagged-routing.test.ts.
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

function issueFor(elementId: string, pageNumber = 1): AuditIssue {
  return {
    id: 'pdf-figure-structtree-1',
    source: 'pdf-figure-structtree',
    severity: 'critical',
    code: 'MATTERHORN-13-001',
    message: `Figure "${elementId}" on page ${pageNumber} has no alternative text`,
    pageNumber,
    element: elementId,
    category: 'alt-text',
  } as AuditIssue;
}

async function docWithPageContent(content: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writePageContent(doc, 1, content);
  return doc;
}

describe('dispatchIssue: MATTERHORN-13-001 tries alt-text-glyph before the AI-vision path', () => {
  it('returns a deterministic alt-text-glyph suggestion for a qualifying single-glyph Figure, with no AI call', async () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(V)Tj\nET\nEMC\n`;
    const doc = await docWithPageContent(content);
    const parsed = { isTagged: true, pages: [], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(issueFor('figure_p1_mc0'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text-glyph');
    expect(res.value).toBe('V');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(1.0);
  });

  it('falls through to the image-based path (returns null with no image available) for a Figure sharing its span with a real embedded image', async () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(slug line text)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`;
    const doc = await docWithPageContent(content);
    const parsed = { isTagged: true, pages: [], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(issueFor('figure_p1_mc0'), parsed, CONFIG, new Map(), new Map(), new Map());

    // No image registered in imageById and no page to render from
    // pageRenderCache -- the existing fallback path correctly returns null
    // rather than fabricating a suggestion from the unrelated slug text.
    expect(res).toBeNull();
  });

  it('falls through to the image-based path for a Figure with multiple readable text-show fragments (a formula)', async () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(negative likelihood ratio)Tj\n0 Tc 1 0 Td\n(C)Tj\nET\nEMC\n`;
    const doc = await docWithPageContent(content);
    const parsed = { isTagged: true, pages: [], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(issueFor('figure_p1_mc0'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });

  it('falls through to the image-based path when the element id is not the figure_p{page}_mc{mcid} struct-tree-walk format (the image-extraction path\'s own id shape)', async () => {
    const content = `/Figure <</MCID 0 >>BDC\nBT\n(V)Tj\nET\nEMC\n`;
    const doc = await docWithPageContent(content);
    const parsed = { isTagged: true, pages: [], parsedPdf: { pdfLibDoc: doc } } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(issueFor('img_p1_0_Im0'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });

  it('falls through to the image-based path when parsedPdf is unavailable', async () => {
    const parsed = { isTagged: true, pages: [] } as unknown as PdfParseResult;

    const res = await svc.dispatchIssue(issueFor('figure_p1_mc0'), parsed, CONFIG, new Map(), new Map(), new Map());

    expect(res).toBeNull();
  });
});
