import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCorpusDocumentCount = vi.fn();
const mockCalibrationRunCount = vi.fn();
const mockZoneCount = vi.fn();
const mockCalibrationRunFindMany = vi.fn();
const mockCorpusDocumentFindMany = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      count: (...args: unknown[]) => mockCorpusDocumentCount(...args),
      findMany: (...args: unknown[]) => mockCorpusDocumentFindMany(...args),
    },
    calibrationRun: {
      count: (...args: unknown[]) => mockCalibrationRunCount(...args),
      findMany: (...args: unknown[]) => mockCalibrationRunFindMany(...args),
    },
    zone: {
      count: (...args: unknown[]) => mockZoneCount(...args),
    },
  },
}));

import { getCorpusStats } from '../../../../src/services/calibration/corpus-stats.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCorpusStats', () => {
  it('empty corpus returns all zeros', async () => {
    mockCorpusDocumentCount.mockResolvedValue(0);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([]);

    const stats = await getCorpusStats();

    expect(stats.totalDocuments).toBe(0);
    expect(stats.totalRuns).toBe(0);
    expect(stats.totalConfirmedZones).toBe(0);
    expect(stats.averageAgreementRate).toBe(0);
    expect(stats.byPublisher).toEqual({});
    expect(stats.byContentType).toEqual({});
  });

  it('totalDocuments correct', async () => {
    mockCorpusDocumentCount.mockResolvedValue(25);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([]);

    const stats = await getCorpusStats();
    expect(stats.totalDocuments).toBe(25);
  });

  it('totalConfirmedZones filters correctly', async () => {
    mockCorpusDocumentCount.mockResolvedValue(0);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(847);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([]);

    const stats = await getCorpusStats();
    expect(stats.totalConfirmedZones).toBe(847);
    expect(mockZoneCount).toHaveBeenCalledWith({
      where: { operatorVerified: true, isArtefact: false },
    });
  });

  it('averageAgreementRate calculation', async () => {
    mockCorpusDocumentCount.mockResolvedValue(0);
    mockCalibrationRunCount.mockResolvedValue(2);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([
      { greenCount: 80, amberCount: 15, redCount: 5 },
      { greenCount: 60, amberCount: 30, redCount: 10 },
    ]);
    mockCorpusDocumentFindMany.mockResolvedValue([]);

    const stats = await getCorpusStats();
    expect(stats.averageAgreementRate).toBe(0.7);
  });

  it('averageAgreementRate skips zero-total runs', async () => {
    mockCorpusDocumentCount.mockResolvedValue(0);
    mockCalibrationRunCount.mockResolvedValue(2);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([
      { greenCount: 80, amberCount: 15, redCount: 5 },
      { greenCount: 0, amberCount: 0, redCount: 0 },
    ]);
    mockCorpusDocumentFindMany.mockResolvedValue([]);

    const stats = await getCorpusStats();
    expect(stats.averageAgreementRate).toBe(0.8);
  });

  it('byPublisher groups correctly', async () => {
    mockCorpusDocumentCount.mockResolvedValue(3);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([
      { publisher: 'Pearson', contentType: null },
      { publisher: 'Pearson', contentType: null },
      { publisher: 'Wiley', contentType: null },
    ]);

    const stats = await getCorpusStats();
    expect(stats.byPublisher).toEqual({ Pearson: 2, Wiley: 1 });
  });

  it('byPublisher skips null', async () => {
    mockCorpusDocumentCount.mockResolvedValue(2);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([
      { publisher: null, contentType: null },
      { publisher: 'Pearson', contentType: null },
    ]);

    const stats = await getCorpusStats();
    expect(stats.byPublisher).toEqual({ Pearson: 1 });
  });

  it('byContentType groups correctly', async () => {
    mockCorpusDocumentCount.mockResolvedValue(3);
    mockCalibrationRunCount.mockResolvedValue(0);
    mockZoneCount.mockResolvedValue(0);
    mockCalibrationRunFindMany.mockResolvedValue([]);
    mockCorpusDocumentFindMany.mockResolvedValue([
      { publisher: null, contentType: 'table-heavy' },
      { publisher: null, contentType: 'mixed' },
      { publisher: null, contentType: 'table-heavy' },
    ]);

    const stats = await getCorpusStats();
    expect(stats.byContentType).toEqual({ 'table-heavy': 2, mixed: 1 });
  });
});
