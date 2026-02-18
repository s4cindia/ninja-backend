/**
 * File Validator Utility Tests
 *
 * Tests for file validation utilities including sanitizeFilename and checkForSuspiciousContent
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeFilename,
  checkForSuspiciousContent,
} from '../../../src/utils/file-validator';

vi.mock('../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('sanitizeFilename', () => {
  describe('Path Traversal Prevention', () => {
    it('should replace path separators with underscores', () => {
      expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
      expect(sanitizeFilename('path\\to\\file.txt')).toBe('path_to_file.txt');
    });

    it('should remove parent directory references', () => {
      expect(sanitizeFilename('../secret.txt')).toBe('__secret.txt');
      expect(sanitizeFilename('../../etc/passwd')).toBe('____etc_passwd');
    });

    it('should remove null bytes', () => {
      expect(sanitizeFilename('file\0.txt')).toBe('file.txt');
    });

    it('should remove Windows reserved characters', () => {
      expect(sanitizeFilename('file<name>:test?.txt')).toBe('file_name__test_.txt');
    });
  });

  describe('URL Encoded Path Traversal', () => {
    it('should handle URL-encoded path separators', () => {
      // %2F = /
      expect(sanitizeFilename('..%2F..%2Fsecret.txt')).toBe('____secret.txt');
      // %5C = \
      expect(sanitizeFilename('..%5C..%5Csecret.txt')).toBe('____secret.txt');
    });

    it('should handle double-encoded path separators', () => {
      // %252F = %2F (double encoded)
      expect(sanitizeFilename('..%252F..%252Fsecret.txt')).toBe('____secret.txt');
    });

    it('should handle URL-encoded null bytes', () => {
      // %00 = null byte
      expect(sanitizeFilename('file%00.txt')).toBe('file.txt');
    });

    it('should handle invalid URL encoding gracefully', () => {
      // Invalid encoding should not cause errors
      expect(sanitizeFilename('%ZZ%invalid')).toBe('%ZZ%invalid');
    });
  });

  describe('Length Limiting', () => {
    it('should truncate filenames exceeding 200 characters', () => {
      const longName = 'a'.repeat(250);
      expect(sanitizeFilename(longName).length).toBe(200);
    });

    it('should not truncate filenames within limit', () => {
      const validName = 'a'.repeat(100);
      expect(sanitizeFilename(validName).length).toBe(100);
    });
  });
});

describe('checkForSuspiciousContent', () => {
  describe('Script Detection', () => {
    it('should detect script tags', () => {
      const buffer = Buffer.from('<html><script>alert(1)</script></html>');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('script');
    });

    it('should detect javascript: URLs', () => {
      const buffer = Buffer.from('<a href="javascript:alert(1)">click</a>');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('javascript');
    });

    it('should detect event handlers', () => {
      const buffer = Buffer.from('<img src="x" onerror="alert(1)">');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(true);
    });

    it('should detect data: URLs with HTML', () => {
      const buffer = Buffer.from('<iframe src="data:text/html,<script>alert(1)</script>">');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(true);
    });
  });

  describe('Binary File Handling', () => {
    it('should skip pattern matching for DOCX files (ZIP format)', () => {
      // DOCX files start with PK\x03\x04 (ZIP signature)
      // They may contain random bytes that look like "onclick=" etc.
      const docxSignature = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
      const randomContent = Buffer.from(' onclick="handler" more content');
      const buffer = Buffer.concat([docxSignature, randomContent]);

      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(false);
    });

    it('should skip pattern matching for PDF files', () => {
      // PDF files start with %PDF
      const pdfSignature = Buffer.from('%PDF-1.7\nsome content onclick="handler"');
      const result = checkForSuspiciousContent(pdfSignature);
      expect(result.suspicious).toBe(false);
    });

    it('should check non-binary files for suspicious patterns', () => {
      const htmlContent = Buffer.from('<div onclick="malicious()">content</div>');
      const result = checkForSuspiciousContent(htmlContent);
      expect(result.suspicious).toBe(true);
    });
  });

  describe('Safe Content', () => {
    it('should allow normal HTML content', () => {
      const buffer = Buffer.from('<html><body><h1>Hello World</h1></body></html>');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(false);
    });

    it('should allow plain text content', () => {
      const buffer = Buffer.from('This is a normal document with no malicious content.');
      const result = checkForSuspiciousContent(buffer);
      expect(result.suspicious).toBe(false);
    });
  });
});
