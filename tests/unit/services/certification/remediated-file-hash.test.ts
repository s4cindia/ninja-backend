import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Readable } from 'stream';

vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: vi.fn(), updateMany: vi.fn() } },
}));

vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    openReadStreamWithFingerprint: vi.fn(), getFileFingerprint: vi.fn(),
    downloadFile: vi.fn(), findRemediatedFileRef: vi.fn(),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import {
  getCurrentRemediatedFileHash,
  sha256Hex,
  sha256OfStream,
} from '../../../../src/services/certification/remediated-file-hash';

const findUnique = prisma.job.findUnique as unknown as ReturnType<typeof vi.fn>;
const updateMany = prisma.job.updateMany as unknown as ReturnType<typeof vi.fn>;
const openStream = fileStorageService.openReadStreamWithFingerprint as unknown as ReturnType<typeof vi.fn>;
const getFileFingerprint = fileStorageService.getFileFingerprint as unknown as ReturnType<typeof vi.fn>;
const downloadFile = fileStorageService.downloadFile as unknown as ReturnType<typeof vi.fn>;
const findRemediatedFileRef = fileStorageService.findRemediatedFileRef as unknown as ReturnType<typeof vi.fn>;

const REF = 'job-storage/job-1/remediated/a.pdf';
const FP = 's3:-:"etag-1"';

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ output: { remediatedFileUrl: REF } });
});

describe('sha256OfStream', () => {
  it('matches the one-shot hash across many uneven chunks', async () => {
    // 3 MB in 64 KiB + odd-sized chunks, like an S3 body arrives.
    const whole = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < whole.length; i++) whole[i] = (i * 31) % 251;
    const chunks: Buffer[] = [];
    for (let off = 0, n = 0; off < whole.length; n++) {
      const size = n % 3 === 0 ? 65536 : 12345;
      chunks.push(whole.subarray(off, off + size));
      off += size;
    }
    expect(chunks.length).toBeGreaterThan(50);

    expect(await sha256OfStream(Readable.from(chunks))).toBe(sha256Hex(whole));
  });

  it('hashes an empty stream like an empty buffer', async () => {
    expect(await sha256OfStream(Readable.from([]))).toBe(sha256Hex(Buffer.alloc(0)));
  });
});

describe('getCurrentRemediatedFileHash', () => {
  it('streams the bytes behind output.remediatedFileUrl and never buffers via downloadFile', async () => {
    const parts = [Buffer.from('%PDF-1.7 '), Buffer.from('synthetic '), Buffer.from('body')];
    openStream.mockResolvedValue({ stream: Readable.from(parts), fingerprint: FP });

    const result = await getCurrentRemediatedFileHash('job-1');

    expect(openStream).toHaveBeenCalledWith(REF);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(result).toEqual({
      sha256: createHash('sha256').update(Buffer.concat(parts)).digest('hex'),
      fileRef: REF,
    });
  });

  it('gives a different hash when a single byte changes', () => {
    expect(sha256Hex(Buffer.from('abc'))).not.toBe(sha256Hex(Buffer.from('abd')));
  });

  it('returns null when no URL is recorded and the download fallback finds no file either', async () => {
    findUnique.mockResolvedValue({ output: { auditReport: {} }, input: { fileName: 'book.pdf' } });
    findRemediatedFileRef.mockResolvedValue(null);
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
    expect(findRemediatedFileRef).toHaveBeenCalledWith('job-1', 'book.pdf');
    expect(openStream).not.toHaveBeenCalled();
  });

  it('without a recorded URL, hashes the file the download endpoint would serve (name fallback)', async () => {
    findUnique.mockResolvedValue({ output: {}, input: { fileName: 'book.pdf' } });
    findRemediatedFileRef.mockResolvedValue('job-storage/job-1/remediated/book_remediated.pdf');
    openStream.mockResolvedValue({ stream: Readable.from([Buffer.from('bytes')]), fingerprint: FP });

    const result = await getCurrentRemediatedFileHash('job-1');

    expect(openStream).toHaveBeenCalledWith('job-storage/job-1/remediated/book_remediated.pdf');
    expect(result).toEqual({ sha256: sha256Hex(Buffer.from('bytes')), fileRef: 'job-storage/job-1/remediated/book_remediated.pdf' });
  });

  it('falls back to "document.pdf" when the job input has no file name, like the download endpoint', async () => {
    findUnique.mockResolvedValue({ output: {}, input: {} });
    findRemediatedFileRef.mockResolvedValue(null);
    await getCurrentRemediatedFileHash('job-1');
    expect(findRemediatedFileRef).toHaveBeenCalledWith('job-1', 'document.pdf');
  });

  it('a recorded URL wins: no name fallback even if its object is gone', async () => {
    openStream.mockRejectedValue(new Error(`File not found in S3: ${REF}`));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
    expect(findRemediatedFileRef).not.toHaveBeenCalled();
  });

  it('returns null when the job or its output is missing', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null when the referenced object is gone (S3 not-found)', async () => {
    openStream.mockRejectedValue(new Error(`File not found in S3: ${REF}`));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null on a local ENOENT', async () => {
    openStream.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('rethrows a real storage failure instead of reporting "no file"', async () => {
    openStream.mockRejectedValue(new Error('AccessDenied'));
    await expect(getCurrentRemediatedFileHash('job-1')).rejects.toThrow('AccessDenied');
  });

  it('rethrows a failure part-way through the stream', async () => {
    async function* broken() {
      yield Buffer.from('first chunk');
      throw new Error('ECONNRESET');
    }
    openStream.mockResolvedValue({ stream: Readable.from(broken()), fingerprint: FP });
    await expect(getCurrentRemediatedFileHash('job-1')).rejects.toThrow('ECONNRESET');
  });
});

describe('getCurrentRemediatedFileHash -- cached hash', () => {
  const CACHED = 'c'.repeat(64);
  const cachedJob = (over: Record<string, unknown> = {}) => ({
    output: { remediatedFileUrl: REF },
    remediatedSha256: CACHED, remediatedSha256Ref: REF, remediatedSha256Fingerprint: FP, ...over,
  });

  it('same object version (HEAD fingerprint matches): returns the cached hash without reading the file', async () => {
    findUnique.mockResolvedValue(cachedJob());
    getFileFingerprint.mockResolvedValue(FP);

    expect(await getCurrentRemediatedFileHash('job-1')).toEqual({ sha256: CACHED, fileRef: REF });
    expect(getFileFingerprint).toHaveBeenCalledWith(REF);
    expect(openStream).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('fingerprint changed: re-hashes and caches under the fingerprint of the GET that produced the bytes', async () => {
    findUnique.mockResolvedValue(cachedJob());
    getFileFingerprint.mockResolvedValue('s3:-:"etag-2"');
    openStream.mockResolvedValue({ stream: Readable.from([Buffer.from('new bytes')]), fingerprint: 's3:-:"etag-3"' });

    const result = await getCurrentRemediatedFileHash('job-1');

    expect(result).toEqual({ sha256: sha256Hex(Buffer.from('new bytes')), fileRef: REF });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        remediatedSha256: sha256Hex(Buffer.from('new bytes')),
        remediatedSha256Ref: REF,
        remediatedSha256Fingerprint: 's3:-:"etag-3"',
      }),
    });
  });

  it('cache for a different stored file is ignored (no HEAD shortcut)', async () => {
    findUnique.mockResolvedValue(cachedJob({ remediatedSha256Ref: 'job-storage/job-1/remediated/other.pdf' }));
    openStream.mockResolvedValue({ stream: Readable.from([Buffer.from('x')]), fingerprint: FP });

    expect(await getCurrentRemediatedFileHash('job-1')).toEqual({ sha256: sha256Hex(Buffer.from('x')), fileRef: REF });
    expect(getFileFingerprint).not.toHaveBeenCalled();
  });

  it('HEAD finds the object gone: null, even with a cached hash', async () => {
    findUnique.mockResolvedValue(cachedJob());
    getFileFingerprint.mockResolvedValue(null);
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('a read with no fingerprint (S3 returned neither ETag nor version) is not cached', async () => {
    openStream.mockResolvedValue({ stream: Readable.from([Buffer.from('x')]), fingerprint: null });
    await getCurrentRemediatedFileHash('job-1');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
