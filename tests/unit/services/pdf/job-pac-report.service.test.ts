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

vi.mock('../../../../src/config', () => ({
  config: {
    s3Bucket: 'ninja-epub-staging',
  },
}));

import { Prisma } from '@prisma/client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../../../../src/lib/prisma';
import { s3Client, s3Service } from '../../../../src/services/s3.service';
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
  it('presigns a deterministic, job-storage-prefixed key', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });

    const result = await getJobPacReportUploadUrl('job-1', 'PAC Report Final.pdf', 'application/pdf');

    expect(getSignedUrl).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'ninja-epub-staging',
          Key: 'job-storage/job-1/external-pac-report/pac-report-final.pdf',
        }),
      }),
      { expiresIn: 30 * 60 },
    );
    expect(result.uploadUrl).toBe('https://s3.example.com/signed-url');
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

  it('regenerates the deterministic key server-side, verifies via HeadObjectCommand, and upserts the report', async () => {
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
      }),
      update: expect.objectContaining({ size: 12345 }),
    });
    expect(result.id).toBe('report-1');
  });

  it('upserts (not creates) so a re-upload after a mistake never requires a manual delete first', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
    (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 1 });
    mockPrisma.jobExternalPacReport.upsert.mockResolvedValue({ id: 'report-1' });

    await confirmJobPacReportUpload('job-1', baseInput);
    await confirmJobPacReportUpload('job-1', baseInput);

    expect(mockPrisma.jobExternalPacReport.upsert).toHaveBeenCalledTimes(2);
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
  it('returns true on successful delete', async () => {
    mockPrisma.jobExternalPacReport.delete.mockResolvedValue({ id: 'report-1' });

    await expect(deleteJobPacReport('job-1')).resolves.toBe(true);
  });

  it('returns false (not a thrown error) when no report exists for that job, so a repeat delete is a no-op', async () => {
    const notFoundError = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '5.22.0',
    });
    mockPrisma.jobExternalPacReport.delete.mockRejectedValue(notFoundError);

    await expect(deleteJobPacReport('job-1')).resolves.toBe(false);
  });
});
