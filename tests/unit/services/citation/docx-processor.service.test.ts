/**
 * DOCX Processor Service Tests
 *
 * Tests for DOCX file processing, validation, and manipulation
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock mammoth before importing the service
vi.mock('mammoth', () => ({
  default: {
    convertToHtml: vi.fn(),
    extractRawText: vi.fn(),
  },
  convertToHtml: vi.fn(),
  extractRawText: vi.fn(),
}));

// Mock jszip
vi.mock('jszip', () => {
  const mockFile = vi.fn().mockReturnValue({
    async: vi.fn().mockResolvedValue('<w:document><w:body></w:body></w:document>'),
  });

  return {
    default: {
      loadAsync: vi.fn().mockResolvedValue({
        file: mockFile,
        generateAsync: vi.fn().mockResolvedValue(Buffer.from('mock-docx')),
      }),
    },
    loadAsync: vi.fn().mockResolvedValue({
      file: mockFile,
      generateAsync: vi.fn().mockResolvedValue(Buffer.from('mock-docx')),
    }),
  };
});

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/reference-style-updater.service', () => ({
  referenceStyleUpdaterService: {
    updateStyle: vi.fn(),
  },
}));

import * as mammoth from 'mammoth';
import { docxProcessorService } from '../../../../src/services/citation/docx-processor.service';

describe('DOCXProcessorService', () => {
  // Create a valid DOCX-like buffer (ZIP magic bytes)
  const createValidDocxBuffer = (): Buffer => {
    // ZIP file signature: PK\x03\x04
    const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
    const padding = Buffer.alloc(100);
    return Buffer.concat([zipHeader, padding]);
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default successful mocks
    vi.mocked(mammoth.extractRawText).mockResolvedValue({
      value: 'Extracted text',
      messages: [],
    });
    vi.mocked(mammoth.convertToHtml).mockResolvedValue({
      value: '<p>Extracted text</p>',
      messages: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateDOCX', () => {
    it('should return valid for proper DOCX buffer', async () => {
      const buffer = createValidDocxBuffer();

      // Mock successful extraction
      vi.mocked(mammoth.extractRawText).mockResolvedValue({
        value: 'Valid document text',
        messages: [],
      });
      vi.mocked(mammoth.convertToHtml).mockResolvedValue({
        value: '<p>Valid document text</p>',
        messages: [],
      });

      const result = await docxProcessorService.validateDOCX(buffer);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for empty buffer', async () => {
      const buffer = Buffer.alloc(0);

      // Mock extraction failure for empty buffer
      vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error('Empty buffer'));

      const result = await docxProcessorService.validateDOCX(buffer);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return invalid for non-ZIP buffer', async () => {
      // Random bytes, not a ZIP file
      const buffer = Buffer.from('not a docx file content');

      // Mock extraction failure for invalid file
      vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error('Invalid DOCX'));

      const result = await docxProcessorService.validateDOCX(buffer);

      expect(result.valid).toBe(false);
    });

    it('should handle corrupted DOCX gracefully', async () => {
      const buffer = createValidDocxBuffer();

      // Mock extraction failure
      vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error('Corrupted file'));

      const result = await docxProcessorService.validateDOCX(buffer);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('extractText', () => {
    it('should extract text from DOCX buffer', async () => {
      const buffer = createValidDocxBuffer();
      const mockText = 'Extracted document text with citations [1] and [2].';
      const mockHtml = '<p>Extracted document text with citations [1] and [2].</p>';

      vi.mocked(mammoth.extractRawText).mockResolvedValue({
        value: mockText,
        messages: [],
      });
      vi.mocked(mammoth.convertToHtml).mockResolvedValue({
        value: mockHtml,
        messages: [],
      });

      const result = await docxProcessorService.extractText(buffer);

      expect(result.text).toBe(mockText);
      expect(result.html).toBe(mockHtml);
      expect(result.rawBuffer).toBe(buffer);
    });

    it('should handle extraction errors gracefully', async () => {
      const buffer = createValidDocxBuffer();

      vi.mocked(mammoth.extractRawText).mockRejectedValueOnce(new Error('Extraction failed'));

      await expect(docxProcessorService.extractText(buffer)).rejects.toThrow();
    });
  });

  describe('getStatistics', () => {
    it('should calculate document statistics correctly', async () => {
      const buffer = createValidDocxBuffer();
      const mockText = 'This is a test document with multiple words. It has two paragraphs.\n\nThis is the second paragraph.';

      vi.mocked(mammoth.extractRawText).mockResolvedValue({
        value: mockText,
        messages: [],
      });
      vi.mocked(mammoth.convertToHtml).mockResolvedValue({
        value: '<p>text</p>',
        messages: [],
      });

      const result = await docxProcessorService.getStatistics(buffer);

      expect(result.wordCount).toBeGreaterThan(0);
      expect(result.paragraphCount).toBeGreaterThanOrEqual(1);
      expect(result.pageCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty document', async () => {
      const buffer = createValidDocxBuffer();

      vi.mocked(mammoth.extractRawText).mockResolvedValue({
        value: '',
        messages: [],
      });
      vi.mocked(mammoth.convertToHtml).mockResolvedValue({
        value: '',
        messages: [],
      });

      const result = await docxProcessorService.getStatistics(buffer);

      expect(result.wordCount).toBe(0);
    });
  });

  describe('applyChanges', () => {
    it('should return buffer when applying changes', async () => {
      const buffer = createValidDocxBuffer();
      const changes = [
        { type: 'RENUMBER', beforeText: '[1]', afterText: '[2]' },
      ];

      const result = await docxProcessorService.applyChanges(buffer, changes);

      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should handle empty changes array', async () => {
      const buffer = createValidDocxBuffer();

      const result = await docxProcessorService.applyChanges(buffer, []);

      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  describe('updateReferences', () => {
    it('should return buffer when updating references', async () => {
      const buffer = createValidDocxBuffer();
      const newReferences = ['1. Smith (2023)', '2. Jones (2022)'];

      const result = await docxProcessorService.updateReferences(buffer, newReferences);

      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });
});
