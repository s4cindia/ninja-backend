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
    job: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: {},
  s3Service: {
    getFileBuffer: vi.fn(),
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
import { s3Service } from '../../../../src/services/s3.service';
import { createAndEnqueuePdfAuditJob } from '../../../../src/controllers/pdf.controller';
import {
  registerTrial,
  deleteTrial,
  getTrialReport,
  getAggregateReport,
  updateAutoModeConfig,
  generateUploadUrl,
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
    it('fetches the uploaded source from S3 and enqueues it via the shared job-creation path', async () => {
      const buffer = Buffer.from('%PDF-1.7 fake');
      (s3Service.getFileBuffer as ReturnType<typeof vi.fn>).mockResolvedValue(buffer);
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

      expect(s3Service.getFileBuffer).toHaveBeenCalledWith('comparison-study/123-sample.pdf');
      expect(createAndEnqueuePdfAuditJob).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'sample.pdf', buffer }),
        'tenant-1',
        'user-1',
        { forceAutoTag: true },
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
        ninjaPacResult: [{ ruleId: '1:6.2-1' }],
        pdfxtTimeMs: 60 * 60 * 1000, // 60 min
        pdfxtPageCount: 20,
        pdfxtCostUsd: 5,
        pdfxtPacResult: [],
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
          ninjaPacResult: [],
          pdfxtPacResult: [],
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
});
