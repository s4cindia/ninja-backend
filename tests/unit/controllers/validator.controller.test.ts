/**
 * Validator Controller Tests — presign-save / confirm-save
 *
 * Tests security-critical contentKey validation and core save flow.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock Prisma — inline factory (vi.mock is hoisted, can't reference top-level vars)
vi.mock('../../../src/lib/prisma', () => ({
  default: {
    editorialDocument: { findFirst: vi.fn(), update: vi.fn() },
    editorialDocumentContent: { upsert: vi.fn() },
    documentVersion: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
  Prisma: {},
}));

vi.mock('../../../src/services/s3.service', () => ({
  s3Service: {
    isConfigured: vi.fn(),
    getPresignedUploadUrl: vi.fn(),
    getFileBuffer: vi.fn(),
    deleteFile: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/services/citation/citation-storage.service', () => ({
  citationStorageService: {},
}));

vi.mock('../../../src/services/document/docx-conversion.service', () => ({
  docxConversionService: {},
}));

vi.mock('../../../src/services/content-type/content-type-detector.service', () => ({
  contentTypeDetector: {},
}));

vi.mock('../../../src/utils/html-to-text', () => ({
  htmlToPlainText: vi.fn((html: string) => html.replace(/<[^>]+>/g, ' ').trim()),
}));

// Import after mocks are set up
import prisma from '../../../src/lib/prisma';
import { s3Service } from '../../../src/services/s3.service';
import { ValidatorController } from '../../../src/controllers/validator/validator.controller';

const TENANT_ID = 'tenant-aaa-bbb';
const USER_ID = 'user-111-222';
const DOC_ID = '4858b5b2-6233-4967-8153-0e166f5f7b81';
const VALID_KEY = `uploads/${TENANT_ID}/1678901234567-${DOC_ID}-content.html`;

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    user: { tenantId: TENANT_ID, id: USER_ID },
    params: { documentId: DOC_ID },
    body: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

const nextFn: NextFunction = vi.fn();

describe('ValidatorController — presignContentSave', () => {
  let controller: ValidatorController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ValidatorController();
  });

  it('returns 501 when S3 is not configured', async () => {
    vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({ id: DOC_ID } as never);
    vi.mocked(s3Service.isConfigured).mockReturnValue(false);

    const res = mockRes();
    await controller.presignContentSave(mockReq(), res, nextFn);

    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'S3_NOT_CONFIGURED' }),
    }));
  });

  it('returns 404 when document not found', async () => {
    vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

    const res = mockRes();
    await controller.presignContentSave(mockReq(), res, nextFn);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('ValidatorController — confirmContentSave', () => {
  let controller: ValidatorController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ValidatorController();
  });

  it('returns 403 for contentKey with wrong tenant prefix', async () => {
    const req = mockReq({
      body: { contentKey: `uploads/other-tenant/1234-${DOC_ID}-content.html` },
    });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'FORBIDDEN' }),
    }));
  });

  it('returns 403 for contentKey with valid prefix but wrong documentId', async () => {
    const req = mockReq({
      body: { contentKey: `uploads/${TENANT_ID}/1234-wrong-doc-id-content.html` },
    });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for contentKey with path traversal attempt', async () => {
    const req = mockReq({
      body: { contentKey: `uploads/${TENANT_ID}/../other-tenant/1234-${DOC_ID}-content.html` },
    });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for contentKey missing .html suffix', async () => {
    const req = mockReq({
      body: { contentKey: `uploads/${TENANT_ID}/1234-${DOC_ID}-content` },
    });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when document not found', async () => {
    vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

    const req = mockReq({ body: { contentKey: VALID_KEY } });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when S3 read fails', async () => {
    vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
      id: DOC_ID,
      documentContent: { fullHtml: '<p>old</p>' },
    } as never);
    vi.mocked(s3Service.getFileBuffer).mockRejectedValue(new Error('NoSuchKey'));

    const req = mockReq({ body: { contentKey: VALID_KEY } });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'CONTENT_NOT_FOUND' }),
    }));
  });

  it('happy path: valid key, content persisted, version created, S3 temp deleted', async () => {
    const htmlContent = '<p>Hello world</p>';
    vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
      id: DOC_ID,
      documentContent: { fullHtml: '<p>old content</p>' },
    } as never);
    vi.mocked(s3Service.getFileBuffer).mockResolvedValue(Buffer.from(htmlContent));
    vi.mocked(s3Service.deleteFile).mockResolvedValue(undefined as never);

    // Mock $transaction to execute the callback
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => {
      const tx = {
        editorialDocumentContent: {
          upsert: vi.fn().mockResolvedValue({ updatedAt: new Date('2026-01-01') }),
        },
        editorialDocument: { update: vi.fn().mockResolvedValue({}) },
        documentVersion: {
          findFirst: vi.fn().mockResolvedValue({ version: 2 }),
          create: vi.fn().mockResolvedValue({}),
        },
        $executeRaw: vi.fn(),
      };
      return (cb as (tx: typeof tx) => Promise<unknown>)(tx);
    });

    const req = mockReq({ body: { contentKey: VALID_KEY, createVersion: true } });
    const res = mockRes();
    await controller.confirmContentSave(req, res, nextFn);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        documentId: DOC_ID,
        wordCount: expect.any(Number),
      }),
    }));
    expect(s3Service.deleteFile).toHaveBeenCalledWith(VALID_KEY);
  });
});
