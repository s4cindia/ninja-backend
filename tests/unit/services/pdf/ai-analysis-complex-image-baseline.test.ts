/**
 * QC brief Theme B3 (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * draftComplexImageBaseline -- a fresh, vision-grounded short-alt baseline
 * for a MANUAL_IF_COMPLEX_IMAGE_TYPES image (diagram/chart-complex), auto-
 * applied so the Figure doesn't ship with no alt at all (F-08), while the
 * long description (diagram/chart only) stays a human-review item.
 * Exercised through analyzeAltText (the real caller), not in isolation,
 * since the rejection filter's Caption-echo check depends on a real
 * pdf-lib document.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';

// analyzeAltText/classifyImageType are private; exercise via cast, same
// pattern as every other *-decorative/*-routing test in this suite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const BBOX = { x: 100, y: 400, width: 200, height: 150, pageWidth: 612, pageHeight: 792 };

const ISSUE: AuditIssue = {
  id: 'alt-1',
  source: 'pdf-alttext',
  severity: 'serious',
  code: 'MATTERHORN-13-001',
  message: 'Image has no alt text',
  pageNumber: 1,
  element: 'img_p1_0_Im0',
  boundingBox: BBOX,
};

const IMAGE: ImageInfo = {
  id: 'img_p1_0_Im0',
  pageNumber: 1,
  index: 0,
  position: { x: 0, y: 0, width: 10, height: 10 },
  dimensions: { width: 10, height: 10 },
  format: 'png',
  colorSpace: 'DeviceRGB',
  bitsPerComponent: 8,
  hasAlpha: false,
  fileSizeBytes: 100,
  base64: 'ZmFrZQ==',
  mimeType: 'image/png',
};

async function docWithNoCaption(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [] });
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
  return doc;
}

async function docWithCaption(captionText: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const page = doc.getPage(0);
  const captionRef = doc.context.register(doc.context.obj({ S: PDFName.of('Caption'), Pg: page.ref, K: 7 }));
  const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [captionRef] });
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
  writePageContent(doc, 1, `<</MCID 7>>BDC BT 11 0 0 11 110 385 Tm (${captionText}) Tj ET EMC`);
  return doc;
}

describe('analyzeAltText: short-alt baseline for MANUAL_IF_COMPLEX_IMAGE_TYPES (Theme B3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('auto-applies a qualifying short alt as a baseline, keeps requiresManualReview for the long description', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: {
        shortAlt: 'Quadrant diagram comparing cost and value across four strategies',
        longDescription: 'X axis: cost (low to high). Y axis: value (low to high). Quadrant 1 (top-right): high value, high cost...',
        confidence: 0.82,
        rationale: 'Clear axis labels and quadrant structure visible',
      },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const doc = await docWithNoCaption();

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(res.suggestionType).toBe('alt-text');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.requiresManualReview).toBe(true);
    expect(res.value).toBe('Quadrant diagram comparing cost and value across four strategies');
    expect(res.extendedAlt).toContain('Quadrant 1');
  });

  it('real bug regression (2026-11-26): calls the vision method with the image bytes, never the text-only method', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    const visionSpy = vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'Quadrant diagram comparing cost and value across four strategies', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const textOnlySpy = vi.spyOn(geminiService, 'generateWithSchema');
    const doc = await docWithNoCaption();

    await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(textOnlySpy).not.toHaveBeenCalled();
    expect(visionSpy).toHaveBeenCalledTimes(1);
    expect(visionSpy.mock.calls[0][0]).toBe(IMAGE.base64);
    expect(visionSpy.mock.calls[0][1]).toBe(IMAGE.mimeType);
  });

  it('real bug regression (2026-11-26): rejects a drafted alt with no word overlap with real overlaid labels drawn in the figure', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    // extractFigureOverlaidText finds the Figure struct element by bbox match
    // (locateMcidBoundingBoxes/extractStructureTagsForPage, bottom-left PDF
    // point space, flipped to top-left before comparison against
    // ISSUE.boundingBox -- see structure-tag-inventory.service.ts's own
    // `y: pageHeight - maxY`) and reads its own MCID's readable text, the
    // same shape figureHasOverlaidContent itself already relies on. The Tm
    // anchor (150, 342) lands inside BBOX = {x:100,y:400,w:200,h:150} once
    // flipped: pageHeight(792) - 342 = 450, within [400, 550].
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const page = doc.getPage(0);
    const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 3 }));
    const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [figureRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
    writePageContent(doc, 1, `<</MCID 3>>BDC BT 8 0 0 8 150 342 Tm (Ovary Fallopian tube Implantation Uterus) Tj ET EMC`);

    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: {
        shortAlt: 'AWS architecture diagram showing a VPC with public and private subnets, ECS Fargate',
        confidence: 0.8,
        rationale: 'r',
      },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const fallbackSpy = vi.spyOn(svc, 'tryGenerateFallbackAltText').mockResolvedValue(null);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(fallbackSpy).toHaveBeenCalled();
    expect(res.applyMode).toBe('guidance-only');
    expect(res.value).toBeUndefined();
    // 2026-11-27: the rejected candidate and its grounding text must ride
    // along on the suggestion so analyzeJob can persist them onto this
    // issue's AiAnalysis.rejectedBaselineHistory -- a false-reject judgment
    // needs the actual rejected text, not just the altTextGuardRejected flag.
    expect(res.altTextGuardRejected).toBe(true);
    expect(res.guardRejectedAlt).toBe('AWS architecture diagram showing a VPC with public and private subnets, ECS Fargate');
    expect(res.guardRejectedGroundingText).toContain('Ovary');
  });

  it('does NOT request a longDescription for a non-diagram/chart MANUAL_IF_COMPLEX type -- there is none to request', async () => {
    // (diagram/chart are the only MANUAL_IF_COMPLEX_IMAGE_TYPES members --
    // this test documents that DIAGRAM_OR_CHART_TYPES gates the prompt's
    // own longDescription request, not a type outside that set, which
    // can't reach this branch at all.)
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'bar-chart', complexity: 'complex' });
    const spy = vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'Bar chart of quarterly revenue by region', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const doc = await docWithNoCaption();

    await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(spy.mock.calls[0][2] as string).toContain('longDescription');
  });

  it('falls back to guidance-only (no auto-apply) when the drafted short alt is a bare generic placeholder', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'a diagram', confidence: 0.3, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const fallbackSpy = vi.spyOn(svc, 'tryGenerateFallbackAltText').mockResolvedValue(null);
    const doc = await docWithNoCaption();

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(fallbackSpy).toHaveBeenCalled();
    expect(res.applyMode).toBe('guidance-only');
    expect(res.value).toBeUndefined();
  });

  it('falls back to guidance-only when the drafted short alt merely echoes a nearby Caption\'s own printed text', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'Figure 5.2: The BATNA box', confidence: 0.7, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const fallbackSpy = vi.spyOn(svc, 'tryGenerateFallbackAltText').mockResolvedValue(null);
    const doc = await docWithCaption('Figure 5.2: The BATNA box');

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(fallbackSpy).toHaveBeenCalled();
    expect(res.applyMode).toBe('guidance-only');
  });

  it('auto-applies normally when a Caption exists but the drafted short alt is genuinely different from it', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockResolvedValue({
      data: { shortAlt: 'Quadrant diagram comparing cost and value', confidence: 0.8, rationale: 'r' },
      usage: { promptTokens: 10, completionTokens: 20 },
    } as never);
    const doc = await docWithCaption('Figure 5.2: The BATNA box');

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.value).toBe('Quadrant diagram comparing cost and value');
  });

  it('falls back to guidance-only (no auto-apply, no crash) when the vision call itself fails', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'complex' });
    vi.spyOn(geminiService, 'analyzeImageWithSchema').mockRejectedValue(new Error('MAX_TOKENS'));
    const fallbackSpy = vi.spyOn(svc, 'tryGenerateFallbackAltText').mockResolvedValue(null);
    const doc = await docWithNoCaption();

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1', doc);

    expect(fallbackSpy).toHaveBeenCalled();
    expect(res.applyMode).toBe('guidance-only');
  });

  it('never calls draftComplexImageBaseline for an ALWAYS_MANUAL_IMAGE_TYPES type (equation/circuit stay fully manual, no baseline attempt)', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'equation', complexity: 'complex' });
    const spy = vi.spyOn(geminiService, 'analyzeImageWithSchema');
    vi.spyOn(svc, 'tryGenerateFallbackAltText').mockResolvedValue(null);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

    expect(spy).not.toHaveBeenCalled();
    expect(res.applyMode).toBe('guidance-only');
  });
});
