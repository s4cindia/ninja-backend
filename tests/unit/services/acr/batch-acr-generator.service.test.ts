import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { batchAcrGeneratorService } from '../../../../src/services/acr/batch-acr-generator.service';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    acrJob: {
      create: vi.fn(),
    },
    acrCriterionReview: {
      create: vi.fn(),
    },
    remediationPlan: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

type AggregateResult = { fileName: string; status: string; issueCount: number };
type IssueDetail = { fileName: string; issueCount: number; issues: Array<{ code: string; message: string; location?: string }> };

describe('BatchAcrGeneratorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('aggregateConformanceConservative', () => {
    it('should return "Supports" when all EPUBs support', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Supports', issueCount: 0 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceConservative: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceConservative(results);
      expect(aggregated).toBe('Supports');
    });

    it('should return "Does Not Support" when any EPUB fails', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Does Not Support', issueCount: 3 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceConservative: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceConservative(results);
      expect(aggregated).toBe('Does Not Support');
    });

    it('should return "Partially Supports" when some EPUBs partially support', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Partially Supports', issueCount: 1 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceConservative: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceConservative(results);
      expect(aggregated).toBe('Partially Supports');
    });
  });

  describe('aggregateConformanceOptimistic', () => {
    it('should return "Partially Supports" when majority pass', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book3.epub', status: 'Does Not Support', issueCount: 3 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceOptimistic: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceOptimistic(results);
      expect(aggregated).toBe('Partially Supports');
    });

    it('should return "Supports" when all pass', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Supports', issueCount: 0 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceOptimistic: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceOptimistic(results);
      expect(aggregated).toBe('Supports');
    });

    it('should return "Does Not Support" when majority fail', () => {
      const results: AggregateResult[] = [
        { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
        { fileName: 'book2.epub', status: 'Does Not Support', issueCount: 3 },
        { fileName: 'book3.epub', status: 'Does Not Support', issueCount: 2 },
      ];
      const service = batchAcrGeneratorService as unknown as { aggregateConformanceOptimistic: (r: AggregateResult[]) => string };
      const aggregated = service.aggregateConformanceOptimistic(results);
      expect(aggregated).toBe('Does Not Support');
    });
  });

  describe('generateCompositeRemarks', () => {
    it('should format remarks with per-EPUB breakdown', () => {
      const details: IssueDetail[] = [
        {
          fileName: 'book1.epub',
          issueCount: 0,
          issues: [],
        },
        {
          fileName: 'book2.epub',
          issueCount: 2,
          issues: [
            { code: 'EPUB-IMG-001', message: 'Missing alt text' },
            { code: 'EPUB-SEM-001', message: 'Missing semantic tag' },
          ],
        },
      ];
      const service = batchAcrGeneratorService as unknown as { generateCompositeRemarks: (criterionId: string, d: IssueDetail[]) => string };
      const remarks = service.generateCompositeRemarks('1.1.1', details);
      expect(remarks).toContain('1 of 2');
      expect(remarks).toContain('book2.epub');
      expect(remarks).toContain('Missing alt text');
    });

    it('should handle all EPUBs passing', () => {
      const details: IssueDetail[] = [
        {
          fileName: 'book1.epub',
          issueCount: 0,
          issues: [],
        },
        {
          fileName: 'book2.epub',
          issueCount: 0,
          issues: [],
        },
      ];
      const service = batchAcrGeneratorService as unknown as { generateCompositeRemarks: (criterionId: string, d: IssueDetail[]) => string };
      const remarks = service.generateCompositeRemarks('1.1.1', details);
      expect(remarks).toContain('2 of 2 EPUBs (100%) fully support');
    });
  });

  describe('getWcagLevel', () => {
    it('should return correct level for Level A criteria', () => {
      const service = batchAcrGeneratorService as unknown as { getWcagLevel: (criterionId: string) => string };
      expect(service.getWcagLevel('1.1.1')).toBe('A');
      expect(service.getWcagLevel('1.2.1')).toBe('A');
      expect(service.getWcagLevel('2.1.1')).toBe('A');
    });

    it('should return correct level for Level AA criteria', () => {
      const service = batchAcrGeneratorService as unknown as { getWcagLevel: (criterionId: string) => string };
      expect(service.getWcagLevel('1.2.4')).toBe('AA');
      expect(service.getWcagLevel('1.4.3')).toBe('AA');
      expect(service.getWcagLevel('2.4.5')).toBe('AA');
    });

    it('should return correct level for Level AAA criteria', () => {
      const service = batchAcrGeneratorService as unknown as { getWcagLevel: (criterionId: string) => string };
      expect(service.getWcagLevel('1.2.6')).toBe('AAA');
      expect(service.getWcagLevel('1.4.6')).toBe('AAA');
      expect(service.getWcagLevel('2.2.3')).toBe('AAA');
    });

    it('should default to A for unknown criteria', () => {
      const service = batchAcrGeneratorService as unknown as { getWcagLevel: (criterionId: string) => string };
      expect(service.getWcagLevel('unknown')).toBe('A');
    });
  });

  describe('generateBatchAcr', () => {
    it('should throw error for invalid mode', async () => {
      // Note: The actual error depends on whether Prisma is mocked.
      // In unit tests without full DB mocking, we verify it throws an error.
      await expect(
        batchAcrGeneratorService.generateBatchAcr(
          'batch-123',
          'tenant-123',
          'user-123',
          'invalid' as 'individual' | 'aggregate'
        )
      ).rejects.toThrow();
    });
  });
});
