import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockZoneFindUnique = vi.fn();
const mockZoneUpdate = vi.fn();
const mockZoneUpdateMany = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    zone: {
      findUnique: (...args: unknown[]) => mockZoneFindUnique(...args),
      update: (...args: unknown[]) => mockZoneUpdate(...args),
      updateMany: (...args: unknown[]) => mockZoneUpdateMany(...args),
    },
  },
  Prisma: {
    DbNull: 'DbNull',
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

import zoneCorrectionRoutes from '../../../src/routes/zone-correction.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/calibration', zoneCorrectionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /calibration/zones/:zoneId/confirm', () => {
  it('sets operatorVerified=true and verifiedBy', async () => {
    const zone = { id: 'z1', type: 'paragraph', operatorLabel: null };
    mockZoneFindUnique.mockResolvedValue(zone);
    mockZoneUpdate.mockResolvedValue({
      ...zone,
      operatorVerified: true,
      operatorLabel: 'paragraph',
      verifiedBy: 'operator-test-id',
    });

    const app = buildApp();
    const res = await request(app).post('/calibration/zones/z1/confirm');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.operatorVerified).toBe(true);
    expect(res.body.data.verifiedBy).toBe('operator-test-id');
    expect(mockZoneUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'z1' },
        data: expect.objectContaining({
          operatorVerified: true,
          operatorLabel: 'paragraph',
          verifiedBy: 'operator-test-id',
        }),
      }),
    );
  });

  it('returns 404 when zone not found', async () => {
    mockZoneFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).post('/calibration/zones/missing/confirm');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /calibration/zones/:zoneId/correct', () => {
  it('updates operatorLabel, preserves doclingLabel', async () => {
    const zone = { id: 'z1', type: 'paragraph', doclingLabel: 'Text', operatorLabel: null };
    mockZoneFindUnique.mockResolvedValue(zone);
    mockZoneUpdate.mockResolvedValue({
      ...zone,
      operatorVerified: true,
      operatorLabel: 'section-header',
      doclingLabel: 'Text',
      verifiedBy: 'operator-test-id',
    });

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/zones/z1/correct')
      .send({ newLabel: 'section-header' });

    expect(res.status).toBe(200);
    expect(res.body.data.operatorLabel).toBe('section-header');
    expect(res.body.data.doclingLabel).toBe('Text');
    expect(mockZoneUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operatorVerified: true,
          operatorLabel: 'section-header',
        }),
      }),
    );
    // Verify doclingLabel is NOT in the update data
    const updateCall = mockZoneUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('doclingLabel');
    expect(updateCall.data).not.toHaveProperty('pdfxtLabel');
  });

  it('returns 422 for missing newLabel', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/calibration/zones/z1/correct')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /calibration/zones/:zoneId/reject', () => {
  it('sets isArtefact=true and verifiedBy', async () => {
    const zone = { id: 'z1', type: 'paragraph' };
    mockZoneFindUnique.mockResolvedValue(zone);
    mockZoneUpdate.mockResolvedValue({
      ...zone,
      isArtefact: true,
      verifiedBy: 'operator-test-id',
    });

    const app = buildApp();
    const res = await request(app).post('/calibration/zones/z1/reject');

    expect(res.status).toBe(200);
    expect(res.body.data.isArtefact).toBe(true);
    expect(res.body.data.verifiedBy).toBe('operator-test-id');
  });

  it('returns 404 when zone not found', async () => {
    mockZoneFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).post('/calibration/zones/missing/reject');

    expect(res.status).toBe(404);
  });
});

describe('POST /calibration/runs/:runId/confirm-all-green', () => {
  it('confirms all GREEN unverified zones', async () => {
    mockZoneUpdateMany.mockResolvedValue({ count: 3 });

    const app = buildApp();
    const res = await request(app).post('/calibration/runs/run-1/confirm-all-green');

    expect(res.status).toBe(200);
    expect(res.body.data.confirmedCount).toBe(3);
    expect(mockZoneUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          calibrationRunId: 'run-1',
          reconciliationBucket: 'GREEN',
          operatorVerified: false,
        },
      }),
    );
  });

  it('excludes already verified zones', async () => {
    mockZoneUpdateMany.mockResolvedValue({ count: 0 });

    const app = buildApp();
    const res = await request(app).post('/calibration/runs/run-1/confirm-all-green');

    expect(res.status).toBe(200);
    expect(res.body.data.confirmedCount).toBe(0);
    // Verify operatorVerified: false is in the where clause
    expect(mockZoneUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ operatorVerified: false }),
      }),
    );
  });
});
