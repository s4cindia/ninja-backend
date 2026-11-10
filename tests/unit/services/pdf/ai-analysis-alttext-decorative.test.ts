import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import { GeminiBlockedResponseError } from '../../../../src/services/ai/gemini-errors';
import { photoAltGenerator } from '../../../../src/services/alt-text/photo-alt-generator.service';
import * as prhConfigService from '../../../../src/services/prh/prh-config.service';
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

  // Was a regression test for parseAiJson's lack of runtime validation
  // (a non-boolean isDecorative would otherwise be truthy and wrongly clear
  // real alt text once this path could reach apply-to-pdf). Now that
  // analyzeAltText validates against a real Zod schema (AltTextResult,
  // z.boolean() for isDecorative), a non-boolean value is rejected by the
  // schema itself -- exhausting generateWithSchema's retry-with-correction
  // loop (the mock returns the same malformed body every attempt) and
  // correctly declining to produce real alt text, rather than silently
  // coercing a malformed value into either branch. The generic-failure
  // branch below no longer returns null for this (see that test's own
  // comment) -- it now surfaces a guidance-only manual-review suggestion
  // instead of silently dropping the issue.
  it('rejects a malformed non-boolean isDecorative via schema validation, falling through to a guidance-only manual-review suggestion', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockResolvedValue({
      text: '{"isDecorative":"false","altText":"A red apple","confidence":0.9,"rationale":"Informative photo"}',
      usage: { promptTokens: 20, completionTokens: 10 },
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBe(0);
  });

  it('returns a guidance-only manual-review suggestion (not null) when Gemini blocks the alt-text request, preserving classification token usage', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({
      type: 'photo',
      complexity: 'simple',
      usage: { promptTokens: 15, completionTokens: 5 },
    });
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
    expect(res.usage).toEqual({ promptTokens: 15, completionTokens: 5 });
  });

  // Previously returned null here, silently dropping the issue entirely --
  // no AiAnalysis row at all, indistinguishable from "no suggestion
  // needed". Now surfaces a guidance-only manual-review suggestion instead,
  // same as the classification-needs-manual and Gemini-blocked branches
  // above, so the issue is never silently lost.
  it('returns a guidance-only manual-review suggestion (not null) when analyzeAltText hits a non-blocked, generic AI failure', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('network timeout'));

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).not.toBeNull();
    expect(res.suggestionType).toBe('alt-text');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.confidence).toBe(0);
    expect(res.rationale).toContain('network timeout');
  });
});

describe('analyzeAltText — fallback Alt-Text Generator integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attaches short + long AI-drafted alt text to a needs-manual-expert decline when the PRH gate allows it', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({
      type: 'equation',
      complexity: 'complex',
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    vi.spyOn(prhConfigService, 'assertAiAltTextAllowed').mockResolvedValue(undefined);
    vi.spyOn(photoAltGenerator, 'generateAltText').mockResolvedValue({
      imageId: '',
      shortAlt: 'Quadratic formula showing x equals...',
      extendedAlt: 'A multi-line derivation of the quadratic formula, starting from ax^2+bx+c=0.',
      confidence: 80,
      flags: [],
      aiModel: 'gemini-flash',
      generatedAt: new Date(),
    } as never);

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'guidance-only', 'job-1', 'tenant-1');
    expect(res.suggestionType).toBe('alt-text');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.requiresManualReview).toBe(true);
    expect(res.value).toBe('Quadratic formula showing x equals...');
    expect(res.extendedAlt).toBe('A multi-line derivation of the quadratic formula, starting from ax^2+bx+c=0.');
    expect(res.guidance).toContain('AI-drafted alt text below is a starting point only');
  });

  it('does not call the generator, and keeps the original guidance, when the PRH gate blocks the job', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({
      type: 'equation',
      complexity: 'complex',
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    vi.spyOn(prhConfigService, 'assertAiAltTextAllowed').mockRejectedValue(new prhConfigService.PrhAiDisabledError());
    const generatorSpy = vi.spyOn(photoAltGenerator, 'generateAltText');

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'guidance-only', 'job-1', 'tenant-1');
    expect(generatorSpy).not.toHaveBeenCalled();
    expect(res.value).toBeUndefined();
    expect(res.extendedAlt).toBeUndefined();
    expect(res.guidance).toBe('This equation requires a subject matter expert to write an accurate description.');
  });

  it('falls back to the original guidance (no crash) when the fallback generator itself throws', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({
      type: 'equation',
      complexity: 'complex',
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    vi.spyOn(prhConfigService, 'assertAiAltTextAllowed').mockResolvedValue(undefined);
    vi.spyOn(photoAltGenerator, 'generateAltText').mockRejectedValue(new Error('Gemini API unreachable'));

    const res = await svc.analyzeAltText(ISSUE, IMAGE, 'guidance-only', 'job-1', 'tenant-1');
    expect(res).not.toBeNull();
    expect(res.value).toBeUndefined();
    expect(res.guidance).toBe('This equation requires a subject matter expert to write an accurate description.');
  });
});

describe('analyzeAltTextImprovement — Gemini-blocked fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a guidance-only manual-review suggestion (not null) when Gemini blocks the improvement request, preserving classification token usage', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue({
      type: 'photo',
      complexity: 'simple',
      usage: { promptTokens: 15, completionTokens: 5 },
    });
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
    expect(res.usage).toEqual({ promptTokens: 15, completionTokens: 5 });
  });

  it('still returns null (unchanged) when analyzeAltTextImprovement hits a non-blocked, generic AI failure', async () => {
    vi.spyOn(svc, 'classifyImageType').mockResolvedValue(null);
    vi.spyOn(geminiService, 'analyzeImage').mockRejectedValue(new Error('network timeout'));

    const res = await svc.analyzeAltTextImprovement(ISSUE, IMAGE, 'apply-to-pdf');
    expect(res).toBeNull();
  });
});
