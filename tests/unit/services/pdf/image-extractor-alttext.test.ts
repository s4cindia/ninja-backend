import { describe, it, expect } from 'vitest';
import { PDFContext, PDFDict, PDFName, PDFString, PDFDocument, PDFArray, PDFRef } from 'pdf-lib';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';

// 1×1 PNG (base64 → bytes without Buffer, which isn't in the test tsconfig scope)
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

// extractFigureInfo is private; exercise via cast with real pdf-lib primitives
// (no full PDFDocument needed — extractFigureInfo only reads dict entries).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = imageExtractorService as any;

function figureDict(entries: Record<string, PDFString>): PDFDict {
  const context = PDFContext.create();
  const dict = PDFDict.withContext(context);
  for (const [key, value] of Object.entries(entries)) {
    dict.set(PDFName.of(key), value);
  }
  return dict;
}

describe('extractFigureInfo — Alt vs ActualText precedence', () => {
  it('preserves an explicit empty /Alt even when /ActualText is non-empty (regression)', () => {
    // A Figure with both an empty /Alt (the decorative marker) and a stale/redundant
    // non-empty /ActualText must keep altText === '', not have it overwritten by
    // ActualText — otherwise the decorative marker silently disappears on re-extraction.
    const node = figureDict({
      Alt: PDFString.of(''),
      ActualText: PDFString.of('A red apple'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('');
  });

  it('falls back to /ActualText when /Alt is absent entirely', () => {
    const node = figureDict({
      ActualText: PDFString.of('A red apple'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('A red apple');
  });

  it('uses /Alt as-is when both are present and non-empty', () => {
    const node = figureDict({
      Alt: PDFString.of('Alt text wins'),
      ActualText: PDFString.of('Actual text loses'),
    });

    const info = svc.extractFigureInfo(node, {} as ParsedPDF, null);
    expect(info.altText).toBe('Alt text wins');
  });
});

describe('extractImages — Figure/image correlation (regression: no cross-image alt-text bleed)', () => {
  /**
   * Regression for the bug fixed by resolveFigureForImage: the OLD
   * correlation (xObjectName forward-match, falling back to the Nth
   * "unmatched" Figure in whole-document struct-tree traversal order) never
   * matches an MCID-bound Figure at all (the bare-PDFNumber /K case --
   * resolveXObjectFromK explicitly gave up on it), so EVERY MCID-bound
   * Figure fell into the positional fallback pool regardless of which image
   * it actually describes. Here, only imgB has a real Figure (with real alt
   * text); imgA is genuinely untagged. Under the old code, imgA (looped
   * first) would incorrectly borrow imgB's alt text from the fallback pool,
   * while imgB (looped second, pool already exhausted) would end up
   * appearing to have none -- both directions of the same misattribution.
   */
  it('does not borrow an unrelated Figure\'s alt text for a genuinely untagged image', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    const imgA = await src.embedPng(PNG); // left, x=50 — stays untagged
    const imgB = await src.embedPng(PNG); // right, x=250 — gets the only real Figure
    srcPage.drawImage(imgA, { x: 50, y: 400, width: 100, height: 100 });
    srcPage.drawImage(imgB, { x: 250, y: 400, width: 100, height: 100 });
    const doc = await PDFDocument.load(await src.save());

    const zones: OrderableZone[] = [
      { pageNumber: 1, bbox: { x: 230, y: 100, w: 140, h: 120 }, zoneType: 'figure' },
    ];
    buildStructTreeFromZones(doc, zones);

    const root = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    const figures: PDFDict[] = [];
    const findFigures = (node: unknown): void => {
      if (!(node instanceof PDFDict)) return;
      if (node.get(PDFName.of('S'))?.toString() === '/Figure') figures.push(node);
      const k = node.get(PDFName.of('K'));
      const kids = k instanceof PDFArray ? k.asArray() : [k];
      for (const kid of kids) if (kid instanceof PDFRef) findFigures(doc.context.lookup(kid));
    };
    findFigures(root);
    expect(figures.length).toBe(1);
    figures[0].set(PDFName.of('Alt'), PDFString.of('A red apple on a table'));

    const bytes = await doc.save();
    const parsedPdf = await pdfParserService.parseBuffer(Buffer.from(bytes));
    try {
      const result = await imageExtractorService.extractImages(parsedPdf, { minWidth: 1, minHeight: 1 });
      const images = result.pages.flatMap(p => p.images);
      expect(images.length).toBe(2);

      const untagged = images.find(i => i.position.x < 150);
      const tagged = images.find(i => i.position.x >= 150);
      expect(untagged?.altText).toBeUndefined();
      expect(tagged?.altText).toBe('A red apple on a table');
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  });
});
