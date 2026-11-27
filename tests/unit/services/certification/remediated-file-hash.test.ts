import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: vi.fn() } },
}));

vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { downloadFile: vi.fn() },
}));

import prisma from '../../../../src/lib/prisma';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { getCurrentRemediatedFileHash, sha256Hex } from '../../../../src/services/certification/remediated-file-hash';

const findUnique = prisma.job.findUnique as unknown as ReturnType<typeof vi.fn>;
const downloadFile = fileStorageService.downloadFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('getCurrentRemediatedFileHash', () => {
  it('hashes the bytes behind output.remediatedFileUrl', async () => {
    const bytes = Buffer.from('%PDF-1.7 synthetic');
    findUnique.mockResolvedValue({ output: { remediatedFileUrl: 'job-storage/job-1/remediated/a.pdf' } });
    downloadFile.mockResolvedValue(bytes);

    const result = await getCurrentRemediatedFileHash('job-1');

    expect(downloadFile).toHaveBeenCalledWith('job-storage/job-1/remediated/a.pdf');
    expect(result).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fileRef: 'job-storage/job-1/remediated/a.pdf',
    });
  });

  it('gives a different hash when a single byte changes', () => {
    expect(sha256Hex(Buffer.from('abc'))).not.toBe(sha256Hex(Buffer.from('abd')));
  });

  it('returns null when the job has no remediated file recorded', async () => {
    findUnique.mockResolvedValue({ output: { auditReport: {} } });
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('returns null when the job or its output is missing', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null when the referenced object is gone (S3 not-found)', async () => {
    findUnique.mockResolvedValue({ output: { remediatedFileUrl: 'k' } });
    downloadFile.mockRejectedValue(new Error('File not found in S3: k'));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('returns null on a local ENOENT', async () => {
    findUnique.mockResolvedValue({ output: { remediatedFileUrl: '/tmp/x.pdf' } });
    downloadFile.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await getCurrentRemediatedFileHash('job-1')).toBeNull();
  });

  it('rethrows a real storage failure instead of reporting "no file"', async () => {
    findUnique.mockResolvedValue({ output: { remediatedFileUrl: 'k' } });
    downloadFile.mockRejectedValue(new Error('AccessDenied'));
    await expect(getCurrentRemediatedFileHash('job-1')).rejects.toThrow('AccessDenied');
  });
});
