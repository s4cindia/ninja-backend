import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { updateMany: vi.fn() },
    jobCertification: { updateMany: vi.fn() },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const listeners: Array<(e: unknown) => unknown> = [];
vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    onRemediatedFileSaved: vi.fn((l: (e: unknown) => unknown) => {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    }),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import { sha256Hex } from '../../../../src/services/certification/remediated-file-hash';
import {
  onRemediatedFileSaved,
  registerRemediatedFileSaveHook,
  unregisterRemediatedFileSaveHook,
} from '../../../../src/services/certification/remediated-file-save-hook';

const jobUpdateMany = prisma.job.updateMany as unknown as ReturnType<typeof vi.fn>;
const certUpdateMany = prisma.jobCertification.updateMany as unknown as ReturnType<typeof vi.fn>;

const REF = 'job-storage/job-1/remediated/doc.pdf';
const bytes = Buffer.from('%PDF-1.7 synthetic remediated bytes');
const event = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1', fileName: 'doc.pdf', fileRef: REF, buffer: bytes, fingerprint: 's3:-:"e1"', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  certUpdateMany.mockResolvedValue({ count: 0 });
  jobUpdateMany.mockResolvedValue({ count: 1 });
});

describe('remediated-file save hook', () => {
  it('caches the new hash against the written object version', async () => {
    await onRemediatedFileSaved(event());
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        remediatedSha256: sha256Hex(bytes),
        remediatedSha256Ref: REF,
        remediatedSha256Fingerprint: 's3:-:"e1"',
      }),
    });
  });

  it('revokes only a certification of this same file whose certified hash differs', async () => {
    certUpdateMany.mockResolvedValue({ count: 1 });
    await onRemediatedFileSaved(event());
    expect(certUpdateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', revokedAt: null, remediatedFileRef: REF, pdfSha256: { not: sha256Hex(bytes) } },
      data: expect.objectContaining({ revokedReason: 'pdf-changed', revokedById: null }),
    });
  });

  it('ignores non-PDF saves (EPUB jobs share saveRemediatedFile)', async () => {
    await onRemediatedFileSaved(event({ fileName: 'book.epub', fileRef: 'job-storage/job-1/remediated/book.epub' }));
    expect(jobUpdateMany).not.toHaveBeenCalled();
    expect(certUpdateMany).not.toHaveBeenCalled();
  });

  it('registration is idempotent and can be undone', () => {
    registerRemediatedFileSaveHook();
    registerRemediatedFileSaveHook();
    expect(fileStorageService.onRemediatedFileSaved).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
    unregisterRemediatedFileSaveHook();
    expect(listeners).toHaveLength(0);
  });
});
