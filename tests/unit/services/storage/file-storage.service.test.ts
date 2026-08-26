/**
 * FileStorageService
 *
 * Migrated from local-disk-only storage (ephemeral on ECS — every deploy
 * replaces the container, wiping /tmp, which silently broke any job older
 * than the current deployment) to S3-backed storage, with local disk kept
 * only as a fallback for local dev when S3 isn't configured. Every public
 * method must behave identically from the caller's point of view in both
 * modes — this file exercises both.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { s3Client, s3Service } from '../../../../src/services/s3.service';

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: { isConfigured: vi.fn() },
}));

vi.mock('../../../../src/config', () => ({
  config: { s3Bucket: 'test-bucket' },
}));

vi.mock('fs/promises');

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function asyncIterableOf(buf: Buffer) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield buf;
    },
  };
}

function notFoundError(name: 'NoSuchKey' | 'NotFound' = 'NoSuchKey'): Error {
  const err = new Error(name);
  (err as any).name = name;
  return err;
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

describe('FileStorageService — S3 mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(s3Service.isConfigured).mockReturnValue(true);
  });

  it('saveFile puts to S3 under job-storage/{jobId}/{fileName} and returns the key', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({} as any);
    const key = await fileStorageService.saveFile('job-1', 'doc.pdf', Buffer.from('hello'));

    expect(key).toBe('job-storage/job-1/doc.pdf');
    const call = vi.mocked(s3Client.send).mock.calls[0][0] as any;
    expect(call.input).toMatchObject({ Bucket: 'test-bucket', Key: 'job-storage/job-1/doc.pdf' });
  });

  it('sanitizes the filename to its basename (defends against path traversal)', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({} as any);
    const key = await fileStorageService.saveFile('job-1', '../../etc/passwd', Buffer.from('x'));
    expect(key).toBe('job-storage/job-1/passwd');
  });

  it('getFile returns the buffer from S3', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({ Body: asyncIterableOf(Buffer.from('hello')) } as any);
    const buffer = await fileStorageService.getFile('job-1', 'doc.pdf');
    expect(buffer?.toString()).toBe('hello');
  });

  it('getFile returns null when the key does not exist', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(notFoundError());
    const buffer = await fileStorageService.getFile('job-1', 'missing.pdf');
    expect(buffer).toBeNull();
  });

  it('getFile rethrows non-not-found errors', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(new Error('AccessDenied'));
    await expect(fileStorageService.getFile('job-1', 'doc.pdf')).rejects.toThrow('AccessDenied');
  });

  it('deleteFile issues a DeleteObjectCommand for the job-scoped key', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({} as any);
    await fileStorageService.deleteFile('job-1', 'doc.pdf');
    const call = vi.mocked(s3Client.send).mock.calls[0][0] as any;
    expect(call.input).toMatchObject({ Bucket: 'test-bucket', Key: 'job-storage/job-1/doc.pdf' });
  });

  it('deleteFile swallows a not-found error', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(notFoundError());
    await expect(fileStorageService.deleteFile('job-1', 'doc.pdf')).resolves.toBeUndefined();
  });

  it('deleteJobFiles lists then batch-deletes every object under the job prefix', async () => {
    vi.mocked(s3Client.send)
      .mockResolvedValueOnce({
        Contents: [{ Key: 'job-storage/job-1/doc.pdf' }, { Key: 'job-storage/job-1/remediated/doc.pdf' }],
        IsTruncated: false,
      } as any)
      .mockResolvedValueOnce({} as any);

    await fileStorageService.deleteJobFiles('job-1');

    expect(s3Client.send).toHaveBeenCalledTimes(2);
    const listCall = vi.mocked(s3Client.send).mock.calls[0][0] as any;
    expect(listCall.input).toMatchObject({ Bucket: 'test-bucket', Prefix: 'job-storage/job-1/' });
    const deleteCall = vi.mocked(s3Client.send).mock.calls[1][0] as any;
    expect(deleteCall.input.Delete.Objects).toEqual([
      { Key: 'job-storage/job-1/doc.pdf' },
      { Key: 'job-storage/job-1/remediated/doc.pdf' },
    ]);
  });

  it('deleteJobFiles is a no-op (no delete call) when the prefix is already empty', async () => {
    vi.mocked(s3Client.send).mockResolvedValueOnce({ Contents: [], IsTruncated: false } as any);
    await fileStorageService.deleteJobFiles('job-1');
    expect(s3Client.send).toHaveBeenCalledTimes(1);
  });

  it('saveRemediatedFile puts under the remediated/ sub-key', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({} as any);
    const key = await fileStorageService.saveRemediatedFile('job-1', 'doc.pdf', Buffer.from('fixed'));
    expect(key).toBe('job-storage/job-1/remediated/doc.pdf');
  });

  it('getRemediatedFile finds the plain filename first', async () => {
    vi.mocked(s3Client.send).mockResolvedValueOnce({ Body: asyncIterableOf(Buffer.from('fixed')) } as any);
    const buffer = await fileStorageService.getRemediatedFile('job-1', 'doc.pdf');
    expect(buffer?.toString()).toBe('fixed');
    const call = vi.mocked(s3Client.send).mock.calls[0][0] as any;
    expect(call.input.Key).toBe('job-storage/job-1/remediated/doc.pdf');
  });

  it('getRemediatedFile falls back to the _remediated suffix convention', async () => {
    vi.mocked(s3Client.send)
      .mockRejectedValueOnce(notFoundError())
      .mockResolvedValueOnce({ Body: asyncIterableOf(Buffer.from('fixed')) } as any);

    const buffer = await fileStorageService.getRemediatedFile('job-1', 'doc.pdf');

    expect(buffer?.toString()).toBe('fixed');
    const secondCall = vi.mocked(s3Client.send).mock.calls[1][0] as any;
    expect(secondCall.input.Key).toBe('job-storage/job-1/remediated/doc_remediated.pdf');
  });

  it('getRemediatedFile returns null when neither candidate exists', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(notFoundError());
    const buffer = await fileStorageService.getRemediatedFile('job-1', 'doc.pdf');
    expect(buffer).toBeNull();
  });

  it('downloadFile fetches an S3 key returned by an earlier saveFile/saveRemediatedFile call', async () => {
    vi.mocked(s3Client.send).mockResolvedValue({ Body: asyncIterableOf(Buffer.from('fixed')) } as any);
    const buffer = await fileStorageService.downloadFile('job-storage/job-1/remediated/doc.pdf');
    expect(buffer.toString()).toBe('fixed');
  });

  it('downloadFile throws when the S3 key is missing', async () => {
    vi.mocked(s3Client.send).mockRejectedValue(notFoundError());
    await expect(fileStorageService.downloadFile('job-storage/job-1/doc.pdf')).rejects.toThrow('File not found in S3');
  });

  it('downloadFile rejects http(s) URLs (not yet implemented)', async () => {
    await expect(fileStorageService.downloadFile('https://example.com/doc.pdf')).rejects.toThrow('not yet implemented');
  });
});

describe('FileStorageService — local-disk fallback (S3 not configured)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(s3Service.isConfigured).mockReturnValue(false);
  });

  it('saveFile writes to disk and returns a local path', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const filePath = await fileStorageService.saveFile('job-1', 'doc.pdf', Buffer.from('hello'));

    expect(filePath).toContain('job-1');
    expect(filePath).toContain('doc.pdf');
    expect(fs.writeFile).toHaveBeenCalledWith(filePath, Buffer.from('hello'));
  });

  it('getFile reads from disk', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('hello') as any);
    const buffer = await fileStorageService.getFile('job-1', 'doc.pdf');
    expect(buffer?.toString()).toBe('hello');
  });

  it('getFile returns null on ENOENT', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(enoent());
    const buffer = await fileStorageService.getFile('job-1', 'missing.pdf');
    expect(buffer).toBeNull();
  });

  it('deleteJobFiles removes the job directory', async () => {
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    await fileStorageService.deleteJobFiles('job-1');
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining('job-1'), { recursive: true, force: true });
  });
});
