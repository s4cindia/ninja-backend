/**
 * Regression coverage for a real production incident: Math_Weir_PDF.pdf (377
 * pages) OOM-killed the ECS task (exit 137, "OutOfMemoryError: container
 * killed due to memory usage") during PdfContrastValidator's per-page render
 * loop -- see maxContrastPages' doc comment in pdf.config.ts for the full
 * incident. Fixed primarily by bumping the ECS task's memory (an infra
 * change, not testable here), plus calling pdfjsPage.cleanup() after every
 * page to release pdfjs-dist's own internal per-page render caches instead
 * of leaving that entirely to GC timing.
 *
 * These tests exercise renderPageForContrast (Stage A of validate()'s
 * render/score split -- see that method's own header comment) directly
 * against a minimal fake pdfjsDoc/pdfjsPage (no real rendering) to prove the
 * cleanup contract: cleanup() fires after every page regardless of success
 * or failure, and a cleanup() failure itself is swallowed (best-effort)
 * rather than masking a real result or crashing the render worker in
 * validate().
 */
import { describe, it, expect, vi } from 'vitest';
import { pdfContrastValidator } from '../../../../src/services/pdf/validators/pdf-contrast.validator';
import type { PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

// renderPageForContrast is private; exercise via cast, same pattern used
// throughout this test suite for private helpers (see
// pdf-contrast-rotated-text.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validator = pdfContrastValidator as any;

function buildFakePage(overrides: Record<string, unknown> = {}) {
  return {
    getViewport: () => ({ width: 10, height: 10, transform: [1, 0, 0, -1, 0, 10] }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [], styles: {} }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const FAKE_PAGE_INFO = { pageNumber: 1 } as PdfParseResult['pages'][0];

describe('PdfContrastValidator -- per-page pdfjs cleanup', () => {
  it('calls pdfjsPage.cleanup() after successfully processing a page', async () => {
    const fakePage = buildFakePage();
    const fakeDoc = { getPage: vi.fn().mockResolvedValue(fakePage) };

    const rendered = await validator.renderPageForContrast(fakeDoc, FAKE_PAGE_INFO);

    // No text items on this fake page, so nothing for Stage B to score --
    // the real assertion here is the cleanup contract below.
    expect(rendered.textItems).toEqual([]);
    expect(fakePage.cleanup).toHaveBeenCalledTimes(1);
  });

  it('still calls pdfjsPage.cleanup() when page processing throws, and re-throws the real error', async () => {
    const fakePage = buildFakePage({
      getTextContent: async () => {
        throw new Error('pdfjs internal render failure');
      },
    });
    const fakeDoc = { getPage: vi.fn().mockResolvedValue(fakePage) };

    await expect(validator.renderPageForContrast(fakeDoc, FAKE_PAGE_INFO)).rejects.toThrow(
      'pdfjs internal render failure'
    );
    expect(fakePage.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not let a cleanup() failure mask a successful page result', async () => {
    const fakePage = buildFakePage({
      cleanup: vi.fn().mockRejectedValue(new Error('cleanup exploded')),
    });
    const fakeDoc = { getPage: vi.fn().mockResolvedValue(fakePage) };

    // Resolves normally (empty text items) -- the cleanup failure must not
    // propagate or replace this result.
    await expect(validator.renderPageForContrast(fakeDoc, FAKE_PAGE_INFO)).resolves.toMatchObject({
      textItems: [],
    });
  });

  it('does not let a cleanup() failure mask a real error from page processing either', async () => {
    const fakePage = buildFakePage({
      getTextContent: async () => {
        throw new Error('pdfjs internal render failure');
      },
      cleanup: vi.fn().mockRejectedValue(new Error('cleanup exploded')),
    });
    const fakeDoc = { getPage: vi.fn().mockResolvedValue(fakePage) };

    // The ORIGINAL error must win -- not the cleanup failure.
    await expect(validator.renderPageForContrast(fakeDoc, FAKE_PAGE_INFO)).rejects.toThrow(
      'pdfjs internal render failure'
    );
  });
});
