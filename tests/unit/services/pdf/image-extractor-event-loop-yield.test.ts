/**
 * Real incident (2026-09-26): a 529-page/3843-image document's extraction
 * step (imageExtractorService.extractImages -> extractPageImages) ran the
 * per-image loop with no yield points -- decodeStreamBytes's
 * zlib.inflateSync plus reversePredictor's hand-written per-byte pixel loop
 * run entirely synchronously for every PNG/predictor-encoded image, one
 * after another. Enough of these back-to-back delayed Node's timer phase
 * long enough that BullMQ's own lock-renewal timer (which needs the event
 * loop free to fire) missed its window mid-extraction. BullMQ concluded the
 * (actually-alive, just busy) worker had died and silently restarted the
 * entire audit from scratch -- confirmed live via Job.input.validatorProgress
 * showing a second "Structure & Tags" entry with fresh timestamps, replacing
 * the first, partway through what should have been one continuous run.
 *
 * extractPageImages now awaits an explicit setImmediate-based yield after
 * every image it processes, guaranteeing the event loop gets a real chance
 * to run pending timers regardless of how expensive any single image's
 * decode turns out to be. These tests prove that yield actually happens,
 * once per processed image.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';

// 1×1 PNG (base64 → bytes without Buffer, which isn't in the test tsconfig scope)
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

describe('extractPageImages — event-loop yield between images', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('yields via setImmediate once per processed image, not zero times and not only once per page', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const imgA = await src.embedPng(PNG);
    const imgB = await src.embedPng(PNG);
    const imgC = await src.embedPng(PNG);
    page.drawImage(imgA, { x: 20, y: 400, width: 50, height: 50 });
    page.drawImage(imgB, { x: 150, y: 400, width: 50, height: 50 });
    page.drawImage(imgC, { x: 280, y: 400, width: 50, height: 50 });

    const bytes = await src.save();
    const parsedPdf = await pdfParserService.parseBuffer(Buffer.from(bytes));

    const realSetImmediate = global.setImmediate;
    const setImmediateSpy = vi.spyOn(global, 'setImmediate').mockImplementation(((cb: () => void) => {
      return realSetImmediate(cb);
    }) as unknown as typeof setImmediate);

    try {
      const result = await imageExtractorService.extractImages(parsedPdf, { minWidth: 1, minHeight: 1 });
      const images = result.pages.flatMap(p => p.images);
      expect(images.length).toBe(3);

      // One yield per image actually processed through the loop -- not a
      // single yield for the whole page, and not zero (the pre-fix behavior).
      expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('does not yield for images skipped by the early minWidth/minHeight filter', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const img = await src.embedPng(PNG);
    // Drawn size is irrelevant to the filter -- extractPageImages checks the
    // XObject's own dict Width/Height (the 1x1 PNG's real intrinsic size),
    // so a high minWidth/minHeight here skips it before any decode work.
    page.drawImage(img, { x: 20, y: 400, width: 50, height: 50 });

    const bytes = await src.save();
    const parsedPdf = await pdfParserService.parseBuffer(Buffer.from(bytes));

    const realSetImmediate = global.setImmediate;
    const setImmediateSpy = vi.spyOn(global, 'setImmediate').mockImplementation(((cb: () => void) => {
      return realSetImmediate(cb);
    }) as unknown as typeof setImmediate);

    try {
      const result = await imageExtractorService.extractImages(parsedPdf, { minWidth: 9999, minHeight: 9999 });
      const images = result.pages.flatMap(p => p.images);
      expect(images.length).toBe(0);
      expect(setImmediateSpy).not.toHaveBeenCalled();
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });
});
