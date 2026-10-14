/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/pdf/auto-remediation-loop.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/pdf/auto-remediation-loop.service')>();
  return {
    ...actual,
    autoRemediationLoopService: {
      startAutoLoop: vi.fn(),
    },
  };
});

import { processAutoRemediationJob } from '../../../src/workers/processors/auto-remediation.processor';
import {
  autoRemediationLoopService,
  ComparisonTrialAutoRemediationDriver,
  JobAutoRemediationDriver,
} from '../../../src/services/pdf/auto-remediation-loop.service';

function makeBullJob(data: { kind: 'trial' | 'jobRun'; id: string }) {
  return { id: `auto-remediation-${data.id}`, data } as any;
}

describe('processAutoRemediationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(autoRemediationLoopService.startAutoLoop).mockResolvedValue(undefined);
  });

  it('constructs a ComparisonTrialAutoRemediationDriver for kind "trial" and awaits startAutoLoop', async () => {
    const result = await processAutoRemediationJob(makeBullJob({ kind: 'trial', id: 'trial-1' }));

    expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(
      new ComparisonTrialAutoRemediationDriver('trial-1')
    );
    expect(result).toEqual({ kind: 'trial', id: 'trial-1' });
  });

  it('constructs a JobAutoRemediationDriver for kind "jobRun" and awaits startAutoLoop', async () => {
    const result = await processAutoRemediationJob(makeBullJob({ kind: 'jobRun', id: 'run-1' }));

    expect(autoRemediationLoopService.startAutoLoop).toHaveBeenCalledWith(
      new JobAutoRemediationDriver('run-1')
    );
    expect(result).toEqual({ kind: 'jobRun', id: 'run-1' });
  });

  it('propagates a rejection if startAutoLoop itself ever rejects (it is not expected to, but the processor adds no swallowing of its own)', async () => {
    vi.mocked(autoRemediationLoopService.startAutoLoop).mockRejectedValue(new Error('unexpected'));

    await expect(processAutoRemediationJob(makeBullJob({ kind: 'trial', id: 'trial-1' }))).rejects.toThrow('unexpected');
  });
});
