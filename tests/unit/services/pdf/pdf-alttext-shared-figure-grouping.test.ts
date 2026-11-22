/**
 * Regression coverage for images sharing one real /Figure struct element
 * (figureGroupKey -- see ImageInfo's own doc comment). Confirmed real and
 * live on Whiting_186772_E9778: 18 Figures each shared by 2-40 images,
 * including one group where an unrelated stock photo (a runner) was swept
 * into the same marked-content span as a genuine anatomy diagram. Before
 * this fix, N images sharing one Figure raised N independent issues, each
 * running its own AI-vision call against its own distinct crop, and
 * applying more than one of their suggestions silently clobbered the
 * shared /Alt (setAltText resolves every one of those N ids to the
 * identical dict -- last write wins).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pdfAltTextValidator } from '../../../../src/services/pdf/validators/pdf-alttext.validator';
import { imageExtractorService, DocumentImages, ImageInfo } from '../../../../src/services/pdf/image-extractor.service';
import { pdfParserService, ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';

vi.mock('../../../../src/services/pdf/image-extractor.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');
vi.mock('../../../../src/services/ai/gemini.service');

describe('PDFAltTextValidator: shared-Figure grouping (figureGroupKey)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('raises exactly one issue for a group of images sharing a Figure, not one per image', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImage(1, 0, 'image', false, 1),
      createMockImage(1, 1, 'image', false, 1),
      createMockImage(1, 2, 'image', false, 1),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

    const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

    const genericIssues = result.issues.filter(i => i.code === 'MATTERHORN-13-004');
    expect(genericIssues).toHaveLength(1);
    expect(genericIssues[0].element).toBe('img_p1_0');
  });

  it('mentions the shared group size and sibling ids in the issue message/context', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImage(1, 0, 'image', false, 1),
      createMockImage(1, 1, 'image', false, 1),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

    const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

    const issue = result.issues.find(i => i.code === 'MATTERHORN-13-004');
    expect(issue?.message).toContain('shared');
    expect(issue?.message).toContain('img_p1_1');
  });

  it('does not merge images on the same page with different (or no) figureGroupKey', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImage(1, 0, 'image', false, 1),
      createMockImage(1, 1, 'image', false, 2),
      createMockImage(1, 2, 'image', false, undefined),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

    const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

    const genericIssues = result.issues.filter(i => i.code === 'MATTERHORN-13-004');
    expect(genericIssues).toHaveLength(3);
  });

  it('declines the AI quality-assessment vision check entirely for a shared group (no single crop can represent it)', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImageWithBase64(1, 0, 'A chart', false, 'base64-0', 'image/jpeg', 7),
      createMockImageWithBase64(1, 1, 'A chart', false, 'base64-1', 'image/jpeg', 7),
      createMockImageWithBase64(1, 2, 'A chart', false, 'base64-2', 'image/jpeg', 7),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);
    vi.mocked(geminiService.analyzeImageWithSchema).mockResolvedValue({
      data: { matchesContent: false, suggestedAltText: 'Something else entirely' },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      attempts: 1,
    });

    await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', true);

    expect(geminiService.analyzeImageWithSchema).toHaveBeenCalledTimes(0);
  });

  it('does not call AI classification for a missing-alt-text shared group (declines, manual review)', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImageWithBase64(1, 0, undefined, false, 'base64-0', 'image/jpeg', 9),
      createMockImageWithBase64(1, 1, undefined, false, 'base64-1', 'image/jpeg', 9),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);
    vi.mocked(geminiService.analyzeImageWithSchema).mockResolvedValue({
      data: { isDecorative: false, altText: 'A runner', confidence: 0.9 },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      attempts: 1,
    });

    const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', true);

    expect(geminiService.analyzeImageWithSchema).not.toHaveBeenCalled();
    const issue = result.issues.find(i => i.code === 'MATTERHORN-13-001');
    expect(issue?.triage).toBeUndefined();
    expect(issue?.suggestion).toContain('AI could not draft this automatically');
  });

  it('still raises an un-grouped issue normally when only one image resolves to a Figure (figureGroupKey set but unique)', async () => {
    const mockParsedPdf = createMockParsedPdf();
    const mockDocImages = createMockDocumentImages([
      createMockImage(1, 0, 'image', false, 42),
    ]);

    vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
    vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

    const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

    const issue = result.issues.find(i => i.code === 'MATTERHORN-13-004');
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain('shared');
  });
});

function createMockParsedPdf(): ParsedPDF {
  return {
    filePath: '/test/document.pdf',
    fileSize: 1024000,
    structure: {
      pageCount: 10,
      metadata: {
        isTagged: true,
        language: 'en',
        title: 'Test Document',
        suspect: false,
        hasAcroForm: false,
      },
      outline: [],
      pages: Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        width: 612,
        height: 792,
        tags: [],
        images: [],
        links: [],
        annotations: [],
      })),
    },
    pdfLibDoc: {} as ParsedPDF['pdfLibDoc'],
    pdfjsDoc: {} as ParsedPDF['pdfjsDoc'],
  } as ParsedPDF;
}

function createMockImage(
  pageNumber: number,
  index: number,
  altText: string | undefined,
  isDecorative: boolean,
  figureGroupKey?: number
): ImageInfo {
  return {
    id: `img_p${pageNumber}_${index}`,
    pageNumber,
    index,
    position: { x: 50, y: 100, width: 200, height: 150 },
    dimensions: { width: 200, height: 150 },
    format: 'jpeg',
    colorSpace: 'DeviceRGB',
    bitsPerComponent: 8,
    hasAlpha: false,
    fileSizeBytes: 12345,
    altText,
    isDecorative,
    mimeType: 'image/jpeg',
    figureGroupKey: figureGroupKey ?? null,
  };
}

function createMockImageWithBase64(
  pageNumber: number,
  index: number,
  altText: string | undefined,
  isDecorative: boolean,
  base64: string,
  mimeType: string,
  figureGroupKey?: number
): ImageInfo {
  return {
    ...createMockImage(pageNumber, index, altText, isDecorative, figureGroupKey),
    base64,
    mimeType,
  };
}

function createMockDocumentImages(images: ImageInfo[]): DocumentImages {
  const pageMap = new Map<number, ImageInfo[]>();

  for (const image of images) {
    if (!pageMap.has(image.pageNumber)) {
      pageMap.set(image.pageNumber, []);
    }
    pageMap.get(image.pageNumber)!.push(image);
  }

  const pages = Array.from(pageMap.entries()).map(([pageNumber, pageImages]) => ({
    pageNumber,
    images: pageImages,
    totalImages: pageImages.length,
  }));

  const imagesWithAltText = images.filter(img => !img.isDecorative && img.altText).length;
  const imagesWithoutAltText = images.filter(img => !img.isDecorative && !img.altText).length;
  const decorativeImages = images.filter(img => img.isDecorative).length;

  return {
    pages,
    totalImages: images.length,
    imageFormats: { jpeg: images.length },
    imagesWithAltText,
    imagesWithoutAltText,
    decorativeImages,
  };
}
