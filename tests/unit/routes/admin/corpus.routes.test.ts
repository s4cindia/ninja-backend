import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// --- Prisma mock ---
const mockCorpusCreate = vi.fn();
const mockCorpusFindMany = vi.fn();
const mockCorpusFindUnique = vi.fn();
const mockCalibrationFindFirst = vi.fn();
const mockCalibrationCreate = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    corpusDocument: {
      create: (...args: unknown[]) => mockCorpusCreate(...args),
      findMany: (...args: unknown[]) => mockCorpusFindMany(...args),
      findUnique: (...args: unknown[]) => mockCorpusFindUnique(...args),
    },
    calibrationRun: {
      findFirst: (...args: unknown[]) => mockCalibrationFindFirst(...args),
      create: (...args: unknown[]) => mockCalibrationCreate(...args),
    },
  },
}));

// --- S3 + presigner mock ---
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://s3.amazonaws.com/presigned-url');

vi.mock('@aws-sdk/client-s3', () => {
  const MockS3Client = vi.fn();
  MockS3Client.prototype.send = vi.fn();
  return { S3Client: MockS3Client, PutObjectCommand: vi.fn() };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// --- Auth mock ---
let mockUser: Record<string, unknown> = { id: 'user-1', role: 'admin', email: 'admin@test.com', tenantId: 't-1' };

vi.mock('../../../../src/middleware/auth.middleware', () => ({
  authenticate: (req: any, _res: any, next: any) => {
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
    mockUser = { id: 'user-1', role: 'admin', email: 'admin@test.com', tenantId: 't-1' };
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

  // Test 7 — POST /admin/corpus/documents/:id/run (success)
  it('POST /admin/corpus/documents/:id/run creates CalibrationRun', async () => {
    mockCorpusFindUnique.mockResolvedValue({ id: 'doc-1', s3Path: 's3://bucket/doc.pdf' });
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
  });

  // Test 8 — POST .../run: 409 when run in progress
  it('POST /admin/corpus/documents/:id/run returns 409 when run in progress', async () => {
    mockCorpusFindUnique.mockResolvedValue({ id: 'doc-1', s3Path: 's3://bucket/doc.pdf' });
    mockCalibrationFindFirst.mockResolvedValue({ id: 'existing-run' });

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/doc-1/run');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_IN_PROGRESS');
  });

  // Test 9 — POST .../run: 404 when document not found
  it('POST /admin/corpus/documents/:id/run returns 404 when not found', async () => {
    mockCorpusFindUnique.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/admin/corpus/documents/missing/run');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
