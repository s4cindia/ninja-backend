/**
 * QC brief Theme B1a (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * figureHasOverlaidContent -- two independent signals, tested in isolation
 * from resolveFigureForImage's own struct-tree resolution chain (which has
 * its own coverage elsewhere) via a spy, and from extractStructureTagsForPage
 * via a module mock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PDFDict, PDFDocument } from 'pdf-lib';

vi.mock('../../../../src/services/pdf/structure-tag-inventory.service', () => ({
  extractStructureTagsForPage: vi.fn(),
}));
vi.mock('../../../../src/services/pdf/pdf-content-stream-io', () => ({
  decodePageContent: vi.fn(),
}));

import { figureHasOverlaidContent, boundingBoxOverlapFraction } from '../../../../src/services/pdf/ai-analysis.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { extractStructureTagsForPage } from '../../../../src/services/pdf/structure-tag-inventory.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

const BBOX = { x: 100, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 };

describe('figureHasOverlaidContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns false outright when the issue has no boundingBox (declines rather than guesses)', () => {
    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', undefined)).toBe(false);
  });

  it('signal 1: returns true when the Figure\'s own subtree carries a readable text-show MCID (the BATNA-box shape)', () => {
    const figureDict = { get: () => undefined } as unknown as PDFDict;
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(figureDict);
    vi.spyOn(pdfStructureWriterService, 'collectLeafMcids').mockReturnValue([3]);
    vi.mocked(decodePageContent).mockReturnValue(`/Figure <</MCID 3 >>BDC\nBT\n(BATNA)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(true);
  });

  it('signal 1 absent: no readable text in the Figure\'s own subtree -- falls through to signal 2', () => {
    const figureDict = {} as PDFDict;
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(figureDict);
    vi.spyOn(pdfStructureWriterService, 'collectLeafMcids').mockReturnValue([3]);
    vi.mocked(decodePageContent).mockReturnValue(`/Figure <</MCID 3 >>BDC\nq\n/Im0 Do\nQ\nEMC\n`);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(false);
  });

  it('signal 2: returns true when a non-Figure, non-Caption sibling substantially overlaps the Figure\'s own bbox', () => {
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(null);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Span', pageNumber: 1, bbox: { x: 110, y: 510, width: 80, height: 40, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(true);
  });

  it('signal 2 excludes a Caption sibling, even when it substantially overlaps', () => {
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(null);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Caption', pageNumber: 1, bbox: { x: 110, y: 510, width: 80, height: 40, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(false);
  });

  it('signal 2 excludes a merely edge-touching sibling (small overlap fraction, e.g. abutting body text)', () => {
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(null);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      // Touches the Figure's right edge by only 2pt -- a tiny overlap fraction.
      { elementId: '5-0', tag: 'P', pageNumber: 1, bbox: { x: 198, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(false);
  });

  it('signal 2 excludes another Figure sibling (the deferred duplicate-tile case, not this fix\'s concern)', () => {
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(null);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Figure', pageNumber: 1, bbox: { x: 100, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(false);
  });

  it('returns false when neither signal fires', () => {
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(null);
    vi.mocked(extractStructureTagsForPage).mockReturnValue([]);

    expect(figureHasOverlaidContent({} as PDFDocument, 1, 'img_p1_0_Im0', BBOX)).toBe(false);
  });
});

describe('boundingBoxOverlapFraction', () => {
  it('treats a zero-area single-point anchor box (the normal shape for ordinary single-line text) sitting inside the other box as full containment (1), not an undefined/forced-zero ratio over zero area', () => {
    const point = { x: 150, y: 520, width: 0, height: 0 };
    expect(boundingBoxOverlapFraction(point, BBOX)).toBe(1);
    expect(boundingBoxOverlapFraction(BBOX, point)).toBe(1);
  });

  it('returns 0 for a zero-area point OUTSIDE the other box', () => {
    const point = { x: 900, y: 900, width: 0, height: 0 };
    expect(boundingBoxOverlapFraction(point, BBOX)).toBe(0);
  });

  it('still computes a genuine fraction for two real (non-zero-area) boxes', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 5, y: 0, width: 10, height: 10 }; // half of a's area overlaps
    expect(boundingBoxOverlapFraction(a, b)).toBeCloseTo(0.5);
  });
});
