import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pdfComprehensiveParserService, PdfParseResult } from './pdf-comprehensive-parser.service';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { textExtractorService } from './text-extractor.service';
import { imageExtractorService } from './image-extractor.service';
import { structureAnalyzerService } from './structure-analyzer.service';
import { AppError } from '../../utils/app-error';
import fs from 'fs/promises';

// Mock dependencies
vi.mock('./pdf-parser.service');
vi.mock('./text-extractor.service');
vi.mock('./image-extractor.service');
vi.mock('./structure-analyzer.service');
vi.mock('fs/promises');

describe('PdfComprehensiveParserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parse', () => {
    it('should parse PDF file successfully', async () => {
      // Mock file stats
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 * 1024 } as any);

      // Mock parsedPDF
      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: '/test/file.pdf',
        fileSize: 1024 * 1024,
        structure: {
          pageCount: 2,
          pages: [
            { pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 },
            { pageNumber: 2, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 },
          ],
          metadata: {
            title: 'Test PDF',
            author: 'Test Author',
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: false,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);

      // Mock text extraction
      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [
          {
            pageNumber: 1,
            fullText: 'Page 1 text',
            blocks: [
              {
                text: 'Page 1 text',
                pageNumber: 1,
                lines: [
                  {
                    text: 'Page 1 text',
                    pageNumber: 1,
                    items: [
                      {
                        text: 'Page 1 text',
                        pageNumber: 1,
                        position: { x: 100, y: 100, width: 200, height: 20 },
                        font: { name: 'Arial', size: 12, isBold: false, isItalic: false },
                        transform: [],
                      },
                    ],
                    boundingBox: { x: 100, y: 100, width: 200, height: 20 },
                    isHeading: false,
                  },
                ],
                boundingBox: { x: 100, y: 100, width: 200, height: 20 },
                type: 'paragraph',
              },
            ],
          },
          {
            pageNumber: 2,
            fullText: 'Page 2 text',
            blocks: [],
          },
        ],
        fullText: 'Page 1 text Page 2 text',
        wordCount: 6,
      });

      // Mock image extraction
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([
        {
          id: 'img-1',
          pageNumber: 1,
          position: { x: 50, y: 50, width: 100, height: 100 },
          altText: 'Test image',
          hasAltText: true,
          actualText: undefined,
          width: 100,
          height: 100,
          data: Buffer.from(''),
        },
      ]);

      // Mock structure analysis
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [
          {
            id: 'h1',
            level: 1,
            text: 'Heading 1',
            pageNumber: 1,
            position: { x: 100, y: 50 },
            isFromTags: false,
            isProperlyNested: true,
          },
        ],
        hasProperHierarchy: true,
        hasH1: true,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });

      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);

      vi.mocked(pdfParserService.close).mockResolvedValue();

      // Execute
      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      // Assert
      expect(result).toBeDefined();
      expect(result.metadata.pageCount).toBe(2);
      expect(result.metadata.title).toBe('Test PDF');
      expect(result.metadata.isTagged).toBe(false);
      expect(result.isTagged).toBe(false);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].pageNumber).toBe(1);
      expect(result.pages[0].content).toHaveLength(1);
      expect(result.pages[0].images).toHaveLength(1);
      expect(result.pages[0].headings).toHaveLength(1);

      // Verify cleanup was called
      expect(pdfParserService.close).toHaveBeenCalled();
    });

    it('should throw error if file does not exist', async () => {
      vi.mocked(fs.stat).mockResolvedValue(null as any);

      await expect(pdfComprehensiveParserService.parse('/nonexistent.pdf')).rejects.toThrow();
    });

    it('should handle parse errors gracefully', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(pdfParserService.parse).mockRejectedValue(new Error('Parse failed'));

      await expect(pdfComprehensiveParserService.parse('/test/file.pdf')).rejects.toThrow('Parse failed');
    });
  });

  describe('parseBuffer', () => {
    it('should parse PDF from buffer successfully', async () => {
      const buffer = Buffer.from('fake pdf content');

      // Mock parsedPDF
      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: 'document.pdf',
        fileSize: buffer.length,
        structure: {
          pageCount: 1,
          pages: [
            { pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 },
          ],
          metadata: {
            title: 'Buffer PDF',
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: true,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parseBuffer).mockResolvedValue(mockParsedPdf as ParsedPDF);

      // Mock extractors
      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [{ pageNumber: 1, fullText: 'Text', blocks: [] }],
        fullText: 'Text',
        wordCount: 1,
      });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);
      vi.mocked(pdfParserService.close).mockResolvedValue();

      // Execute
      const result = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');

      // Assert
      expect(result).toBeDefined();
      expect(result.metadata.pageCount).toBe(1);
      expect(result.metadata.title).toBe('Buffer PDF');
      expect(result.isTagged).toBe(true);
      expect(result.pages).toHaveLength(1);
      expect(pdfParserService.parseBuffer).toHaveBeenCalledWith(buffer, 'test.pdf');
    });

    it('should use default filename if not provided', async () => {
      const buffer = Buffer.from('fake pdf');

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: 'document.pdf',
        fileSize: buffer.length,
        structure: {
          pageCount: 1,
          pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 }],
          metadata: {
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: false,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parseBuffer).mockResolvedValue(mockParsedPdf as ParsedPDF);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({ pages: [], fullText: '', wordCount: 0 });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);
      vi.mocked(pdfParserService.close).mockResolvedValue();

      await pdfComprehensiveParserService.parseBuffer(buffer);

      expect(pdfParserService.parseBuffer).toHaveBeenCalledWith(buffer, 'document.pdf');
    });
  });

  describe('metadata extraction', () => {
    it('should extract complete metadata', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: '/test/file.pdf',
        fileSize: 1024,
        structure: {
          pageCount: 5,
          pages: [],
          metadata: {
            title: 'Test Title',
            author: 'Test Author',
            creator: 'Test Creator',
            producer: 'Test Producer',
            subject: 'Test Subject',
            keywords: ['keyword1', 'keyword2'],
            creationDate: new Date('2024-01-01'),
            modificationDate: new Date('2024-01-02'),
            language: 'en-US',
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: true,
            isTagged: true,
            hasOutline: true,
            hasAcroForm: true,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({ pages: [], fullText: '', wordCount: 0 });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);
      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      expect(result.metadata).toMatchObject({
        title: 'Test Title',
        author: 'Test Author',
        creator: 'Test Creator',
        producer: 'Test Producer',
        subject: 'Test Subject',
        keywords: ['keyword1', 'keyword2'],
        language: 'en-US',
        pdfVersion: '1.7',
        pageCount: 5,
        isTagged: true,
        isLinearized: true,
        hasOutline: true,
        hasAcroForm: true,
        hasXFA: false,
        hasStructureTree: true,
      });
    });
  });

  describe('content extraction', () => {
    it('should extract text content with positions', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: '/test/file.pdf',
        fileSize: 1024,
        structure: {
          pageCount: 1,
          pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 }],
          metadata: {
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: false,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);

      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [
          {
            pageNumber: 1,
            fullText: 'Hello World',
            blocks: [
              {
                text: 'Hello World',
                pageNumber: 1,
                lines: [
                  {
                    text: 'Hello World',
                    pageNumber: 1,
                    items: [
                      {
                        text: 'Hello',
                        pageNumber: 1,
                        position: { x: 100, y: 100, width: 50, height: 12 },
                        font: { name: 'Helvetica', size: 12, isBold: false, isItalic: false },
                        transform: [],
                      },
                      {
                        text: 'World',
                        pageNumber: 1,
                        position: { x: 155, y: 100, width: 50, height: 12 },
                        font: { name: 'Helvetica', size: 12, isBold: false, isItalic: false },
                        transform: [],
                      },
                    ],
                    boundingBox: { x: 100, y: 100, width: 105, height: 12 },
                    isHeading: false,
                  },
                ],
                boundingBox: { x: 100, y: 100, width: 105, height: 12 },
                type: 'paragraph',
              },
            ],
          },
        ],
        fullText: 'Hello World',
        wordCount: 2,
      });

      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);
      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      expect(result.pages[0].content).toHaveLength(2);
      expect(result.pages[0].content[0]).toMatchObject({
        text: 'Hello',
        position: { x: 100, y: 100, width: 50, height: 12 },
        font: { name: 'Helvetica', size: 12 },
      });
      expect(result.pages[0].content[1]).toMatchObject({
        text: 'World',
        position: { x: 155, y: 100, width: 50, height: 12 },
      });
    });

    it('should extract images with alt text', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: '/test/file.pdf',
        fileSize: 1024,
        structure: {
          pageCount: 1,
          pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 }],
          metadata: {
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: false,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({ pages: [], fullText: '', wordCount: 0 });

      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([
        {
          id: 'img-1',
          pageNumber: 1,
          position: { x: 50, y: 50, width: 200, height: 150 },
          altText: 'A beautiful landscape',
          hasAltText: true,
          actualText: undefined,
          width: 200,
          height: 150,
          data: Buffer.from(''),
        },
        {
          id: 'img-2',
          pageNumber: 1,
          position: { x: 50, y: 250, width: 100, height: 100 },
          altText: undefined,
          hasAltText: false,
          actualText: undefined,
          width: 100,
          height: 100,
          data: Buffer.from(''),
        },
      ]);

      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([]);
      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      expect(result.pages[0].images).toHaveLength(2);
      expect(result.pages[0].images[0]).toMatchObject({
        id: 'img-1',
        altText: 'A beautiful landscape',
        hasAltText: true,
      });
      expect(result.pages[0].images[1]).toMatchObject({
        id: 'img-2',
        hasAltText: false,
      });
    });

    it('should extract links with destinations', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: '/test/file.pdf',
        fileSize: 1024,
        structure: {
          pageCount: 1,
          pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 }],
          metadata: {
            pdfVersion: '1.7',
            isEncrypted: false,
            isLinearized: false,
            isTagged: false,
            hasOutline: false,
            hasAcroForm: false,
            hasXFA: false,
          },
        },
        pdfLibDoc: {} as any,
        pdfjsDoc: {} as any,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({ pages: [], fullText: '', wordCount: 0 });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.analyzeHeadingHierarchy).mockResolvedValue({
        headings: [],
        hasProperHierarchy: true,
        hasH1: false,
        multipleH1: false,
        skippedLevels: [],
        issues: [],
      });
      vi.mocked(structureAnalyzerService.extractTables).mockResolvedValue([]);
      vi.mocked(structureAnalyzerService.extractLists).mockResolvedValue([]);

      vi.mocked(structureAnalyzerService.extractLinks).mockResolvedValue([
        {
          id: 'link-1',
          pageNumber: 1,
          text: 'Click here',
          url: 'https://example.com',
          position: { x: 100, y: 100, width: 100, height: 20 },
          hasDescriptiveText: true,
          issues: [],
        },
        {
          id: 'link-2',
          pageNumber: 1,
          text: 'Go to page 5',
          destination: 5,
          position: { x: 100, y: 150, width: 120, height: 20 },
          hasDescriptiveText: true,
          issues: [],
        },
      ]);

      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      expect(result.pages[0].links).toHaveLength(2);
      expect(result.pages[0].links[0]).toMatchObject({
        text: 'Click here',
        url: 'https://example.com',
        hasDescriptiveText: true,
      });
      expect(result.pages[0].links[1]).toMatchObject({
        text: 'Go to page 5',
        destination: 5,
        hasDescriptiveText: true,
      });
    });
  });
});
