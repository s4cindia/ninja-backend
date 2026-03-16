import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockCorpusDocFindMany = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      findMany: (...args: unknown[]) => mockCorpusDocFindMany(...args),
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

describe('GET /calibration/corpus-docs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated documents with 200', async () => {
    const docs = [
      {
        id: 'doc-1',
        filename: 'test.pdf',
        publisher: 'Pearson',
        contentType: 'mixed',
        uploadedAt: new Date(),
        bootstrapJobs: [{ id: 'job-1', status: 'COMPLETE' }],
      },
      {
        id: 'doc-2',
        filename: 'test2.pdf',
        publisher: 'Wiley',
        contentType: 'text-dominant',
        uploadedAt: new Date(),
        bootstrapJobs: [],
      },
    ];
    mockCorpusDocFindMany.mockResolvedValue(docs);

    const app = buildApp();
    const res = await request(app).get('/calibration/corpus-docs');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.documents).toHaveLength(2);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('filters by publisher', async () => {
    mockCorpusDocFindMany.mockResolvedValue([]);

    const app = buildApp();
    await request(app).get('/calibration/corpus-docs?publisher=Pearson');

    expect(mockCorpusDocFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publisher: 'Pearson' }),
      }),
    );
  });

  it('returns empty result with nextCursor null', async () => {
    mockCorpusDocFindMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get('/calibration/corpus-docs');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ documents: [], nextCursor: null });
  });
});
