/**
 * Comparison Study Service Tests
 *
 * Focus areas:
 * - registerTrial wires the source file through the same job-creation
 *   path as every other PDF upload (createAndEnqueuePdfAuditJob)
 * - getTrialReport's cost/pages-per-hour math (Ninja AI cost + blended
 *   GPU cost, pdfxt manual entry, pages/hour from page count and time)
 * - getAggregateReport's speedup calculation across validated trials
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    comparisonTrial: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    externalPacReport: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    job: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: vi.fn() },
  s3Service: {
    getFileBuffer: vi.fn(),
    getFileSize: vi.fn(),
    getPresignedDownloadUrl: vi.fn(),
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/signed-url')),
}));

vi.mock('../../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    downloadFile: vi.fn(),
  },
}));

vi.mock('../../../../src/services/pdf/verapdf.service', () => ({
  veraPdfService: {
    isAvailable: vi.fn(() => false),
    validate: vi.fn(),
  },
}));

vi.mock('../../../../src/controllers/pdf.controller', () => ({
  createAndEnqueuePdfAuditJob: vi.fn(),
}));

vi.mock('../../../../src/config', () => ({
  config: {
    s3Bucket: 'ninja-epub-staging',
    ninjaGpuBlendedCostPerDocUsd: 0.42,
  },
}));

import { Prisma } from '@prisma/client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../../../../src/lib/prisma';
import { s3Client, s3Service } from '../../../../src/services/s3.service';
import { createAndEnqueuePdfAuditJob } from '../../../../src/controllers/pdf.controller';
import {
  registerTrial,
  deleteTrial,
  getTrialReport,
  getAggregateReport,
  updateAutoModeConfig,
  generateUploadUrl,
  getPacReportUploadUrl,
  confirmPacReportUpload,
  getPacReport,
  deletePacReport,
} from '../../../../src/services/comparison-study/comparison-study.service';

const mockPrisma = prisma as unknown as {
  comparisonTrial: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  externalPacReport: {
    upsert: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

describe('comparison-study.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateUploadUrl', () => {
    it('signs the URL for 30 minutes, not the old 5-minute window a large PDF upload could outrun', async () => {
      await generateUploadUrl('Altman_PDF.pdf');

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 30 * 60 }
      );
    });
  });

  describe('registerTrial', () => {
    it('reads the uploaded source\'s size via a cheap HEAD request and enqueues it via the shared job-creation path, without downloading its bytes', async () => {
      // Real incident (2026-09-25): registerTrial used to download the
      // WHOLE file (getFileBuffer) purely to read its byte length and hand
      // the buffer to createAndEnqueuePdfAuditJob, which then re-uploaded
      // that same buffer to a different S3 key -- a full download+reupload
      // round trip inside this single HTTP request/response cycle that
      // could time out or exhaust memory for a large PDF ("Network Error"
      // on Register Trial). Now uses getFileSize (a HEAD request) and
      // passes sourceS3Key through so the shared job-creation path can do a
      // server-side S3-to-S3 copy instead.
      (s3Service.getFileSize as ReturnType<typeof vi.fn>).mockResolvedValue(123456);
      (createAndEnqueuePdfAuditJob as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-123' });
      mockPrisma.comparisonTrial.create.mockResolvedValue({
        id: 'trial-1',
        ninjaJobId: 'job-123',
        status: 'registered',
      });

      const trial = await registerTrial({
        sourceFileName: 'sample.pdf',
        sourceS3Key: 'comparison-study/123-sample.pdf',
        contentType: 'text-dominant',
        operatorId: 'op-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });

      expect(s3Service.getFileSize).toHaveBeenCalledWith('comparison-study/123-sample.pdf');
      expect(s3Service.getFileBuffer).not.toHaveBeenCalled();
      expect(createAndEnqueuePdfAuditJob).toHaveBeenCalledWith(
        { originalname: 'sample.pdf', mimetype: 'application/pdf', size: 123456 },
        'tenant-1',
        'user-1',
        { forceAutoTag: true, sourceS3Key: 'comparison-study/123-sample.pdf' },
      );
      expect(mockPrisma.comparisonTrial.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ninjaJobId: 'job-123', status: 'registered' }),
        }),
      );
      expect(trial.ninjaJobId).toBe('job-123');
    });
  });

  describe('getTrialReport', () => {
    it('sums Ninja AI cost and blended GPU cost, and computes pages/hour for both tools', async () => {
      mockPrisma.comparisonTrial.findUniqueOrThrow.mockResolvedValue({
        id: 'trial-1',
        sourceFileName: 'sample.pdf',
        contentType: 'text-dominant',
        ninjaActiveMs: 30 * 60 * 1000, // 30 min
        ninjaGpuCostUsd: 0.42,
        ninjaPacResult: { ran: true, failures: [{ ruleId: '1:6.2-1' }] },
        pdfxtTimeMs: 60 * 60 * 1000, // 60 min
        pdfxtPageCount: 20,
        pdfxtCostUsd: 5,
        pdfxtPacResult: { ran: true, failures: [] },
        job: { output: { aiAnalysisStats: { totalCostUsd: 0.08 } } },
      });

      const report = await getTrialReport('trial-1');

      // Ninja: 20 pages in 30 min -> 40 pages/hour
      expect(report.ninja.pagesPerHour).toBe(40);
      expect(report.ninja.costUsd).toBeCloseTo(0.5); // 0.08 AI + 0.42 GPU
      expect(report.ninja.pacFailureCount).toBe(1);

      // pdfxt: 20 pages in 60 min -> 20 pages/hour
      expect(report.pdfxt.pagesPerHour).toBe(20);
      expect(report.pdfxt.costUsd).toBe(5);
      expect(report.pdfxt.pacFailureCount).toBe(0);
    });

    it('returns null pages/hour when time or page count is missing', async () => {
      mockPrisma.comparisonTrial.findUniqueOrThrow.mockResolvedValue({
        id: 'trial-2',
        sourceFileName: 'sample.pdf',
        contentType: 'mixed',
        ninjaActiveMs: null,
        ninjaGpuCostUsd: null,
        ninjaPacResult: null,
        pdfxtTimeMs: null,
        pdfxtPageCount: null,
        pdfxtCostUsd: null,
        pdfxtPacResult: null,
        job: { output: null },
      });

      const report = await getTrialReport('trial-2');

      expect(report.ninja.pagesPerHour).toBeNull();
      expect(report.ninja.costUsd).toBeNull();
      expect(report.pdfxt.pagesPerHour).toBeNull();
    });

    it('reports pacFailureCount as null (not 0) when veraPDF never ran for that side, even for an old-shape stale row', async () => {
      // CodeRabbit finding on PR #577, confirmed real: persisting just the
      // raw failures array made "veraPDF was unavailable/timed out" and
      // "veraPDF ran and found zero failures" both read back as
      // pacFailureCount: 0 -- a false clean-pass result. { ran: false }
      // must read back as null, and a stale pre-fix row (a bare array, no
      // `ran` field at all) must ALSO safely degrade to null rather than
      // being misread as a real zero-failure result.
      mockPrisma.comparisonTrial.findUniqueOrThrow.mockResolvedValue({
        id: 'trial-3',
        sourceFileName: 'sample.pdf',
        contentType: 'mixed',
        ninjaActiveMs: null,
        ninjaGpuCostUsd: null,
        ninjaPacResult: { ran: false, failures: [] },
        pdfxtTimeMs: null,
        pdfxtPageCount: null,
        pdfxtCostUsd: null,
        pdfxtPacResult: [{ ruleId: 'stale-pre-fix-row' }], // old shape, predates this fix
        job: { output: null },
      });

      const report = await getTrialReport('trial-3');

      expect(report.ninja.pacFailureCount).toBeNull();
      expect(report.pdfxt.pacFailureCount).toBeNull();
    });
  });

  describe('getAggregateReport', () => {
    it('computes estimated speedup as pdfxt time over Ninja time across validated trials', async () => {
      mockPrisma.comparisonTrial.findMany.mockResolvedValue([
        { id: 't1', status: 'validated' },
        { id: 't2', status: 'validated' },
        { id: 't3', status: 'registered' }, // not yet validated — excluded
      ]);
      mockPrisma.comparisonTrial.findUniqueOrThrow.mockImplementation(({ where: { id } }: { where: { id: string } }) => {
        const base = {
          sourceFileName: 'x.pdf',
          contentType: 'mixed',
          ninjaPacResult: { ran: true, failures: [] },
          pdfxtPacResult: { ran: true, failures: [] },
          pdfxtPageCount: 10,
          job: { output: null },
        };
        if (id === 't1') {
          return Promise.resolve({ ...base, ninjaActiveMs: 10 * 60_000, ninjaGpuCostUsd: null, pdfxtTimeMs: 40 * 60_000, pdfxtCostUsd: null });
        }
        return Promise.resolve({ ...base, ninjaActiveMs: 20 * 60_000, ninjaGpuCostUsd: null, pdfxtTimeMs: 40 * 60_000, pdfxtCostUsd: null });
      });

      const aggregate = await getAggregateReport();

      expect(aggregate.trialCount).toBe(3);
      expect(aggregate.validatedCount).toBe(2);
      expect(aggregate.avgNinjaActiveMs).toBe(15 * 60_000); // avg(10, 20) min
      expect(aggregate.avgPdfxtTimeMs).toBe(40 * 60_000);
      // speedup = avg pdfxt time / avg ninja time = 40 / 15
      expect(aggregate.estimatedSpeedup).toBeCloseTo(40 / 15, 2);
    });
  });

  describe('deleteTrial', () => {
    it('deletes the trial and returns true', async () => {
      mockPrisma.comparisonTrial.delete.mockResolvedValue({ id: 'trial-1' });

      await expect(deleteTrial('trial-1')).resolves.toBe(true);
      expect(mockPrisma.comparisonTrial.delete).toHaveBeenCalledWith({ where: { id: 'trial-1' } });
    });

    it('returns false when the trial does not exist (P2025)', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });
      mockPrisma.comparisonTrial.delete.mockRejectedValueOnce(err);

      await expect(deleteTrial('missing-trial')).resolves.toBe(false);
    });

    it('rethrows non-P2025 errors', async () => {
      mockPrisma.comparisonTrial.delete.mockRejectedValueOnce(new Error('connection lost'));

      await expect(deleteTrial('trial-1')).rejects.toThrow('connection lost');
    });
  });

  describe('updateAutoModeConfig', () => {
    it('updates mode/round-limit/cost-limit fields that were provided', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1', mode: 'manual', autoStatus: null });
      mockPrisma.comparisonTrial.update.mockResolvedValue({ id: 'trial-1', mode: 'auto' });

      await updateAutoModeConfig('trial-1', { mode: 'auto', autoMaxRounds: 5, autoCostLimitUsd: 3.5 });

      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { mode: 'auto', autoMaxRounds: 5, autoCostLimitUsd: 3.5 },
      });
    });

    it('updates autoColorContrastMode when provided', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: null });
      mockPrisma.comparisonTrial.update.mockResolvedValue({ id: 'trial-1', autoColorContrastMode: 'apply-to-pdf' });

      await updateAutoModeConfig('trial-1', { autoColorContrastMode: 'apply-to-pdf' });

      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { autoColorContrastMode: 'apply-to-pdf' },
      });
    });

    it('accepts an explicit null to revert autoColorContrastMode back to "inherit tenant/default config"', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({
        id: 'trial-1',
        mode: 'auto',
        autoStatus: null,
        autoColorContrastMode: 'apply-to-pdf',
      });
      mockPrisma.comparisonTrial.update.mockResolvedValue({ id: 'trial-1', autoColorContrastMode: null });

      await updateAutoModeConfig('trial-1', { autoColorContrastMode: null });

      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { autoColorContrastMode: null },
      });
    });

    it('omits fields that were not provided from the update payload', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1', mode: 'manual', autoStatus: null });
      mockPrisma.comparisonTrial.update.mockResolvedValue({ id: 'trial-1' });

      await updateAutoModeConfig('trial-1', { autoMaxRounds: 5 });

      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { autoMaxRounds: 5 },
      });
    });

    it('rejects changing mode while a run is in progress', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: 'running' });

      await expect(updateAutoModeConfig('trial-1', { mode: 'manual' })).rejects.toMatchObject({ statusCode: 409 });
      expect(mockPrisma.comparisonTrial.update).not.toHaveBeenCalled();
    });

    it('allows updating round/cost limits while running, as long as mode itself is unchanged', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1', mode: 'auto', autoStatus: 'running' });
      mockPrisma.comparisonTrial.update.mockResolvedValue({ id: 'trial-1' });

      await updateAutoModeConfig('trial-1', { mode: 'auto', autoCostLimitUsd: 5 });

      expect(mockPrisma.comparisonTrial.update).toHaveBeenCalledWith({
        where: { id: 'trial-1' },
        data: { mode: 'auto', autoCostLimitUsd: 5 },
      });
    });

    it('throws a 404 AppError (not a raw Prisma error) when the trial does not exist', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue(null);

      await expect(updateAutoModeConfig('missing-trial', { mode: 'auto' })).rejects.toMatchObject({ statusCode: 404 });
      expect(mockPrisma.comparisonTrial.update).not.toHaveBeenCalled();
    });
  });

  describe('getPacReportUploadUrl', () => {
    it('presigns a deterministic, trial-ID-derived key', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1' });

      const result = await getPacReportUploadUrl('trial-1', 'PAC Report Final.pdf', 'application/pdf');

      expect(getSignedUrl).toHaveBeenCalledWith(
        s3Client,
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'ninja-epub-staging',
            Key: 'comparison-study/pac-reports/trial-1/pac-report-final.pdf',
          }),
        }),
        { expiresIn: 30 * 60 },
      );
      expect(result.uploadUrl).toBe('https://s3.example.com/signed-url');
    });

    it('throws a 404 AppError when the trial does not exist', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue(null);

      await expect(getPacReportUploadUrl('missing-trial', 'report.pdf', 'application/pdf')).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(getSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('confirmPacReportUpload', () => {
    const baseInput = {
      originalFileName: 'PAC Report Final.pdf',
      mimeType: 'application/pdf',
      summary: { pass: 40, fail: 2, untested: 5, humanRequired: 1, notApplicable: 0 },
      uploadedById: 'user-1',
    };

    it('regenerates the deterministic key server-side, verifies via HeadObjectCommand, and upserts the report', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1' });
      (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 12345 });
      mockPrisma.externalPacReport.upsert.mockResolvedValue({ id: 'report-1', trialId: 'trial-1', ...baseInput, size: 12345 });

      const result = await confirmPacReportUpload('trial-1', baseInput);

      expect(s3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'ninja-epub-staging',
            Key: 'comparison-study/pac-reports/trial-1/pac-report-final.pdf',
          }),
        }),
      );
      expect(mockPrisma.externalPacReport.upsert).toHaveBeenCalledWith({
        where: { trialId: 'trial-1' },
        create: expect.objectContaining({
          trialId: 'trial-1',
          s3Key: 'comparison-study/pac-reports/trial-1/pac-report-final.pdf',
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

    it('never trusts a client-supplied key -- always regenerates it from trialId + originalFileName', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1' });
      (s3Client.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ContentLength: 1 });
      mockPrisma.externalPacReport.upsert.mockResolvedValue({ id: 'report-1' });

      await confirmPacReportUpload('trial-1', { ...baseInput, originalFileName: 'different-name.pdf' });

      expect(s3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ Key: 'comparison-study/pac-reports/trial-1/different-name.pdf' }),
        }),
      );
    });

    it('throws a 404 AppError when the trial does not exist', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue(null);

      await expect(confirmPacReportUpload('missing-trial', baseInput)).rejects.toMatchObject({ statusCode: 404 });
      expect(s3Client.send).not.toHaveBeenCalled();
      expect(mockPrisma.externalPacReport.upsert).not.toHaveBeenCalled();
    });

    it('throws a 400 AppError (not a raw S3 error) when the object never actually landed in S3', async () => {
      mockPrisma.comparisonTrial.findUnique.mockResolvedValue({ id: 'trial-1' });
      (s3Client.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NotFound'));

      await expect(confirmPacReportUpload('trial-1', baseInput)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockPrisma.externalPacReport.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getPacReport', () => {
    it('returns null when no report has been uploaded, without calling S3', async () => {
      mockPrisma.externalPacReport.findUnique.mockResolvedValue(null);

      const result = await getPacReport('trial-1');

      expect(result).toBeNull();
      expect(s3Service.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns the report plus a presigned download URL when one exists', async () => {
      mockPrisma.externalPacReport.findUnique.mockResolvedValue({
        id: 'report-1',
        trialId: 'trial-1',
        s3Key: 'comparison-study/pac-reports/trial-1/report.pdf',
      });
      (s3Service.getPresignedDownloadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
        downloadUrl: 'https://s3.example.com/download-url',
        expiresIn: 3600,
      });

      const result = await getPacReport('trial-1');

      expect(s3Service.getPresignedDownloadUrl).toHaveBeenCalledWith('comparison-study/pac-reports/trial-1/report.pdf');
      expect(result).toMatchObject({ id: 'report-1', downloadUrl: 'https://s3.example.com/download-url' });
    });
  });

  describe('deletePacReport', () => {
    it('returns true on successful delete', async () => {
      mockPrisma.externalPacReport.delete.mockResolvedValue({ id: 'report-1' });

      await expect(deletePacReport('trial-1')).resolves.toBe(true);
    });

    it('returns false (not a thrown error) when no report exists for that trial, so a repeat delete is a no-op', async () => {
      const notFoundError = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });
      mockPrisma.externalPacReport.delete.mockRejectedValue(notFoundError);

      await expect(deletePacReport('trial-1')).resolves.toBe(false);
    });
  });
});
