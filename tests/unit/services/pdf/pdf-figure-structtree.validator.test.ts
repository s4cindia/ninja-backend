/**
 * Regression coverage for pdf-figure-structtree.validator.ts: a direct
 * struct-tree walk for /Figure elements missing /Alt or /ActualText,
 * mirroring pdf-formula.validator.ts's own pattern for /Formula. Confirmed
 * live against a real 377-page document (Math_Weir_PDF via the real PAC/
 * axesPAC desktop tool): 513 total /Figure elements, 80 with an alternate,
 * 433 without -- an exact match to this validator's own count -- while
 * Ninja's existing image-XObject-based alt-text validator found only ~2,
 * because most of the 433 wrap no Do-invoked Image XObject at all (a bare
 * MCID reference to vector-drawn or marked-content-only glyphs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { pdfFigureStructTreeValidator } from '../../../../src/services/pdf/validators/pdf-figure-structtree.validator';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import type { ImageInfo } from '../../../../src/services/pdf/image-extractor.service';

vi.mock('../../../../src/services/pdf/image-extractor.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/services/pdf/image-extractor.service')>();
  return { ...actual, imageExtractorService: { extractImages: vi.fn() } };
});

function emptyImages() {
  return { pages: [], totalImages: 0, imageFormats: {}, imagesWithAltText: 0, imagesWithoutAltText: 0, decorativeImages: 0 };
}

function fakeImage(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    id: 'img_p1_0_Im0',
    pageNumber: 1,
    index: 0,
    position: { x: 0, y: 0, width: 50, height: 50 },
    dimensions: { width: 50, height: 50 },
    format: 'png',
    colorSpace: 'RGB',
    bitsPerComponent: 8,
    hasAlpha: false,
    fileSizeBytes: 0,
    mimeType: 'image/png',
    ...overrides,
  };
}

/** Registers a bare /Figure struct element directly in a real StructTreeRoot, with an optional /K MCID and Pg. */
function registerFigure(doc: PDFDocument, opts: { pageRef: PDFRef; mcid?: number; alt?: string }): PDFRef {
  const dict: Record<string, unknown> = { S: PDFName.of('Figure'), Pg: opts.pageRef };
  if (opts.mcid !== undefined) dict.K = opts.mcid;
  if (opts.alt !== undefined) dict.Alt = PDFString.of(opts.alt);
  return doc.context.register(doc.context.obj(dict));
}

async function buildTaggedDoc(figures: Array<{ mcid?: number; alt?: string }>): Promise<{ doc: PDFDocument; parsedPdf: ParsedPDF }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);

  const figureRefs = figures.map(f => registerFigure(doc, { pageRef: page.ref, ...f }));
  const docNode = doc.context.obj({ S: PDFName.of('Document'), K: figureRefs });
  const docRef = doc.context.register(docNode);
  const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
  const structTreeRootRef = doc.context.register(structTreeRoot);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
  return { doc, parsedPdf };
}

describe('PdfFigureStructTreeValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(emptyImages());
  });

  it('flags a /Figure with no /Alt and no /ActualText', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('MATTERHORN-13-001');
    expect(result.issues[0].matterhornCheckpoint).toBe('13-001');
    expect(result.issues[0].matterhornHow).toBe('M');
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('figure_p1_mc5');
    expect(result.metadata).toEqual({ totalFigures: 1, figuresWithAlternate: 0, figuresCoveredByImagePath: 0, figuresMissingAlternate: 1 });
  });

  it('does not flag a /Figure that already has /Alt', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 5, alt: 'A decision tree diagram' }]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.figuresWithAlternate).toBe(1);
  });

  it('falls back to a positional element id when the Figure has no MCID', async () => {
    const { parsedPdf } = await buildTaggedDoc([{}]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues[0].element).toBe('figure_p1_0');
  });

  it('reproduces the real Math_Weir_PDF.pdf shape: three bare-MCID Figures on one page, all missing alt text', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 531 }, { mcid: 547 }, { mcid: 554 }]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(3);
    expect(result.issues.map(i => i.element)).toEqual(['figure_p1_mc531', 'figure_p1_mc547', 'figure_p1_mc554']);
  });

  it('returns no issues when the document has no structure tree at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.totalFigures).toBe(0);
  });

  it('skips a Figure already covered by the image-extraction path, even though it has no Alt -- pdf-alttext.validator.ts already decides that case', async () => {
    const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }, { mcid: 9 }]);

    vi.mocked(imageExtractorService.extractImages).mockResolvedValue({
      ...emptyImages(),
      pages: [{ pageNumber: 1, totalImages: 1, images: [fakeImage({ id: 'img_p1_0_Im0' })] }],
    });

    // The image resolves to the FIRST Figure (mcid: 5) -- mirror
    // resolveFigureForImage's real contract by returning the actual dict
    // getAllFigureElements would hand back for it (reference equality,
    // exactly as the validator's own doc comment describes).
    const allFigures = pdfModifierService.getAllFigureElements(doc);
    const covered = allFigures.find(f => {
      const k = f.get(PDFName.of('K'));
      return k && 'asNumber' in k && (k as { asNumber(): number }).asNumber() === 5;
    });
    vi.spyOn(pdfModifierService, 'resolveFigureForImage').mockReturnValue(covered ?? null);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    // Only the SECOND figure (mcid: 9, not covered by any image) is flagged.
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].element).toBe('figure_p1_mc9');
    expect(result.metadata.figuresCoveredByImagePath).toBe(1);
  });

  it('degrades gracefully (flags everything) when computing image coverage throws', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
    vi.mocked(imageExtractorService.extractImages).mockRejectedValue(new Error('boom'));

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
  });
});
