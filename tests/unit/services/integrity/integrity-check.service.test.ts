import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures mocks are initialized before vi.mock factories run
const {
  mockDocFindFirst,
  mockJobFindFirst,
  mockJobCreate,
  mockJobUpdate,
  mockJobUpdateMany,
  mockJobCount,
  mockIssueFindMany,
  mockIssueCount,
  mockIssueGroupBy,
  mockTransaction,
  mockDocContentFindUnique,
  mockDocFindUnique,
} = vi.hoisted(() => ({
  mockDocFindFirst: vi.fn(),
  mockJobFindFirst: vi.fn(),
  mockJobCreate: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockJobUpdateMany: vi.fn(),
  mockJobCount: vi.fn(),
  mockIssueFindMany: vi.fn(),
  mockIssueCount: vi.fn(),
  mockIssueGroupBy: vi.fn(),
  mockTransaction: vi.fn(),
  mockDocContentFindUnique: vi.fn(),
  mockDocFindUnique: vi.fn(),
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    editorialDocument: {
      findFirst: mockDocFindFirst,
      findUnique: mockDocFindUnique,
    },
    editorialDocumentContent: {
      findUnique: mockDocContentFindUnique,
    },
    integrityCheckJob: {
      findFirst: mockJobFindFirst,
      create: mockJobCreate,
      update: mockJobUpdate,
      updateMany: mockJobUpdateMany,
      count: mockJobCount,
    },
    integrityIssue: {
      findMany: mockIssueFindMany,
      count: mockIssueCount,
      groupBy: mockIssueGroupBy,
      createMany: vi.fn(),
    },
    $transaction: mockTransaction,
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/services/integrity/checks/ai-integrity.check', () => ({
  aiIntegrityCheck: vi.fn().mockResolvedValue([]),
  VALID_CHECK_TYPES: new Set([
    'FIGURE_REF',
    'TABLE_REF',
    'EQUATION_REF',
    'CITATION_REF',
    'SECTION_NUMBERING',
  ]),
}));

import { integrityCheckService } from '../../../../src/services/integrity/integrity-check.service';

const TENANT_ID = 'tenant-1';
const DOCUMENT_ID = 'doc-1';
const JOB_ID = 'job-1';

describe('integrityCheckService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no active jobs (under concurrency cap)
    mockJobCount.mockResolvedValue(0);
  });

  // =========================================================================
  // startCheck
  // =========================================================================
  describe('startCheck', () => {
    it('throws NOT_FOUND when document does not belong to tenant (IDOR protection)', async () => {
      mockDocFindFirst.mockResolvedValue(null);

      await expect(
        integrityCheckService.startCheck(TENANT_ID, DOCUMENT_ID)
      ).rejects.toThrow('Document not found');

      expect(mockDocFindFirst).toHaveBeenCalledWith({
        where: { id: DOCUMENT_ID, tenantId: TENANT_ID },
        select: { id: true },
      });
    });

    it('returns existing job ID when an active job already exists', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          integrityCheckJob: {
            findFirst: vi.fn().mockResolvedValue({ id: 'existing-job' }),
            create: vi.fn(),
          },
        };
        return cb(tx);
      });

      const result = await integrityCheckService.startCheck(TENANT_ID, DOCUMENT_ID);

      expect(result).toEqual({ jobId: 'existing-job' });
    });

    it('creates a new job when no active job exists', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          integrityCheckJob: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: JOB_ID }),
          },
        };
        return cb(tx);
      });
      // Mock the executeCheck dependencies to prevent unhandled errors
      mockJobUpdate.mockResolvedValue({});
      mockDocContentFindUnique.mockResolvedValue(null);

      const result = await integrityCheckService.startCheck(TENANT_ID, DOCUMENT_ID);

      expect(result).toEqual({ jobId: JOB_ID });
    });

    it('filters invalid check types from the provided list', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });

      let capturedCreate: unknown;
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          integrityCheckJob: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockImplementation((args: unknown) => {
              capturedCreate = args;
              return { id: JOB_ID };
            }),
          },
        };
        return cb(tx);
      });
      mockJobUpdate.mockResolvedValue({});
      mockDocContentFindUnique.mockResolvedValue(null);

      await integrityCheckService.startCheck(TENANT_ID, DOCUMENT_ID, [
        'FIGURE_REF',
        'INVALID_TYPE',
        'TABLE_REF',
      ]);

      // Only valid check types should be passed
      const data = (capturedCreate as { data: { checkTypes: string[] } }).data;
      expect(data.checkTypes).toEqual(['FIGURE_REF', 'TABLE_REF']);
    });
  });

  // =========================================================================
  // getIssues
  // =========================================================================
  describe('getIssues', () => {
    it('returns empty result when document does not belong to tenant', async () => {
      mockDocFindFirst.mockResolvedValue(null);

      const result = await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({ issues: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    });

    it('returns empty result when no completed job exists', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      // getLatestJobId calls integrityCheckJob.findFirst
      mockJobFindFirst.mockResolvedValue(null);

      const result = await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({ issues: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    });

    it('returns paginated issues with correct metadata', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue({ id: JOB_ID });

      const mockIssues = [
        { id: 'i1', checkType: 'FIGURE_REF', severity: 'WARNING', createdAt: new Date() },
        { id: 'i2', checkType: 'TABLE_REF', severity: 'ERROR', createdAt: new Date() },
      ];
      mockIssueFindMany.mockResolvedValue(mockIssues);
      mockIssueCount.mockResolvedValue(25);

      const result = await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID, {
        page: 2,
        limit: 10,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(25);
      expect(result.totalPages).toBe(3);
      // Issues should be sorted by severity (ERROR before WARNING)
      expect(result.issues[0].severity).toBe('ERROR');
      expect(result.issues[1].severity).toBe('WARNING');
    });

    it('applies checkType filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue({ id: JOB_ID });
      mockIssueFindMany.mockResolvedValue([]);
      mockIssueCount.mockResolvedValue(0);

      await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID, {
        checkType: 'FIGURE_REF',
      });

      expect(mockIssueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ checkType: 'FIGURE_REF' }),
        })
      );
    });

    it('applies severity filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue({ id: JOB_ID });
      mockIssueFindMany.mockResolvedValue([]);
      mockIssueCount.mockResolvedValue(0);

      await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID, {
        severity: 'ERROR',
      });

      expect(mockIssueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ severity: 'ERROR' }),
        })
      );
    });

    it('applies status filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue({ id: JOB_ID });
      mockIssueFindMany.mockResolvedValue([]);
      mockIssueCount.mockResolvedValue(0);

      await integrityCheckService.getIssues(DOCUMENT_ID, TENANT_ID, {
        status: 'FIXED',
      });

      expect(mockIssueFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'FIXED' }),
        })
      );
    });
  });

  // =========================================================================
  // getSummary
  // =========================================================================
  describe('getSummary', () => {
    it('returns empty object when document does not belong to tenant', async () => {
      mockDocFindFirst.mockResolvedValue(null);

      const result = await integrityCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({});
    });

    it('returns empty object when no completed job exists', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue(null);

      const result = await integrityCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({});
    });

    it('returns grouped counts by checkType, severity, and status', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockJobFindFirst.mockResolvedValue({ id: JOB_ID });
      mockIssueGroupBy.mockResolvedValue([
        { checkType: 'FIGURE_REF', severity: 'ERROR', status: 'PENDING', _count: 3 },
        { checkType: 'FIGURE_REF', severity: 'WARNING', status: 'PENDING', _count: 2 },
        { checkType: 'FIGURE_REF', severity: 'SUGGESTION', status: 'FIXED', _count: 1 },
        { checkType: 'TABLE_REF', severity: 'ERROR', status: 'PENDING', _count: 5 },
        { checkType: 'TABLE_REF', severity: 'WARNING', status: 'AUTO_FIXED', _count: 1 },
      ]);

      const result = await integrityCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({
        FIGURE_REF: { total: 6, errors: 3, warnings: 2, suggestions: 1, pending: 5, fixed: 1 },
        TABLE_REF: { total: 6, errors: 5, warnings: 1, suggestions: 0, pending: 5, fixed: 1 },
      });
    });
  });

  // =========================================================================
  // cleanupStaleJobs
  // =========================================================================
  describe('cleanupStaleJobs', () => {
    it('marks old PROCESSING/QUEUED jobs as FAILED', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 3 });

      const result = await integrityCheckService.cleanupStaleJobs();

      expect(result).toBe(3);
      expect(mockJobUpdateMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['QUEUED', 'PROCESSING'] },
          createdAt: { lt: expect.any(Date) },
        },
        data: {
          status: 'FAILED',
          metadata: { error: 'Job timed out (stale cleanup)' },
        },
      });
    });

    it('returns 0 when no stale jobs exist', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 0 });

      const result = await integrityCheckService.cleanupStaleJobs();

      expect(result).toBe(0);
    });

    it('uses custom maxAgeMs for cutoff calculation', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 1 });
      const customAge = 60 * 60 * 1000; // 1 hour

      const before = Date.now();
      await integrityCheckService.cleanupStaleJobs(customAge);
      const after = Date.now();

      const calledWith = mockJobUpdateMany.mock.calls[0][0];
      const cutoffTime = calledWith.where.createdAt.lt.getTime();

      // Cutoff should be approximately (now - 1 hour)
      expect(cutoffTime).toBeGreaterThanOrEqual(before - customAge);
      expect(cutoffTime).toBeLessThanOrEqual(after - customAge);
    });
  });
});
