import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// --- Prisma mock ---
const mockCorpusCreate = vi.fn();
const mockCorpusFindMany = vi.fn();
const mockCorpusFindUnique = vi.fn();
const mockCorpusFindFirst = vi.fn();
const mockCorpusUpdate = vi.fn();
const mockCalibrationFindFirst = vi.fn();
const mockCalibrationCreate = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      create: (...args: unknown[]) => mockCorpusCreate(...args),
      findMany: (...args: unknown[]) => mockCorpusFindMany(...args),
      findUnique: (...args: unknown[]) => mockCorpusFindUnique(...args),
      findFirst: (...args: unknown[]) => mockCorpusFindFirst(...args),
      update: (...args: unknown[]) => mockCorpusUpdate(...args),
    },
    calibrationRun: {
      findFirst: (...args: unknown[]) => mockCalibrationFindFirst(...args),
      create: (...args: unknown[]) => mockCalibrationCreate(...args),
    },
  },
}));

// --- S3 + presigner mock ---
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://s3.amazonaws.com/presigned-url');
const mockS3Send = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-s3', () => {
  const MockS3Client = vi.fn();
  MockS3Client.prototype.send = vi.fn();
  return {
    S3Client: MockS3Client,
    PutObjectCommand: class MockPutObjectCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// --- s3.service mock (used by tagged-pdf upload) ---
vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: (...args: unknown[]) => mockS3Send(...args) },
}));

// --- Config mock (used by tagged-pdf upload for s3Bucket) ---
vi.mock('../../../../src/config', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    config: {
      ...(actual.config as Record<string, unknown>),
      s3Bucket: 'ninja-epub-staging',
      s3Region: 'ap-south-1',
    },
  };
});

// --- BullMQ queue mock ---
const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

vi.mock('../../../../src/queues', () => ({
  getCalibrationQueue: () => ({ add: mockQueueAdd }),
  areQueuesAvailable: () => true,
  JOB_TYPES: { CALIBRATION_RUN: 'CALIBRATION_RUN' },
}));

// --- Logger mock ---
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Auth mock ---
let mockUser: Record<string, unknown> = { id: 'user-1', userId: 'user-1', role: 'admin', email: 'admin@test.com', tenantId: 't-1' };

vi.mock('../../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = mockUser;
    next();
  },
}));

import adminCorpusRoutes from '../../../../src/routes/admin/corpus.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminCorpusRoutes);
  return app;
}

describe('admin/corpus.routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'user-1', userId: 'user-1', role: 'admin', email: 'admin@test.com', tenantId: 't-1' };
  });

  // Test 1 — POST /admin/corpus/upload-url (admin)
  it('POST /admin/corpus/upload-url returns presigned URL for admin', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/upload-url')
      .send({ filename: 'test.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('uploadUrl');
    expect(res.body.data).toHaveProperty('s3Key');
    expect(res.body.data).toHaveProperty('s3Path');
    expect(res.body.data).toHaveProperty('expiresAt');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  // Test 2 — POST /admin/corpus/upload-url (non-admin)
  it('POST /admin/corpus/upload-url returns 403 for non-admin', async () => {
    mockUser = { id: 'user-2', role: 'USER', email: 'user@test.com', tenantId: 't-1' };
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/upload-url')
      .send({ filename: 'test.pdf' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // Test 3 — filename sanitisation
  it('POST /admin/corpus/upload-url sanitises filename', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/upload-url')
      .send({ filename: 'My File (1).pdf' });

    expect(res.status).toBe(200);
    expect(res.body.data.s3Key).toMatch(/^corpus\/\d+-my-file--1-.pdf$/);
    expect(res.body.data.s3Key).not.toMatch(/[^a-zA-Z0-9._\-/]/);
  });

  // Test 4 — POST /admin/corpus/register
  it('POST /admin/corpus/register creates CorpusDocument', async () => {
    mockCorpusCreate.mockResolvedValue({
      id: 'doc-1',
      s3Path: 's3://ninja-epub-staging/corpus/test.pdf',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/register')
      .send({
        filename: 'test.pdf',
        s3Path: 's3://ninja-epub-staging/corpus/test.pdf',
        publisher: 'Pearson',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id', 'doc-1');
    expect(res.body.data).toHaveProperty('s3Path');
    expect(mockCorpusCreate).toHaveBeenCalledTimes(1);
  });

  // Test 5 — GET /admin/corpus/documents (paginated)
  it('GET /admin/corpus/documents returns paginated list', async () => {
    const mockDocs = [
      { id: 'd1', filename: 'a.pdf', bootstrapJobs: [] },
      { id: 'd2', filename: 'b.pdf', bootstrapJobs: [] },
      { id: 'd3', filename: 'c.pdf', bootstrapJobs: [] },
    ];
    mockCorpusFindMany.mockResolvedValue(mockDocs);
    const app = buildApp();
    const res = await request(app)
      .get('/admin/corpus/documents?limit=20');

    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(3);
    expect(res.body.data.nextCursor).toBeNull();
  });

  // Test 6 — GET /admin/corpus/documents with publisher filter
  it('GET /admin/corpus/documents filters by publisher', async () => {
    mockCorpusFindMany.mockResolvedValue([]);
    const app = buildApp();
    await request(app)
      .get('/admin/corpus/documents?publisher=Pearson');

    expect(mockCorpusFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publisher: 'Pearson' }),
      }),
    );
  });

  // Test 7 — POST /admin/corpus/documents/:id/run (success + queue dispatch)
  it('POST /admin/corpus/documents/:id/run creates CalibrationRun and dispatches job', async () => {
    mockCorpusFindUnique.mockResolvedValue({
      id: 'doc-1',
      s3Path: 's3://bucket/corpus/doc.pdf',
      taggedPdfPath: null,
    });
    mockCalibrationFindFirst.mockResolvedValue(null);
    mockCalibrationCreate.mockResolvedValue({ id: 'run-1' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/run');

    expect(res.status).toBe(202);
    expect(res.body.data.runId).toBe('run-1');
    expect(res.body.data.status).toBe('QUEUED');
    expect(mockCalibrationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentId: 'doc-1' }),
      }),
    );

    // Verify BullMQ job dispatched
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'CALIBRATION_RUN',
      expect.objectContaining({
        type: 'CALIBRATION_RUN',
        tenantId: 't-1',
        options: expect.objectContaining({
          runId: 'run-1',
          documentId: 'doc-1',
          s3Path: 's3://bucket/corpus/doc.pdf',
          tenantId: 't-1',
        }),
      }),
      expect.objectContaining({
        jobId: 'calibration-run-1',
        attempts: 3,
      }),
    );
  });

  // Test 7b — POST .../run includes taggedPdfPath when set on doc
  it('POST /admin/corpus/documents/:id/run includes taggedPdfPath in job options', async () => {
    mockCorpusFindUnique.mockResolvedValue({
      id: 'doc-1',
      s3Path: 's3://bucket/corpus/doc.pdf',
      taggedPdfPath: 's3://bucket/corpus/tagged/doc-1.pdf',
    });
    mockCalibrationFindFirst.mockResolvedValue(null);
    mockCalibrationCreate.mockResolvedValue({ id: 'run-2' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/run');

    expect(res.status).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'CALIBRATION_RUN',
      expect.objectContaining({
        options: expect.objectContaining({
          taggedPdfPath: 's3://bucket/corpus/tagged/doc-1.pdf',
        }),
      }),
      expect.anything(),
    );
  });

  // Test 8 — POST .../run: 409 when run in progress (no queue dispatch)
  it('POST /admin/corpus/documents/:id/run returns 409 when run in progress', async () => {
    mockCorpusFindUnique.mockResolvedValue({ id: 'doc-1', s3Path: 's3://bucket/doc.pdf' });
    mockCalibrationFindFirst.mockResolvedValue({ id: 'existing-run' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/run');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_IN_PROGRESS');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // Test 9 — POST .../run: 404 when document not found
  it('POST /admin/corpus/documents/:id/run returns 404 when not found', async () => {
    mockCorpusFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/missing/run');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // ─── Tagged PDF upload tests ─────────────────────────────────────

  // Test 10 — POST .../tagged-pdf success (admin)
  it('POST /admin/corpus/documents/:id/tagged-pdf uploads for admin', async () => {
    mockCorpusFindFirst.mockResolvedValue({ id: 'doc-1', s3Path: 's3://bucket/corpus/doc.pdf' });
    mockCorpusUpdate.mockResolvedValue({ id: 'doc-1', taggedPdfPath: 's3://ninja-epub-staging/corpus/tagged/doc-1.pdf' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/tagged-pdf')
      .attach('file', Buffer.from('%PDF-1.4 test content'), {
        filename: 'tagged.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.documentId).toBe('doc-1');
    expect(res.body.data.taggedPdfPath).toMatch(/^s3:\/\/ninja-epub-staging\/corpus\/tagged\/doc-1\.pdf$/);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockCorpusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-1' },
        data: { taggedPdfPath: 's3://ninja-epub-staging/corpus/tagged/doc-1.pdf' },
      }),
    );
  });

  // Test 11 — POST .../tagged-pdf success (operator)
  it('POST /admin/corpus/documents/:id/tagged-pdf uploads for operator', async () => {
    mockUser = { id: 'user-2', userId: 'user-2', role: 'OPERATOR', email: 'op@test.com', tenantId: 't-1' };
    mockCorpusFindFirst.mockResolvedValue({ id: 'doc-1', s3Path: 's3://bucket/corpus/doc.pdf' });
    mockCorpusUpdate.mockResolvedValue({ id: 'doc-1', taggedPdfPath: 's3://ninja-epub-staging/corpus/tagged/doc-1.pdf' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/tagged-pdf')
      .attach('file', Buffer.from('%PDF-1.4 test content'), {
        filename: 'tagged.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // Test 12 — POST .../tagged-pdf no file → 400
  it('POST /admin/corpus/documents/:id/tagged-pdf returns 400 when no file', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/tagged-pdf');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });

  // Test 13 — POST .../tagged-pdf wrong mime → 422
  it('POST /admin/corpus/documents/:id/tagged-pdf returns 422 for non-PDF', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/tagged-pdf')
      .attach('file', Buffer.from('not a pdf'), {
        filename: 'test.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  // Test 14 — POST .../tagged-pdf doc not found → 404
  it('POST /admin/corpus/documents/:id/tagged-pdf returns 404 when doc not found', async () => {
    mockCorpusFindFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/missing/tagged-pdf')
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'tagged.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // Test 15 — POST .../tagged-pdf forbidden for USER role
  it('POST /admin/corpus/documents/:id/tagged-pdf returns 403 for USER role', async () => {
    mockUser = { id: 'user-3', role: 'USER', email: 'user@test.com', tenantId: 't-1' };

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/tagged-pdf')
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'tagged.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
