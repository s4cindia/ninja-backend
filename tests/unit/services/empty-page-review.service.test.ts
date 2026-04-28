import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockReviewFindUnique = vi.fn();
const mockReviewFindMany = vi.fn();
const mockReviewUpsert = vi.fn();
const mockReviewDelete = vi.fn();
const mockCalibrationRunFindUnique = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    emptyPageReview: {
      findUnique: (...args: unknown[]) => mockReviewFindUnique(...args),
      findMany: (...args: unknown[]) => mockReviewFindMany(...args),
      upsert: (...args: unknown[]) => mockReviewUpsert(...args),
      delete: (...args: unknown[]) => mockReviewDelete(...args),
    },
    calibrationRun: {
      findUnique: (...args: unknown[]) => mockCalibrationRunFindUnique(...args),
    },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  calibrationRunExists,
  deleteReview,
  getReview,
  listReviews,
  upsertReview,
} from '../../../src/services/empty-page-review.service';

const RUN_ID = 'run-abc';
const ANNOTATOR_ID = 'user-123';

const annotator = {
  id: ANNOTATOR_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
};

function makeReview(overrides: Partial<{ pageNumber: number; category: string }> = {}) {
  return {
    id: 'review-1',
    calibrationRunId: RUN_ID,
    pageNumber: overrides.pageNumber ?? 5,
    category: (overrides.category ?? 'LEGIT_EMPTY') as 'LEGIT_EMPTY' | 'DETECTION_FAILURE' | 'UNSURE',
    pageType: 'blank',
    expectedContent: null,
    notes: null,
    annotatorId: ANNOTATOR_ID,
    annotator,
    reviewedAt: new Date('2026-04-28T10:00:00.000Z'),
    updatedAt: new Date('2026-04-28T10:00:00.000Z'),
    createdAt: new Date('2026-04-28T10:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('empty-page-review.service', () => {
  describe('calibrationRunExists', () => {
    it('returns true when the run exists', async () => {
      mockCalibrationRunFindUnique.mockResolvedValueOnce({ id: RUN_ID });
      await expect(calibrationRunExists(RUN_ID)).resolves.toBe(true);
      expect(mockCalibrationRunFindUnique).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        select: { id: true },
      });
    });

    it('returns false when the run does not exist', async () => {
      mockCalibrationRunFindUnique.mockResolvedValueOnce(null);
      await expect(calibrationRunExists(RUN_ID)).resolves.toBe(false);
    });
  });

  describe('listReviews', () => {
    it('returns reviews sorted by pageNumber ascending', async () => {
      mockReviewFindMany.mockResolvedValueOnce([
        makeReview({ pageNumber: 3 }),
        makeReview({ pageNumber: 7 }),
        makeReview({ pageNumber: 12 }),
      ]);

      const result = await listReviews(RUN_ID);

      expect(mockReviewFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { calibrationRunId: RUN_ID },
          orderBy: { pageNumber: 'asc' },
        }),
      );
      expect(result.map(r => r.pageNumber)).toEqual([3, 7, 12]);
      expect(result[0].annotator).toEqual(annotator);
      expect(typeof result[0].reviewedAt).toBe('string');
    });

    it('returns an empty array when no reviews exist', async () => {
      mockReviewFindMany.mockResolvedValueOnce([]);
      await expect(listReviews(RUN_ID)).resolves.toEqual([]);
    });
  });

  describe('getReview', () => {
    it('returns a single review when it exists', async () => {
      mockReviewFindUnique.mockResolvedValueOnce(makeReview({ pageNumber: 9 }));
      const result = await getReview(RUN_ID, 9);
      expect(result).not.toBeNull();
      expect(result?.pageNumber).toBe(9);
      expect(mockReviewFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { calibrationRunId_pageNumber: { calibrationRunId: RUN_ID, pageNumber: 9 } },
        }),
      );
    });

    it('returns null when no review exists for that page', async () => {
      mockReviewFindUnique.mockResolvedValueOnce(null);
      await expect(getReview(RUN_ID, 9)).resolves.toBeNull();
    });
  });

  describe('upsertReview', () => {
    it('creates a new review and returns it as a DTO', async () => {
      mockReviewUpsert.mockResolvedValueOnce(makeReview({ pageNumber: 5, category: 'LEGIT_EMPTY' }));

      const dto = await upsertReview(RUN_ID, 5, ANNOTATOR_ID, {
        category: 'LEGIT_EMPTY',
        pageType: 'blank',
      });

      expect(dto.pageNumber).toBe(5);
      expect(dto.category).toBe('LEGIT_EMPTY');
      expect(dto.expectedContent).toBeNull();
      expect(dto.notes).toBeNull();

      expect(mockReviewUpsert).toHaveBeenCalledTimes(1);
      const upsertArg = mockReviewUpsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({
        calibrationRunId_pageNumber: { calibrationRunId: RUN_ID, pageNumber: 5 },
      });
      expect(upsertArg.create).toMatchObject({
        calibrationRunId: RUN_ID,
        pageNumber: 5,
        category: 'LEGIT_EMPTY',
        pageType: 'blank',
        expectedContent: null,
        notes: null,
        annotatorId: ANNOTATOR_ID,
      });
      expect(upsertArg.update).toMatchObject({
        category: 'LEGIT_EMPTY',
        pageType: 'blank',
        expectedContent: null,
        notes: null,
        annotatorId: ANNOTATOR_ID,
      });
      expect(upsertArg.update.reviewedAt).toBeInstanceOf(Date);
    });

    it('updates an existing review when called twice with the same payload (idempotent)', async () => {
      const stored = makeReview({ pageNumber: 5, category: 'DETECTION_FAILURE' });
      stored.expectedContent = 'Chapter 1 opening';
      mockReviewUpsert.mockResolvedValue(stored);

      const payload = {
        category: 'DETECTION_FAILURE' as const,
        pageType: 'text_normal',
        expectedContent: 'Chapter 1 opening',
      };

      const first = await upsertReview(RUN_ID, 5, ANNOTATOR_ID, payload);
      const second = await upsertReview(RUN_ID, 5, ANNOTATOR_ID, payload);

      expect(first).toEqual(second);
      expect(mockReviewUpsert).toHaveBeenCalledTimes(2);
      const args = mockReviewUpsert.mock.calls.map(c => c[0]);
      expect(args[0].where).toEqual(args[1].where);
      expect(args[0].create.expectedContent).toBe('Chapter 1 opening');
      expect(args[0].update.expectedContent).toBe('Chapter 1 opening');
    });

    it('persists undefined optional fields as null', async () => {
      mockReviewUpsert.mockResolvedValueOnce(makeReview());

      await upsertReview(RUN_ID, 5, ANNOTATOR_ID, {
        category: 'UNSURE',
        pageType: 'other',
      });

      const arg = mockReviewUpsert.mock.calls[0][0];
      expect(arg.create.expectedContent).toBeNull();
      expect(arg.create.notes).toBeNull();
      expect(arg.update.expectedContent).toBeNull();
      expect(arg.update.notes).toBeNull();
    });
  });

  describe('deleteReview', () => {
    it('returns true when a review is deleted', async () => {
      mockReviewDelete.mockResolvedValueOnce({ id: 'r-1' });
      await expect(deleteReview(RUN_ID, 5)).resolves.toBe(true);
      expect(mockReviewDelete).toHaveBeenCalledWith({
        where: { calibrationRunId_pageNumber: { calibrationRunId: RUN_ID, pageNumber: 5 } },
      });
    });

    it('returns false when the review does not exist (P2025)', async () => {
      const err = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });
      mockReviewDelete.mockRejectedValueOnce(err);
      await expect(deleteReview(RUN_ID, 5)).resolves.toBe(false);
    });

    it('rethrows non-P2025 errors', async () => {
      mockReviewDelete.mockRejectedValueOnce(new Error('connection lost'));
      await expect(deleteReview(RUN_ID, 5)).rejects.toThrow('connection lost');
    });
  });
});
