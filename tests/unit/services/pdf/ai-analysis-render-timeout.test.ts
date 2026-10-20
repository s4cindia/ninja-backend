import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/**
 * Regression coverage for a real production incident (2026-10-19):
 * FMHE_PDF.pdf's AI analysis pass (11991 issues) stalled completely for 3+
 * hours with zero progress, zero errors, and zero log output. The
 * remediation-cycle lock's own heartbeat stayed alive throughout (so the
 * periodic orphan-reconciliation sweep never caught it), but the actual
 * Promise.all over pLimit(10) never advanced -- pdfjs-dist's page.render()
 * has no built-in timeout, and pageRenderCache (ai-analysis.service.ts)
 * caches the PROMISE itself, not just its resolved value, so every issue on
 * the same page awaits the IDENTICAL hung promise, silently occupying the
 * entire pLimit(10) concurrency budget forever.
 *
 * Exercises the real renderPageToBase64/renderRegionToBase64 methods (not
 * mocked away, unlike ai-analysis-figure-crop-render.test.ts's own coverage
 * of their CALLERS) against a fake pdfjsDoc whose page never resolves, to
 * confirm the new withRenderTimeout wrapper actually bounds them.
 */

// renderPageToBase64/renderRegionToBase64/withRenderTimeout are private;
// exercise via cast, same pattern as this suite's sibling render tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

function buildFakeParsedPdf(overrides: { getPage?: () => Promise<unknown> } = {}): ParsedPDF {
  return {
    pdfjsDoc: {
      getPage: overrides.getPage ?? (async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve() }),
      })),
    },
  } as unknown as ParsedPDF;
}

describe('AiAnalysisService render timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renderPageToBase64 resolves to null within its own timeout when pdfjsDoc.getPage() hangs forever, instead of hanging the whole pLimit(10) analysis pass indefinitely', async () => {
    const parsedPdf = buildFakeParsedPdf({ getPage: () => new Promise(() => {}) });

    const resultPromise = svc.renderPageToBase64(parsedPdf, 1);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toBeNull();
  });

  it('renderPageToBase64 resolves to null within its own timeout when page.render() itself hangs forever', async () => {
    const parsedPdf = buildFakeParsedPdf({
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: new Promise(() => {}) }),
      }),
    });

    const resultPromise = svc.renderPageToBase64(parsedPdf, 1);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toBeNull();
  });

  it('renderRegionToBase64 resolves to null within its own timeout when page.render() hangs forever (the formula-rendering path, not cached via pageRenderCache)', async () => {
    const parsedPdf = buildFakeParsedPdf({
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: new Promise(() => {}) }),
      }),
    });

    const resultPromise = svc.renderRegionToBase64(parsedPdf, 1, { x: 0, y: 0, width: 50, height: 50 });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toBeNull();
  });

  it('renderPageToBase64 resolves normally (well before the timeout) when rendering succeeds quickly', async () => {
    const parsedPdf = buildFakeParsedPdf();

    await expect(svc.renderPageToBase64(parsedPdf, 1)).resolves.toEqual(expect.any(String));
  });
});
