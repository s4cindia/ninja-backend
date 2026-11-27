import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn() },
    jobExternalAcrobatReport: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: { getPresignedDownloadUrl: vi.fn() },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/signed-url')),
}));

vi.mock('../../../../src/config', () => ({ config: { s3Bucket: 'test-bucket' } }));

vi.mock('../../../../src/services/certification/remediated-file-hash', () => ({
  getCurrentRemediatedFileHash: vi.fn(),
}));

import { Prisma } from '@prisma/client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../../../../src/lib/prisma';
import { s3Client, s3Service } from '../../../../src/services/s3.service';
import { getCurrentRemediatedFileHash } from '../../../../src/services/certification/remediated-file-hash';
import { AppError } from '../../../../src/utils/app-error';
import {
  getJobAcrobatReportUploadUrl,
  confirmJobAcrobatReportUpload,
  getJobAcrobatReport,
  deleteJobAcrobatReport,
} from '../../../../src/services/certification/job-acrobat-report.service';

const FIXTURE = readFileSync(
  path.join(__dirname, '../../../fixtures/acrobat-report/synthetic-acrobat-report.html'),
  'utf8',
);

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  jobExternalAcrobatReport: {
    upsert: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};
const send = s3Client.send as unknown as ReturnType<typeof vi.fn>;
const hash = getCurrentRemediatedFileHash as unknown as ReturnType<typeof vi.fn>;

/** S3 holds `html` at whatever key is asked for; records the keys. */
function s3Holds(html: string, opts: { contentLength?: number } = {}) {
  const keys: string[] = [];
  send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) {
      keys.push(cmd.input.Key!);
      return { ContentLength: opts.contentLength ?? Buffer.byteLength(html) };
    }
    if (cmd instanceof GetObjectCommand) {
      keys.push(cmd.input.Key!);
      return { Body: { transformToString: async () => html } };
    }
    throw new Error('unexpected command');
  });
  return keys;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
  mockPrisma.jobExternalAcrobatReport.upsert.mockImplementation(async ({ create }: { create: unknown }) => ({ id: 'r1', ...(create as object) }));
  hash.mockResolvedValue({ sha256: 'abc123', fileRef: 'job-storage/job-1/remediated/x.pdf' });
});

describe('getJobAcrobatReportUploadUrl', () => {
  it('presigns a deterministic job-storage key signed as text/html', async () => {
    const result = await getJobAcrobatReportUploadUrl('job-1', 'My Report (2).html');

    expect(getSignedUrl).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'job-storage/job-1/external-acrobat-report/my-report--2-.html',
          ContentType: 'text/html',
        }),
      }),
      { expiresIn: 1800 },
    );
    expect(result).toEqual({ uploadUrl: 'https://s3.example.com/signed-url', expiresIn: 1800, contentType: 'text/html' });
  });

  it('404s for an unknown job', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);
    await expect(getJobAcrobatReportUploadUrl('nope', 'r.html')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('confirmJobAcrobatReportUpload', () => {
  it('stores parsed counts, failed rules and the remediated-file hash', async () => {
    const keys = s3Holds(FIXTURE);

    const { report, parse } = await confirmJobAcrobatReportUpload('job-1', {
      originalFileName: 'Report.html',
      uploadedById: 'user-1',
    });

    // Same server-derived key on both reads -- never a client path.
    expect(keys).toEqual([
      'job-storage/job-1/external-acrobat-report/report.html',
      'job-storage/job-1/external-acrobat-report/report.html',
    ]);
    expect(parse.trusted).toBe(true);
    const call = mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ jobId: 'job-1' });
    expect(call.create).toMatchObject({
      jobId: 'job-1',
      passed: 27,
      failed: 3,
      needsManualCheck: 2,
      skipped: 0,
      passedManually: 0,
      failedManually: 0,
      countsSource: 'parsed',
      remediatedSha256: 'abc123',
      uploadedById: 'user-1',
      mimeType: 'text/html',
    });
    expect((call.create.failedRules as { ruleId: string }[]).map((r) => r.ruleId)).toEqual([
      'TabOrder', 'TableHeaders', 'ListItems',
    ]);
    expect(call.update).toEqual(expect.objectContaining({ countsSource: 'parsed' }));
    expect(report.id).toBe('r1');
  });

  it('prefers parsed counts over operator counts when the parse is trusted', async () => {
    s3Holds(FIXTURE);
    await confirmJobAcrobatReportUpload('job-1', {
      originalFileName: 'r.html',
      uploadedById: 'u',
      operatorCounts: { passed: 32, failed: 0, needsManualCheck: 0, skipped: 0 },
    });
    expect(mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create).toMatchObject({
      failed: 3, countsSource: 'parsed',
    });
  });

  it('refuses with 422 + the parse result when it cannot parse and no counts were given', async () => {
    s3Holds(FIXTURE.replace('<li>Failed: 3</li>', '<li>Failed: 0</li>'));

    const err = await confirmJobAcrobatReportUpload('job-1', { originalFileName: 'r.html', uploadedById: 'u' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 422, code: 'ACROBAT_REPORT_COUNTS_REQUIRED' });
    const details = (err as AppError).details as { parse: { trusted: boolean; failedRules: unknown[] } };
    expect(details.parse.trusted).toBe(false);
    expect(details.parse.failedRules).toHaveLength(3);
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
  });

  it('stores operator counts (marked operator) when the parse is not trusted', async () => {
    s3Holds(FIXTURE.replace('<li>Failed: 3</li>', '<li>Failed: 0</li>'));
    await confirmJobAcrobatReportUpload('job-1', {
      originalFileName: 'r.html',
      uploadedById: 'u',
      operatorCounts: { passed: 27, failed: 3, needsManualCheck: 2, skipped: 0 },
    });
    const create = mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ failed: 3, countsSource: 'operator', passedManually: null, failedManually: null });
    expect((create.parseWarnings as string[]).join(' ')).toMatch(/rule table has 3/);
  });

  it('records a null hash when the job has no remediated file yet', async () => {
    s3Holds(FIXTURE);
    hash.mockResolvedValue(null);
    await confirmJobAcrobatReportUpload('job-1', { originalFileName: 'r.html', uploadedById: 'u' });
    expect(mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create.remediatedSha256).toBeNull();
  });

  it('400s when the object never landed in S3', async () => {
    send.mockRejectedValue(new Error('NotFound'));
    await expect(
      confirmJobAcrobatReportUpload('job-1', { originalFileName: 'r.html', uploadedById: 'u' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
  });

  it('400s on an oversized object without downloading it', async () => {
    const keys = s3Holds(FIXTURE, { contentLength: 50 * 1024 * 1024 });
    await expect(
      confirmJobAcrobatReportUpload('job-1', { originalFileName: 'r.html', uploadedById: 'u' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'ACROBAT_REPORT_TOO_LARGE' });
    expect(keys).toHaveLength(1); // HEAD only, no GET
  });
});

describe('getJobAcrobatReport / deleteJobAcrobatReport', () => {
  it('returns the report with a presigned download URL, or null', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValueOnce({ id: 'r1', s3Key: 'k' });
    (s3Service.getPresignedDownloadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ downloadUrl: 'https://dl' });
    expect(await getJobAcrobatReport('job-1')).toEqual({ id: 'r1', s3Key: 'k', downloadUrl: 'https://dl' });

    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValueOnce(null);
    expect(await getJobAcrobatReport('job-1')).toBeNull();
  });

  it('delete returns false (not an error) when nothing exists', async () => {
    mockPrisma.jobExternalAcrobatReport.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: 'x' }),
    );
    expect(await deleteJobAcrobatReport('job-1')).toBe(false);
  });

  it('delete returns true when a report was removed', async () => {
    mockPrisma.jobExternalAcrobatReport.delete.mockResolvedValue({});
    expect(await deleteJobAcrobatReport('job-1')).toBe(true);
  });
});
