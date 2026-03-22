import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockZoneFindMany = vi.fn();
const mockCalibrationRunFindMany = vi.fn();
const mockCalibrationRunCount = vi.fn();
const mockCorpusDocumentCount = vi.fn();
const mockCorpusDocumentFindMany = vi.fn();
const mockZoneCount = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockCalibrationRunFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      count: (...args: unknown[]) => mockCalibrationRunCount(...args),
    },
    zone: {
      findMany: (...args: unknown[]) => mockZoneFindMany(...args),
      count: (...args: unknown[]) => mockZoneCount(...args),
    },
    corpusDocument: {
      count: (...args: unknown[]) => mockCorpusDocumentCount(...args),
      findMany: (...args: unknown[]) => mockCorpusDocumentFindMany(...args),
    },
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
  getCalibrationQueue: () => null,
}));

import calibrationRoutes from '../../../src/routes/calibration.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/calibration', calibrationRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /calibration/runs/:runId', () => {
  it('returns 200 and sets isArchived=true', async () => {
    mockFindUnique.mockResolvedValue({ id: 'run-1' });
    mockUpdate.mockResolvedValue({});

    const app = buildApp();
    const res = await request(app).delete('/calibration/runs/run-1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('CalibrationRun archived');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { isArchived: true },
    });
  });

  it('returns 404 for non-existent run', async () => {
    mockFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).delete('/calibration/runs/missing');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /calibration/runs/:runId/zones', () => {
  it('returns zones for the correct runId', async () => {
    const zones = [
      { id: 'z1', calibrationRunId: 'run-1', reconciliationBucket: 'GREEN' },
      { id: 'z2', calibrationRunId: 'run-1', reconciliationBucket: 'AMBER' },
    ];
    mockZoneFindMany.mockResolvedValue(zones);

    const app = buildApp();
    const res = await request(app).get('/calibration/runs/run-1/zones');

    expect(res.status).toBe(200);
    expect(res.body.data.zones).toHaveLength(2);
    expect(mockZoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { calibrationRunId: 'run-1' },
      }),
    );
  });

  it('passes bucket filter to where clause', async () => {
    mockZoneFindMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get(
      '/calibration/runs/run-1/zones?bucket=GREEN',
    );

    expect(res.status).toBe(200);
    expect(mockZoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { calibrationRunId: 'run-1', reconciliationBucket: 'GREEN' },
      }),
    );
  });
});

describe('GET /calibration/runs with fromDate', () => {
  it('passes gte date to where clause', async () => {
    mockCalibrationRunFindMany.mockResolvedValue([]);

    const app = buildApp();
    const fromDate = '2026-01-15T00:00:00.000Z';
    const res = await request(app).get(
      `/calibration/runs?fromDate=${encodeURIComponent(fromDate)}`,
    );

    expect(res.status).toBe(200);
    expect(mockCalibrationRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runDate: expect.objectContaining({ gte: new Date(fromDate) }),
        }),
      }),
    );
  });
});

describe('GET /calibration/corpus-stats', () => {
  it('returns CorpusStats shape', async () => {
    mockCorpusDocumentCount.mockResolvedValue(10);
    mockCalibrationRunCount.mockResolvedValue(5);
    mockZoneCount.mockResolvedValue(100);
    mockCalibrationRunFindMany.mockResolvedValue([
      { greenCount: 80, amberCount: 10, redCount: 10 },
    ]);
    mockCorpusDocumentFindMany.mockResolvedValue([
      { publisher: 'Pearson', contentType: 'mixed' },
    ]);

    const app = buildApp();
    const res = await request(app).get('/calibration/corpus-stats');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data).toHaveProperty('totalDocuments');
    expect(data).toHaveProperty('totalRuns');
    expect(data).toHaveProperty('totalConfirmedZones');
    expect(data).toHaveProperty('averageAgreementRate');
    expect(data).toHaveProperty('byPublisher');
    expect(data).toHaveProperty('byContentType');
  });
});
