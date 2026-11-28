/**
 * Save-time revocation through the REAL storage path, in S3 mode: the real
 * fileStorageService.saveRemediatedFile with the real hook registered; only
 * the S3 client and Prisma are mocked. Local dev (no S3) only exercises the
 * read-time check, so this is the test that covers the S3 key form the
 * hook actually sees in staging/production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: { isConfigured: vi.fn(() => true) },
}));

vi.mock('../../../../src/config', () => ({ config: { s3Bucket: 'test-bucket' } }));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { updateMany: vi.fn() },
    jobCertification: { updateMany: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { s3Client } from '../../../../src/services/s3.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import {
  registerRemediatedFileSaveHook,
  unregisterRemediatedFileSaveHook,
} from '../../../../src/services/certification/remediated-file-save-hook';

const jobUpdateMany = prisma.job.updateMany as unknown as ReturnType<typeof vi.fn>;
const certUpdateMany = prisma.jobCertification.updateMany as unknown as ReturnType<typeof vi.fn>;
const send = s3Client.send as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ ETag: '"9b2cf535f27731c974343645a3985328"', VersionId: 'v-42' });
  jobUpdateMany.mockResolvedValue({ count: 1 });
  certUpdateMany.mockResolvedValue({ count: 1 });
  registerRemediatedFileSaveHook();
});

afterEach(() => unregisterRemediatedFileSaveHook());

describe('save-time revocation via saveRemediatedFile (S3 mode)', () => {
  it('re-saving the remediated PDF caches its hash under the S3 key + ETag/version and revokes a certification of that key', async () => {
    const bytes = Buffer.from('%PDF-1.7 synthetic remediated bytes, round 2');
    const sha = createHash('sha256').update(bytes).digest('hex');

    const key = await fileStorageService.saveRemediatedFile('job-1', 'book.pdf', bytes);

    expect(key).toBe('job-storage/job-1/remediated/book.pdf');
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        remediatedSha256: sha,
        remediatedSha256Ref: 'job-storage/job-1/remediated/book.pdf',
        remediatedSha256Fingerprint: 's3:v-42:"9b2cf535f27731c974343645a3985328"',
      }),
    });
    expect(certUpdateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        revokedAt: null,
        remediatedFileRef: 'job-storage/job-1/remediated/book.pdf',
        pdfSha256: { not: sha },
      },
      data: expect.objectContaining({ revokedReason: 'pdf-changed', revokedById: null }),
    });
  });

  it('a database failure in the hook does not fail the save', async () => {
    jobUpdateMany.mockRejectedValue(new Error('connection reset'));
    await expect(fileStorageService.saveRemediatedFile('job-1', 'book.pdf', Buffer.from('%PDF x')))
      .resolves.toBe('job-storage/job-1/remediated/book.pdf');
  });
});
