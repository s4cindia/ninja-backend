import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdate = vi.fn();
const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      update: (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
  Prisma: {
    DbNull: 'DbNull',
  },
}));

import {
  saveMapSnapshot,
  getMapSnapshot,
  getMapHistory,
} from '../../../../src/services/metrics/map-persistence';
import type { MAPResult } from '../../../../src/services/metrics/ml-metrics.types';

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleResult: MAPResult = {
  overallMAP: 0.85,
  perClass: [],
  insufficientDataWarnings: [],
  groundTruthTotal: 40,
  predictionTotal: 42,
};

describe('saveMapSnapshot', () => {
  it('calls prisma.calibrationRun.update with correct args', async () => {
    mockUpdate.mockResolvedValue({});
    await saveMapSnapshot('run-1', sampleResult);

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { mapSnapshot: sampleResult },
    });
  });
});

describe('getMapSnapshot', () => {
  it('returns null when run not found', async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await getMapSnapshot('missing-id');
    expect(result).toBeNull();
  });

  it('returns null when mapSnapshot is null', async () => {
    mockFindUnique.mockResolvedValue({ mapSnapshot: null });
    const result = await getMapSnapshot('run-1');
    expect(result).toBeNull();
  });
});

describe('getMapHistory', () => {
  it('returns results ordered by completedAt asc', async () => {
    const runs = [
      { id: 'r1', runDate: new Date('2026-01-01'), mapSnapshot: { overallMAP: 0.7, perClass: [] } },
      { id: 'r2', runDate: new Date('2026-02-01'), mapSnapshot: { overallMAP: 0.8, perClass: [] } },
    ];
    mockFindMany.mockResolvedValue(runs);

    const result = await getMapHistory();
    expect(result).toHaveLength(2);
    expect(result[0].runId).toBe('r1');
    expect(result[1].runId).toBe('r2');
  });

  it('filters by fromDate correctly', async () => {
    const runs = [
      { id: 'r2', runDate: new Date('2026-02-01'), mapSnapshot: { overallMAP: 0.8, perClass: [] } },
      { id: 'r3', runDate: new Date('2026-03-01'), mapSnapshot: { overallMAP: 0.9, perClass: [] } },
    ];
    mockFindMany.mockResolvedValue(runs);

    const from = new Date('2026-01-15');
    const result = await getMapHistory(from);
    expect(result).toHaveLength(2);
    // Verify the findMany was called with gte filter
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          completedAt: expect.objectContaining({ gte: from }),
        }),
      }),
    );
  });
});
