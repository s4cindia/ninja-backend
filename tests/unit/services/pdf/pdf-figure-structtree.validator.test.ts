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
import { PDFContentStream } from 'pdf-lib/cjs/core';
import { pdfFigureStructTreeValidator } from '../../../../src/services/pdf/validators/pdf-figure-structtree.validator';
import { imageExtractorService } from '../../../../src/services/pdf/image-extractor.service';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
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

  // CodeRabbit/Codex findings on this validator's first version, confirmed
  // real -- each test below reproduces the exact scenario and confirms it's
  // fixed.

  it('does not flag a Figure with an explicit empty /Alt -- the PDF/UA-compliant decorative marker, matching pdf-alttext.validator.ts\'s own image-path convention', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 5, alt: '' }]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(0);
    expect(result.metadata.figuresWithAlternate).toBe(1);
  });

  it('includes the element id in the issue message, so multiple Figures on the same page get distinct deduplication keys (base-audit.service.ts\'s deduplicateIssues keys on message)', async () => {
    const { parsedPdf } = await buildTaggedDoc([{ mcid: 531 }, { mcid: 547 }]);

    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(2);
    const messages = result.issues.map(i => i.message);
    expect(new Set(messages).size).toBe(2); // no two messages identical
    expect(messages[0]).toContain('figure_p1_mc531');
    expect(messages[1]).toContain('figure_p1_mc547');
  });

  it('recurses into an indirect /K reference that resolves to a PDFArray, not only a PDFDict (a real producer shape, including StructTreeRoot\'s own /K)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), Pg: page.ref, K: 5 }));
    // An indirect /K on the Document node pointing at an ARRAY, not a dict --
    // the exact shape the old `!(node instanceof PDFDict) return` bailed on.
    const kidsArrayRef = doc.context.register(doc.context.obj([figureRef]));
    const docNode = doc.context.obj({ S: PDFName.of('Document'), K: kidsArrayRef });
    const docRef = doc.context.register(docNode);
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.metadata.totalFigures).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].element).toBe('figure_p1_mc5');
  });

  it('resolves the MCID and page from an MCR dictionary (/Type /MCR /Pg ref /MCID n), not only a bare integer /K', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([612, 792]);
    const page2 = doc.addPage([612, 792]);

    // The Figure's own structural position has no /Pg -- its real content
    // lives on page2 via an MCR, which is what actually determines the page.
    const mcr = doc.context.obj({ Type: PDFName.of('MCR'), Pg: page2.ref, MCID: 42 });
    const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), K: mcr }));
    const docNode = doc.context.obj({ S: PDFName.of('Document'), Pg: page1.ref, K: [figureRef] });
    const docRef = doc.context.register(docNode);
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    // Page 2 (from the MCR's own /Pg), not page 1 (the ancestor Document's /Pg).
    expect(result.issues[0].pageNumber).toBe(2);
    expect(result.issues[0].element).toBe('figure_p2_mc42');
  });

  it('inherits the page from an ancestor when the Figure itself has no direct /Pg', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    // Figure has NO /Pg of its own -- must inherit from the Document ancestor.
    const figureRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), K: 7 }));
    const docNode = doc.context.obj({ S: PDFName.of('Document'), Pg: page.ref, K: [figureRef] });
    const docRef = doc.context.register(docNode);
    const structTreeRoot = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
    doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(structTreeRoot));

    const parsedPdf = { pdfLibDoc: doc } as unknown as ParsedPDF;
    const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].pageNumber).toBe(1);
    expect(result.issues[0].element).toBe('figure_p1_mc7');
  });

  describe('boundingBox attachment (mcid-bounding-box.ts)', () => {
    it('attaches a real, top-left-origin boundingBox when the Figure\'s MCID resolves to drawn geometry', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      // Device box: x 100-170, y 500-500 (a flat line). Page height 792 ->
      // top-left y = 792 - 500 = 292.
      expect(result.issues[0].boundingBox).toEqual({
        x: 100, y: 292, width: 70, height: 0, pageWidth: 612, pageHeight: 792,
      });
    });

    it('attaches independent boundingBoxes for multiple Figures on the same page', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 1 }, { mcid: 2 }]);
      writePageContent(
        doc, 1,
        '<</MCID 1>>BDC q 1 0 0 1 10 10 cm 0 0 m 5 0 l S Q EMC ' +
        '<</MCID 2>>BDC q 1 0 0 1 200 200 cm 0 0 m 5 0 l S Q EMC',
      );

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(2);
      const byElement = new Map(result.issues.map(i => [i.element, i.boundingBox]));
      expect(byElement.get('figure_p1_mc1')).toEqual({ x: 10, y: 782, width: 5, height: 0, pageWidth: 612, pageHeight: 792 });
      expect(byElement.get('figure_p1_mc2')).toEqual({ x: 200, y: 592, width: 5, height: 0, pageWidth: 612, pageHeight: 792 });
    });

    it('leaves boundingBox unset when the page has no content stream at all', async () => {
      const { parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].boundingBox).toBeUndefined();
    });

    it('leaves boundingBox unset when the MCID never appears in the page content (bail rather than guess)', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      writePageContent(doc, 1, '<</MCID 999>>BDC q 1 0 0 1 10 10 cm 0 0 m 5 0 l S Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].boundingBox).toBeUndefined();
    });

    // Real incident, Math_Nikitopoulos_PDF.pdf (2026-09-25): all 6 of this
    // document's real struct-tree-only Figures are `Do`-only spans invoking
    // Form XObjects with substantial real BBoxes (e.g. 404x268 points).
    // Before the resolveFormXObject fix, the unit-square fallback collapsed
    // every one to a ~1x1-point device-space box (device-space "1 unit" at
    // ~1:1 CTM scale, instead of the form's real few-hundred-point extent),
    // handing fallbackToPageRender's crop a near-blank sliver instead of the
    // actual diagram.
    it('REGRESSION: resolves a Do-invoked Form XObject\'s own /BBox, not a bare unit square', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      const page = doc.getPage(0);

      const formStream = doc.context.flateStream(new Uint8Array(0), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: doc.context.obj([0, 0, 200, 100]),
      });
      const formRef = doc.context.register(formStream);
      const resources = doc.context.obj({ XObject: doc.context.obj({ Fm1: formRef }) });
      page.node.set(PDFName.of('Resources'), resources);

      writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm /Fm1 Do Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      // Form's own BBox [0,0,200,100] at CTM translation (100,500): device
      // box x 100-300, y 500-600. Page height 792 -> top-left y = 792-600 = 192.
      expect(result.issues[0].boundingBox).toEqual({
        x: 100, y: 192, width: 200, height: 100, pageWidth: 612, pageHeight: 792,
      });
    });

    it('falls back to the unit-square approximation for a Do invoking a real Image XObject (not a Form)', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      const page = doc.getPage(0);

      const imageStream = doc.context.flateStream(new Uint8Array(0), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Image'),
        Width: 10,
        Height: 10,
      });
      const imageRef = doc.context.register(imageStream);
      const resources = doc.context.obj({ XObject: doc.context.obj({ Im0: imageRef }) });
      page.node.set(PDFName.of('Resources'), resources);

      writePageContent(doc, 1, '<</MCID 5>>BDC q 100 0 0 50 100 500 cm /Im0 Do Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      // Unit square [0,0]-[1,1] scaled by cm (100,50) then translated
      // (100,500): device box x 100-200, y 500-550. Page height 792 -> top
      // y = 792-550 = 242.
      expect(result.issues[0].boundingBox).toEqual({
        x: 100, y: 242, width: 100, height: 50, pageWidth: 612, pageHeight: 792,
      });
    });

    // CodeRabbit finding on this same PR, confirmed real: /BBox and /Matrix
    // are legal as INDIRECT arrays (`/BBox 5 0 R`), not just inline
    // (`/BBox [0 0 200 100]`) -- dict.get() alone returns the bare PDFRef,
    // which the array-shape check must resolve first or it silently falls
    // back to the unit square / identity matrix this fix exists to avoid.
    it('REGRESSION: resolves a Form XObject whose /BBox and /Matrix are themselves indirect references', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      const page = doc.getPage(0);

      const bboxRef = doc.context.register(doc.context.obj([0, 0, 200, 100]));
      const matrixRef = doc.context.register(doc.context.obj([1, 0, 0, 1, 0, 0]));
      const formStream = doc.context.flateStream(new Uint8Array(0), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: bboxRef,
        Matrix: matrixRef,
      });
      const formRef = doc.context.register(formStream);
      const resources = doc.context.obj({ XObject: doc.context.obj({ Fm1: formRef }) });
      page.node.set(PDFName.of('Resources'), resources);

      writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm /Fm1 Do Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].boundingBox).toEqual({
        x: 100, y: 192, width: 200, height: 100, pageWidth: 612, pageHeight: 792,
      });
    });

    // CodeRabbit finding on this same PR, confirmed real: a Form XObject
    // created via pdf-lib's own PDFContentStream.of (e.g. a prior
    // remediation round's own writer output, re-audited by this same
    // validator) is a PDFContentStream, not a PDFRawStream -- both are a
    // PDFStream, but the PDFRawStream-only version rejected the former,
    // falling back to the unit square exactly like an unresolvable form
    // would.
    it('REGRESSION: resolves a Form XObject backed by a PDFContentStream (e.g. authored via pdf-lib itself), not only a parsed PDFRawStream', async () => {
      const { doc, parsedPdf } = await buildTaggedDoc([{ mcid: 5 }]);
      const page = doc.getPage(0);

      const formDict = doc.context.obj({
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: doc.context.obj([0, 0, 200, 100]),
      });
      const formStream = PDFContentStream.of(formDict, []);
      const formRef = doc.context.register(formStream);
      const resources = doc.context.obj({ XObject: doc.context.obj({ Fm1: formRef }) });
      page.node.set(PDFName.of('Resources'), resources);

      writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm /Fm1 Do Q EMC');

      const result = await pdfFigureStructTreeValidator.validate(parsedPdf);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].boundingBox).toEqual({
        x: 100, y: 192, width: 200, height: 100, pageWidth: 612, pageHeight: 792,
      });
    });
  });
});
