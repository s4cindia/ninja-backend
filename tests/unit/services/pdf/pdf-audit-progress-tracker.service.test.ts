/**
 * PdfAuditProgressTracker -- extracted from accessibility.processor.ts
 * (2026-10-18) so pdf-batch-orchestrator.service.ts can share the exact
 * same, already incident-hardened progress-callback implementation. The
 * full crash-safety matrix (every callback swallows a failing Prisma/Redis
 * call instead of rejecting) is already proven unchanged through the
 * extraction by accessibility.processor.progress-callbacks.test.ts's 10
 * tests, which exercise this factory indirectly via the real worker. These
 * tests cover what's actually new here: the factory's own reusability
 * contract -- configurable percentage ranges, the optional onPercent hook,
 * and getLastKnownPercent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queueService } from '../../../../src/services/queue.service';
import prisma from '../../../../src/lib/prisma';
import { createAuditProgressCallbacks } from '../../../../src/services/pdf/pdf-audit-progress-tracker';

vi.mock('../../../../src/services/queue.service');
vi.mock('../../../../src/lib/prisma', () => ({
  default: { job: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('createAuditProgressCallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {} } as any);
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);
    vi.mocked(queueService.updateJobProgress).mockResolvedValue(undefined as any);
  });

  it('uses the single-file worker\'s own default percentage scheme (20-88% extraction, 88-95% validators) when no overrides are given -- the batch orchestrator relies on these defaults matching exactly, since PdfJobProgressPanel hard-codes them', async () => {
    const { onProgress, onValidatorComplete } = createAuditProgressCallbacks({ jobId: 'job-1' });

    await onProgress(5, 10); // 50% through extraction -> 20 + round(0.5*68) = 54
    expect(queueService.updateJobProgress).toHaveBeenLastCalledWith('job-1', 54);

    await onValidatorComplete('Tables', 1, 4, 8, new Date()); // 50% through validators -> 88 + round(0.5*7) = 92
    expect(queueService.updateJobProgress).toHaveBeenLastCalledWith('job-1', 92);
  });

  it('uses caller-supplied percentage ranges when overridden', async () => {
    const { onProgress } = createAuditProgressCallbacks({
      jobId: 'job-1',
      extractionStartPct: 0,
      extractionPctRange: 100,
    });

    await onProgress(1, 4); // 25% through a 0-100 range -> 25
    expect(queueService.updateJobProgress).toHaveBeenLastCalledWith('job-1', 25);
  });

  it('fires the optional onPercent hook alongside every percentage it computes', async () => {
    const onPercent = vi.fn();
    const { onProgress, onValidatorComplete } = createAuditProgressCallbacks({ jobId: 'job-1', onPercent });

    await onProgress(5, 10);
    await onValidatorComplete('Tables', 1, 4, 8, new Date());

    expect(onPercent).toHaveBeenCalledTimes(2);
  });

  it('does not throw when onPercent is omitted -- the batch orchestrator has no BullMQ job reference to supply one', async () => {
    const { onProgress } = createAuditProgressCallbacks({ jobId: 'job-1' });

    await expect(onProgress(5, 10)).resolves.toBeUndefined();
  });

  it('getLastKnownPercent reflects the most recent percentage across all three callbacks', async () => {
    const { onProgress, onValidatorComplete, onAltTextImageProgress, getLastKnownPercent } =
      createAuditProgressCallbacks({ jobId: 'job-1' });

    expect(getLastKnownPercent()).toBe(20); // extractionStartPct default, before any call

    await onProgress(5, 10);
    expect(getLastKnownPercent()).toBe(54);

    await onValidatorComplete('Tables', 1, 4, 8, new Date());
    expect(getLastKnownPercent()).toBe(92);

    // onAltTextImageProgress deliberately re-reports the last known percentage
    // rather than computing a new one (see the factory's own doc comment) --
    // it should stay at 92, not change.
    await onAltTextImageProgress(100, 200);
    expect(getLastKnownPercent()).toBe(92);
    expect(queueService.updateJobProgress).toHaveBeenLastCalledWith('job-1', 92);
  });
});
