import { describe, it, expect } from 'vitest';
import { locateXObjectInvocation, findNearestMcidForPosition, findNearestMcidCandidatesForPosition } from '../../../../src/services/pdf/figure-content-tagger';
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

  it('bails (returns null) rather than guessing when the same XObject is invoked more than once and no occurrence is given', () => {
    const content = '/Im0 Do /Im0 Do';
    expect(locateXObjectInvocation(content, 'Im0')).toBeNull();
  });

  it('does not false-match a name that is a substring of another (e.g. Im0 vs Im01)', () => {
    const content = '/Im01 Do';
    expect(locateXObjectInvocation(content, 'Im0')).toBeNull();
  });

  /**
   * Regression for the confirmed root cause of "alt text describes
   * completely unrelated content" / S4 Carlisle's "Duplicate figure tags
   * and alt text" defect: a reused XObject resource (the same embedded
   * image invoked more than once on one page, at different positions -- a
   * normal, common authoring pattern) used to make this function bail
   * entirely, with no way for a caller to target a SPECIFIC invocation.
   * `occurrence` (0-based) disambiguates instead of bailing, matching
   * image-extractor.service.ts's own ImageInfo.index numbering.
   */
  it('with occurrence, disambiguates instead of bailing when the same XObject is invoked more than once', () => {
    const content = '/Im0 Do /Im0 Do /Im0 Do';
    const first = locateXObjectInvocation(content, 'Im0', 0);
    const second = locateXObjectInvocation(content, 'Im0', 1);
    const third = locateXObjectInvocation(content, 'Im0', 2);
    expect(first).toEqual({ start: 0, end: 7 });
    expect(second).toEqual({ start: 8, end: 15 });
    expect(third).toEqual({ start: 16, end: 23 });
    // Each occurrence's own range really does slice out "/Im0 Do" on its own.
    expect(content.slice(first!.start, first!.end)).toBe('/Im0 Do');
    expect(content.slice(second!.start, second!.end)).toBe('/Im0 Do');
    expect(content.slice(third!.start, third!.end)).toBe('/Im0 Do');
  });

  it('returns null (does not wrap around or clamp) when the requested occurrence does not exist', () => {
    const content = '/Im0 Do /Im0 Do';
    expect(locateXObjectInvocation(content, 'Im0', 2)).toBeNull();
  });

  it('occurrence 0 on a single invocation behaves exactly like the no-occurrence form (backward compatible)', () => {
    const content = 'q 1 0 0 1 10 10 cm /Im0 Do Q';
    expect(locateXObjectInvocation(content, 'Im0', 0)).toEqual(locateXObjectInvocation(content, 'Im0'));
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

describe('findNearestMcidCandidatesForPosition', () => {
  /**
   * Regression for a real investigation finding (Whiting/Zaidi jobs,
   * 2026-11-20): a single "nearest MCID" can itself be orphaned in the
   * structure tree even while a real, correctly-tagged element sits a
   * little farther away on the same page -- buildFigureFromImage needs
   * every nearby candidate, not just #1, to recover from that. This test
   * covers the plural function's own contract: two distinct tagged
   * paragraphs on one page, each its own MCID, returned sorted
   * nearest-first to the target, with no duplicates.
   */
  it('returns every distinct nearby MCID, nearest-first, not just the single closest one', async () => {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([400, 600]);
    srcPage.drawText('Close paragraph', { x: 50, y: 400, size: 14 });
    srcPage.drawText('Far paragraph', { x: 50, y: 50, size: 14 });
    const doc = await PDFDocument.load(await src.save());

    const zones: OrderableZone[] = [
      { pageNumber: 1, bbox: { x: 0, y: 150, w: 400, h: 150 }, zoneType: 'paragraph' },
      { pageNumber: 1, bbox: { x: 0, y: 500, w: 400, h: 100 }, zoneType: 'paragraph' },
    ];
    const built = buildStructTreeFromZones(doc, zones);
    expect(built.elements).toBeGreaterThan(0);

    const buffer = Buffer.from(await doc.save());
    const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-test-multi-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const parsedPdf = await pdfParserService.parse(tmpPath);
    try {
      // Target near "Close paragraph" (y=400, drawn text -> top-down y
      // ~ 600-400=200-ish once pdfjs flips it) -- closer to that one than
      // to "Far paragraph" (y=50 -> top-down ~550-ish).
      const candidates = await findNearestMcidCandidatesForPosition(parsedPdf, 1, { x: 50, y: 200 });
      expect(candidates.length).toBe(2);
      // Sorted nearest-first.
      expect(candidates[0].distance).toBeLessThanOrEqual(candidates[1].distance);
      // No duplicate MCIDs.
      expect(new Set(candidates.map(c => c.mcid)).size).toBe(2);
      // findNearestMcidForPosition (the single-result wrapper) must still
      // return exactly the first of these -- backward compatible contract.
      const single = await findNearestMcidForPosition(parsedPdf, 1, { x: 50, y: 200 });
      expect(single).toEqual(candidates[0]);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);

  it('returns [] when the page has no MCID-bound text content at all', async () => {
    const src = await PDFDocument.create();
    src.addPage([400, 600]);
    const doc = await PDFDocument.load(await src.save());

    const buffer = Buffer.from(await doc.save());
    const tmpPath = path.join(os.tmpdir(), `zzz-diag-figure-test-multi-empty-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buffer);
    const parsedPdf = await pdfParserService.parse(tmpPath);
    try {
      const candidates = await findNearestMcidCandidatesForPosition(parsedPdf, 1, { x: 50, y: 100 });
      expect(candidates).toEqual([]);
    } finally {
      await pdfParserService.close(parsedPdf);
      fs.unlinkSync(tmpPath);
    }
  }, 30_000);
});
