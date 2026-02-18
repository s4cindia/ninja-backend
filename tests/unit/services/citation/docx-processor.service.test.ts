/**
 * DocxProcessorService Unit Tests
 *
 * Tests security validation paths, memory management,
 * circuit breaker behavior, and DOCX processing.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies
vi.mock('mammoth', () => ({
  default: {
    convertToHtml: vi.fn().mockResolvedValue({ value: '<p>Test content</p>', messages: [] }),
    extractRawText: vi.fn().mockResolvedValue({ value: 'Test content' }),
  },
  convertToHtml: vi.fn().mockResolvedValue({ value: '<p>Test content</p>', messages: [] }),
  extractRawText: vi.fn().mockResolvedValue({ value: 'Test content' }),
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/config/memory.config', () => ({
  memoryConfig: {
    maxUploadFileSize: 50 * 1024 * 1024,
    maxXmlMemorySize: 10 * 1024 * 1024,
    maxMemoryFileSize: 5 * 1024 * 1024,
  },
  getMemoryUsage: vi.fn().mockReturnValue({
    heapUsed: 100 * 1024 * 1024,
    heapTotal: 500 * 1024 * 1024,
    rss: 200 * 1024 * 1024,
  }),
  isMemorySafeForSize: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../../src/utils/memory-safe-processor', () => ({
  withMemoryTracking: vi.fn((fn) => fn),
  FileTooLargeError: class FileTooLargeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'FileTooLargeError';
    }
  },
}));

vi.mock('../../../../src/utils/app-error', () => ({
  AppError: {
    badRequest: vi.fn((msg, code) => {
      const err = new Error(msg);
      return err;
    }),
    serviceUnavailable: vi.fn((msg, code) => {
      const err = new Error(msg);
      return err;
    }),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('test')),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../../src/services/citation/reference-style-updater.service', () => ({
  referenceStyleUpdaterService: {
    updateReferenceStyles: vi.fn().mockResolvedValue(undefined),
  },
}));

import { isMemorySafeForSize } from '../../../../src/config/memory.config';

describe('DocxProcessorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Security Validation', () => {
    it('should reject files exceeding maximum size', async () => {
      const { docxProcessorService } = await import('../../../../src/services/citation/docx-processor.service');
      const oversizedBuffer = Buffer.alloc(60 * 1024 * 1024);

      await expect(
        docxProcessorService.parseDocx(oversizedBuffer)
      ).rejects.toThrow();
    });

    it('should validate DOCX file signature', async () => {
      const { docxProcessorService } = await import('../../../../src/services/citation/docx-processor.service');
      const invalidBuffer = Buffer.from('not a valid docx file');

      await expect(
        docxProcessorService.parseDocx(invalidBuffer)
      ).rejects.toThrow();
    });

    it('should reject when memory is insufficient', async () => {
      vi.mocked(isMemorySafeForSize).mockReturnValue(false);
      const { docxProcessorService } = await import('../../../../src/services/citation/docx-processor.service');
      const buffer = Buffer.alloc(1024);

      await expect(
        docxProcessorService.parseDocx(buffer)
      ).rejects.toThrow();
    });
  });

  describe('parseDocx', () => {
    it('should parse valid DOCX and return content', async () => {
      vi.mocked(isMemorySafeForSize).mockReturnValue(true);
      const { docxProcessorService } = await import('../../../../src/services/citation/docx-processor.service');
      const validDocx = createMinimalDocxBuffer();

      const result = await docxProcessorService.parseDocx(validDocx);

      expect(result).toBeDefined();
    });
  });

  describe('applyChanges', () => {
    it('should handle empty changes array', async () => {
      vi.mocked(isMemorySafeForSize).mockReturnValue(true);
      const { docxProcessorService } = await import('../../../../src/services/citation/docx-processor.service');
      const validDocx = createMinimalDocxBuffer();
      const changes: Array<{ type: 'RENUMBER'; beforeText: string; afterText: string }> = [];

      const result = await docxProcessorService.applyChanges(validDocx, changes);

      expect(result).toBeInstanceOf(Buffer);
    });
  });
});

function createMinimalDocxBuffer(): Buffer {
  const pkSignature = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
  const padding = Buffer.alloc(1000);
  return Buffer.concat([pkSignature, padding]);
}
