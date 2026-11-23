/**
 * QC brief Theme B1a (docs/qc/2026-11-23-ninja-qc-karsaklian-brief.md):
 * figureHasOverlaidContent -- two independent signals, both sourced from
 * extractStructureTagsForPage's own page-level struct-tag inventory (a
 * module mock here).
 *
 * Signal 1 finds the Figure struct element by matching ITS OWN bbox
 * against that inventory, NOT via pdfModifierService.resolveFigureForImage
 * -- confirmed via direct pre-merge verification against the real
 * Karsaklian file that resolveFigureForImage's own matching returns null
 * for Fig 5.2 itself (the brief's own named motivating example, F-09/F-30):
 * its single bare MCID wraps the image's Do call AND unrelated text
 * together, a shape that resolver doesn't handle. The bbox match needs
 * nothing from that resolver.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

vi.mock('../../../../src/services/pdf/structure-tag-inventory.service', () => ({
  extractStructureTagsForPage: vi.fn(),
  resolveElementRef: vi.fn(),
}));
vi.mock('../../../../src/services/pdf/pdf-content-stream-io', () => ({
  decodePageContent: vi.fn(),
}));

import { figureHasOverlaidContent, boundingBoxOverlapFraction } from '../../../../src/services/pdf/ai-analysis.service';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { extractStructureTagsForPage, resolveElementRef } from '../../../../src/services/pdf/structure-tag-inventory.service';
import { decodePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

const BBOX = { x: 100, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 };
const FAKE_REF = { toString: () => '5-0' };

// A real pdf-lib document, so `dict instanceof PDFDict` (figureHasOverlaidContent's
// own guard after resolveElementRef) is genuinely satisfied -- a plain mock
// object can't fake that instanceof check.
let realDoc: PDFDocument;
beforeAll(async () => {
  realDoc = await PDFDocument.create();
  realDoc.context.lookup = () => realDoc.context.obj({ S: PDFName.of('Figure') });
});

describe('figureHasOverlaidContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns false outright when the issue has no boundingBox (declines rather than guesses)', () => {
    expect(figureHasOverlaidContent(realDoc, 1, undefined)).toBe(false);
  });

  it('signal 1: returns true when the Figure\'s own subtree (found by bbox match, not resolveFigureForImage) carries a readable text-show MCID (the real Fig 5.2 / BATNA-box shape)', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Figure', pageNumber: 1, bbox: BBOX },
    ]);
    vi.mocked(resolveElementRef).mockReturnValue(FAKE_REF as never);
    vi.spyOn(pdfStructureWriterService, 'collectLeafMcids').mockReturnValue([3]);
    vi.mocked(decodePageContent).mockReturnValue(`/Figure <</MCID 3 >>BDC\nBT\n(BATNA)Tj\nET\nq\n/Im0 Do\nQ\nEMC\n`);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(true);
  });

  it('signal 1 absent: the Figure found by bbox match has no readable text in its own subtree -- falls through to signal 2', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Figure', pageNumber: 1, bbox: BBOX },
    ]);
    vi.mocked(resolveElementRef).mockReturnValue(FAKE_REF as never);
    vi.spyOn(pdfStructureWriterService, 'collectLeafMcids').mockReturnValue([3]);
    vi.mocked(decodePageContent).mockReturnValue(`/Figure <</MCID 3 >>BDC\nq\n/Im0 Do\nQ\nEMC\n`);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
  });

  it('signal 1 absent: no Figure on the page matches this bbox closely enough -- falls through to signal 2', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      // A DIFFERENT Figure elsewhere on the page -- not a close bbox match.
      { elementId: '9-0', tag: 'Figure', pageNumber: 1, bbox: { x: 400, y: 100, width: 50, height: 50, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
  });

  it('signal 2: returns true when a non-Figure, non-Caption sibling substantially overlaps the Figure\'s own bbox', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Span', pageNumber: 1, bbox: { x: 110, y: 510, width: 80, height: 40, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(true);
  });

  it('signal 2 excludes a Caption sibling, even when it substantially overlaps', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Caption', pageNumber: 1, bbox: { x: 110, y: 510, width: 80, height: 40, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
  });

  it('signal 2 excludes a merely edge-touching sibling (small overlap fraction, e.g. abutting body text)', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      // Touches the Figure's right edge by only 2pt -- a tiny overlap fraction.
      { elementId: '5-0', tag: 'P', pageNumber: 1, bbox: { x: 198, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
  });

  it('signal 2 excludes another Figure sibling (the deferred duplicate-tile case, not this fix\'s concern)', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([
      { elementId: '5-0', tag: 'Figure', pageNumber: 1, bbox: { x: 100, y: 500, width: 100, height: 60, pageWidth: 612, pageHeight: 792 } },
    ]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
  });

  it('returns false when neither signal fires', () => {
    vi.mocked(extractStructureTagsForPage).mockReturnValue([]);

    expect(figureHasOverlaidContent(realDoc, 1, BBOX)).toBe(false);
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
