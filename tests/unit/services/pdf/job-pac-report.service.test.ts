/**
 * Job External PAC Report Service Tests
 *
 * Job-native counterpart to comparison-study.service.test.ts's own PAC
 * report test block -- same coverage, keyed on jobId instead of trialId,
 * plus a key-prefix assertion confirming the deliberate deviation
 * (job-storage/<jobId>/external-pac-report/... instead of
 * comparison-study/pac-reports/...) that lets deleteJobFiles() sweep it
 * up automatically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      findUnique: vi.fn(),
    },
    jobExternalPacReport: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: {
    getPresignedDownloadUrl: vi.fn(),
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/signed-url')),
}));

vi.mock('../../../../src/services/certification/remediated-file-hash', () => ({
  getCurrentRemediatedFileHash: vi.fn(() => Promise.resolve({ sha256: 'deadbeef', fileRef: 'job-storage/job-1/remediated/x.pdf' })),
}));

vi.mock('../../../../src/services/certification/certification-revoke', () => ({
  revokeActiveCertification: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../../../src/config', () => ({
  config: {
    s3Bucket: 'ninja-epub-staging',
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Prisma } from '@prisma/client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../../../../src/lib/prisma';
import { s3Client, s3Service } from '../../../../src/services/s3.service';
import { getCurrentRemediatedFileHash } from '../../../../src/services/certification/remediated-file-hash';
import { revokeActiveCertification } from '../../../../src/services/certification/certification-revoke';
import { logger } from '../../../../src/lib/logger';
import {
  getJobPacReportUploadUrl,
  confirmJobPacReportUpload,
  getJobPacReport,
  deleteJobPacReport,
} from '../../../../src/services/pdf/job-pac-report.service';

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  jobExternalPacReport: {
    upsert: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getJobPacReportUploadUrl', () => {
  it('presigns a per-upload staging key under job-storage and returns its uploadId', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });

    const result = await getJobPacReportUploadUrl('job-1', 'PAC Report Final.pdf', 'application/pdf');

    expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getSignedUrl).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'ninja-epub-staging',
          Key: `job-storage/job-1/external-pac-report/uploads/${result.uploadId}/pac-report-final.pdf`,
        }),
      }),
      { expiresIn: 30 * 60 },
    );
    expect(result.uploadUrl).toBe('https://s3.example.com/signed-url');
  });

  it('issues a different uploadId (and staging key) per upload of the same file name', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    const a = await getJobPacReportUploadUrl('job-1', 'pac.pdf', 'application/pdf');
    const b = await getJobPacReportUploadUrl('job-1', 'pac.pdf', 'application/pdf');
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it('throws a 404 AppError when the job does not exist', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);

    await expect(getJobPacReportUploadUrl('missing-job', 'report.pdf', 'application/pdf')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('confirmJobPacReportUpload', () => {
  const baseInput = {
    originalFileName: 'PAC Report Final.pdf',
    mimeType: 'application/pdf',
    summary: { pass: 40, fail: 2, untested: 5, humanRequired: 1, notApplicable: 0 },
    uploadedById: 'user-1',
  };

  it('legacy (no uploadId): regenerates the deterministic key server-side, verifies via HeadObjectCommand, and upserts the report', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 12345 });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1', jobId: 'job-1', ...baseInput, size: 12345 });

    const result = await confirmJobPacReportUpload('job-1', baseInput);

    expect(s3Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'ninja-epub-staging',
          Key: 'job-storage/job-1/external-pac-report/pac-report-final.pdf',
        }),
      }),
    );
    expect(mockPrisma.jobExternalPacReport.upsert).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      create: expect.objectContaining({
        jobId: 'job-1',
        s3Key: 'job-storage/job-1/external-pac-report/pac-report-final.pdf',
        size: 12345,
        pass: 40,
        fail: 2,
        untested: 5,
        humanRequired: 1,
        notApplicable: 0,
        uploadedById: 'user-1',
        remediatedSha256: 'deadbeef',
      }),
      update: expect.objectContaining({ size: 12345, remediatedSha256: 'deadbeef' }),
    });
    expect(result.id).toBe('report-1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Legacy confirm without uploadId'));
  });

  it('upserts (not creates) so a re-upload after a mistake never requires a manual delete first', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 1 });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1' });

    await confirmJobPacReportUpload('job-1', baseInput);
    await confirmJobPacReportUpload('job-1', baseInput);

    expect(mockPrisma.jobExternalPacReport.upsert).toHaveBeenCalledTimes(2);
  });

  it('records a null remediatedSha256 when the job has no remediated file yet', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 1 });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1' });
    vi.mocked(getCurrentRemediatedFileHash).mockResolvedValueOnce(null);

    await confirmJobPacReportUpload('job-1', baseInput);

    expect(mockPrisma.jobExternalPacReport.upsert.mock.calls[0][0].create.remediatedSha256).toBeNull();
  });

  it('throws a 404 AppError when the job does not exist', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);

    await expect(confirmJobPacReportUpload('missing-job', baseInput)).rejects.toMatchObject({ statusCode: 404 });
    expect(s3Client.send).not.toHaveBeenCalled();
    expect(mockPrisma.jobExternalPacReport.upsert).not.toHaveBeenCalled();
  });

  it('throws a 400 AppError (not a raw S3 error) when the object never actually landed in S3', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NotFound'));

    await expect(confirmJobPacReportUpload('job-1', baseInput)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.jobExternalPacReport.upsert).not.toHaveBeenCalled();
  });
});

describe('getJobPacReport', () => {
  it('returns null when no report has been uploaded, without calling S3', async () => {
    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValue(null);

    const result = await getJobPacReport('job-1');

    expect(result).toBeNull();
    expect(s3Service.getPresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns the report plus a presigned download URL when one exists', async () => {
    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValue({
      id: 'report-1',
      jobId: 'job-1',
      s3Key: 'job-storage/job-1/external-pac-report/report.pdf',
    });
    (s3Service.getPresignedDownloadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      downloadUrl: 'https://s3.example.com/download-url',
      expiresIn: 3600,
    });

    const result = await getJobPacReport('job-1');

    expect(s3Service.getPresignedDownloadUrl).toHaveBeenCalledWith('job-storage/job-1/external-pac-report/report.pdf');
    expect(result).toMatchObject({ id: 'report-1', downloadUrl: 'https://s3.example.com/download-url' });
  });
});

describe('deleteJobPacReport', () => {
  it('returns true on successful delete, and revokes the active certification', async () => {
    mockPrisma.jobExternalPacReport.delete.mockResolvedValue({ id: 'report-1' });

    await expect(deleteJobPacReport('job-1')).resolves.toBe(true);
    expect(revokeActiveCertification).toHaveBeenCalledWith('job-1', 'pac-report-deleted');
  });

  it('returns false (not a thrown error) when no report exists for that job, so a repeat delete is a no-op', async () => {
    const notFoundError = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '5.22.0',
    });
    mockPrisma.jobExternalPacReport.delete.mockRejectedValue(notFoundError);

    await expect(deleteJobPacReport('job-1')).resolves.toBe(false);
    expect(revokeActiveCertification).not.toHaveBeenCalled();
  });
});

describe('confirmJobPacReportUpload -- certification evidence', () => {
  const input = {
    originalFileName: 'pac.pdf', mimeType: 'application/pdf', summary: { fail: 0 }, uploadedById: 'user-1',
  };

  it('a first upload revokes nothing; replacing an existing report revokes the active certification', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 1 });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1' });

    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValueOnce(null);
    await confirmJobPacReportUpload('job-1', input);
    expect(revokeActiveCertification).not.toHaveBeenCalled();

    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValueOnce({ id: 'report-1' });
    await confirmJobPacReportUpload('job-1', input);
    expect(revokeActiveCertification).toHaveBeenCalledWith('job-1', 'pac-report-replaced');
  });
});

describe('confirmJobPacReportUpload -- staging/confirmed split', () => {
  const UPLOAD_ID = '6f1c2b0e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  const STAGING = `job-storage/job-1/external-pac-report/uploads/${UPLOAD_ID}/pac-report-final.pdf`;
  const CONFIRMED = `job-storage/job-1/external-pac-report/confirmed/${UPLOAD_ID}.pdf`;
  const input = {
    uploadId: UPLOAD_ID,
    originalFileName: 'PAC Report Final.pdf',
    mimeType: 'application/pdf',
    summary: { fail: 3 },
    uploadedById: 'user-1',
  };
  const send = s3Client.send as ReturnType<typeof vi.fn>;
  const commands = () => send.mock.calls.map((c) => ({ name: c[0].constructor.name, input: c[0].input }));

  beforeEach(() => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1' });
    send.mockImplementation((cmd: { constructor: { name: string } }) =>
      Promise.resolve(cmd.constructor.name === 'HeadObjectCommand' ? { ContentLength: 777, ETag: '"e1"' } : {}));
  });

  it('copies exactly the HEADed version to an immutable confirmed key, records that key, then deletes the staging object', async () => {
    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValue(null);

    await confirmJobPacReportUpload('job-1', input);

    const cmds = commands();
    expect(cmds[0]).toEqual({ name: 'HeadObjectCommand', input: { Bucket: 'ninja-epub-staging', Key: STAGING } });
    expect(cmds[1]).toEqual({
      name: 'CopyObjectCommand',
      input: { Bucket: 'ninja-epub-staging', Key: CONFIRMED, CopySource: `ninja-epub-staging/${STAGING}`, CopySourceIfMatch: '"e1"' },
    });
    expect(mockPrisma.jobExternalPacReport.upsert.mock.calls[0][0].create).toMatchObject({ s3Key: CONFIRMED, size: 777, fail: 3 });
    expect(cmds[2]).toEqual({ name: 'DeleteObjectCommand', input: { Bucket: 'ninja-epub-staging', Key: STAGING } });
    expect(cmds).toHaveLength(3);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('replacing a report deletes the previous confirmed object (after the record switched)', async () => {
    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValue({
      id: 'report-1', s3Key: 'job-storage/job-1/external-pac-report/confirmed/old.pdf',
    });

    await confirmJobPacReportUpload('job-1', input);

    expect(revokeActiveCertification).toHaveBeenCalledWith('job-1', 'pac-report-replaced');
    const deletes = commands().filter((c) => c.name === 'DeleteObjectCommand').map((c) => c.input.Key);
    expect(deletes).toEqual([STAGING, 'job-storage/job-1/external-pac-report/confirmed/old.pdf']);
  });

  it('the staged file changed between HEAD and copy: 409, nothing recorded', async () => {
    send.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'HeadObjectCommand') return Promise.resolve({ ContentLength: 1, ETag: '"e1"' });
      return Promise.reject(Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
        name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 },
      }));
    });

    await expect(confirmJobPacReportUpload('job-1', input)).rejects.toMatchObject({
      statusCode: 409, code: 'PAC_REPORT_UPLOAD_CHANGED',
    });
    expect(mockPrisma.jobExternalPacReport.upsert).not.toHaveBeenCalled();
  });

  it('a staging object that never landed: 400 before any copy', async () => {
    send.mockRejectedValue(new Error('NotFound'));
    await expect(confirmJobPacReportUpload('job-1', input)).rejects.toMatchObject({ statusCode: 400 });
    expect(commands().map((c) => c.name)).toEqual(['HeadObjectCommand']);
  });

  it('a file name without a usable extension gets a .bin confirmed key', async () => {
    mockPrisma.jobExternalPacReport.findUnique.mockResolvedValue(null);
    await confirmJobPacReportUpload('job-1', { ...input, originalFileName: 'report' });
    expect(mockPrisma.jobExternalPacReport.upsert.mock.calls[0][0].create.s3Key)
      .toBe(`job-storage/job-1/external-pac-report/confirmed/${UPLOAD_ID}.bin`);
  });
});

describe('deleteJobPacReport -- S3 cleanup', () => {
  it('deletes the stored object after the record', async () => {
    mockPrisma.jobExternalPacReport.delete.mockResolvedValue({ id: 'report-1', s3Key: 'job-storage/job-1/external-pac-report/confirmed/x.pdf' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await expect(deleteJobPacReport('job-1')).resolves.toBe(true);

    const call = (s3Client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.constructor.name).toBe('DeleteObjectCommand');
    expect(call.input).toEqual({ Bucket: 'ninja-epub-staging', Key: 'job-storage/job-1/external-pac-report/confirmed/x.pdf' });
  });

  it('a failed S3 delete is logged, not thrown (the record is already gone)', async () => {
    mockPrisma.jobExternalPacReport.delete.mockResolvedValue({ id: 'report-1', s3Key: 'k' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('AccessDenied'));

    await expect(deleteJobPacReport('job-1')).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not delete deleted report k'));
  });
});
