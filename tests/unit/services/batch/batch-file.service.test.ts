/**
 * BatchFileService -- migrated off local-disk storage (fs.writeFile/readFile
 * against BATCH_UPLOAD_DIR, storageType hardcoded 'LOCAL') onto
 * fileStorageService (S3-backed in staging/production, same service the
 * rest of the PDF/EPUB pipeline already uses post-PR-#482). ECS Fargate
 * wipes local disk on every deploy and tasks don't share a filesystem
 * across replicas, so the old storage was losing batch files exactly the
 * way PR #482 already fixed for the main pipeline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBatchFileFindUnique = vi.fn();
const mockBatchFileCreate = vi.fn();
const mockBatchFileUpdate = vi.fn();
const mockBatchFileDelete = vi.fn();
const mockBatchUpdate = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    batchFile: {
      findUnique: (...args: unknown[]) => mockBatchFileFindUnique(...args),
      create: (...args: unknown[]) => mockBatchFileCreate(...args),
      update: (...args: unknown[]) => mockBatchFileUpdate(...args),
      delete: (...args: unknown[]) => mockBatchFileDelete(...args),
    },
    batch: {
      update: (...args: unknown[]) => mockBatchUpdate(...args),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockSaveFile = vi.fn();
const mockGetFile = vi.fn();
const mockSaveRemediatedFile = vi.fn();
const mockDeleteFile = vi.fn();

vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    saveFile: (...args: unknown[]) => mockSaveFile(...args),
    getFile: (...args: unknown[]) => mockGetFile(...args),
    saveRemediatedFile: (...args: unknown[]) => mockSaveRemediatedFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  },
}));

const mockIsConfigured = vi.fn();
vi.mock('../../../../src/services/s3.service', () => ({
  s3Service: { isConfigured: () => mockIsConfigured() },
}));

import { batchFileService } from '../../../../src/services/batch/batch-file.service';

describe('BatchFileService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
  });

  describe('uploadFiles', () => {
    it('stores the file via fileStorageService, keyed by a precomputed id, and records storageType S3', async () => {
      mockSaveFile.mockResolvedValue('job-storage/some-id/book-123-abc.epub');
      mockBatchFileCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data }));

      const [result] = await batchFileService.uploadFiles('batch-1', [
        { buffer: Buffer.from('epub-bytes'), filename: 'book.epub', size: 10 },
      ]);

      expect(mockSaveFile).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^book-\d+-[a-z0-9]+\.epub$/), Buffer.from('epub-bytes'));
      expect(mockBatchFileCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: expect.any(String),
          batchId: 'batch-1',
          storagePath: 'job-storage/some-id/book-123-abc.epub',
          storageType: 'S3',
          status: 'UPLOADED',
        }),
      });
      // The id passed to saveFile must be the same id the BatchFile row is
      // created with -- that's the whole point of precomputing it.
      const saveFileId = mockSaveFile.mock.calls[0][0];
      expect(result.id).toBe(saveFileId);
    });

    it('records storageType LOCAL when S3 is not configured (local dev)', async () => {
      mockIsConfigured.mockReturnValue(false);
      mockSaveFile.mockResolvedValue('/tmp/epub-storage/some-id/book-123-abc.epub');
      mockBatchFileCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data }));

      await batchFileService.uploadFiles('batch-1', [
        { buffer: Buffer.from('epub-bytes'), filename: 'book.epub', size: 10 },
      ]);

      expect(mockBatchFileCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ storageType: 'LOCAL' }),
      });
    });

    it('rejects a non-EPUB file before ever touching storage', async () => {
      await expect(
        batchFileService.uploadFiles('batch-1', [{ buffer: Buffer.from('x'), filename: 'book.pdf', size: 10 }])
      ).rejects.toThrow('Only EPUB files are supported');

      expect(mockSaveFile).not.toHaveBeenCalled();
      expect(mockBatchFileCreate).not.toHaveBeenCalled();
    });

    it('rejects a file over 100MB before ever touching storage', async () => {
      await expect(
        batchFileService.uploadFiles('batch-1', [{ buffer: Buffer.from('x'), filename: 'book.epub', size: 101 * 1024 * 1024 }])
      ).rejects.toThrow('File too large');

      expect(mockSaveFile).not.toHaveBeenCalled();
    });
  });

  describe('getFileBuffer / getFileByBatchFile', () => {
    const file = { id: 'file-1', fileName: 'book-123-abc.epub' };

    it('reads the buffer via fileStorageService, keyed by the file id', async () => {
      mockBatchFileFindUnique.mockResolvedValue(file);
      mockGetFile.mockResolvedValue(Buffer.from('epub-bytes'));

      const buffer = await batchFileService.getFileBuffer('file-1');

      expect(mockGetFile).toHaveBeenCalledWith('file-1', 'book-123-abc.epub');
      expect(buffer).toEqual(Buffer.from('epub-bytes'));
    });

    it('throws when the storage backend has no object for this file (not silently returning empty)', async () => {
      mockBatchFileFindUnique.mockResolvedValue(file);
      mockGetFile.mockResolvedValue(null);

      await expect(batchFileService.getFileBuffer('file-1')).rejects.toThrow('File not found in storage: file-1');
    });

    it('throws when the BatchFile row itself does not exist', async () => {
      mockBatchFileFindUnique.mockResolvedValue(null);

      await expect(batchFileService.getFileBuffer('missing')).rejects.toThrow('File not found: missing');
      expect(mockGetFile).not.toHaveBeenCalled();
    });
  });

  describe('saveRemediatedFile', () => {
    it('builds an extension-aware remediated filename and persists the path', async () => {
      mockBatchFileFindUnique.mockResolvedValue({ id: 'file-1', fileName: 'book-123-abc.epub' });
      mockSaveRemediatedFile.mockResolvedValue('job-storage/file-1/remediated/book-123-abc_remediated.epub');

      const result = await batchFileService.saveRemediatedFile('file-1', Buffer.from('fixed'));

      expect(mockSaveRemediatedFile).toHaveBeenCalledWith('file-1', 'book-123-abc_remediated.epub', Buffer.from('fixed'));
      expect(mockBatchFileUpdate).toHaveBeenCalledWith({
        where: { id: 'file-1' },
        data: { remediatedFilePath: 'job-storage/file-1/remediated/book-123-abc_remediated.epub' },
      });
      expect(result).toBe('job-storage/file-1/remediated/book-123-abc_remediated.epub');
    });

    it('does not clobber the original filename for a non-.epub name (regression: old .replace(".epub", ...) silently no-op\'d)', async () => {
      mockBatchFileFindUnique.mockResolvedValue({ id: 'file-1', fileName: 'book-123-abc.pdf' });
      mockSaveRemediatedFile.mockResolvedValue('job-storage/file-1/remediated/book-123-abc_remediated.pdf');

      await batchFileService.saveRemediatedFile('file-1', Buffer.from('fixed'));

      expect(mockSaveRemediatedFile).toHaveBeenCalledWith('file-1', 'book-123-abc_remediated.pdf', Buffer.from('fixed'));
    });
  });

  describe('deleteFile', () => {
    it('deletes via fileStorageService and the BatchFile row when the batch is DRAFT', async () => {
      mockBatchFileFindUnique.mockResolvedValue({ id: 'file-1', batchId: 'batch-1', fileName: 'book.epub', batch: { status: 'DRAFT' } });
      mockDeleteFile.mockResolvedValue(undefined);

      await batchFileService.deleteFile('file-1');

      expect(mockDeleteFile).toHaveBeenCalledWith('file-1', 'book.epub');
      expect(mockBatchFileDelete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
      expect(mockBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { totalFiles: { decrement: 1 }, filesUploaded: { decrement: 1 } },
      });
    });

    it('refuses to delete a file from a non-DRAFT batch', async () => {
      mockBatchFileFindUnique.mockResolvedValue({ id: 'file-1', batchId: 'batch-1', fileName: 'book.epub', batch: { status: 'PROCESSING' } });

      await expect(batchFileService.deleteFile('file-1')).rejects.toThrow('Cannot delete files from batch that is not in DRAFT status');
      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(mockBatchFileDelete).not.toHaveBeenCalled();
    });
  });
});
