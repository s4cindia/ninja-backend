import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockFindUnique = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    trainingRun: {
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

const mockEcsSend = vi.fn().mockResolvedValue({
  tasks: [{ taskArn: 'mock-task-arn' }],
});
const mockSsmSend = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-ecs', () => {
  const MockECSClient = vi.fn();
  MockECSClient.prototype.send = (...args: unknown[]) => mockEcsSend(...args);
  return { ECSClient: MockECSClient, RunTaskCommand: vi.fn() };
});

vi.mock('@aws-sdk/client-ssm', () => {
  const MockSSMClient = vi.fn();
  MockSSMClient.prototype.send = (...args: unknown[]) => mockSsmSend(...args);
  return { SSMClient: MockSSMClient, PutParameterCommand: vi.fn() };
});

import {
  startTraining,
  onTrainingComplete,
  getTrainingStatus,
} from '../../../../src/services/training/training.service';

describe('training.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('startTraining creates PENDING then updates to RUNNING', async () => {
    mockCreate.mockResolvedValue({ id: 'run-1' });
    mockUpdate.mockResolvedValue({});

    const result = await startTraining({
      corpusExportS3Path: 's3://bucket/corpus.zip',
    });

    expect(result).toBe('run-1');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RUNNING' }),
      }),
    );
  });

  it('startTraining calls SSM 3 times', async () => {
    mockCreate.mockResolvedValue({ id: 'run-2' });
    mockUpdate.mockResolvedValue({});

    await startTraining({
      corpusExportS3Path: 's3://bucket/corpus.zip',
    });

    expect(mockSsmSend).toHaveBeenCalledTimes(3);
  });

  it('startTraining calls ECS RunTaskCommand once', async () => {
    mockCreate.mockResolvedValue({ id: 'run-3' });
    mockUpdate.mockResolvedValue({});

    await startTraining({
      corpusExportS3Path: 's3://bucket/corpus.zip',
    });

    expect(mockEcsSend).toHaveBeenCalledTimes(1);
  });

  it('onTrainingComplete success updates with COMPLETED', async () => {
    mockUpdate.mockResolvedValue({});

    await onTrainingComplete('run-4', true, {
      weightsS3: 's3://x/best.pt',
      onnxS3: 's3://x/best.onnx',
      epochs: 87,
      durationMs: 3600000,
      overallMAP: 0.81,
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-4' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          weightsS3Path: 's3://x/best.pt',
        }),
      }),
    );
  });

  it('onTrainingComplete failure updates with FAILED', async () => {
    mockUpdate.mockResolvedValue({});

    await onTrainingComplete('run-5', false);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-5' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('getTrainingStatus returns null for unknown id', async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await getTrainingStatus('nonexistent');

    expect(result).toBeNull();
  });
});
