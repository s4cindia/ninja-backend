import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures mocks are initialized before vi.mock factories run
const {
  mockDocFindFirst,
  mockJobFindFirst,
  mockJobCreate,
  mockJobUpdate,
  mockJobUpdateMany,
  mockJobCount,
  mockMatchFindMany,
  mockMatchCount,
  mockMatchGroupBy,
  mockMatchAggregate,
  mockTransaction,
  mockDocContentFindUnique,
  mockDocFindUnique,
  mockTextChunkFindMany,
  mockTextChunkCreateMany,
} = vi.hoisted(() => ({
  mockDocFindFirst: vi.fn(),
  mockJobFindFirst: vi.fn(),
  mockJobCreate: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockJobUpdateMany: vi.fn(),
  mockJobCount: vi.fn(),
  mockMatchFindMany: vi.fn(),
  mockMatchCount: vi.fn(),
  mockMatchGroupBy: vi.fn(),
  mockMatchAggregate: vi.fn(),
  mockTransaction: vi.fn(),
  mockDocContentFindUnique: vi.fn(),
  mockDocFindUnique: vi.fn(),
  mockTextChunkFindMany: vi.fn(),
  mockTextChunkCreateMany: vi.fn(),
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
    plagiarismCheckJob: {
      findFirst: mockJobFindFirst,
      create: mockJobCreate,
      update: mockJobUpdate,
      updateMany: mockJobUpdateMany,
      count: mockJobCount,
    },
    plagiarismMatch: {
      findMany: mockMatchFindMany,
      count: mockMatchCount,
      groupBy: mockMatchGroupBy,
      aggregate: mockMatchAggregate,
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    editorialTextChunk: {
      findMany: mockTextChunkFindMany,
      createMany: mockTextChunkCreateMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
    generateJSON: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../../src/utils/text-chunker', () => ({
  splitTextIntoChunks: vi.fn().mockReturnValue([{ text: 'chunk1', offset: 0 }]),
}));

import { plagiarismCheckService } from '../../../../src/services/plagiarism/plagiarism-check.service';

const TENANT_ID = 'tenant-1';
const DOCUMENT_ID = 'doc-1';
const JOB_ID = 'job-1';

describe('plagiarismCheckService', () => {
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
        plagiarismCheckService.startCheck(TENANT_ID, DOCUMENT_ID)
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
          plagiarismCheckJob: {
            findFirst: vi.fn().mockResolvedValue({ id: 'existing-job' }),
            create: vi.fn(),
          },
        };
        return cb(tx);
      });

      const result = await plagiarismCheckService.startCheck(TENANT_ID, DOCUMENT_ID);

      expect(result).toEqual({ jobId: 'existing-job' });
    });

    it('creates a new job when no active job exists', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          plagiarismCheckJob: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: JOB_ID }),
          },
        };
        return cb(tx);
      });
      // Mock the executeCheck dependencies to prevent unhandled errors
      mockJobUpdate.mockResolvedValue({});
      mockDocFindUnique.mockResolvedValue(null);
      mockDocContentFindUnique.mockResolvedValue(null);

      const result = await plagiarismCheckService.startCheck(TENANT_ID, DOCUMENT_ID);

      expect(result).toEqual({ jobId: JOB_ID });
    });

    it('does not create a duplicate job for the same document', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });

      const mockTxCreate = vi.fn();
      mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          plagiarismCheckJob: {
            findFirst: vi.fn().mockResolvedValue({ id: 'existing-job' }),
            create: mockTxCreate,
          },
        };
        return cb(tx);
      });

      await plagiarismCheckService.startCheck(TENANT_ID, DOCUMENT_ID);

      expect(mockTxCreate).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getMatches
  // =========================================================================
  describe('getMatches', () => {
    it('returns empty result when document does not belong to tenant', async () => {
      mockDocFindFirst.mockResolvedValue(null);

      const result = await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({ matches: [], total: 0, page: 1, limit: 50, totalPages: 0 });
    });

    it('returns paginated matches with correct metadata', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });

      const mockMatches = [
        { id: 'm1', matchType: 'EXTERNAL_ACADEMIC', similarityScore: 0.95, createdAt: new Date() },
        { id: 'm2', matchType: 'EXTERNAL_WEB', similarityScore: 0.7, createdAt: new Date() },
      ];
      mockMatchFindMany.mockResolvedValue(mockMatches);
      mockMatchCount.mockResolvedValue(30);

      const result = await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID, {
        page: 2,
        limit: 10,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(30);
      expect(result.totalPages).toBe(3);
      expect(result.matches).toHaveLength(2);
    });

    it('applies matchType filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockMatchFindMany.mockResolvedValue([]);
      mockMatchCount.mockResolvedValue(0);

      await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID, {
        matchType: 'EXTERNAL_ACADEMIC',
      });

      expect(mockMatchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ matchType: 'EXTERNAL_ACADEMIC' }),
        })
      );
    });

    it('applies classification filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockMatchFindMany.mockResolvedValue([]);
      mockMatchCount.mockResolvedValue(0);

      await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID, {
        classification: 'VERBATIM_COPY',
      });

      expect(mockMatchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ classification: 'VERBATIM_COPY' }),
        })
      );
    });

    it('applies status filter to the query', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockMatchFindMany.mockResolvedValue([]);
      mockMatchCount.mockResolvedValue(0);

      await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID, {
        status: 'PENDING',
      });

      expect(mockMatchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'PENDING' }),
        })
      );
    });

    it('uses default page=1 and limit=50 when options are omitted', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });
      mockMatchFindMany.mockResolvedValue([]);
      mockMatchCount.mockResolvedValue(0);

      const result = await plagiarismCheckService.getMatches(DOCUMENT_ID, TENANT_ID);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      expect(mockMatchFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 50,
        })
      );
    });
  });

  // =========================================================================
  // getSummary
  // =========================================================================
  describe('getSummary', () => {
    it('returns empty summary when document does not belong to tenant', async () => {
      mockDocFindFirst.mockResolvedValue(null);

      const result = await plagiarismCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result).toEqual({
        total: 0,
        averageSimilarity: 0,
        byType: {},
        byClassification: {},
        byStatus: {},
      });
    });

    it('returns aggregated summary with correct structure', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });

      mockMatchGroupBy
        .mockResolvedValueOnce([
          { matchType: 'EXTERNAL_ACADEMIC', _count: 5 },
          { matchType: 'EXTERNAL_WEB', _count: 3 },
        ])
        .mockResolvedValueOnce([
          { classification: 'VERBATIM_COPY', _count: 4 },
          { classification: 'PARAPHRASED', _count: 4 },
        ])
        .mockResolvedValueOnce([
          { status: 'PENDING', _count: 6 },
          { status: 'CONFIRMED_PLAGIARISM', _count: 2 },
        ]);

      mockMatchAggregate.mockResolvedValue({
        _avg: { similarityScore: 0.72 },
        _count: 8,
      });

      const result = await plagiarismCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result.total).toBe(8);
      expect(result.averageSimilarity).toBe(0.72);
      expect(result.byType).toEqual({ EXTERNAL_ACADEMIC: 5, EXTERNAL_WEB: 3 });
      expect(result.byClassification).toEqual({ VERBATIM_COPY: 4, PARAPHRASED: 4 });
      expect(result.byStatus).toEqual({ PENDING: 6, CONFIRMED_PLAGIARISM: 2 });
    });

    it('returns 0 average similarity when no matches exist', async () => {
      mockDocFindFirst.mockResolvedValue({ id: DOCUMENT_ID });

      mockMatchGroupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      mockMatchAggregate.mockResolvedValue({
        _avg: { similarityScore: null },
        _count: 0,
      });

      const result = await plagiarismCheckService.getSummary(DOCUMENT_ID, TENANT_ID);

      expect(result.total).toBe(0);
      expect(result.averageSimilarity).toBe(0);
    });
  });

  // =========================================================================
  // cleanupStaleJobs
  // =========================================================================
  describe('cleanupStaleJobs', () => {
    it('marks old PROCESSING/QUEUED jobs as FAILED', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 2 });

      const result = await plagiarismCheckService.cleanupStaleJobs();

      expect(result).toBe(2);
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

      const result = await plagiarismCheckService.cleanupStaleJobs();

      expect(result).toBe(0);
    });

    it('uses default 30 minute maxAgeMs for cutoff', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 0 });

      const before = Date.now();
      await plagiarismCheckService.cleanupStaleJobs();
      const after = Date.now();

      const calledWith = mockJobUpdateMany.mock.calls[0][0];
      const cutoffTime = calledWith.where.createdAt.lt.getTime();
      const defaultMaxAge = 30 * 60 * 1000;

      // Cutoff should be approximately (now - 30 minutes)
      expect(cutoffTime).toBeGreaterThanOrEqual(before - defaultMaxAge);
      expect(cutoffTime).toBeLessThanOrEqual(after - defaultMaxAge);
    });

    it('uses custom maxAgeMs for cutoff calculation', async () => {
      mockJobUpdateMany.mockResolvedValue({ count: 1 });
      const customAge = 60 * 60 * 1000; // 1 hour

      const before = Date.now();
      await plagiarismCheckService.cleanupStaleJobs(customAge);
      const after = Date.now();

      const calledWith = mockJobUpdateMany.mock.calls[0][0];
      const cutoffTime = calledWith.where.createdAt.lt.getTime();

      expect(cutoffTime).toBeGreaterThanOrEqual(before - customAge);
      expect(cutoffTime).toBeLessThanOrEqual(after - customAge);
    });
  });
});
