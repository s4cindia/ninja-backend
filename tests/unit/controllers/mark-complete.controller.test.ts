import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Prisma mock ────────────────────────────────────────────────────
const mockCalibrationRunFindUnique = vi.fn();
const mockCalibrationRunUpdate = vi.fn();
const mockIssueDeleteMany = vi.fn();
const mockIssueCreateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      findUnique: (...args: unknown[]) => mockCalibrationRunFindUnique(...args),
      update: (...args: unknown[]) => mockCalibrationRunUpdate(...args),
    },
    calibrationRunIssue: {
      deleteMany: (...args: unknown[]) => mockIssueDeleteMany(...args),
      createMany: (...args: unknown[]) => mockIssueCreateMany(...args),
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      mockTransaction(fn);
      // Run the transaction callback inline against the same mocks
      return fn({
        calibrationRun: {
          update: (...args: unknown[]) => mockCalibrationRunUpdate(...args),
        },
        calibrationRunIssue: {
          deleteMany: (...args: unknown[]) => mockIssueDeleteMany(...args),
          createMany: (...args: unknown[]) => mockIssueCreateMany(...args),
        },
      });
    },
  },
}));

// ── Auth middleware bypass ─────────────────────────────────────────
vi.mock('../../../src/middleware/auth.middleware', () => ({
  authenticate: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1' } as never;
    next();
  },
  authorize: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

// ── Service mocks ──────────────────────────────────────────────────
const mockGenerateAnalysis = vi.fn();
const mockGetStoredAnalysis = vi.fn();
const mockGenerateCorpus = vi.fn();

vi.mock('../../../src/services/calibration/annotation-analysis.service', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/services/calibration/annotation-analysis.service',
  );
  return {
    ...actual,
    generateAnnotationAnalysis: (...args: unknown[]) => mockGenerateAnalysis(...args),
    getStoredAnalysis: (...args: unknown[]) => mockGetStoredAnalysis(...args),
    generateCorpusSummary: (...args: unknown[]) => mockGenerateCorpus(...args),
  };
});

// Neutralize report/timesheet services so the controller imports them without real DB calls
vi.mock('../../../src/services/calibration/annotation-report.service', () => ({
  annotationReportService: {
    getAnnotationReport: vi.fn(),
    exportAnnotationCsv: vi.fn(),
    exportLineageCsv: vi.fn(),
    exportAnnotationPdf: vi.fn(),
  },
}));

vi.mock('../../../src/services/calibration/annotation-timesheet.service', () => ({
  annotationTimesheetService: {
    getTimesheetReport: vi.fn(),
    exportTimesheetCsv: vi.fn(),
    exportTimesheetPdf: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
  },
}));

import annotationReportRoutes from '../../../src/routes/annotation-report.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/calibration', annotationReportRoutes);
  return app;
}

const FAKE_RESULT = {
  report: {
    markdown: 'stub',
    generatedAt: '2026-04-13T00:00:00.000Z',
    model: 'claude-haiku-4.5',
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
  },
  costBreakdown: {
    aiAnnotationCostUsd: 0,
    aiReportCostUsd: 0,
    annotatorActiveHours: 0,
    annotatorCostInr: 0,
    totalCostInr: 0,
  },
  pagesReviewed: 42,
  completionNotes: 'done',
  issues: [],
};

describe('POST /calibration/runs/:runId/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateAnalysis.mockResolvedValue(FAKE_RESULT);
  });

  it('accepts an empty body (backwards compatibility) and invokes service with empty input', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue({
      corpusDocument: { pageCount: 200 },
    });

    const app = buildApp();
    const res = await request(app).post('/calibration/runs/run-1/complete').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockGenerateAnalysis).toHaveBeenCalledWith('run-1', {
      pagesReviewed: undefined,
      issues: undefined,
      notes: undefined,
    });
  });

  it('accepts a full body with issues and passes them through', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue({
      corpusDocument: { pageCount: 200 },
    });

    const app = buildApp();
    const body = {
      pagesReviewed: 120,
      notes: 'all good',
      issues: [
        { category: 'PAGE_ALIGNMENT_MISMATCH', pagesAffected: 5, blocking: true },
        { category: 'OTHER', description: 'extractor stalled' },
      ],
    };
    const res = await request(app).post('/calibration/runs/run-2/complete').send(body);
    expect(res.status).toBe(200);
    expect(mockGenerateAnalysis).toHaveBeenCalledTimes(1);
    const arg = mockGenerateAnalysis.mock.calls[0]![1] as {
      pagesReviewed?: number;
      issues?: unknown[];
      notes?: string;
    };
    expect(arg.pagesReviewed).toBe(120);
    expect(arg.notes).toBe('all good');
    expect(arg.issues).toHaveLength(2);
  });

  it('returns 422 on invalid payload', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/calibration/runs/run-1/complete')
      .send({ issues: [{ category: 'OTHER' }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockGenerateAnalysis).not.toHaveBeenCalled();
  });

  it('returns 404 when run is missing even if only issues are provided (no pagesReviewed)', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/runs/missing/complete')
      .send({ issues: [{ category: 'PAGE_ALIGNMENT_MISMATCH' }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockGenerateAnalysis).not.toHaveBeenCalled();
  });

  it('returns 404 when run is missing with empty body', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/runs/missing/complete')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockGenerateAnalysis).not.toHaveBeenCalled();
  });

  it('returns 422 when pagesReviewed exceeds document page count', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue({
      corpusDocument: { pageCount: 100 },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/runs/run-1/complete')
      .send({ pagesReviewed: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockGenerateAnalysis).not.toHaveBeenCalled();
  });

  it('returns 404 when run does not exist and pagesReviewed provided', async () => {
    mockCalibrationRunFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/calibration/runs/missing/complete')
      .send({ pagesReviewed: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockGenerateAnalysis).not.toHaveBeenCalled();
  });
});
