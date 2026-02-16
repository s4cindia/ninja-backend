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

// Mock memory config to avoid memory pressure issues in tests
vi.mock('../../../../src/config/memory.config', () => ({
  memoryConfig: {
    maxMemoryFileSize: 5 * 1024 * 1024,  // 5MB
    maxXmlMemorySize: 10 * 1024 * 1024,  // 10MB
    maxUploadFileSize: 50 * 1024 * 1024, // 50MB
    streamChunkSize: 65536,
    magicByteBufferSize: 4096,
    memoryWarningThreshold: 0.8,
    enableMemoryLogging: false,
  },
  getMemoryUsage: vi.fn().mockReturnValue({
    heapUsed: 50 * 1024 * 1024,   // 50MB
    heapTotal: 512 * 1024 * 1024, // 512MB
    external: 10 * 1024 * 1024,
    rss: 100 * 1024 * 1024,
    heapUsedMB: 50,
    heapTotalMB: 512,
  }),
  // Always return true for memory safety in tests
  isMemorySafeForSize: vi.fn().mockReturnValue(true),
}));

// Mock memory-safe-processor
vi.mock('../../../../src/utils/memory-safe-processor', () => ({
  FileTooLargeError: class FileTooLargeError extends Error {
    constructor(
      public readonly fileSize: number,
      public readonly maxSize: number,
      message?: string
    ) {
      super(message || `File size ${fileSize} exceeds maximum ${maxSize} for memory processing`);
      this.name = 'FileTooLargeError';
    }
  },
  withMemoryTracking: vi.fn().mockImplementation(async (_operation, fn) => fn()),
  assertMemorySafe: vi.fn(),
}));

import * as mammoth from 'mammoth';
import { docxProcessorService, resetCircuitBreaker } from '../../../../src/services/citation/docx-processor.service';

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

    // Reset circuit breaker state between tests
    resetCircuitBreaker();

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

  describe('Security Validation', () => {
    it('should reject files exceeding size limit in replaceCitationsWithTrackChanges', async () => {
      // Create a buffer larger than 50MB limit
      const largeBuffer = Buffer.alloc(51 * 1024 * 1024);

      // The replaceCitationsWithTrackChanges should throw for oversized files
      // Either "too large" error or "exceeds" error pattern
      await expect(
        docxProcessorService.replaceCitationsWithTrackChanges(
          largeBuffer,
          [{ oldText: '[1]', newText: '[2]' }],
          []
        )
      ).rejects.toThrow(/too large|exceeds/i);
    });

    it('should reject non-ZIP files via validateDOCX', async () => {
      const invalidBuffer = Buffer.from('This is plain text, not a DOCX/ZIP file');

      vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error('Invalid DOCX'));

      const result = await docxProcessorService.validateDOCX(invalidBuffer);

      expect(result.valid).toBe(false);
    });

    it('should reject empty buffer via validateDOCX', async () => {
      const emptyBuffer = Buffer.alloc(0);

      vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error('Empty buffer'));

      const result = await docxProcessorService.validateDOCX(emptyBuffer);

      expect(result.valid).toBe(false);
    });
  });
});
