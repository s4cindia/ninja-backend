import { describe, it, expect } from 'vitest';
import { locateXObjectInvocation, findNearestMcidForPosition } from '../../../../src/services/pdf/figure-content-tagger';
import { PDFDocument } from 'pdf-lib';
import { buildStructTreeFromZones } from '../../../../src/services/zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../../../../src/services/zone-extractor/seam-c/reading-order';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('locateXObjectInvocation', () => {
  it('finds the exact byte range of a single /Name Do invocation', () => {
    const content = 'q 1 0 0 1 10 10 cm /Im0 Do Q';
    const range = locateXObjectInvocation(content, 'Im0');
    expect(range).toBeTruthy();
    expect(content.slice(range!.start, range!.end)).toBe('/Im0 Do');
  });

  it('returns null when the XObject is never invoked', () => {
    const content = 'q 1 0 0 1 10 10 cm /Im1 Do Q';
    expect(locateXObjectInvocation(content, 'Im0')).toBeNull();
  });

  it('bails (returns null) rather than guessing when the same XObject is invoked more than once', () => {
    const content = '/Im0 Do /Im0 Do';
    expect(locateXObjectInvocation(content, 'Im0')).toBeNull();
  });

  it('does not false-match a name that is a substring of another (e.g. Im0 vs Im01)', () => {
    const content = '/Im01 Do';
    expect(locateXObjectInvocation(content, 'Im0')).toBeNull();
  });
});

describe('findNearestMcidForPosition', () => {
  it('finds the MCID of real tagged text nearest a target position, real PDF via buildStructTreeFromZones', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    srcPage.drawText('Nearby paragraph text', { x: 50, y: 500, size: 14 });
    const doc = await PDFDocument.load(await src.save());

    // Generous zone covering the drawn text region -- buildStructTreeFromZones
    // tags whatever falls within it as a real /P with a real MCID.
    const zones: OrderableZone[] = [
      { pageNumber: 1, bbox: { x: 0, y: 0, w: 400, h: 300 }, zoneType: 'paragraph' },
    ];
    const built = buildStructTreeFromZones(doc, zones);
    expect(built.elements).toBeGreaterThan(0);

    const buffer = Buffer.from(await doc.save());
    const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-test-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const parsedPdf = await pdfParserService.parse(tmpPath);
    try {
      const result = await findNearestMcidForPosition(parsedPdf, 1, { x: 50, y: 100 });
      expect(result).toBeTruthy();
      expect(result!.mcid).toBeGreaterThanOrEqual(0);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('returns null when the page has no MCID-bound text content at all', async () => {
    const src = await PDFDocument.create();
    src.addPage([400, 600]);
    const doc = await PDFDocument.load(await src.save());

    const buffer = Buffer.from(await doc.save());
    const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-test-empty-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const parsedPdf = await pdfParserService.parse(tmpPath);
    try {
      const result = await findNearestMcidForPosition(parsedPdf, 1, { x: 50, y: 100 });
      expect(result).toBeNull();
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);
});
