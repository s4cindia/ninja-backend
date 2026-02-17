import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures these are initialized before vi.mock factories run
const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    acrJob: { findFirst: mockFindFirst },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// AcrService reads edition data from JSON at construction; return minimal valid shape
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ editions: [], criteria: [] })),
    existsSync: vi.fn(() => true),
  },
}));

import { AcrService } from '../../../../src/services/acr.service';

describe('AcrService.resolveAcrJob', () => {
  let service: AcrService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AcrService();
  });

  it('returns the most recently created AcrJob — verifies orderBy: createdAt desc', async () => {
    const newerJob = { id: 'newer-id', tenantId: 'tenant-abc', jobId: 'job-123', createdAt: new Date('2024-02-02') };
    mockFindFirst.mockResolvedValue(newerJob);

    const result = await service.resolveAcrJob('job-123', 'tenant-abc');

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
    expect(result?.id).toBe('newer-id');
  });

  it('scopes queries to tenantId and does not return records from a different tenant', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await service.resolveAcrJob('job-123', 'tenant-B');

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-B' }),
      })
    );
    expect(result).toBeNull();
  });

  it('throws when tenantId is empty, preventing unauthenticated lookups', async () => {
    await expect(
      // @ts-expect-error — intentionally testing runtime guard
      service.resolveAcrJob('job-123', '')
    ).rejects.toThrow('tenantId is required');
  });
});
