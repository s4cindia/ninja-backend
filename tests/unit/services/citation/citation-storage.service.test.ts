/**
 * CitationStorageService Unit Tests
 *
 * Tests S3/local storage fallback logic, path sanitization,
 * and file retrieval from both storage types.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies before importing the service
vi.mock('../../../../src/services/s3.service', () => ({
  s3Service: {
    isConfigured: vi.fn(),
    uploadBuffer: vi.fn(),
    getFileBuffer: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

vi.mock('../../../../src/config', () => ({
  config: {
    awsAccessKeyId: 'test-key',
    awsSecretAccessKey: 'test-secret',
    uploadDir: '/tmp/test-uploads',
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test content')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return {
    ...actual,
    join: (...args: string[]) => args.join('/'),
  };
});

// Import after mocks are set up
import { citationStorageService } from '../../../../src/services/citation/citation-storage.service';
import { s3Service } from '../../../../src/services/s3.service';

describe('CitationStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('uploadFile', () => {
    const tenantId = 'tenant-123';
    const fileName = 'test-document.docx';
    const buffer = Buffer.from('test file content');

    it('should upload to S3 when S3 is configured', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(s3Service.uploadBuffer).mockResolvedValue('citation-management/tenant-123/123456-test-document.docx');

      const result = await citationStorageService.uploadFile(tenantId, fileName, buffer);

      expect(result.storageType).toBe('S3');
      expect(result.storagePath).toContain('citation-management');
      expect(s3Service.uploadBuffer).toHaveBeenCalled();
    });

    it('should fall back to local storage when S3 is not configured', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const result = await citationStorageService.uploadFile(tenantId, fileName, buffer);

      expect(result.storageType).toBe('LOCAL');
      expect(result.storagePath).toContain('citation-management');
      expect(s3Service.uploadBuffer).not.toHaveBeenCalled();
    });

    it('should fall back to local storage when S3 upload fails', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(s3Service.uploadBuffer).mockRejectedValue(new Error('S3 error'));

      const result = await citationStorageService.uploadFile(tenantId, fileName, buffer);

      expect(result.storageType).toBe('LOCAL');
      expect(result.storagePath).toContain('citation-management');
    });

    it('should sanitize filename to prevent path traversal', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const maliciousFileName = '../../../etc/passwd.docx';
      const result = await citationStorageService.uploadFile(tenantId, maliciousFileName, buffer);

      expect(result.storagePath).not.toContain('..');
      expect(result.storagePath).not.toContain('/etc/');
    });

    it('should sanitize filename with null bytes', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const maliciousFileName = 'test\x00malicious.docx';
      const result = await citationStorageService.uploadFile(tenantId, maliciousFileName, buffer);

      expect(result.storagePath).not.toContain('\x00');
    });

    it('should limit filename length', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const longFileName = 'a'.repeat(300) + '.docx';
      const result = await citationStorageService.uploadFile(tenantId, longFileName, buffer);

      // Storage path should exist and be reasonable length
      expect(result.storagePath.length).toBeLessThan(350);
    });
  });

  describe('getFileBuffer', () => {
    const storagePath = 'citation-management/tenant-123/test-file.docx';
    const testBuffer = Buffer.from('test content');

    it('should retrieve file from S3 when storageType is S3', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(s3Service.getFileBuffer).mockResolvedValue(testBuffer);

      const result = await citationStorageService.getFileBuffer(storagePath, 'S3');

      expect(result).toEqual(testBuffer);
      expect(s3Service.getFileBuffer).toHaveBeenCalledWith(storagePath);
    });

    it('should retrieve file from local storage when storageType is LOCAL', async () => {
      const result = await citationStorageService.getFileBuffer(storagePath, 'LOCAL');

      expect(result).toBeInstanceOf(Buffer);
      expect(s3Service.getFileBuffer).not.toHaveBeenCalled();
    });

    it('should throw error when S3 retrieval fails', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(s3Service.getFileBuffer).mockRejectedValue(new Error('S3 error'));

      // The service throws when S3 retrieval fails (no fallback for getFileBuffer)
      await expect(
        citationStorageService.getFileBuffer(storagePath, 'S3')
      ).rejects.toThrow('Failed to retrieve file from S3');
    });
  });

  describe('Security: Path Traversal Prevention', () => {
    it('should remove directory traversal sequences', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const attacks = [
        '../../../etc/passwd',
        '..\..\windows\system32',
        'test/../../../secret.txt',
        'normal/../../attack.exe',
      ];

      for (const attack of attacks) {
        const result = await citationStorageService.uploadFile('tenant', attack, Buffer.from('test'));
        expect(result.storagePath).not.toMatch(/\.\./);
      }
    });

    it('should handle unicode path attacks', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      // Various unicode tricks for path traversal
      const unicodeAttacks = [
        'test%2e%2e%2fpasswd',
        'test\u002e\u002e/passwd',
      ];

      for (const attack of unicodeAttacks) {
        const result = await citationStorageService.uploadFile('tenant', attack, Buffer.from('test'));
        expect(result.storagePath).toBeDefined();
        // Should complete without throwing
      }
    });
  });
});
