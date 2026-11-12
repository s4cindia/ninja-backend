/**
 * Regression coverage for the confirmed root cause of "alt text describes
 * completely unrelated content" / S4 Carlisle's "Duplicate figure tags and
 * alt text" defect (Karsaklian_189165_9781606497623.pdf). extractPageImages
 * used to loop the Resources/XObject dict once per resource NAME and do
 * `imagePlacements.find(p => p.xObjectName === xObjectName)` -- always the
 * FIRST matching placement, silently dropping every later occurrence of a
 * reused resource -- falling back to `imagePlacements[index]` whenever no
 * name match existed at all. That fallback indexed a content-stream
 * PAINT-ordered array using a Resources-dict ENUMERATION-ordered counter --
 * two unrelated orderings that desync as soon as any resource on the page
 * is reused or never painted, silently handing a completely unrelated
 * image's position (and, via ai-analysis.service.ts's own
 * fallbackToPageRender/issue.boundingBox, an unrelated crop) to the AI
 * alt-text generator.
 *
 * Fixed by resolving EVERY real on-page invocation of an XObject (not just
 * the first) into its own ImageInfo, with `index` now meaning "the Nth
 * occurrence of THIS xObjectName on this page" -- see ImageInfo's own doc
 * comment in image-extractor.service.ts.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

// 1×1 PNG (base64 → bytes without Buffer, which isn't in the test tsconfig scope)
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

describe('extractImages — reused XObject (same resource invoked more than once on one page)', () => {
  it('produces two independent, correctly-positioned ImageInfo entries, not one collapsed or cross-contaminated entry', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const img = await src.embedPng(PNG);
    page.drawImage(img, { x: 50, y: 400, width: 100, height: 80 }); // first (and, so far, only) placement
    const doc = await PDFDocument.load(await src.save());

    const firstContent = decodePageContent(doc, 1)!;
    const xobj = firstContent.match(/\/([\w.#+-]+)\s+Do\b/)?.[1]!;
    expect(xobj).toBeTruthy();

    // Manually append a SECOND invocation of the SAME XObject resource at
    // a different position/size -- drawImage always allocates a FRESH
    // resource name per call (confirmed empirically: even drawing the SAME
    // embedded PDFImage object twice gives two DIFFERENT names, not a
    // shared one), so a genuinely reused XObject (one Resources/XObject
    // entry, invoked via `Do` twice) has to be built this way instead.
    writePageContent(doc, 1, `${firstContent}\nq 60 0 0 40 250 100 cm /${xobj} Do Q\n`);

    const bytes = await doc.save();
    const parsedPdf = await pdfParserService.parseBuffer(Buffer.from(bytes));
    try {
      const result = await imageExtractorService.extractImages(parsedPdf, { minWidth: 1, minHeight: 1 });
      const images = result.pages.flatMap(p => p.images);
      expect(images.length).toBe(2);

      const first = images.find(i => i.index === 0);
      const second = images.find(i => i.index === 1);
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();

      // Both occurrences share the same underlying XObject name (the id's
      // own suffix after `img_p{page}_{index}_`) -- confirming this really
      // is the "same resource, two invocations" shape, not two different
      // resources.
      const nameOf = (id: string): string | undefined => id.match(/^img_p\d+_\d+_(.+)$/)?.[1];
      expect(nameOf(first!.id)).toBeTruthy();
      expect(nameOf(first!.id)).toBe(nameOf(second!.id));

      // Each entry carries its OWN real on-page position (top-left-origin:
      // viewport.height - f - height, where f is drawImage's own `y`) --
      // not the same position repeated, not swapped, not an unrelated
      // default/placeholder.
      expect(first!.position).toEqual({ x: 50, y: 120, width: 100, height: 80 });
      expect(second!.position).toEqual({ x: 250, y: 460, width: 60, height: 40 });
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });

  it('two DIFFERENT XObjects, each invoked once, still each resolve to their own correct position (no regression)', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    const imgA = await src.embedPng(PNG);
    const imgB = await src.embedPng(PNG); // distinct XObject despite identical bytes -- pdf-lib doesn't dedupe across separate embeds
    page.drawImage(imgA, { x: 20, y: 400, width: 50, height: 50 });
    page.drawImage(imgB, { x: 300, y: 50, width: 30, height: 30 });
    const doc = await PDFDocument.load(await src.save());

    const bytes = await doc.save();
    const parsedPdf = await pdfParserService.parseBuffer(Buffer.from(bytes));
    try {
      const result = await imageExtractorService.extractImages(parsedPdf, { minWidth: 1, minHeight: 1 });
      const images = result.pages.flatMap(p => p.images);
      expect(images.length).toBe(2);

      // Each is its OWN distinct name's occurrence 0 -- not a shared,
      // page-wide running counter.
      expect(images.every(i => i.index === 0)).toBe(true);

      const left = images.find(i => i.position.x < 150);
      const right = images.find(i => i.position.x >= 150);
      expect(left?.position).toEqual({ x: 20, y: 150, width: 50, height: 50 });
      expect(right?.position).toEqual({ x: 300, y: 520, width: 30, height: 30 });
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });
});
