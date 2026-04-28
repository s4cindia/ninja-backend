import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockListReviews = vi.fn();
const mockGetReview = vi.fn();
const mockUpsertReview = vi.fn();
const mockDeleteReview = vi.fn();
const mockCalibrationRunExists = vi.fn();

vi.mock('../../../src/services/empty-page-review.service', () => ({
  listReviews: (...args: unknown[]) => mockListReviews(...args),
  getReview: (...args: unknown[]) => mockGetReview(...args),
  upsertReview: (...args: unknown[]) => mockUpsertReview(...args),
  deleteReview: (...args: unknown[]) => mockDeleteReview(...args),
  calibrationRunExists: (...args: unknown[]) => mockCalibrationRunExists(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deleteEmptyPageReview,
  getEmptyPageReview,
  listEmptyPageReviews,
  upsertEmptyPageReview,
} from '../../../src/controllers/empty-page-review.controller';

const RUN_ID = 'run-abc';

function buildApp(role: string | undefined, userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role !== undefined) {
      req.user = {
        id: userId,
        email: 'u@example.com',
        tenantId: 'tenant-1',
        role,
      } as never;
    }
    next();
  });

  const sub = express.Router({ mergeParams: true });
  sub.get('/', listEmptyPageReviews);
  sub.get('/:pageNumber', getEmptyPageReview);
  sub.put('/:pageNumber', upsertEmptyPageReview);
  sub.delete('/:pageNumber', deleteEmptyPageReview);
  app.use('/runs/:runId/empty-page-reviews', sub);

  return app;
}

const sampleDTO = {
  pageNumber: 5,
  category: 'LEGIT_EMPTY' as const,
  pageType: 'blank',
  expectedContent: null,
  notes: null,
  annotator: { id: 'user-1', firstName: 'Ada', lastName: 'L', email: 'a@x.com' },
  reviewedAt: '2026-04-28T10:00:00.000Z',
  updatedAt: '2026-04-28T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCalibrationRunExists.mockResolvedValue(true);
});

describe('empty-page-review controller — authorization', () => {
  it('returns 403 for users without ADMIN or OPERATOR role', async () => {
    const app = buildApp('USER');

    const list = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews`);
    expect(list.status).toBe(403);

    const upsert = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/5`)
      .send({ category: 'LEGIT_EMPTY', pageType: 'blank' });
    expect(upsert.status).toBe(403);

    const del = await request(app).delete(`/runs/${RUN_ID}/empty-page-reviews/5`);
    expect(del.status).toBe(403);
  });

  it('allows OPERATOR role to read and write', async () => {
    const app = buildApp('OPERATOR');
    mockListReviews.mockResolvedValueOnce([sampleDTO]);
    mockUpsertReview.mockResolvedValueOnce(sampleDTO);

    const list = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews`);
    expect(list.status).toBe(200);
    expect(list.body.success).toBe(true);
    expect(list.body.data.reviews).toHaveLength(1);

    const upsert = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/5`)
      .send({ category: 'LEGIT_EMPTY', pageType: 'blank' });
    expect(upsert.status).toBe(200);
    expect(mockUpsertReview).toHaveBeenCalledWith(
      RUN_ID,
      5,
      'user-1',
      expect.objectContaining({ category: 'LEGIT_EMPTY', pageType: 'blank' }),
    );
  });

  it('allows ADMIN role to read and write', async () => {
    const app = buildApp('ADMIN');
    mockListReviews.mockResolvedValueOnce([]);
    const list = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews`);
    expect(list.status).toBe(200);
  });
});

describe('empty-page-review controller — endpoints', () => {
  it('GET /:pageNumber returns 404 when no review exists', async () => {
    const app = buildApp('OPERATOR');
    mockGetReview.mockResolvedValueOnce(null);

    const res = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews/5`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
  });

  it('GET /:pageNumber returns the review when present', async () => {
    const app = buildApp('OPERATOR');
    mockGetReview.mockResolvedValueOnce(sampleDTO);

    const res = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews/5`);
    expect(res.status).toBe(200);
    expect(res.body.data.pageNumber).toBe(5);
  });

  it('GET / returns 404 when the run does not exist', async () => {
    const app = buildApp('OPERATOR');
    mockCalibrationRunExists.mockResolvedValueOnce(false);

    const res = await request(app).get(`/runs/${RUN_ID}/empty-page-reviews`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RUN_NOT_FOUND');
  });

  it('PUT /:pageNumber rejects bad category values with 422', async () => {
    const app = buildApp('OPERATOR');
    const res = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/5`)
      .send({ category: 'BOGUS', pageType: 'blank' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpsertReview).not.toHaveBeenCalled();
  });

  it('PUT /:pageNumber rejects pageType outside the vocabulary', async () => {
    const app = buildApp('OPERATOR');
    const res = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/5`)
      .send({ category: 'LEGIT_EMPTY', pageType: 'half_title' });
    expect(res.status).toBe(422);
  });

  it('PUT /:pageNumber rejects DETECTION_FAILURE without expectedContent', async () => {
    const app = buildApp('OPERATOR');
    const res = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/5`)
      .send({ category: 'DETECTION_FAILURE', pageType: 'text_normal' });
    expect(res.status).toBe(422);
    const issue = res.body.error.details.find(
      (d: { path: (string | number)[] }) => d.path?.[0] === 'expectedContent',
    );
    expect(issue).toBeDefined();
  });

  it('PUT /:pageNumber rejects non-positive pageNumber', async () => {
    const app = buildApp('OPERATOR');
    const res = await request(app)
      .put(`/runs/${RUN_ID}/empty-page-reviews/0`)
      .send({ category: 'LEGIT_EMPTY', pageType: 'blank' });
    expect(res.status).toBe(422);
  });

  it('DELETE /:pageNumber returns 200 with deleted=true on success', async () => {
    const app = buildApp('OPERATOR');
    mockDeleteReview.mockResolvedValueOnce(true);

    const res = await request(app).delete(`/runs/${RUN_ID}/empty-page-reviews/5`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
  });

  it('DELETE /:pageNumber returns 404 when no review existed', async () => {
    const app = buildApp('OPERATOR');
    mockDeleteReview.mockResolvedValueOnce(false);

    const res = await request(app).delete(`/runs/${RUN_ID}/empty-page-reviews/5`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
  });
});
