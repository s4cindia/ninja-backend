/**
 * Citation Storage Service Tests
 *
 * Tests for file storage abstraction (S3 with local fallback)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock S3 service
vi.mock('../../../../src/services/s3.service', () => ({
  s3Service: {
    isConfigured: vi.fn().mockReturnValue(false),
    uploadBuffer: vi.fn(),
    getFileBuffer: vi.fn(),
    getPresignedDownloadUrl: vi.fn(),
    deleteFile: vi.fn(),
    fileExists: vi.fn(),
  },
}));

// Mock config
vi.mock('../../../../src/config', () => ({
  config: {
    uploadDir: './test-uploads',
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
  },
}));

// Mock logger
vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test content')),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

import { s3Service } from '../../../../src/services/s3.service';
import { config } from '../../../../src/config';
import { citationStorageService } from '../../../../src/services/citation/citation-storage.service';

describe('CitationStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('uploadFile', () => {
    it('should upload to local storage when S3 is not configured', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const result = await citationStorageService.uploadFile(
        'tenant-1',
        'test-document.docx',
        Buffer.from('test content'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );

      expect(result.storageType).toBe('LOCAL');
      expect(result.storagePath).toContain('citation-management/tenant-1/');
      expect(result.storagePath).toContain('test-document.docx');
    });

    it('should upload to S3 when configured', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';
      vi.mocked(s3Service.uploadBuffer).mockResolvedValue('citation-management/tenant-1/12345-test.docx');

      const result = await citationStorageService.uploadFile(
        'tenant-1',
        'test.docx',
        Buffer.from('test content'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );

      expect(result.storageType).toBe('S3');
      expect(s3Service.uploadBuffer).toHaveBeenCalled();
    });

    it('should sanitize filenames to prevent path traversal', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      const result = await citationStorageService.uploadFile(
        'tenant-1',
        '../../../etc/passwd',
        Buffer.from('test'),
        'application/octet-stream'
      );

      expect(result.storagePath).not.toContain('..');
      expect(result.storagePath).not.toContain('/etc/passwd');
    });

    it('should fall back to local storage on S3 error', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';
      vi.mocked(s3Service.uploadBuffer).mockRejectedValue(new Error('S3 error'));

      const result = await citationStorageService.uploadFile(
        'tenant-1',
        'test.docx',
        Buffer.from('test'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );

      expect(result.storageType).toBe('LOCAL');
    });
  });

  describe('getFileBuffer', () => {
    it('should retrieve from local storage', async () => {
      const result = await citationStorageService.getFileBuffer(
        'citation-management/tenant-1/test.docx',
        'LOCAL'
      );

      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should retrieve from S3 when storage type is S3', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';
      vi.mocked(s3Service.getFileBuffer).mockResolvedValue(Buffer.from('s3 content'));

      const result = await citationStorageService.getFileBuffer(
        'citation-management/tenant-1/test.docx',
        'S3'
      );

      expect(s3Service.getFileBuffer).toHaveBeenCalled();
      expect(result.toString()).toBe('s3 content');
    });
  });

  describe('getDownloadUrl', () => {
    it('should return null for local storage', async () => {
      const result = await citationStorageService.getDownloadUrl(
        'citation-management/tenant-1/test.docx',
        'LOCAL'
      );

      expect(result).toBeNull();
    });

    it('should return presigned URL for S3 storage', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';
      vi.mocked(s3Service.getPresignedDownloadUrl).mockResolvedValue({
        downloadUrl: 'https://s3.example.com/presigned-url',
        expiresIn: 3600,
      });

      const result = await citationStorageService.getDownloadUrl(
        'citation-management/tenant-1/test.docx',
        'S3'
      );

      expect(result).toBe('https://s3.example.com/presigned-url');
    });
  });

  describe('deleteFile', () => {
    it('should delete from local storage', async () => {
      const fs = await import('fs/promises');

      await citationStorageService.deleteFile(
        'citation-management/tenant-1/test.docx',
        'LOCAL'
      );

      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should delete from S3 when storage type is S3', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';

      await citationStorageService.deleteFile(
        'citation-management/tenant-1/test.docx',
        'S3'
      );

      expect(s3Service.deleteFile).toHaveBeenCalled();
    });
  });

  describe('fileExists', () => {
    it('should check local filesystem for local storage', async () => {
      const result = await citationStorageService.fileExists(
        'citation-management/tenant-1/test.docx',
        'LOCAL'
      );

      expect(result).toBe(true);
    });

    it('should check S3 for S3 storage', async () => {
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(config as any).awsAccessKeyId = 'test-key';
      vi.mocked(config as any).awsSecretAccessKey = 'test-secret';
      vi.mocked(s3Service.fileExists).mockResolvedValue(true);

      const result = await citationStorageService.fileExists(
        'citation-management/tenant-1/test.docx',
        'S3'
      );

      expect(s3Service.fileExists).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});
