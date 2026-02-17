import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures mocks are initialized before vi.mock factories run
const { mockJobFindFirst, mockAcrJobFindFirst, mockAcrJobCreate, mockCriterionReviewFindMany, mockCriterionReviewCreate } = vi.hoisted(() => ({
  mockJobFindFirst: vi.fn(),
  mockAcrJobFindFirst: vi.fn(),
  mockAcrJobCreate: vi.fn(),
  mockCriterionReviewFindMany: vi.fn(),
  mockCriterionReviewCreate: vi.fn(),
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findFirst: mockJobFindFirst },
    acrJob: { findFirst: mockAcrJobFindFirst, create: mockAcrJobCreate },
    acrCriterionReview: { findMany: mockCriterionReviewFindMany, create: mockCriterionReviewCreate },
    acrJobVersion: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({
      editions: [{ code: 'EPUB-A', name: 'Test', description: '', totalCount: 0, standard: '', criteriaIds: [] }],
      criteria: [],
    })),
    existsSync: vi.fn(() => true),
  },
}));

// fetchEpubAuditResults queries the DB — stub it out
vi.mock('../../../../src/services/epub/epub-audit.service', () => ({
  epubAuditService: { runAudit: vi.fn() },
}));

import { AcrService } from '../../../../src/services/acr.service';

const STUB_JOB = { id: 'job-1', tenantId: 'tenant-1', userId: 'user-1', output: { fileName: 'test.epub', combinedIssues: [], issues: [] }, validationResults: [] };
const STUB_ACR_DRAFT = { id: 'acr-old', status: 'draft', tenantId: 'tenant-1', jobId: 'job-1' };
const STUB_ACR_FINALIZED = { id: 'acr-old', status: 'finalized', tenantId: 'tenant-1', jobId: 'job-1' };
const STUB_ACR_NEW = { id: 'acr-new', status: 'in_progress', tenantId: 'tenant-1', jobId: 'job-1' };

describe('AcrService.createAcrAnalysis — versioning', () => {
  let service: AcrService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AcrService();
    // Stub fetchEpubAuditResults internal call
    mockJobFindFirst.mockResolvedValue(STUB_JOB);
    // Default: return existing reviews as empty
    mockCriterionReviewFindMany.mockResolvedValue([]);
  });

  it('reuses an existing draft AcrJob without creating a new record', async () => {
    mockAcrJobFindFirst.mockResolvedValue(STUB_ACR_DRAFT);

    const result = await service.createAcrAnalysis('user-1', 'tenant-1', 'job-1', 'EPUB-A');

    expect(result.acrJob.id).toBe('acr-old');
    expect(mockAcrJobCreate).not.toHaveBeenCalled();
  });

  it('creates a new AcrJob version when the existing record is finalized', async () => {
    mockAcrJobFindFirst.mockResolvedValue(STUB_ACR_FINALIZED);
    mockAcrJobCreate.mockResolvedValue(STUB_ACR_NEW);

    const result = await service.createAcrAnalysis('user-1', 'tenant-1', 'job-1', 'EPUB-A');

    expect(mockAcrJobCreate).toHaveBeenCalledOnce();
    expect(result.acrJob.id).toBe('acr-new');
  });

  it('creates a new AcrJob when no existing record exists', async () => {
    mockAcrJobFindFirst.mockResolvedValue(null);
    mockAcrJobCreate.mockResolvedValue(STUB_ACR_NEW);

    const result = await service.createAcrAnalysis('user-1', 'tenant-1', 'job-1', 'EPUB-A');

    expect(mockAcrJobCreate).toHaveBeenCalledOnce();
    expect(result.acrJob.id).toBe('acr-new');
  });
});
