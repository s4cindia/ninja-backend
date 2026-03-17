import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockFindMany = vi.fn();
const mockCreateMany = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      createMany: (...args: unknown[]) => mockCreateMany(...args),
    },
    calibrationRun: { findMany: vi.fn().mockResolvedValue([]) },
    zone: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../../src/middleware/auth.middleware', () => ({
  authenticate: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1' } as never;
    next();
  },
}));

vi.mock('../../../src/queues', () => ({
  getCalibrationQueue: vi.fn(),
}));

vi.mock('../../../src/services/calibration/corpus-stats.service', () => ({
  getCorpusStats: vi.fn().mockResolvedValue({}),
}));

import calibrationRoutes from '../../../src/routes/calibration.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/calibration', calibrationRoutes);
  return app;
}

describe('POST /calibration/corpus-docs/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates 3 valid new documents', async () => {
    mockFindMany.mockResolvedValue([]);
    mockCreateMany.mockResolvedValue({ count: 3 });

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({
        documents: [
          { filename: 'a.pdf', s3Path: 's3://bucket/a.pdf' },
          { filename: 'b.pdf', s3Path: 's3://bucket/b.pdf' },
          { filename: 'c.pdf', s3Path: 's3://bucket/c.pdf' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBe(3);
    expect(res.body.data.skipped).toBe(0);
    expect(res.body.data.errors).toEqual([]);
  });

  it('skips duplicate s3Path', async () => {
    mockFindMany.mockResolvedValue([{ s3Path: 's3://bucket/a.pdf' }]);
    mockCreateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({
        documents: [
          { filename: 'a.pdf', s3Path: 's3://bucket/a.pdf' },
          { filename: 'b.pdf', s3Path: 's3://bucket/b.pdf' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.skipped).toBe(1);
  });

  it('captures createMany failure in errors', async () => {
    mockFindMany.mockResolvedValue([]);
    mockCreateMany.mockRejectedValue(new Error('DB write failed'));

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({
        documents: [{ filename: 'a.pdf', s3Path: 's3://bucket/a.pdf' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.errors).toHaveLength(1);
    expect(res.body.data.errors[0]).toContain('DB write failed');
  });

  it('rejects empty documents array with 422', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({ documents: [] });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('rejects more than 500 documents with 422', async () => {
    const docs = Array.from({ length: 501 }, (_, i) => ({
      filename: `f${i}.pdf`,
      s3Path: `s3://bucket/f${i}.pdf`,
    }));

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({ documents: docs });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('handles mixed valid and duplicate documents', async () => {
    mockFindMany.mockResolvedValue([
      { s3Path: 's3://bucket/a.pdf' },
      { s3Path: 's3://bucket/c.pdf' },
    ]);
    mockCreateMany.mockResolvedValue({ count: 3 });

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/corpus-docs/batch')
      .send({
        documents: [
          { filename: 'a.pdf', s3Path: 's3://bucket/a.pdf' },
          { filename: 'b.pdf', s3Path: 's3://bucket/b.pdf' },
          { filename: 'c.pdf', s3Path: 's3://bucket/c.pdf' },
          { filename: 'd.pdf', s3Path: 's3://bucket/d.pdf' },
          { filename: 'e.pdf', s3Path: 's3://bucket/e.pdf' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(3);
    expect(res.body.data.skipped).toBe(2);
    expect(res.body.data.errors).toEqual([]);
  });
});
