/**
 * Tests for PDF Alt Text Validator
 *
 * Tests validation of alternative text for images in PDF documents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pdfAltTextValidator } from '../../../../src/services/pdf/validators/pdf-alttext.validator';
import { imageExtractorService, DocumentImages, ImageInfo } from '../../../../src/services/pdf/image-extractor.service';
import { pdfParserService, ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';

// Mock dependencies
vi.mock('../../../../src/services/pdf/image-extractor.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');
vi.mock('../../../../src/services/ai/gemini.service');

describe('PDFAltTextValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateFromFile', () => {
    it('should validate a PDF with all images having good alt text', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'A detailed chart showing sales growth over time', false),
        createMockImage(1, 1, 'Company logo', false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.issues).toHaveLength(0);
      expect(result.metadata.totalImages).toBe(2);
      expect(result.metadata.imagesWithAltText).toBe(2);
      expect(result.metadata.imagesWithoutAltText).toBe(0);
    });

    it('should identify critical issue for image with no alt text', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, false), // No alt text
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.summary.critical).toBe(1);

      const noAltTextIssue = result.issues.find(i => i.code === 'MATTERHORN-13-002');
      expect(noAltTextIssue).toBeDefined();
      expect(noAltTextIssue?.severity).toBe('critical');
      expect(noAltTextIssue?.message).toContain('no alternative text');
      expect(noAltTextIssue?.wcagCriteria).toContain('1.1.1');
    });

    it('should identify serious issue for generic alt text', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'image', false), // Generic alt text
        createMockImage(2, 0, 'photo', false), // Generic alt text
        createMockImage(3, 0, 'figure', false), // Generic alt text
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.serious).toBe(3);

      const genericIssues = result.issues.filter(i => i.code === 'MATTERHORN-13-003');
      expect(genericIssues).toHaveLength(3);
      expect(genericIssues[0].message).toContain('generic alt text');
    });

    it('should skip decorative images', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, true), // Decorative, no alt text - should be skipped
        createMockImage(1, 1, 'Important chart', false), // Not decorative
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      // Should only check the non-decorative image
      expect(result.issues).toHaveLength(0);
      expect(result.metadata.decorativeImages).toBe(1);
    });

    it('should identify moderate issue for alt text that is too short', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'ab', false), // Too short (less than 3 chars)
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.moderate).toBe(1);

      const qualityIssue = result.issues.find(i => i.code === 'ALT-TEXT-QUALITY');
      expect(qualityIssue).toBeDefined();
      expect(qualityIssue?.message).toContain('too short');
    });

    it('should identify moderate issue for alt text that is too long', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const longAltText = 'A'.repeat(151); // Over 150 characters
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, longAltText, false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.moderate).toBe(1);

      const qualityIssue = result.issues.find(i => i.code === 'ALT-TEXT-QUALITY');
      expect(qualityIssue).toBeDefined();
      expect(qualityIssue?.message).toContain('too long');
    });

    it('should identify minor issue for redundant prefix', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'image of a sunset over mountains', false),
        createMockImage(2, 0, 'picture of a dog playing', false),
        createMockImage(3, 0, 'photo of the team', false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.minor).toBe(3);

      const prefixIssues = result.issues.filter(i => i.code === 'ALT-TEXT-REDUNDANT-PREFIX');
      expect(prefixIssues).toHaveLength(3);
      expect(prefixIssues[0].message).toContain('redundant prefix');
    });
  });

  describe('AI integration', () => {
    it('should use AI to generate alt text suggestions for images without alt text', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImageWithBase64(1, 0, undefined, false, 'base64data', 'image/jpeg'),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);
      vi.mocked(geminiService.analyzeImage).mockResolvedValue({
        text: 'A colorful bar chart showing quarterly revenue growth',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      });

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', true);

      expect(geminiService.analyzeImage).toHaveBeenCalled();
      expect(result.issues[0].suggestion).toContain('AI suggestion');
      expect(result.issues[0].suggestion).toContain('bar chart');
    });

    it('should use AI to assess alt text quality', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImageWithBase64(1, 0, 'A chart', false, 'base64data', 'image/jpeg'),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);
      vi.mocked(geminiService.analyzeImage).mockResolvedValue({
        text: JSON.stringify({
          matchesContent: false,
          suggestedAltText: 'Bar chart showing quarterly revenue growth from Q1 to Q4 2024',
        }),
        usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 },
      });

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', true);

      expect(geminiService.analyzeImage).toHaveBeenCalled();
      expect(result.summary.moderate).toBeGreaterThan(0);

      const qualityIssue = result.issues.find(i => i.code === 'ALT-TEXT-QUALITY');
      expect(qualityIssue).toBeDefined();
      expect(qualityIssue?.suggestion).toContain('quarterly revenue growth');
    });

    it('should handle AI service failures gracefully', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const longAltText = 'This is a very long alt text that exceeds the recommended maximum length of 125 characters and should be flagged as a quality issue even without AI analysis';
      const mockDocImages = createMockDocumentImages([
        createMockImageWithBase64(1, 0, longAltText, false, 'base64data', 'image/jpeg'),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);
      vi.mocked(geminiService.analyzeImage).mockRejectedValue(new Error('API error'));

      // Should not throw, but continue validation without AI
      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', true);

      expect(result).toBeDefined();
      // Should still identify quality issues without AI (length-based checks)
      expect(result.summary.moderate).toBeGreaterThan(0);
    });
  });

  describe('severity classification', () => {
    it('should classify no alt text as critical', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.critical).toBe(1);
      expect(result.issues[0].severity).toBe('critical');
    });

    it('should classify generic alt text as serious', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'image', false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.serious).toBe(1);
      expect(result.issues[0].severity).toBe('serious');
    });

    it('should classify quality issues as moderate', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'ab', false), // Too short
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.moderate).toBe(1);
      expect(result.issues[0].severity).toBe('moderate');
    });

    it('should classify redundant prefix as minor', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, 'image of a sunset', false),
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.minor).toBe(1);
      expect(result.issues[0].severity).toBe('minor');
    });
  });

  describe('WCAG and Matterhorn mapping', () => {
    it('should map all issues to WCAG 1.1.1', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, false), // No alt text
        createMockImage(2, 0, 'image', false), // Generic
        createMockImage(3, 0, 'ab', false), // Too short
        createMockImage(4, 0, 'image of a tree', false), // Redundant prefix
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      // All issues should have WCAG 1.1.1
      for (const issue of result.issues) {
        expect(issue.wcagCriteria).toContain('1.1.1');
      }
    });

    it('should use correct Matterhorn checkpoints', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, false), // MATTERHORN-13-002
        createMockImage(2, 0, 'image', false), // MATTERHORN-13-003
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      const noAltIssue = result.issues.find(i => i.code === 'MATTERHORN-13-002');
      expect(noAltIssue).toBeDefined();

      const genericIssue = result.issues.find(i => i.code === 'MATTERHORN-13-003');
      expect(genericIssue).toBeDefined();
    });
  });

  describe('summary calculation', () => {
    it('should correctly calculate issue summary', async () => {
      const mockParsedPdf = createMockParsedPdf();
      const mockDocImages = createMockDocumentImages([
        createMockImage(1, 0, undefined, false), // Critical
        createMockImage(2, 0, 'image', false), // Serious
        createMockImage(3, 0, 'ab', false), // Moderate
        createMockImage(4, 0, 'image of a tree', false), // Minor
      ]);

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue(mockDocImages);

      const result = await pdfAltTextValidator.validateFromFile('/path/to/test.pdf', false);

      expect(result.summary.critical).toBe(1);
      expect(result.summary.serious).toBe(1);
      expect(result.summary.moderate).toBe(1);
      expect(result.summary.minor).toBe(1);
      expect(result.summary.total).toBe(4);
    });
  });
});

// Helper functions to create mock data

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
    },
    pdfLibDoc: {} as ParsedPDF['pdfLibDoc'],
    pdfjsDoc: {} as ParsedPDF['pdfjsDoc'],
  };
}

function createMockImage(
  pageNumber: number,
  index: number,
  altText: string | undefined,
  isDecorative: boolean
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
  };
}

function createMockImageWithBase64(
  pageNumber: number,
  index: number,
  altText: string | undefined,
  isDecorative: boolean,
  base64: string,
  mimeType: string
): ImageInfo {
  return {
    ...createMockImage(pageNumber, index, altText, isDecorative),
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
