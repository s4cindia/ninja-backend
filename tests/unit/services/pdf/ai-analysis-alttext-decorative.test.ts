import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { GeminiBlockedResponseError } from '../../../../src/services/ai/gemini-errors';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';

// analyzeAltText is private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const ISSUE: AuditIssue = {
  id: 'alt-1',
  source: 'pdf-alttext',
  severity: 'serious',
  code: 'MATTERHORN-13-001',
  message: 'Image has no alt text',
  pageNumber: 150,
  element: 'img_p150_0_Im0',
};

const IMAGE: ImageInfo = {
  id: 'img_p150_0_Im0',
  pageNumber: 150,
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

describe('analyzeAltText — decorative branch applyMode', () => {
  afterEach(() => vi.restoreAllMocks());

  function decorativeResponse(confidence = 1.0) {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: `{"isDecorative":true,"confidence":${confidence},"rationale":"Purely ornamental divider graphic"}`,
      usage: { promptTokens: 20, completionTokens: 10 },
    } as never);
  }

  it('follows mode into apply-to-pdf, so the suggestion is applicable (not stuck as guidance-only)', async () => {
    decorativeResponse();
    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');

    expect(res.suggestionType).toBe('alt-text-decorative');
    expect(res.applyMode).toBe('apply-to-pdf');
    expect(res.value).toBeUndefined();
    expect(res.guidance).toContain('alt text will be cleared');
  });

  it('stays guidance-only when mode is guidance-only (untagged PDF)', async () => {
    decorativeResponse();
    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'guidance-only');

    expect(res.suggestionType).toBe('alt-text-decorative');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.guidance).toContain('set alt="" in the authoring tool');
  });

  it('still returns a real alt-text suggestion (unaffected) when the image is not decorative', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isDecorative":false,"altText":"A red apple","confidence":0.9,"rationale":"Informative photo"}',
      usage: { promptTokens: 20, completionTokens: 10 },
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res.suggestionType).toBe('alt-text');
    expect(res.value).toBe('A red apple');
    expect(res.applyMode).toBe('apply-to-pdf');
  });

  it('does not treat a malformed string "false" as decorative (regression: parseAiJson has no runtime validation)', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      // A non-boolean isDecorative would otherwise be truthy and wrongly
      // clear real alt text once this path can reach apply-to-pdf.
      text: '{"isDecorative":"false","altText":"A red apple","confidence":0.9,"rationale":"Informative photo"}',
      usage: { promptTokens: 20, completionTokens: 10 },
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res.suggestionType).toBe('alt-text');
    expect(res.value).toBe('A red apple');
  });

  it('returns a guidance-only manual-review suggestion (not null) when Gemini blocks the alt-text request', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(
      new GeminiBlockedResponseError('Candidate was blocked due to SAFETY', 'SAFETY')
    );

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBe(0);
    expect(res.guidance).toContain('safety filter');
    expect(res.rationale).toContain('SAFETY');
  });

  it('still returns null (unchanged) when analyzeAltText hits a non-blocked, generic AI failure', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('network timeout'));

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).toBeNull();
  });
});

describe('analyzeAltTextImprovement — Gemini-blocked fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a guidance-only manual-review suggestion (not null) when Gemini blocks the improvement request', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(
      new GeminiBlockedResponseError('Candidate was blocked due to SAFETY', 'SAFETY')
    );

    const res = await svc.analyzeAltTextImprovement(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text-improvement');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBe(0);
    expect(res.guidance).toContain('safety filter');
    expect(res.rationale).toContain('SAFETY');
  });

  it('still returns null (unchanged) when analyzeAltTextImprovement hits a non-blocked, generic AI failure', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('network timeout'));

    const res = await svc.analyzeAltTextImprovement(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).toBeNull();
  });
});
