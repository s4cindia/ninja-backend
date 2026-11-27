import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn() },
    jobExternalAcrobatReport: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: {},
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
import { s3Client } from '../../../../src/services/s3.service';
import { getCurrentRemediatedFileHash } from '../../../../src/services/certification/remediated-file-hash';
import { AppError } from '../../../../src/utils/app-error';
import { MAX_ACROBAT_REPORT_BYTES } from '../../../../src/services/certification/acrobat-report-parser';
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

const UPLOAD_ID = '6f1c2a54-9d3e-4b7a-8c11-2e5f0a9b7c3d';
const STAGING_KEY = `job-storage/job-1/external-acrobat-report/uploads/${UPLOAD_ID}/report.html`;
const CONFIRMED_KEY = `job-storage/job-1/external-acrobat-report/confirmed/${UPLOAD_ID}.html`;
const OLD_KEY = 'job-storage/job-1/external-acrobat-report/confirmed/0b6e1f7a-0000-4000-8000-000000000000.html';

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

interface S3Log { head: string[]; get: string[]; put: { key: string; body: Buffer }[]; deleted: string[] }

/**
 * S3 holds `html` at any key. `headSize` lets HEAD report a different
 * size from what GET then streams (an object swapped between the two).
 */
function s3Holds(html: string | Buffer, opts: { headSize?: number; deleteFails?: boolean } = {}): S3Log {
  const bytes = Buffer.isBuffer(html) ? html : Buffer.from(html);
  const log: S3Log = { head: [], get: [], put: [], deleted: [] };
  send.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof HeadObjectCommand) {
      log.head.push(cmd.input.Key!);
      return { ContentLength: opts.headSize ?? bytes.length };
    }
    if (cmd instanceof GetObjectCommand) {
      log.get.push(cmd.input.Key!);
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += 64 * 1024) chunks.push(bytes.subarray(i, i + 64 * 1024));
      return { Body: Readable.from(chunks) };
    }
    if (cmd instanceof PutObjectCommand) {
      log.put.push({ key: cmd.input.Key!, body: cmd.input.Body as Buffer });
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      log.deleted.push(cmd.input.Key!);
      if (opts.deleteFails) throw new Error('AccessDenied');
      return {};
    }
    throw new Error('unexpected command');
  });
  return log;
}

function confirm(extra: Partial<Parameters<typeof confirmJobAcrobatReportUpload>[1]> = {}) {
  return confirmJobAcrobatReportUpload('job-1', {
    uploadId: UPLOAD_ID,
    originalFileName: 'Report.html',
    uploadedById: 'user-1',
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.job.findUnique.mockResolvedValue({ id: 'job-1' });
  mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValue(null);
  mockPrisma.jobExternalAcrobatReport.upsert.mockImplementation(async ({ create }: { create: unknown }) => ({ id: 'r1', ...(create as object) }));
  hash.mockResolvedValue({ sha256: 'abc123', fileRef: 'job-storage/job-1/remediated/x.pdf' });
});

describe('getJobAcrobatReportUploadUrl', () => {
  it('presigns a fresh staging key under uploads/, signed as text/html, and returns its uploadId', async () => {
    const result = await getJobAcrobatReportUploadUrl('job-1', 'My Report (2).html');

    expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getSignedUrl).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'test-bucket',
          Key: `job-storage/job-1/external-acrobat-report/uploads/${result.uploadId}/my-report--2-.html`,
          ContentType: 'text/html',
        }),
      }),
      { expiresIn: 1800 },
    );
    expect(result).toMatchObject({ uploadUrl: 'https://s3.example.com/signed-url', expiresIn: 1800, contentType: 'text/html' });
  });

  it('never reuses a key, even for the same file name', async () => {
    const a = await getJobAcrobatReportUploadUrl('job-1', 'report.html');
    const b = await getJobAcrobatReportUploadUrl('job-1', 'report.html');
    expect(a.uploadId).not.toBe(b.uploadId);
  });

  it('404s for an unknown job', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);
    await expect(getJobAcrobatReportUploadUrl('nope', 'r.html')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('confirmJobAcrobatReportUpload', () => {
  it('parses the staged upload, writes exactly those bytes to the confirmed key, and records that key', async () => {
    const log = s3Holds(FIXTURE);

    const { report, parse } = await confirm();

    expect(log.head).toEqual([STAGING_KEY]);
    expect(log.get).toEqual([STAGING_KEY]);
    expect(log.put).toHaveLength(1);
    expect(log.put[0].key).toBe(CONFIRMED_KEY);
    expect(log.put[0].body.equals(Buffer.from(FIXTURE))).toBe(true);
    expect(parse.trusted).toBe(true);
    const call = mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ jobId: 'job-1' });
    expect(call.create).toMatchObject({
      jobId: 'job-1',
      s3Key: CONFIRMED_KEY,
      size: Buffer.byteLength(FIXTURE),
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
    expect(report.id).toBe('r1');
  });

  it('after the record switches, deletes the staging upload (and nothing else on a first upload)', async () => {
    const log = s3Holds(FIXTURE);
    await confirm();
    expect(log.deleted).toEqual([STAGING_KEY]);
    const upsertOrder = mockPrisma.jobExternalAcrobatReport.upsert.mock.invocationCallOrder[0];
    const firstDeleteOrder = send.mock.invocationCallOrder[send.mock.calls.findIndex(([c]) => c instanceof DeleteObjectCommand)];
    expect(upsertOrder).toBeLessThan(firstDeleteOrder);
  });

  it('on a replacement, also deletes the previous confirmed object -- only after the record switched', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValue({ s3Key: OLD_KEY });
    const log = s3Holds(FIXTURE);

    await confirm();

    expect(mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].update.s3Key).toBe(CONFIRMED_KEY);
    expect(log.deleted).toEqual([STAGING_KEY, OLD_KEY]);
  });

  it('failed cleanup deletes do not fail the confirm', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValue({ s3Key: OLD_KEY });
    s3Holds(FIXTURE, { deleteFails: true });

    await expect(confirm()).resolves.toMatchObject({ report: { s3Key: CONFIRMED_KEY } });
  });

  it('prefers parsed counts over operator counts when the parse is trusted', async () => {
    s3Holds(FIXTURE);
    await confirm({ operatorCounts: { passed: 32, failed: 0, needsManualCheck: 0, skipped: 0 } });
    expect(mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create).toMatchObject({
      failed: 3, countsSource: 'parsed',
    });
  });

  it('refuses with 422 + the parse result, writing and deleting nothing', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValue({ s3Key: OLD_KEY });
    const log = s3Holds(FIXTURE.replace('<li>Failed: 3</li>', '<li>Failed: 0</li>'));

    const err = await confirm().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 422, code: 'ACROBAT_REPORT_COUNTS_REQUIRED' });
    const details = (err as AppError).details as { parse: { trusted: boolean; failedRules: unknown[] } };
    expect(details.parse.trusted).toBe(false);
    expect(details.parse.failedRules).toHaveLength(3);
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
    // Staging kept (the operator re-confirms it with counts); confirmed report untouched.
    expect(log.put).toEqual([]);
    expect(log.deleted).toEqual([]);
  });

  it('stores operator counts (marked operator) when the parse is not trusted', async () => {
    s3Holds(FIXTURE.replace('<li>Failed: 3</li>', '<li>Failed: 0</li>'));
    await confirm({ operatorCounts: { passed: 27, failed: 3, needsManualCheck: 2, skipped: 0 } });
    const create = mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ failed: 3, countsSource: 'operator', passedManually: null, failedManually: null });
    expect((create.parseWarnings as string[]).join(' ')).toMatch(/rule table has 3/);
  });

  it('records a null hash when the job has no remediated file yet', async () => {
    s3Holds(FIXTURE);
    hash.mockResolvedValue(null);
    await confirm();
    expect(mockPrisma.jobExternalAcrobatReport.upsert.mock.calls[0][0].create.remediatedSha256).toBeNull();
  });

  it('400s when the object never landed in S3', async () => {
    send.mockRejectedValue(new Error('NotFound'));
    await expect(confirm()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
  });

  it('400s on an oversized object seen by HEAD: no GET, staging deleted, confirmed report untouched', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValue({ s3Key: OLD_KEY });
    const log = s3Holds(FIXTURE, { headSize: 50 * 1024 * 1024 });

    await expect(confirm()).rejects.toMatchObject({ statusCode: 400, code: 'ACROBAT_REPORT_TOO_LARGE' });

    expect(log.get).toEqual([]);
    expect(log.deleted).toEqual([STAGING_KEY]);
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
  });

  it('stops reading at the cap when the object was swapped for a larger one after HEAD', async () => {
    const huge = Buffer.alloc(MAX_ACROBAT_REPORT_BYTES + 200 * 1024, 0x61);
    const log = s3Holds(huge, { headSize: 10 }); // HEAD saw a small file

    await expect(confirm()).rejects.toMatchObject({ statusCode: 400, code: 'ACROBAT_REPORT_TOO_LARGE' });

    expect(log.put).toEqual([]);
    expect(log.deleted).toEqual([STAGING_KEY]);
    expect(mockPrisma.jobExternalAcrobatReport.upsert).not.toHaveBeenCalled();
  });
});

describe('getJobAcrobatReport', () => {
  it('signs the download as an attachment, never inline', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValueOnce({
      id: 'r1', s3Key: CONFIRMED_KEY, originalFileName: 'My "Report".html',
    });

    const result = await getJobAcrobatReport('job-1');

    expect(result).toMatchObject({ id: 'r1', downloadUrl: 'https://s3.example.com/signed-url' });
    expect(getSignedUrl).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        input: expect.objectContaining({
          Key: CONFIRMED_KEY,
          // Quotes in the stored name can't break out of the header value.
          ResponseContentDisposition: 'attachment; filename="my--report-.html"',
        }),
      }),
      { expiresIn: 3600 },
    );
  });

  it('returns null when none was uploaded', async () => {
    mockPrisma.jobExternalAcrobatReport.findUnique.mockResolvedValueOnce(null);
    expect(await getJobAcrobatReport('job-1')).toBeNull();
  });
});

describe('deleteJobAcrobatReport', () => {
  it('removes the record and then its S3 object', async () => {
    mockPrisma.jobExternalAcrobatReport.delete.mockResolvedValue({ id: 'r1', s3Key: CONFIRMED_KEY });
    const log = s3Holds(FIXTURE);

    expect(await deleteJobAcrobatReport('job-1')).toBe(true);
    expect(log.deleted).toEqual([CONFIRMED_KEY]);
  });

  it('still reports success when the S3 delete fails (record is already gone)', async () => {
    mockPrisma.jobExternalAcrobatReport.delete.mockResolvedValue({ id: 'r1', s3Key: CONFIRMED_KEY });
    s3Holds(FIXTURE, { deleteFails: true });

    expect(await deleteJobAcrobatReport('job-1')).toBe(true);
  });

  it('returns false (not an error) when nothing exists, touching no object', async () => {
    mockPrisma.jobExternalAcrobatReport.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: 'x' }),
    );
    const log = s3Holds(FIXTURE);

    expect(await deleteJobAcrobatReport('job-1')).toBe(false);
    expect(log.deleted).toEqual([]);
  });
});
