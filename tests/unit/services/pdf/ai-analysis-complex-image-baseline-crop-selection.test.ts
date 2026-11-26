/**
 * Confirms draftComplexImageBaseline's vision call receives whichever image
 * dispatchIssue itself already resolved -- the whole-figure CROP when
 * figureHasOverlaidContent applies (real labels drawn over/around the raster
 * image, the BATNA-box/T4-composite-figure shape), never the raw embedded
 * image unconditionally. Exercised through dispatchIssue (the real caller),
 * not analyzeAltText/draftComplexImageBaseline in isolation -- every other
 * test in ai-analysis-complex-image-baseline.test.ts hands analyzeAltText an
 * already-resolved ImageInfo directly, which proves draftComplexImageBaseline
 * forwards whatever it's given correctly, but never proves dispatchIssue
 * resolved the RIGHT image in the first place. This test closes that gap.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

vi.mock('../../../../src/services/pdf/structure-tag-inventory.service', () => ({
  extractStructureTagsForPage: vi.fn(),
  resolveElementRef: vi.fn(),
}));
vi.mock('../../../../src/services/pdf/pdf-content-stream-io', () => ({
  decodePageContent: vi.fn(),
}));

import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AiRemediationConfig } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { extractStructureTagsForPage, resolveElementRef } from '../../../../src/services/pdf/structure-tag-inventory.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// dispatchIssue/renderPageToBase64 are private; exercise via cast, same
// pattern as every other *-routing.test.ts in this suite.
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

const BBOX = { x: 100, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 };

const RAW_IMAGE_BASE64 = (() => {
  const c = createCanvas(50, 50);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000'; // red -- the "raw embedded image", unambiguously distinct from the page render below
  ctx.fillRect(0, 0, 50, 50);
  return c.toBuffer('image/png').toString('base64');
})();

const WHOLE_PAGE_BASE64 = (() => {
  const c = createCanvas(612, 792);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0000ff'; // blue -- the "whole rendered page", unambiguously distinct from the raw image above
  ctx.fillRect(0, 0, 612, 792);
  return c.toBuffer('image/png').toString('base64');
})();

function buildImage(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    id: 'img_p1_0_Im0',
    pageNumber: 1,
    index: 0,
    position: { x: BBOX.x, y: BBOX.y, width: BBOX.width, height: BBOX.height },
    dimensions: { width: 100, height: 60 },
    format: 'png',
    colorSpace: 'DeviceRGB',
    bitsPerComponent: 8,
    hasAlpha: false,
    fileSizeBytes: 100,
    base64: RAW_IMAGE_BASE64,
    mimeType: 'image/png',
    ...overrides,
  };
}

function buildIssue(): AuditIssue {
  return {
    id: 'alt-1',
    source: 'pdf-alttext',
    severity: 'serious',
    code: 'MATTERHORN-13-001',
    message: 'Image has no alt text',
    category: 'alt-text',
    pageNumber: 1,
    element: 'img_p1_0_Im0',
    boundingBox: BBOX,
  } as AuditIssue;
}

// A real pdf-lib document, so `dict instanceof PDFDict` (figureHasOverlaidContent's
// own guard after resolveElementRef) is genuinely satisfied -- a plain mock
// object can't fake that instanceof check. Same pattern as
// ai-analysis-figure-has-overlaid-content.test.ts.
let realDoc: PDFDocument;
beforeAll(async () => {
  realDoc = await PDFDocument.create();
  realDoc.context.lookup = () => realDoc.context.obj({ S: PDFName.of('Figure') });
});

function buildParsed(): PdfParseResult {
  return {
    isTagged: true,
    pages: [{ tables: [] }],
    parsedPdf: { pdfLibDoc: realDoc },
  } as unknown as PdfParseResult;
}

describe('dispatchIssue -> draftComplexImageBaseline: crop vs. raw image selection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the whole-figure CROP (not the raw embedded image) when figureHasOverlaidContent applies', async () => {
    // Signal 1 (figureHasOverlaidContent): the Figure's own subtree, found
    // by bbox match, carries a readable text-show MCID -- the real
    // T4/BATNA-box composite-figure shape (an image + separately-drawn
    // overlaid text labels sharing one Figure).
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Figure', pageNumber: 1, bbox: BBOX } as never,
    ]);
    vi.mocked(resolveElementRef).mockReturnValue({ toString: () => '5-0' } as never);
    vi.spyOn(pdfStructureWriterService, 'collectLeafMcids').mockReturnValue([3]);
    vi.mocked(decodePageContent).mockReturnValue('/Figure <</MCID 3 >>BDC\nBT\n(Ovary Fallopian tube)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n');

    vi.spyOn(svc, 'renderPageToBase64').mockResolvedValue(WHOLE_PAGE_BASE64);
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    const visionSpy = vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'Diagram of conception and implantation showing the ovary and fallopian tube', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);

    const imageById = new Map([['img_p1_0_Im0', buildImage()]]);
    await svc.dispatchIssue(
      buildIssue(), buildParsed(), CONFIG, imageById, new Map(), new Map(), new Map(), 'job-1', 'tenant-1', 'doc.pdf'
    );

    expect(visionSpy).toHaveBeenCalledTimes(1);
    const sentBase64 = visionSpy.mock.calls[0][0];
    expect(sentBase64).not.toBe(RAW_IMAGE_BASE64); // not the raw embedded image
    expect(sentBase64).not.toBe(WHOLE_PAGE_BASE64); // and not the uncropped whole page either -- a real crop of it
  });

  it('sends the raw embedded image when the Figure has no overlaid content at all', async () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([]); // neither signal fires
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    const visionSpy = vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'A simple labeled bar chart of quarterly revenue', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);

    const imageById = new Map([['img_p1_0_Im0', buildImage()]]);
    await svc.dispatchIssue(
      buildIssue(), buildParsed(), CONFIG, imageById, new Map(), new Map(), new Map(), 'job-1', 'tenant-1', 'doc.pdf'
    );

    expect(visionSpy).toHaveBeenCalledTimes(1);
    expect(visionSpy.mock.calls[0][0]).toBe(RAW_IMAGE_BASE64);
  });
});
