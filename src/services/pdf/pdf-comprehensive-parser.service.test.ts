import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pdfComprehensiveParserService } from './pdf-comprehensive-parser.service';
import { pdfParserService, ParsedPDF } from './pdf-parser.service';
import { textExtractorService } from './text-extractor.service';
import { imageExtractorService } from './image-extractor.service';
import { structureAnalyzerService } from './structure-analyzer.service';
import fs from 'fs/promises';
import type { Stats } from 'fs';
import type { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 * 1024 } as Stats);

      // Mock parsed PDF
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
        pdfLibDoc: {} as unknown as PDFDocument,
        pdfjsDoc: {} as unknown as PDFDocumentProxy,
      };

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf as ParsedPDF);

      // Mock text extraction
      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            text: 'Page 1 text',
            items: [{
              text: 'Page 1 text',
              pageNumber: 1,
              position: { x: 100, y: 100, width: 200, height: 20 },
              font: { name: 'Arial', size: 12, isBold: false, isItalic: false },
              transform: [],
            }],
            lines: [{
              text: 'Page 1 text',
              pageNumber: 1,
              items: [{
                text: 'Page 1 text',
                pageNumber: 1,
                position: { x: 100, y: 100, width: 200, height: 20 },
                font: { name: 'Arial', size: 12, isBold: false, isItalic: false },
                transform: [],
              }],
              boundingBox: { x: 100, y: 100, width: 200, height: 20 },
              isHeading: false,
            }],
            blocks: [{
              text: 'Page 1 text',
              pageNumber: 1,
              lines: [{
                text: 'Page 1 text',
                pageNumber: 1,
                items: [{
                  text: 'Page 1 text',
                  pageNumber: 1,
                  position: { x: 100, y: 100, width: 200, height: 20 },
                  font: { name: 'Arial', size: 12, isBold: false, isItalic: false },
                  transform: [],
                }],
                boundingBox: { x: 100, y: 100, width: 200, height: 20 },
                isHeading: false,
              }],
              boundingBox: { x: 100, y: 100, width: 200, height: 20 },
              type: 'paragraph',
            }],
            wordCount: 3,
            characterCount: 11,
          },
          {
            pageNumber: 2,
            width: 612,
            height: 792,
            text: 'Page 2 text',
            items: [],
            lines: [],
            blocks: [],
            wordCount: 3,
            characterCount: 11,
          },
        ],
        fullText: 'Page 1 text Page 2 text',
        totalWords: 6,
        totalCharacters: 23,
        totalPages: 2,
        languages: ['en'],
        readingOrder: 'left-to-right',
      });

      // Mock image extraction
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue({
        pages: [{
          pageNumber: 1,
          totalImages: 1,
          images: [{
            id: 'img-1',
            pageNumber: 1,
            index: 0,
            position: { x: 50, y: 50, width: 100, height: 100 },
            dimensions: { width: 100, height: 100 },
            format: 'jpeg',
            colorSpace: 'DeviceRGB',
            bitsPerComponent: 8,
            hasAlpha: false,
            fileSizeBytes: 1024,
            altText: 'Test image',
            isDecorative: false,
            mimeType: 'image/jpeg',
          }],
        }],
        totalImages: 1,
        imageFormats: { jpeg: 1 },
        imagesWithAltText: 1,
        imagesWithoutAltText: 0,
        decorativeImages: 0,
      });

      // Mock structure analysis
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue({
        isTaggedPDF: false,
        headings: {
          headings: [{
            id: 'h1',
            level: 1,
            text: 'Heading 1',
            pageNumber: 1,
            position: { x: 100, y: 50 },
            isFromTags: false,
            isProperlyNested: true,
          }],
          hasProperHierarchy: true,
          hasH1: true,
          multipleH1: false,
          skippedLevels: [],
          issues: [],
        },
        tables: [],
        lists: [],
        links: [],
        readingOrder: { isLogical: true, hasStructureTree: false, issues: [], confidence: 0.5 },
        language: { hasDocumentLanguage: false, languageChanges: [], issues: [] },
        bookmarks: [],
        formFields: [],
        accessibilityScore: 75,
        summary: {
          totalHeadings: 1,
          totalTables: 0,
          totalLists: 0,
          totalLinks: 0,
          totalImages: 1,
          totalFormFields: 0,
          criticalIssues: 0,
          majorIssues: 0,
          minorIssues: 0,
        },
      });

      vi.mocked(pdfParserService.close).mockResolvedValue();

      // Execute
      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      // Assert
      expect(result).toBeDefined();
      expect(result.metadata.pageCount).toBe(2);
      expect(result.metadata.title).toBe('Test PDF');
      expect(result.isTagged).toBe(false);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].images).toHaveLength(1);
      expect(result.pages[0].images[0].hasAltText).toBe(true);
      expect(pdfParserService.close).toHaveBeenCalled();
    });

    it('should handle file not found', async () => {
      vi.mocked(fs.stat).mockResolvedValue(null as unknown as Stats);

      await expect(pdfComprehensiveParserService.parse('/nonexistent.pdf')).rejects.toThrow();
    });

    it('should cleanup PDF handle even if extraction fails', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as Stats);

      const mockParsedPdf = {
        filePath: '/test/file.pdf',
        fileSize: 1024,
        structure: {
          pageCount: 1,
          pages: [],
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
        pdfLibDoc: {} as unknown as PDFDocument,
        pdfjsDoc: {} as unknown as PDFDocumentProxy,
      } as unknown as ParsedPDF;

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(textExtractorService.extractText).mockRejectedValue(new Error('Extraction failed'));
      vi.mocked(pdfParserService.close).mockResolvedValue();

      await expect(pdfComprehensiveParserService.parse('/test/file.pdf')).rejects.toThrow('Extraction failed');
      expect(pdfParserService.close).toHaveBeenCalledWith(mockParsedPdf);
    });
  });

  describe('parseBuffer', () => {
    it('should parse PDF buffer successfully', async () => {
      const buffer = Buffer.from('test');

      const mockParsedPdf: Partial<ParsedPDF> = {
        filePath: 'buffer',
        fileSize: 4,
        structure: {
          pageCount: 1,
          pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, hasAnnotations: false, annotationCount: 0 }],
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
        pdfLibDoc: {} as unknown as PDFDocument,
        pdfjsDoc: {} as unknown as PDFDocumentProxy,
      };

      vi.mocked(pdfParserService.parseBuffer).mockResolvedValue(mockParsedPdf as ParsedPDF);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [{
          pageNumber: 1,
          width: 612,
          height: 792,
          text: '',
          items: [],
          lines: [],
          blocks: [],
          wordCount: 0,
          characterCount: 0,
        }],
        fullText: '',
        totalWords: 0,
        totalCharacters: 0,
        totalPages: 1,
        languages: [],
        readingOrder: 'left-to-right',
      });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue({
        pages: [],
        totalImages: 0,
        imageFormats: {},
        imagesWithAltText: 0,
        imagesWithoutAltText: 0,
        decorativeImages: 0,
      });
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue({
        isTaggedPDF: true,
        headings: { headings: [], hasProperHierarchy: true, hasH1: false, multipleH1: false, skippedLevels: [], issues: [] },
        tables: [],
        lists: [],
        links: [],
        readingOrder: { isLogical: true, hasStructureTree: true, issues: [], confidence: 0.9 },
        language: { hasDocumentLanguage: false, languageChanges: [], issues: [] },
        bookmarks: [],
        formFields: [],
        accessibilityScore: 85,
        summary: { totalHeadings: 0, totalTables: 0, totalLists: 0, totalLinks: 0, totalImages: 0, totalFormFields: 0, criticalIssues: 0, majorIssues: 0, minorIssues: 0 },
      });
      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');

      expect(result).toBeDefined();
      expect(result.metadata.pageCount).toBe(1);
      expect(result.isTagged).toBe(true);
      expect(pdfParserService.close).toHaveBeenCalled();
    });

    it('should cleanup PDF handle even if buffer extraction fails', async () => {
      const buffer = Buffer.from('test');

      const mockParsedPdf = {
        filePath: 'buffer',
        fileSize: 4,
        structure: {
          pageCount: 1,
          pages: [],
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
        pdfLibDoc: {} as unknown as PDFDocument,
        pdfjsDoc: {} as unknown as PDFDocumentProxy,
      } as unknown as ParsedPDF;

      vi.mocked(pdfParserService.parseBuffer).mockResolvedValue(mockParsedPdf);
      vi.mocked(textExtractorService.extractText).mockRejectedValue(new Error('Buffer extraction failed'));
      vi.mocked(pdfParserService.close).mockResolvedValue();

      await expect(pdfComprehensiveParserService.parseBuffer(buffer)).rejects.toThrow('Buffer extraction failed');
      expect(pdfParserService.close).toHaveBeenCalledWith(mockParsedPdf);
    });
  });

  describe('image conversion', () => {
    it('should convert images with alt text correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as Stats);

      const mockParsedPdf = {
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
        pdfLibDoc: {} as unknown as PDFDocument,
        pdfjsDoc: {} as unknown as PDFDocumentProxy,
      } as unknown as ParsedPDF;

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(textExtractorService.extractText).mockResolvedValue({
        pages: [{
          pageNumber: 1,
          width: 612,
          height: 792,
          text: '',
          items: [],
          lines: [],
          blocks: [],
          wordCount: 0,
          characterCount: 0,
        }],
        fullText: '',
        totalWords: 0,
        totalCharacters: 0,
        totalPages: 1,
        languages: [],
        readingOrder: 'left-to-right',
      });
      vi.mocked(imageExtractorService.extractImages).mockResolvedValue({
        pages: [{
          pageNumber: 1,
          totalImages: 1,
          images: [{
            id: 'img-with-alt',
            pageNumber: 1,
            index: 0,
            position: { x: 0, y: 0, width: 100, height: 100 },
            dimensions: { width: 100, height: 100 },
            format: 'jpeg',
            colorSpace: 'DeviceRGB',
            bitsPerComponent: 8,
            hasAlpha: false,
            fileSizeBytes: 1024,
            altText: 'Test alt text',
            mimeType: 'image/jpeg',
          }],
        }],
        totalImages: 1,
        imageFormats: { jpeg: 1 },
        imagesWithAltText: 1,
        imagesWithoutAltText: 0,
        decorativeImages: 0,
      });
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue({
        isTaggedPDF: false,
        headings: { headings: [], hasProperHierarchy: true, hasH1: false, multipleH1: false, skippedLevels: [], issues: [] },
        tables: [],
        lists: [],
        links: [],
        readingOrder: { isLogical: true, hasStructureTree: false, issues: [], confidence: 0.5 },
        language: { hasDocumentLanguage: false, languageChanges: [], issues: [] },
        bookmarks: [],
        formFields: [],
        accessibilityScore: 75,
        summary: { totalHeadings: 0, totalTables: 0, totalLists: 0, totalLinks: 0, totalImages: 1, totalFormFields: 0, criticalIssues: 0, majorIssues: 0, minorIssues: 0 },
      });
      vi.mocked(pdfParserService.close).mockResolvedValue();

      const result = await pdfComprehensiveParserService.parse('/test/file.pdf');

      expect(result.pages[0].images[0].hasAltText).toBe(true);
      expect(result.pages[0].images[0].altText).toBe('Test alt text');
    });
  });
});
