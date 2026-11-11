import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    teamReview: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
  },
}));

import { getActiveReviewBlock } from '../../../../src/services/team-review/review-gate.service';

describe('getActiveReviewBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the job has no review at all', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await getActiveReviewBlock('job-1');

    expect(result).toBeNull();
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      orderBy: { reviewedAt: 'desc' },
    });
  });

  it('returns null when the most recent review is OK', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'r-1', reviewedBy: 'leader-1', reviewedAt: new Date('2026-11-01'), outcome: 'OK', notes: null,
    });

    const result = await getActiveReviewBlock('job-1');

    expect(result).toBeNull();
  });

  it('returns the block details when the most recent review is NEEDS_CORRECTION', async () => {
    const reviewedAt = new Date('2026-11-01');
    mockFindFirst.mockResolvedValue({
      id: 'r-2', reviewedBy: 'leader-1', reviewedAt, outcome: 'NEEDS_CORRECTION', notes: 'fix the alt text',
    });

    const result = await getActiveReviewBlock('job-1');

    expect(result).toEqual({
      reviewId: 'r-2',
      reviewedBy: 'leader-1',
      reviewedAt,
      notes: 'fix the alt text',
    });
  });

  it('a later OK review supersedes an earlier NEEDS_CORRECTION (only the single most recent row matters)', async () => {
    // findFirst with orderBy desc already returns only the latest row --
    // this test documents that the service trusts that single row rather
    // than scanning history itself.
    mockFindFirst.mockResolvedValue({
      id: 'r-3', reviewedBy: 'leader-1', reviewedAt: new Date('2026-11-05'), outcome: 'OK', notes: null,
    });

    const result = await getActiveReviewBlock('job-1');

    expect(result).toBeNull();
  });
});
