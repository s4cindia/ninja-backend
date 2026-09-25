/**
 * Orphaned-job recovery around the web/worker split.
 *
 * Real incident (2026-09-26): a worker redeploy SIGKILLed a 529-page PDF's
 * Alt Text step ~25 minutes in. ECS Fargate's stopTimeout is capped at 120s
 * regardless of task-definition value, so worker.close()'s default "wait for
 * the active job to finish" could never complete before SIGKILL. The job's
 * BullMQ lock was left to expire passively and its DB row stayed at
 * PROCESSING/error:null indefinitely — no failure, no retry, no visibility.
 *
 * Three independent layers close that gap, each covered below:
 *  1. failActiveJobsBeforeShutdown() — runs on SIGTERM, before worker.close(),
 *     so a job that's actually mid-flight during a deploy fails fast and
 *     honestly instead of hanging.
 *  2. cleanupStaleActiveJobs() (exercised indirectly via the shared
 *     failAndCleanActiveJobs helper) — the pre-existing startup sweep,
 *     unchanged in behavior, still catches whatever a crash/OOM with no
 *     graceful SIGTERM leaves behind.
 *  3. cleanupStalePdfJobs() — periodic (watchdog-interval) DB-level sweep
 *     for anything layers 1 and 2 miss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockJobUpdateMany } = vi.hoisted(() => ({
  mockJobUpdateMany: vi.fn(),
}));

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { updateMany: mockJobUpdateMany },
  },
}));

const { mockAreQueuesAvailable, mockGetAccessibilityQueue } = vi.hoisted(() => ({
  mockAreQueuesAvailable: vi.fn(),
  mockGetAccessibilityQueue: vi.fn(),
}));

vi.mock('../../../src/queues', async () => {
  const actual = await vi.importActual<typeof import('../../../src/queues')>('../../../src/queues');
  return {
    ...actual,
    areQueuesAvailable: mockAreQueuesAvailable,
    getAccessibilityQueue: mockGetAccessibilityQueue,
  };
});

import { failActiveJobsBeforeShutdown, cleanupStalePdfJobs } from '../../../src/workers/index';

describe('failActiveJobsBeforeShutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails the DB record for every currently-active accessibility job and cleans BullMQ', async () => {
    mockAreQueuesAvailable.mockReturnValue(true);
    const mockClean = vi.fn().mockResolvedValue(['bull-job-1']);
    const mockGetActive = vi.fn().mockResolvedValue([
      { id: 'job-1', data: { options: { dbJobId: 'job-1' } } },
    ]);
    mockGetAccessibilityQueue.mockReturnValue({ getActive: mockGetActive, clean: mockClean });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });

    await failActiveJobsBeforeShutdown();

    expect(mockJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PROCESSING' },
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('Worker restarted (deploy)'),
      }),
    });
    expect(mockClean).toHaveBeenCalledWith(0, 11, 'active');
  });

  it('falls back to the BullMQ job id when options.dbJobId is absent', async () => {
    mockAreQueuesAvailable.mockReturnValue(true);
    const mockClean = vi.fn().mockResolvedValue([]);
    const mockGetActive = vi.fn().mockResolvedValue([{ id: 'fallback-id', data: {} }]);
    mockGetAccessibilityQueue.mockReturnValue({ getActive: mockGetActive, clean: mockClean });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });

    await failActiveJobsBeforeShutdown();

    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'fallback-id', status: 'PROCESSING' } })
    );
  });

  it('does nothing when there are no active jobs', async () => {
    mockAreQueuesAvailable.mockReturnValue(true);
    const mockClean = vi.fn();
    const mockGetActive = vi.fn().mockResolvedValue([]);
    mockGetAccessibilityQueue.mockReturnValue({ getActive: mockGetActive, clean: mockClean });

    await failActiveJobsBeforeShutdown();

    expect(mockJobUpdateMany).not.toHaveBeenCalled();
    expect(mockClean).not.toHaveBeenCalled();
  });

  it('is a no-op when queues are unavailable (never throws, never touches Prisma)', async () => {
    mockAreQueuesAvailable.mockReturnValue(false);

    await expect(failActiveJobsBeforeShutdown()).resolves.toBeUndefined();

    expect(mockGetAccessibilityQueue).not.toHaveBeenCalled();
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('swallows errors from the queue instead of throwing (must not block shutdown)', async () => {
    mockAreQueuesAvailable.mockReturnValue(true);
    mockGetAccessibilityQueue.mockImplementation(() => {
      throw new Error('Redis unreachable');
    });

    await expect(failActiveJobsBeforeShutdown()).resolves.toBeUndefined();
  });
});

describe('cleanupStalePdfJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks PDF/EPUB accessibility jobs stuck at PROCESSING with no recent progress as FAILED', async () => {
    mockJobUpdateMany.mockResolvedValue({ count: 1 });

    await cleanupStalePdfJobs();

    expect(mockJobUpdateMany).toHaveBeenCalledWith({
      where: {
        type: { in: ['PDF_ACCESSIBILITY', 'EPUB_ACCESSIBILITY'] },
        status: 'PROCESSING',
        updatedAt: { lt: expect.any(Date) },
      },
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('orphaned'),
      }),
    });
  });

  it('does not throw if the update itself fails', async () => {
    mockJobUpdateMany.mockRejectedValue(new Error('DB unavailable'));

    await expect(cleanupStalePdfJobs()).resolves.toBeUndefined();
  });
});
