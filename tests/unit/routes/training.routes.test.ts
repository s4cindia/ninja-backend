import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockZoneFindMany = vi.fn();
const mockZoneCount = vi.fn();
const mockCalibrationRunFindMany = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    zone: {
      findMany: (...args: unknown[]) => mockZoneFindMany(...args),
      count: (...args: unknown[]) => mockZoneCount(...args),
    },
    calibrationRun: {
      findMany: (...args: unknown[]) => mockCalibrationRunFindMany(...args),
    },
  },
}));

vi.mock('../../../src/middleware/auth.middleware', () => ({
  authenticate: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = { id: 'operator-test-id', tenantId: 'tenant-1' } as never;
    next();
  },
}));

import trainingRoutes from '../../../src/routes/training.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/training', trainingRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /training/ground-truth', () => {
  it('returns only operatorVerified=true, isArtefact=false zones in YOLO format', async () => {
    mockZoneFindMany.mockResolvedValue([
      {
        pageNumber: 1,
        bounds: { x: 10, y: 20, w: 100, h: 50 },
        type: 'paragraph',
        operatorLabel: 'section-header',
      },
    ]);

    const app = buildApp();
    const res = await request(app).get('/training/ground-truth?runId=run-1');

    expect(res.status).toBe(200);
    expect(res.body.data.zones).toHaveLength(1);
    expect(res.body.data.total).toBe(1);

    // Verify the where clause
    expect(mockZoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          calibrationRunId: 'run-1',
          operatorVerified: true,
          isArtefact: false,
        },
      }),
    );
  });

  it('returns confidence=1.0 and source=operator', async () => {
    mockZoneFindMany.mockResolvedValue([
      {
        pageNumber: 1,
        bounds: { x: 0, y: 0, w: 10, h: 10 },
        type: 'table',
        operatorLabel: 'table',
      },
    ]);

    const app = buildApp();
    const res = await request(app).get('/training/ground-truth?runId=run-1');

    const zone = res.body.data.zones[0];
    expect(zone.confidence).toBe(1.0);
    expect(zone.source).toBe('operator');
  });

  it('uses operatorLabel when present, falls back to type', async () => {
    mockZoneFindMany.mockResolvedValue([
      {
        pageNumber: 1,
        bounds: { x: 0, y: 0, w: 10, h: 10 },
        type: 'paragraph',
        operatorLabel: 'caption',
      },
      {
        pageNumber: 2,
        bounds: { x: 0, y: 0, w: 10, h: 10 },
        type: 'figure',
        operatorLabel: null,
      },
    ]);

    const app = buildApp();
    const res = await request(app).get('/training/ground-truth?runId=run-1');

    expect(res.body.data.zones[0].label).toBe('caption');
    expect(res.body.data.zones[1].label).toBe('figure');
  });

  it('returns 422 when runId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/training/ground-truth');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /training/ground-truth/stats', () => {
  it('totalConfirmed count correct', async () => {
    mockZoneFindMany.mockResolvedValue([
      { operatorLabel: 'paragraph', type: 'paragraph', calibrationRunId: null },
      { operatorLabel: null, type: 'table', calibrationRunId: null },
      { operatorLabel: 'figure', type: 'figure', calibrationRunId: null },
    ]);
    mockCalibrationRunFindMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get('/training/ground-truth/stats');

    expect(res.status).toBe(200);
    expect(res.body.data.totalConfirmed).toBe(3);
  });

  it('byZoneType groups correctly', async () => {
    mockZoneFindMany.mockResolvedValue([
      { operatorLabel: 'paragraph', type: 'paragraph', calibrationRunId: null },
      { operatorLabel: 'paragraph', type: 'paragraph', calibrationRunId: null },
      { operatorLabel: null, type: 'table', calibrationRunId: null },
    ]);
    mockCalibrationRunFindMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get('/training/ground-truth/stats');

    expect(res.body.data.byZoneType).toEqual({
      paragraph: 2,
      table: 1,
    });
  });
});
