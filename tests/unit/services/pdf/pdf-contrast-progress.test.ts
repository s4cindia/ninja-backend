/**
 * Regression coverage for a real production incident (2026-10-19):
 * FMHE_PDF.pdf's 2040-page Color Contrast pass ran for 17+ minutes with no
 * progress signal to the caller at all -- the only progress report
 * available was per-VALIDATOR (before/after the entire per-page loop),
 * never per-page within it. pdf-audit.service.ts's own audit-wide staleness
 * timeout then killed the still-working job as a suspected hang (same class
 * of problem PdfAltTextValidator's own 2026-10-17 fix addressed for
 * image-heavy documents -- see pdf-alttext.validator.test.ts's "onProgress
 * callback" suite for the sibling coverage this mirrors).
 *
 * Exercises the PUBLIC validate() method (not the private
 * validatePageContrast -- see pdf-contrast-page-cleanup.test.ts for that)
 * against a fake pdfjsDoc whose getPage() always rejects. That's enough to
 * drive every page through validate()'s own per-page try/catch/finally
 * without needing to mock canvas rendering at all -- the progress-reporting
 * logic under test lives entirely in that finally block, before any real
 * rendering would happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

function buildFakeParsed(pageCount: number, options: { emptyContentPages?: number[] } = {}): {
  parsed: PdfParseResult;
  getPage: ReturnType<typeof vi.fn>;
} {
  const emptySet = new Set(options.emptyContentPages ?? []);
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    pageNumber: i + 1,
    // Non-empty unless this page is listed as deliberately empty -- content
    // length is all validate() itself inspects before calling getPage.
    content: emptySet.has(i + 1) ? [] : [{}],
  })) as unknown as PdfParseResult['pages'];

  const getPage = vi.fn().mockRejectedValue(new Error('no real pdfjs rendering in this test'));
  const parsed = {
    pages,
    parsedPdf: { pdfjsDoc: { getPage } },
  } as unknown as PdfParseResult;

  return { parsed, getPage };
}

describe('PdfContrastValidator -- onProgress callback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('always calls onProgress on the final page, even with zero elapsed time', async () => {
    const { parsed } = buildFakeParsed(2);
    const onProgress = vi.fn();

    await pdfContrastValidator.validate(parsed, onProgress);

    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('throttles intermediate pages to no calls when no wall-clock time passes, only the final page survives', async () => {
    const { parsed } = buildFakeParsed(4);
    const onProgress = vi.fn();

    await pdfContrastValidator.validate(parsed, onProgress);

    // No time advance between pages 1-3 -- if onProgress fired per-page
    // regardless of elapsed time, this would be 4 calls instead of 1.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(4, 4);
  });

  it('calls onProgress once the 30s throttle window elapses mid-run, independent of the final-page flush', async () => {
    const { parsed, getPage } = buildFakeParsed(3);
    // Simulate real wall-clock time passing while page 2 was being
    // processed, as a side effect of its own (rejected) getPage call.
    getPage
      .mockRejectedValueOnce(new Error('page 1'))
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(31_000);
        throw new Error('page 2');
      })
      .mockRejectedValueOnce(new Error('page 3'));
    const onProgress = vi.fn();

    await pdfContrastValidator.validate(parsed, onProgress);

    // One call once the throttle window elapses after page 2, plus the
    // guaranteed final-page call after page 3.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 2, 3);
    expect(onProgress).toHaveBeenNthCalledWith(2, 3, 3);
  });

  it('counts a page skipped for empty content toward completed, subject to the same throttle as any other page', async () => {
    const { parsed } = buildFakeParsed(2, { emptyContentPages: [1] });
    const onProgress = vi.fn();

    await pdfContrastValidator.validate(parsed, onProgress);

    // Page 1 (empty content) goes through maybeReportProgress too, but it's
    // not the last page and no wall-clock time has passed, so it's throttled
    // same as any other mid-run page -- only page 2's call survives.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('still calls onProgress with the final count when every page has empty content (CodeRabbit finding, PR #700)', async () => {
    // Without this, a document whose pages are ALL empty-content would never
    // call onProgress at all -- not even the guaranteed final call -- since
    // the empty-content branch used to skip maybeReportProgress() entirely,
    // reintroducing the exact hang-detection false positive this fix exists
    // to close.
    const { parsed } = buildFakeParsed(3, { emptyContentPages: [1, 2, 3] });
    const onProgress = vi.fn();

    await pdfContrastValidator.validate(parsed, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });

  it('is optional -- validate() still works with no onProgress argument', async () => {
    const { parsed } = buildFakeParsed(2);

    await expect(pdfContrastValidator.validate(parsed)).resolves.toEqual([]);
  });
});
