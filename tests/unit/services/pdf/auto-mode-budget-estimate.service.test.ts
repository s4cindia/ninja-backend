/**
 * Auto Mode Budget Estimate Service Tests
 *
 * Focus areas:
 * - estimateBudgetForJob reads this job's own issuesFound and scales the
 *   historical avg-cost-per-issue against it
 * - estimateBudgetForTenant has no specific job to scale against, falls
 *   back to avg cost per historical run
 * - confidence tiers by sample size, with a thin sample returning the flat
 *   $2.00 default unchanged rather than a guess
 * - tenant sample is used as-is once it has enough history; a thin tenant
 *   sample falls back to the (superset) global sample
 * - clamping to the existing [0.1, 10] schema bounds
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    pdfAutoRemediationRun: { findMany: vi.fn() },
    job: { findUnique: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import { estimateBudgetForJob, estimateBudgetForTenant } from '../../../../src/services/pdf/auto-mode-budget-estimate.service';

const mockPrisma = prisma as unknown as {
  pdfAutoRemediationRun: { findMany: ReturnType<typeof vi.fn> };
  job: { findUnique: ReturnType<typeof vi.fn> };
};

function run(costUsd: number, issuesFound: number | null) {
  return {
    autoCostSpentUsd: costUsd,
    job: { output: issuesFound === null ? null : { auditReport: { issues: new Array(issuesFound).fill({}) } } },
  };
}

describe('auto-mode-budget-estimate.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('estimateBudgetForJob', () => {
    it('returns the flat $2.00 default with low confidence when the job has no completed audit yet', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: null });

      const result = await estimateBudgetForJob('job-1');

      expect(result).toEqual({ estimatedCostUsd: 2.0, confidence: 'low', sampleSize: 0, basedOnIssueCount: null });
      expect(mockPrisma.pdfAutoRemediationRun.findMany).not.toHaveBeenCalled();
    });

    it('returns the flat default when the job itself does not exist', async () => {
      mockPrisma.job.findUnique.mockResolvedValue(null);

      const result = await estimateBudgetForJob('missing-job');

      expect(result).toEqual({ estimatedCostUsd: 2.0, confidence: 'low', sampleSize: 0, basedOnIssueCount: null });
    });

    it('returns low confidence (and the flat default, not a guess) when fewer than 5 historical samples exist', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(500).fill({}) } } });
      mockPrisma.pdfAutoRemediationRun.findMany
        .mockResolvedValueOnce([run(1, 100), run(1, 100)]) // tenant sample: 2
        .mockResolvedValueOnce([run(1, 100), run(1, 100), run(1, 100)]); // global fallback: 3 -- still < 5

      const result = await estimateBudgetForJob('job-1');

      expect(result).toEqual({ estimatedCostUsd: 2.0, confidence: 'low', sampleSize: 3, basedOnIssueCount: 500 });
    });

    it('scales the historical avg cost-per-issue against THIS job\'s own issuesFound, at medium confidence (5-19 samples)', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(500).fill({}) } } });
      // 5 historical runs, $1 per 100 issues each -- avgCostPerIssue = 0.01.
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce([
        run(1, 100), run(1, 100), run(1, 100), run(1, 100), run(1, 100),
      ]);

      const result = await estimateBudgetForJob('job-1');

      // 500 issues * 0.01/issue = $5.00
      expect(result).toEqual({ estimatedCostUsd: 5.0, confidence: 'medium', sampleSize: 5, basedOnIssueCount: 500 });
      // Tenant sample already met the threshold -- no global fallback query needed.
      expect(mockPrisma.pdfAutoRemediationRun.findMany).toHaveBeenCalledTimes(1);
    });

    it('reports high confidence at 20+ samples', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(100).fill({}) } } });
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce(
        Array.from({ length: 20 }, () => run(1, 100))
      );

      const result = await estimateBudgetForJob('job-1');

      expect(result.confidence).toBe('high');
      expect(result.sampleSize).toBe(20);
    });

    it('falls back to the global sample when the tenant sample alone is too thin', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(200).fill({}) } } });
      mockPrisma.pdfAutoRemediationRun.findMany
        .mockResolvedValueOnce([run(1, 100), run(1, 100)]) // tenant: only 2
        .mockResolvedValueOnce(Array.from({ length: 10 }, () => run(1, 100))); // global: 10

      const result = await estimateBudgetForJob('job-1');

      expect(result.sampleSize).toBe(10);
      expect(result.confidence).toBe('medium');
      // 200 issues * (10/1000) = $2.00
      expect(result.estimatedCostUsd).toBe(2.0);
    });

    it('does NOT fall back to global when the tenant sample alone already meets the confidence threshold, even if global is larger', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(100).fill({}) } } });
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce(
        Array.from({ length: 5 }, () => run(1, 100)) // exactly 5 -- meets the threshold
      );

      await estimateBudgetForJob('job-1');

      expect(mockPrisma.pdfAutoRemediationRun.findMany).toHaveBeenCalledTimes(1);
    });

    it('clamps the estimate to the existing [0.1, 10] schema bounds on the high end', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(10000).fill({}) } } });
      // avgCostPerIssue = 1 ($5 / 5 issues total) -- 10000 issues would be $10,000 unclamped.
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce([
        run(1, 1), run(1, 1), run(1, 1), run(1, 1), run(1, 1),
      ]);

      const result = await estimateBudgetForJob('job-1');

      expect(result.estimatedCostUsd).toBe(10);
    });

    it('clamps the estimate to the existing [0.1, 10] schema bounds on the low end', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(1).fill({}) } } });
      // avgCostPerIssue is tiny -- 1 issue would estimate well under $0.10 unclamped.
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce([
        run(0.01, 10000), run(0.01, 10000), run(0.01, 10000), run(0.01, 10000), run(0.01, 10000),
      ]);

      const result = await estimateBudgetForJob('job-1');

      expect(result.estimatedCostUsd).toBe(0.1);
    });

    it('excludes a sample with zero recorded spend or zero issues from the calibration data (nothing real to learn from)', async () => {
      mockPrisma.job.findUnique.mockResolvedValue({ tenantId: 'tenant-1', output: { auditReport: { issues: new Array(100).fill({}) } } });
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce([
        run(0, 100), // zero spend -- excluded
        run(1, 0),   // zero issues -- excluded
        run(1, 100), run(1, 100), run(1, 100), run(1, 100), run(1, 100),
      ]);

      const result = await estimateBudgetForJob('job-1');

      expect(result.sampleSize).toBe(5);
    });
  });

  describe('estimateBudgetForTenant', () => {
    it('has no specific job to scale against -- basedOnIssueCount is always null', async () => {
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce(
        Array.from({ length: 5 }, () => run(2, 100))
      );

      const result = await estimateBudgetForTenant('tenant-1');

      expect(result.basedOnIssueCount).toBeNull();
      // avg cost per run = $2.00
      expect(result.estimatedCostUsd).toBe(2.0);
    });

    it('returns the flat default at low confidence with zero historical runs', async () => {
      mockPrisma.pdfAutoRemediationRun.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await estimateBudgetForTenant('tenant-1');

      expect(result).toEqual({ estimatedCostUsd: 2.0, confidence: 'low', sampleSize: 0, basedOnIssueCount: null });
    });
  });
});
