import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Readable } from 'stream';

vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: vi.fn() } },
}));

vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { openReadStream: vi.fn(), downloadFile: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import {
  getCurrentRemediatedFileHash,
  sha256Hex,
  sha256OfStream,
} from '../../../../src/services/certification/remediated-file-hash';

const findUnique = prisma.job.findUnique as unknown as ReturnType<typeof vi.fn>;
const openReadStream = fileStorageService.openReadStream as unknown as ReturnType<typeof vi.fn>;
const downloadFile = fileStorageService.downloadFile as unknown as ReturnType<typeof vi.fn>;

const REF = 'job-storage/job-1/remediated/a.pdf';

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
    openReadStream.mockResolvedValue(Readable.from(parts));

    const result = await getCurrentRemediatedFileHash('job-1');

    expect(openReadStream).toHaveBeenCalledWith(REF);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(result).toEqual({
      sha256: createHash('sha256').update(Buffer.concat(parts)).digest('hex'),
      fileRef: REF,
    });
  });

  it('gives a different hash when a single byte changes', () => {
    expect(sha256Hex(Buffer.from('abc'))).not.toBe(sha256Hex(Buffer.from('abd')));
  });

  it('returns null when the job has no remediated file recorded', async () => {
    findUnique.mockResolvedValue({ output: { auditReport: {} } });
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it('returns null when the job or its output is missing', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null when the referenced object is gone (S3 not-found)', async () => {
    openReadStream.mockRejectedValue(new Error(`File not found in S3: ${REF}`));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null on a local ENOENT', async () => {
    openReadStream.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('rethrows a real storage failure instead of reporting "no file"', async () => {
    openReadStream.mockRejectedValue(new Error('AccessDenied'));
    await expect(getCurrentRemediatedFileHash('job-1')).rejects.toThrow('AccessDenied');
  });

  it('rethrows a failure part-way through the stream', async () => {
    async function* broken() {
      yield Buffer.from('first chunk');
      throw new Error('ECONNRESET');
    }
    openReadStream.mockResolvedValue(Readable.from(broken()));
    await expect(getCurrentRemediatedFileHash('job-1')).rejects.toThrow('ECONNRESET');
  });
});
