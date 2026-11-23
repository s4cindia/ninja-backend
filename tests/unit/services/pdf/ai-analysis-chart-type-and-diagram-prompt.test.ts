/**
 * QC brief Theme B3 (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * (1) real bug fix -- MANUAL_IF_COMPLEX_IMAGE_TYPES used to check the
 * literal string 'chart', but classifyImageType's own schema only ever
 * returns 'bar-chart'/'line-chart'/'pie-chart' -- no chart has EVER
 * triggered manual review, on any document, regardless of complexity.
 * (2) a diagram/chart gets a structural vision prompt (axes, quadrants,
 * flow order, grid rows/columns) instead of the generic one, with a
 * raised 300-char cap, directly targeting the confirmed F-12/F-30/F-31
 * "flat label list" symptom.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';

// analyzeAltText/classifyImageType are private; exercise via cast, same
// pattern as ai-analysis-alttext-decorative.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const ISSUE: AuditIssue = {
  id: 'alt-1',
  source: 'pdf-alttext',
  severity: 'serious',
  code: 'MATTERHORN-13-001',
  message: 'Image has no alt text',
  pageNumber: 10,
  element: 'img_p10_0_Im0',
};

const IMAGE: ImageInfo = {
  id: 'img_p10_0_Im0',
  pageNumber: 10,
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

describe('MANUAL_IF_COMPLEX_IMAGE_TYPES chart matching', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['bar-chart', 'line-chart', 'pie-chart'])(
    'routes a complex %s to manual review (the real bug: this never happened before this fix)',
    async (type) => {
      vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type, complexity: 'complex' });
      // QC brief Theme B3's short-alt baseline (draftComplexImageBaseline)
      // tries a real vision call before this guidance-only fallback -- a
      // generic-sounding draft here declines, so the test still exercises
      // the fallback path this assertion cares about.
      vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({
        data: { shortAlt: 'a chart', confidence: 0.4, rationale: 'r' },
        usage: { promptTokens: 1, completionTokens: 1 },
      } as never);
      vi.spyOn(aiAnalysisService as never, 'tryGenerateFallbackAltText' as never).mockResolvedValue(null as never);

      const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

      expect(res.requiresManualReview).toBe(true);
      expect(res.rationale).toContain(type);
    }
  );

  it('does NOT route a simple chart to manual review -- only complex ones', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'bar-chart', complexity: 'simple' });
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isDecorative":false,"altText":"Bar chart","confidence":0.9,"rationale":"r"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

    expect(res.requiresManualReview).toBeUndefined();
  });
});

describe('diagram/chart structural vision prompt', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the structural prompt (axes/quadrants/flow/grid, 300-char cap) for a simple diagram', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'simple' });
    const spy = vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isDecorative":false,"altText":"A quadrant diagram","confidence":0.9,"rationale":"r"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    } as never);

    await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

    const promptArg = spy.mock.calls[0][2] as string;
    expect(promptArg).toContain('axes');
    expect(promptArg).toContain('quadrant');
    expect(promptArg).toContain('max 300 characters');
  });

  it('uses the generic prompt (max 125 characters) for a plain photo', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'photo', complexity: 'simple' });
    const spy = vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isDecorative":false,"altText":"A red apple","confidence":0.9,"rationale":"r"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    } as never);

    await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

    const promptArg = spy.mock.calls[0][2] as string;
    expect(promptArg).toContain('max 125 characters');
    expect(promptArg).not.toContain('quadrant');
  });

  it('accepts a structural alt text longer than 125 but within 300 characters for a diagram', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({ type: 'diagram', complexity: 'simple' });
    const longAlt = 'A quadrant diagram with X axis labeled Cost and Y axis labeled Value, '.repeat(2).slice(0, 220).trim();
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: JSON.stringify({ isDecorative: false, altText: longAlt, confidence: 0.9, rationale: 'r' }),
      usage: { promptTokens: 1, completionTokens: 1 },
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf', 'job-1', 'tenant-1');

    expect(res.value).toBe(longAlt);
  });
});
