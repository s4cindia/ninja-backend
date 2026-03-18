import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();
const mockFindFirst = vi.fn();

const mockTransaction = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    trainingRun: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    calibrationRun: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
  Prisma: { DbNull: 'DbNull' },
}));

const mockSsmSend = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-ssm', () => {
  const MockSSMClient = vi.fn();
  MockSSMClient.prototype.send = (...args: unknown[]) => mockSsmSend(...args);
  return { SSMClient: MockSSMClient, PutParameterCommand: vi.fn() };
});

import {
  evaluateTrainingRun,
  promoteTrainingRun,
  rollbackTrainingRun,
} from '../../../../src/services/training/evaluation.service';

function makeRun(overrides?: Record<string, unknown>) {
  return {
    id: 'run-1',
    status: 'COMPLETED',
    mapResult: {
      overallMAP: 0.80,
      perClassAP: {
        paragraph: 0.85, table: 0.82, figure: 0.78,
        'section-header': 0.75, caption: 0.70,
        footnote: 0.65, header: 0.60, footer: 0.55,
      },
    },
    onnxS3Path: 's3://bucket/best.onnx',
    promotedAt: null,
    ...overrides,
  };
}

function makeCalibration(overrides?: Record<string, unknown>) {
  return {
    id: 'cal-1',
    completedAt: new Date(),
    mapSnapshot: {
      overallMAP: 0.74,
      perClassAP: {
        paragraph: 0.80, table: 0.78, figure: 0.72,
        'section-header': 0.70, caption: 0.65,
        footnote: 0.60, header: 0.58, footer: 0.53,
      },
    },
    ...overrides,
  };
}

describe('evaluation.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockTransaction.mockResolvedValue([{ count: 1 }, {}]);
  });

  // Test 1 — PROCEED
  it('recommends PROCEED when improvement >= 0.5% and no regression > 2%', async () => {
    mockFindUnique.mockResolvedValue(makeRun());
    mockFindFirst.mockResolvedValue(makeCalibration());

    const result = await evaluateTrainingRun('run-1');

    expect(result.promotionRecommendation).toBe('PROCEED');
    expect(result.overallDelta).toBeCloseTo(0.06, 4);
    expect(result.fineTunedOverallMAP).toBe(0.80);
    expect(result.baseOverallMAP).toBe(0.74);
    expect(result.holdReason).toBeUndefined();
    expect(result.perClassDeltas).toHaveLength(8);
  });

  // Test 2 — HOLD: below threshold
  it('recommends HOLD when overall improvement below 0.5% threshold', async () => {
    mockFindUnique.mockResolvedValue(makeRun({
      mapResult: {
        overallMAP: 0.742,
        perClassAP: {
          paragraph: 0.80, table: 0.78, figure: 0.72,
          'section-header': 0.70, caption: 0.65,
          footnote: 0.60, header: 0.58, footer: 0.53,
        },
      },
    }));
    mockFindFirst.mockResolvedValue(makeCalibration({
      mapSnapshot: { overallMAP: 0.740, perClassAP: {} },
    }));

    const result = await evaluateTrainingRun('run-1');

    expect(result.promotionRecommendation).toBe('HOLD');
    expect(result.holdReason).toContain('below 0.5% threshold');
  });

  // Test 3 — HOLD: class regression > 2%
  it('recommends HOLD when one class regresses > 2%', async () => {
    mockFindUnique.mockResolvedValue(makeRun({
      mapResult: {
        overallMAP: 0.80,
        perClassAP: {
          paragraph: 0.85, table: 0.60, figure: 0.78,
          'section-header': 0.75, caption: 0.70,
          footnote: 0.65, header: 0.60, footer: 0.55,
        },
      },
    }));
    mockFindFirst.mockResolvedValue(makeCalibration({
      mapSnapshot: {
        overallMAP: 0.74,
        perClassAP: {
          paragraph: 0.80, table: 0.65, figure: 0.72,
          'section-header': 0.70, caption: 0.65,
          footnote: 0.60, header: 0.58, footer: 0.53,
        },
      },
    }));

    const result = await evaluateTrainingRun('run-1');

    expect(result.promotionRecommendation).toBe('HOLD');
    expect(result.holdReason).toContain('table');
  });

  // Test 4 — HOLD: zero improvement
  it('recommends HOLD when overall improvement is zero', async () => {
    mockFindUnique.mockResolvedValue(makeRun({
      mapResult: { overallMAP: 0.74, perClassAP: {} },
    }));
    mockFindFirst.mockResolvedValue(makeCalibration({
      mapSnapshot: { overallMAP: 0.74, perClassAP: {} },
    }));

    const result = await evaluateTrainingRun('run-1');

    expect(result.promotionRecommendation).toBe('HOLD');
    expect(result.holdReason).toContain('0.00%');
  });

  // Test 5 — throws if not found
  it('throws if TrainingRun not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(evaluateTrainingRun('missing'))
      .rejects.toThrow('not found');
  });

  // Test 6 — throws if not COMPLETED
  it('throws if TrainingRun is not COMPLETED', async () => {
    mockFindUnique.mockResolvedValue(makeRun({ status: 'RUNNING' }));

    await expect(evaluateTrainingRun('run-1'))
      .rejects.toThrow('not COMPLETED');
  });

  // Test 7 — persists result
  it('persists evaluationResult and promotionRecommendation', async () => {
    mockFindUnique.mockResolvedValue(makeRun());
    mockFindFirst.mockResolvedValue(makeCalibration());

    await evaluateTrainingRun('run-1');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          promotionRecommendation: 'PROCEED',
          evaluationResult: expect.objectContaining({
            trainingRunId: 'run-1',
            promotionRecommendation: 'PROCEED',
          }),
        }),
      }),
    );
  });

  // Test 8 — promoteTrainingRun: SSM updated
  it('promote updates SSM with ONNX path', async () => {
    mockFindUnique.mockResolvedValue(makeRun());

    const result = await promoteTrainingRun('run-1', 'admin-user');

    expect(result.onnxPath).toBe('s3://bucket/best.onnx');
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  // Test 9 — promoteTrainingRun: previous runs superseded
  it('promote supersedes previous promoted runs', async () => {
    mockFindUnique.mockResolvedValue(makeRun());

    await promoteTrainingRun('run-1', 'admin-user');

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          promotedAt: { not: null },
          id: { not: 'run-1' },
        },
        data: { promotionRecommendation: 'SUPERSEDED' },
      }),
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ promotedBy: 'admin-user' }),
      }),
    );
  });

  // Test 10 — rollbackTrainingRun: SSM reverted
  it('rollback updates SSM to the specified run ONNX path', async () => {
    mockFindUnique.mockResolvedValue(makeRun({
      onnxS3Path: 's3://bucket/old/best.onnx',
    }));

    const result = await rollbackTrainingRun('run-1');

    expect(result.rolledBackTo).toBe('run-1');
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });
});
