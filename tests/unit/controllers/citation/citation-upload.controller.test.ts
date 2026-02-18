/**
 * CitationUploadController Unit Tests
 *
 * Tests happy path + error cases for:
 * - presignUpload
 * - confirmUpload
 * - upload (legacy)
 * - getJobStatus
 * - getAnalysis
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock dependencies before importing controller
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    file: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    job: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    editorialDocument: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    citation: {
      createMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    referenceListEntry: {
      createMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    referenceListEntryCitation: {
      createMany: vi.fn(),
    },
    citationChange: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/services/s3.service', () => ({
  s3Service: {
    isConfigured: vi.fn(),
    getConfigStatus: vi.fn().mockReturnValue({ bucket: false, region: 'us-east-1', credentialsType: 'none' }),
    getPresignedUploadUrl: vi.fn(),
    getFileBuffer: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/docx-processor.service', () => ({
  docxProcessorService: {
    validateDOCX: vi.fn(),
    extractText: vi.fn(),
    getStatistics: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/citation-storage.service', () => ({
  citationStorageService: {
    uploadFile: vi.fn(),
  },
}));

vi.mock('../../../../src/services/citation/ai-citation-detector.service', () => ({
  aiCitationDetectorService: {
    analyzeDocument: vi.fn(),
  },
}));

vi.mock('../../../../src/queues', () => ({
  areQueuesAvailable: vi.fn().mockReturnValue(false),
  getCitationQueue: vi.fn().mockReturnValue(null),
  JOB_TYPES: { CITATION_DETECTION: 'CITATION_DETECTION' },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-id-12345'),
}));

// Import after mocks
import { CitationUploadController } from '../../../../src/controllers/citation/citation-upload.controller';
import { s3Service } from '../../../../src/services/s3.service';
import { docxProcessorService } from '../../../../src/services/citation/docx-processor.service';
import prisma from '../../../../src/lib/prisma';

describe('CitationUploadController', () => {
  let controller: CitationUploadController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new CitationUploadController();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockRes = {
      json: jsonMock,
      status: statusMock,
    };

    mockNext = vi.fn();

    // Default authenticated user
    mockReq = {
      user: { tenantId: 'tenant-123', id: 'user-456' },
      body: {},
      params: {},
      query: {},
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('presignUpload', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    });

    it('should return 400 when fileName is missing', async () => {
      mockReq.body = {};

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'MISSING_FILENAME', message: 'fileName is required' },
      });
    });

    it('should return 400 for non-DOCX files', async () => {
      mockReq.body = { fileName: 'test.pdf' };

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_FILE_TYPE', message: 'Only DOCX files are allowed' },
      });
    });

    it('should return 400 when file size exceeds limit', async () => {
      mockReq.body = { fileName: 'test.docx', fileSize: 100 * 1024 * 1024 }; // 100MB

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds 50MB limit' },
      });
    });

    it('should return 503 when S3 is not configured', async () => {
      mockReq.body = { fileName: 'test.docx' };
      vi.mocked(s3Service.isConfigured).mockReturnValue(false);

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'S3_NOT_CONFIGURED', message: 'S3 storage is not configured. Contact administrator.' },
      });
    });

    it('should return presigned URL on success', async () => {
      mockReq.body = { fileName: 'test.docx', fileSize: 1024 };
      vi.mocked(s3Service.isConfigured).mockReturnValue(true);
      vi.mocked(s3Service.getPresignedUploadUrl).mockResolvedValue({
        uploadUrl: 'https://s3.example.com/upload',
        fileKey: 'tenant-123/file-key.docx',
        expiresIn: 3600,
      });
      vi.mocked(prisma.file.create).mockResolvedValue({
        id: 'file-123',
        tenantId: 'tenant-123',
        filename: 'test.docx',
        originalName: 'test.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1024,
        path: 'tenant-123/file-key.docx',
        status: 'PENDING_UPLOAD',
        storagePath: 'tenant-123/file-key.docx',
        storageType: 'S3',
        metadata: null,
        latestJobId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.presignUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          uploadUrl: 'https://s3.example.com/upload',
          fileKey: 'tenant-123/file-key.docx',
          fileId: 'file-123',
          expiresIn: 3600,
        },
      });
    });
  });

  describe('confirmUpload', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('should return 400 when fileKey is missing', async () => {
      mockReq.body = { fileName: 'test.docx' };

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'MISSING_FILE_KEY', message: 'fileKey is required' },
      });
    });

    it('should return 400 when fileName is missing', async () => {
      mockReq.body = { fileKey: 'tenant-123/file.docx' };

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'MISSING_FILENAME', message: 'fileName is required' },
      });
    });

    it('should return 400 when file not found in S3', async () => {
      mockReq.body = { fileKey: 'tenant-123/missing.docx', fileName: 'test.docx' };
      vi.mocked(s3Service.getFileBuffer).mockRejectedValue(new Error('Not found'));

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: 'File not found in S3. Upload may have failed.' },
      });
    });

    it('should return 400 for invalid DOCX structure (not ZIP)', async () => {
      mockReq.body = { fileKey: 'tenant-123/file.docx', fileName: 'test.docx' };
      // Invalid magic bytes (not ZIP)
      vi.mocked(s3Service.getFileBuffer).mockResolvedValue(Buffer.from('invalid'));

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_FILE_STRUCTURE', message: 'Invalid DOCX file structure' },
      });
    });

    it('should return 400 when DOCX validation fails', async () => {
      mockReq.body = { fileKey: 'tenant-123/file.docx', fileName: 'test.docx' };
      // Valid ZIP magic bytes (PK..)
      const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
      vi.mocked(s3Service.getFileBuffer).mockResolvedValue(zipMagic);
      vi.mocked(docxProcessorService.validateDOCX).mockResolvedValue({
        valid: false,
        error: 'Missing document.xml',
      });

      await controller.confirmUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_DOCX', message: 'Missing document.xml' },
      });
    });
  });

  describe('upload (legacy)', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('should return 400 when no file uploaded', async () => {
      mockReq.file = undefined;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NO_FILE', message: 'No file uploaded' },
      });
    });

    it('should return 400 for invalid MIME type', async () => {
      mockReq.file = {
        mimetype: 'application/pdf',
        originalname: 'test.pdf',
        buffer: Buffer.from('test'),
        size: 100,
      } as Express.Multer.File;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_FILE_TYPE', message: 'Only DOCX files are allowed' },
      });
    });

    it('should return 400 for wrong file extension', async () => {
      mockReq.file = {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'test.pdf',
        buffer: Buffer.from('test'),
        size: 100,
      } as Express.Multer.File;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_FILE_EXTENSION', message: 'File must have .docx extension' },
      });
    });

    it('should return 400 for file too large', async () => {
      mockReq.file = {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'test.docx',
        buffer: Buffer.alloc(60 * 1024 * 1024), // 60MB
        size: 60 * 1024 * 1024,
      } as Express.Multer.File;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: 'File size exceeds 50MB limit' },
      });
    });

    it('should return 400 for invalid file structure', async () => {
      // Buffer without ZIP magic bytes
      const invalidBuffer = Buffer.from('not a zip file content');
      mockReq.file = {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'test.docx',
        buffer: invalidBuffer,
        size: invalidBuffer.length,
      } as Express.Multer.File;

      await controller.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'INVALID_FILE_STRUCTURE', message: 'Invalid DOCX file structure' },
      });
    });
  });

  describe('getJobStatus', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.getJobStatus(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('should return 404 when job not found', async () => {
      mockReq.params = { jobId: 'non-existent-job' };
      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await controller.getJobStatus(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    });

    it('should return job status without document for in-progress jobs', async () => {
      mockReq.params = { jobId: 'job-123' };
      vi.mocked(prisma.job.findFirst).mockResolvedValue({
        id: 'job-123',
        status: 'PROCESSING',
        progress: 50,
        error: null,
        output: {},
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      } as ReturnType<typeof prisma.job.findFirst> extends Promise<infer T> ? T : never);

      await controller.getJobStatus(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          jobId: 'job-123',
          status: 'PROCESSING',
          progress: 50,
        }),
      });
    });

    it('should return job status with document info for completed jobs', async () => {
      mockReq.params = { jobId: 'job-123' };
      vi.mocked(prisma.job.findFirst).mockResolvedValue({
        id: 'job-123',
        status: 'COMPLETED',
        progress: 100,
        error: null,
        output: {},
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      } as ReturnType<typeof prisma.job.findFirst> extends Promise<infer T> ? T : never);
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        originalName: 'test.docx',
        status: 'PARSED',
        wordCount: 1000,
        pageCount: 5,
      } as ReturnType<typeof prisma.editorialDocument.findFirst> extends Promise<infer T> ? T : never);
      vi.mocked(prisma.citation.count).mockResolvedValue(10);
      vi.mocked(prisma.referenceListEntry.count).mockResolvedValue(5);

      await controller.getJobStatus(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          jobId: 'job-123',
          status: 'COMPLETED',
          document: expect.objectContaining({
            documentId: 'doc-123',
            filename: 'test.docx',
            statistics: expect.objectContaining({
              citationsFound: 10,
              referencesFound: 5,
            }),
          }),
        }),
      });
    });
  });

  describe('getAnalysis', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.getAnalysis(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('should return 404 when document not found', async () => {
      mockReq.params = { documentId: 'non-existent-doc' };
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await controller.getAnalysis(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    });

    it('should return analysis results on success', async () => {
      mockReq.params = { documentId: 'doc-123' };
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        originalName: 'test.docx',
        status: 'PARSED',
        wordCount: 1000,
        pageCount: 5,
        referenceListStyle: 'APA',
        citations: [
          {
            id: 'cit-1',
            rawText: '[1]',
            citationType: 'NUMERIC',
            paragraphIndex: 0,
            startOffset: 10,
            endOffset: 13,
            referenceId: null,
            confidence: 0.9,
          },
        ],
        job: { id: 'job-123' },
        documentContent: { fullText: 'Sample text', fullHtml: '<p>Sample text</p>' },
      } as ReturnType<typeof prisma.editorialDocument.findFirst> extends Promise<infer T> ? T : never);

      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([
        {
          id: 'ref-1',
          authors: ['Smith J'],
          year: '2023',
          title: 'Test Article',
          journalName: 'Test Journal',
          volume: '1',
          issue: '2',
          pages: '1-10',
          doi: '10.1234/test',
          url: null,
          publisher: null,
          formattedApa: 'Smith, J. (2023). Test Article.',
          citationLinks: [],
        },
      ] as ReturnType<typeof prisma.referenceListEntry.findMany> extends Promise<infer T> ? T : never);

      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

      await controller.getAnalysis(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          document: expect.objectContaining({
            id: 'doc-123',
            filename: 'test.docx',
            status: 'PARSED',
          }),
          detectedStyle: 'APA',
          citations: expect.arrayContaining([
            expect.objectContaining({
              id: 'cit-1',
              rawText: '[1]',
            }),
          ]),
          references: expect.arrayContaining([
            expect.objectContaining({
              id: 'ref-1',
              authors: ['Smith J'],
            }),
          ]),
        }),
      });
    });
  });

  describe('reanalyze', () => {
    it('should return 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.reanalyze(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('should return 404 when document not found', async () => {
      mockReq.params = { documentId: 'non-existent-doc' };
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await controller.reanalyze(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    });
  });
});
