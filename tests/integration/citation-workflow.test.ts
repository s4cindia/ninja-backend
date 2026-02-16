/**
 * Citation Workflow Integration Tests
 *
 * Tests the complete upload → analysis → export flow for citation management
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock Prisma
vi.mock('../../src/lib/prisma', () => ({
  default: {
    editorialDocument: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    referenceListEntry: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    citation: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    citationChange: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    job: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Mock services
vi.mock('../../src/services/citation/ai-citation-detector.service', () => ({
  aiCitationDetectorService: {
    analyzeDocument: vi.fn(),
  },
}));

vi.mock('../../src/services/citation/docx-processor.service', () => ({
  docxProcessorService: {
    validateDOCX: vi.fn(),
    extractText: vi.fn(),
    getStatistics: vi.fn(),
    applyChanges: vi.fn(),
  },
}));

vi.mock('../../src/services/citation/citation-storage.service', () => ({
  citationStorageService: {
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

vi.mock('../../src/services/citation/doi-validation.service', () => ({
  doiValidationService: {
    validateDOI: vi.fn(),
    validateReferences: vi.fn(),
  },
}));

vi.mock('../../src/queues', () => ({
  getCitationQueue: vi.fn().mockReturnValue(null),
  areQueuesAvailable: vi.fn().mockReturnValue(false),
  JOB_TYPES: { CITATION_DETECTION: 'CITATION_DETECTION' },
}));

vi.mock('../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs/promises for export tests
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  realpath: vi.fn(),
}));

import prisma from '../../src/lib/prisma';
import { aiCitationDetectorService } from '../../src/services/citation/ai-citation-detector.service';
import { docxProcessorService } from '../../src/services/citation/docx-processor.service';
import { citationStorageService } from '../../src/services/citation/citation-storage.service';
import { doiValidationService } from '../../src/services/citation/doi-validation.service';
import { CitationUploadController } from '../../src/controllers/citation/citation-upload.controller';
import { CitationStyleController } from '../../src/controllers/citation/citation-style.controller';
import { CitationExportController } from '../../src/controllers/citation/citation-export.controller';

describe('Citation Workflow Integration', () => {
  let uploadController: CitationUploadController;
  let styleController: CitationStyleController;
  let exportController: CitationExportController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;
  let sendMock: ReturnType<typeof vi.fn>;
  let setHeaderMock: ReturnType<typeof vi.fn>;

  const TENANT_ID = 'tenant-123';
  const USER_ID = 'user-123';

  beforeEach(() => {
    uploadController = new CitationUploadController();
    styleController = new CitationStyleController();
    exportController = new CitationExportController();

    jsonMock = vi.fn();
    sendMock = vi.fn();
    setHeaderMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock, send: sendMock });
    mockNext = vi.fn();

    mockRes = {
      status: statusMock,
      json: jsonMock,
      send: sendMock,
      setHeader: setHeaderMock,
    };

    mockReq = {
      user: {
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'test@example.com',
        role: 'USER',
      },
      params: {},
      body: {},
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Upload → Analysis Flow', () => {
    it('should upload DOCX and run synchronous analysis when queue unavailable', async () => {
      // Setup file upload request
      const mockFile = {
        originalname: 'test-document.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1024 * 100, // 100KB
        buffer: Buffer.from([0x50, 0x4B, 0x03, 0x04]), // ZIP magic bytes
      };

      (mockReq as any).file = mockFile;

      // Mock DOCX validation
      vi.mocked(docxProcessorService.validateDOCX).mockResolvedValue({ valid: true });
      vi.mocked(docxProcessorService.extractText).mockResolvedValue({
        text: 'This study found [1] significant results. Previous work [2] confirmed this.',
        html: '<p>This study found [1] significant results. Previous work [2] confirmed this.</p>',
      });
      vi.mocked(docxProcessorService.getStatistics).mockResolvedValue({
        wordCount: 12,
        pageCount: 1,
        paragraphCount: 1,
      });

      // Mock storage
      vi.mocked(citationStorageService.uploadFile).mockResolvedValue({
        storagePath: 'citations/tenant-123/test-document.docx',
        storageType: 'local',
      });

      // Mock job creation
      vi.mocked(prisma.job.create).mockResolvedValue({
        id: 'job-123',
        tenantId: TENANT_ID,
        userId: USER_ID,
        type: 'CITATION_DETECTION',
        status: 'PROCESSING',
      } as any);

      // Mock document creation
      vi.mocked(prisma.editorialDocument.create).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        jobId: 'job-123',
        originalName: 'test-document.docx',
        status: 'QUEUED',
      } as any);

      // Mock AI analysis
      vi.mocked(aiCitationDetectorService.analyzeDocument).mockResolvedValue({
        inTextCitations: [
          { id: 'c1', text: '[1]', position: { startChar: 16, endChar: 19 }, type: 'numeric' },
          { id: 'c2', text: '[2]', position: { startChar: 54, endChar: 57 }, type: 'numeric' },
        ],
        references: [
          { id: 'r1', number: 1, rawText: 'Smith J. Paper 1. 2023.', components: { authors: ['Smith J'], year: '2023', title: 'Paper 1' } },
          { id: 'r2', number: 2, rawText: 'Jones A. Paper 2. 2022.', components: { authors: ['Jones A'], year: '2022', title: 'Paper 2' } },
        ],
        detectedStyle: 'Vancouver',
        statistics: { totalCitations: 2, totalReferences: 2 },
      });

      // Mock batch inserts
      vi.mocked(prisma.citation.createMany).mockResolvedValue({ count: 2 });
      vi.mocked(prisma.referenceListEntry.createMany).mockResolvedValue({ count: 2 });

      // Mock document update
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({
        id: 'doc-123',
        status: 'PARSED',
      } as any);

      // Mock final document fetch
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue({
        id: 'doc-123',
        citations: [{ id: 'c1' }, { id: 'c2' }],
      } as any);

      vi.mocked(prisma.referenceListEntry.count).mockResolvedValue(2);

      vi.mocked(prisma.job.update).mockResolvedValue({
        id: 'job-123',
        status: 'COMPLETED',
      } as any);

      await uploadController.upload(mockReq as Request, mockRes as Response, mockNext);

      // Verify the flow
      expect(docxProcessorService.validateDOCX).toHaveBeenCalled();
      expect(docxProcessorService.extractText).toHaveBeenCalled();
      expect(citationStorageService.uploadFile).toHaveBeenCalled();
      expect(prisma.job.create).toHaveBeenCalled();
      expect(prisma.editorialDocument.create).toHaveBeenCalled();
      expect(aiCitationDetectorService.analyzeDocument).toHaveBeenCalled();
      expect(prisma.citation.createMany).toHaveBeenCalled();
      expect(prisma.referenceListEntry.createMany).toHaveBeenCalled();

      // Verify response
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            documentId: 'doc-123',
            status: 'COMPLETED',
            statistics: expect.objectContaining({
              citationsFound: 2,
              referencesFound: 2,
            }),
          }),
        })
      );
    });

    it('should reject invalid DOCX files', async () => {
      const mockFile = {
        originalname: 'fake.docx',
        mimetype: 'application/pdf', // Wrong mimetype
        size: 1024,
        buffer: Buffer.from([0x25, 0x50, 0x44, 0x46]), // PDF magic bytes
      };

      (mockReq as any).file = mockFile;

      await uploadController.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INVALID_FILE_TYPE',
          }),
        })
      );
    });

    it('should reject files exceeding size limit', async () => {
      const mockFile = {
        originalname: 'large.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 60 * 1024 * 1024, // 60MB - exceeds 50MB limit
        buffer: Buffer.from([0x50, 0x4B, 0x03, 0x04]),
      };

      (mockReq as any).file = mockFile;

      await uploadController.upload(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'FILE_TOO_LARGE',
          }),
        })
      );
    });
  });

  describe('Analysis → Style Conversion Flow', () => {
    it('should convert citation style for analyzed document', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'APA' };

      // Mock document with references
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListStyle: 'Vancouver',
        referenceListEntries: [
          {
            id: 'ref-1',
            formattedApa: 'Smith J. Paper title. Journal. 2023;1:1-10.',
            authors: ['Smith J'],
            year: '2023',
            title: 'Paper title',
          },
          {
            id: 'ref-2',
            formattedApa: 'Jones A. Another paper. Journal. 2022;2:20-30.',
            authors: ['Jones A'],
            year: '2022',
            title: 'Another paper',
          },
        ],
        citations: [],
      } as any);

      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({
        id: 'doc-123',
        referenceListStyle: 'APA',
      } as any);

      await styleController.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(prisma.citationChange.create).toHaveBeenCalledTimes(2);
      expect(prisma.editorialDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referenceListStyle: 'APA' },
        })
      );
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            targetStyle: 'APA',
            totalConverted: 2,
          }),
        })
      );
    });

    it('should reject invalid citation style', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'InvalidStyle' };

      await styleController.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INVALID_STYLE',
          }),
        })
      );
    });
  });

  describe('DOI Validation Flow', () => {
    it('should validate DOIs for all references with DOIs', async () => {
      mockReq.params = { documentId: 'doc-123' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', doi: '10.1038/s41586-023-00001-0' },
          { id: 'ref-2', doi: '10.1038/s41586-023-00002-1' },
          { id: 'ref-3', doi: null }, // No DOI
        ],
      } as any);

      vi.mocked(doiValidationService.validateDOI)
        .mockResolvedValueOnce({
          valid: true,
          doi: '10.1038/s41586-023-00001-0',
          metadata: { title: 'Paper 1', authors: ['Smith'], year: '2023' },
        } as any)
        .mockResolvedValueOnce({
          valid: false,
          error: 'DOI not found',
        });

      await styleController.validateDOIs(mockReq as Request, mockRes as Response, mockNext);

      expect(doiValidationService.validateDOI).toHaveBeenCalledTimes(2);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            validated: 2,
            valid: 1,
            invalid: 1,
          }),
        })
      );
    });

    it('should handle documents with no DOIs', async () => {
      mockReq.params = { documentId: 'doc-123' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', doi: null },
          { id: 'ref-2', doi: null },
        ],
      } as any);

      await styleController.validateDOIs(mockReq as Request, mockRes as Response, mockNext);

      expect(doiValidationService.validateDOI).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            message: 'No DOIs found in references',
            validated: 0,
          }),
        })
      );
    });
  });

  describe('Preview → Export Flow', () => {
    it('should preview all pending changes', async () => {
      mockReq.params = { documentId: 'doc-123' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        originalName: 'test.docx',
        referenceListStyle: 'APA',
      } as any);

      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([
        { id: 'ch1', changeType: 'RENUMBER', beforeText: '[1]', afterText: '[2]', isReverted: false },
        { id: 'ch2', changeType: 'REFERENCE_STYLE_CONVERSION', beforeText: 'Old ref', afterText: 'New ref', isReverted: false },
        { id: 'ch3', changeType: 'RENUMBER', beforeText: '[3]', afterText: '[1]', isReverted: false },
      ] as any);

      await exportController.previewChanges(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            documentId: 'doc-123',
            summary: expect.objectContaining({
              totalChanges: 3,
            }),
            changes: expect.objectContaining({
              RENUMBER: expect.any(Array),
              REFERENCE_STYLE_CONVERSION: expect.any(Array),
            }),
          }),
        })
      );
    });

    it('should export modified DOCX with applied changes', async () => {
      mockReq.params = { documentId: 'doc-123' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        originalName: 'test.docx',
        storagePath: 'citations/tenant-123/test.docx',
        citations: [],
        referenceListEntries: [],
      } as any);

      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([
        { changeType: 'RENUMBER', beforeText: '[1]', afterText: '[2]', isReverted: false },
      ] as any);

      // Mock file read with path traversal protection
      const fsPromises = await import('fs/promises');
      const path = await import('path');
      const uploadDir = path.resolve(process.cwd(), 'uploads');
      const validPath = path.join(uploadDir, 'citations/tenant-123/test.docx');
      vi.mocked(fsPromises.realpath).mockResolvedValue(validPath);
      const originalBuffer = Buffer.from('original docx content');
      vi.mocked(fsPromises.readFile).mockResolvedValue(originalBuffer);

      // Mock docx processor
      const modifiedBuffer = Buffer.from('modified docx content');
      vi.mocked(docxProcessorService.applyChanges).mockResolvedValue(modifiedBuffer);

      await exportController.exportDocument(mockReq as Request, mockRes as Response, mockNext);

      expect(docxProcessorService.applyChanges).toHaveBeenCalled();
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('test_modified.docx'));
      expect(sendMock).toHaveBeenCalledWith(modifiedBuffer);
    });

    it('should return 404 for non-existent document on export', async () => {
      mockReq.params = { documentId: 'non-existent' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await exportController.exportDocument(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'NOT_FOUND',
          }),
        })
      );
    });

    it('should reject path traversal attempts in storagePath (security)', async () => {
      mockReq.params = { documentId: 'doc-123' };

      // Document with malicious storagePath containing path traversal
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        originalName: 'test.docx',
        storagePath: '../../../etc/passwd', // Path traversal attempt
        citations: [],
        referenceListEntries: [],
      } as any);

      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

      // Mock realpath to return a path outside uploads directory
      const fsPromises = await import('fs/promises');
      vi.mocked(fsPromises.realpath).mockResolvedValue('/etc/passwd');

      await exportController.exportDocument(mockReq as Request, mockRes as Response, mockNext);

      // Should throw AppError which gets passed to next()
      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'INVALID_PATH',
        })
      );
    });
  });

  describe('Complete Workflow', () => {
    it('should complete full workflow: upload → analyze → convert style → export', async () => {
      // Step 1: Upload
      const mockFile = {
        originalname: 'research-paper.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 50000,
        buffer: Buffer.from([0x50, 0x4B, 0x03, 0x04]),
      };
      (mockReq as any).file = mockFile;

      vi.mocked(docxProcessorService.validateDOCX).mockResolvedValue({ valid: true });
      vi.mocked(docxProcessorService.extractText).mockResolvedValue({
        text: 'Study found [1] results.',
        html: '<p>Study found [1] results.</p>',
      });
      vi.mocked(docxProcessorService.getStatistics).mockResolvedValue({
        wordCount: 4,
        pageCount: 1,
        paragraphCount: 1,
      });
      vi.mocked(citationStorageService.uploadFile).mockResolvedValue({
        storagePath: 'path/to/file.docx',
        storageType: 'local',
      });
      vi.mocked(prisma.job.create).mockResolvedValue({ id: 'job-1', status: 'PROCESSING' } as any);
      vi.mocked(prisma.editorialDocument.create).mockResolvedValue({
        id: 'doc-1',
        status: 'QUEUED',
      } as any);
      vi.mocked(aiCitationDetectorService.analyzeDocument).mockResolvedValue({
        inTextCitations: [{ id: 'c1', text: '[1]' }],
        references: [{ id: 'r1', number: 1, rawText: 'Ref 1', components: { authors: ['A'], year: '2023' } }],
        detectedStyle: 'Vancouver',
        statistics: { totalCitations: 1, totalReferences: 1 },
      });
      vi.mocked(prisma.citation.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.referenceListEntry.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({ id: 'doc-1', status: 'PARSED' } as any);
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue({
        id: 'doc-1',
        citations: [{ id: 'c1' }],
      } as any);
      vi.mocked(prisma.referenceListEntry.count).mockResolvedValue(1);
      vi.mocked(prisma.job.update).mockResolvedValue({ id: 'job-1', status: 'COMPLETED' } as any);

      await uploadController.upload(mockReq as Request, mockRes as Response, mockNext);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

      // Step 2: Get Analysis (verify via getAnalysis)
      vi.clearAllMocks();
      mockReq.params = { documentId: 'doc-1' };
      delete (mockReq as any).file;

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: TENANT_ID,
        originalName: 'research-paper.docx',
        status: 'PARSED',
        referenceListStyle: 'Vancouver',
        wordCount: 4,
        pageCount: 1,
        documentContent: {
          fullText: 'Study found [1] results.',
          fullHtml: '<p>Study found [1] results.</p>',
        },
        citations: [{ id: 'c1', rawText: '[1]' }],
        job: { id: 'job-1' },
      } as any);
      vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([
        { id: 'r1', sortKey: '0001', citationLinks: [{ citationId: 'c1' }] },
      ] as any);
      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

      await uploadController.getAnalysis(mockReq as Request, mockRes as Response, mockNext);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            documentId: 'doc-1',
            detectedStyle: 'Vancouver',
          }),
        })
      );

      // Step 3: Convert Style
      vi.clearAllMocks();
      mockReq.body = { targetStyle: 'APA' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: TENANT_ID,
        referenceListStyle: 'Vancouver',
        referenceListEntries: [{ id: 'r1', formattedApa: 'Ref 1' }],
        citations: [],
      } as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({ referenceListStyle: 'APA' } as any);

      await styleController.convertStyle(mockReq as Request, mockRes as Response, mockNext);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ targetStyle: 'APA' }),
        })
      );

      // Step 4: Preview Changes
      vi.clearAllMocks();
      delete mockReq.body.targetStyle;

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        tenantId: TENANT_ID,
        originalName: 'research-paper.docx',
        referenceListStyle: 'APA',
      } as any);
      vi.mocked(prisma.citationChange.findMany).mockResolvedValue([
        { id: 'ch1', changeType: 'REFERENCE_STYLE_CONVERSION', beforeText: 'Old', afterText: 'New', isReverted: false },
      ] as any);

      await exportController.previewChanges(mockReq as Request, mockRes as Response, mockNext);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            summary: expect.objectContaining({ totalChanges: 1 }),
          }),
        })
      );

      // Workflow complete - document is ready for export
    });
  });

  describe('Error Handling', () => {
    it('should handle analysis failures gracefully', async () => {
      const mockFile = {
        originalname: 'test.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1000,
        buffer: Buffer.from([0x50, 0x4B, 0x03, 0x04]),
      };
      (mockReq as any).file = mockFile;

      vi.mocked(docxProcessorService.validateDOCX).mockResolvedValue({ valid: true });
      vi.mocked(docxProcessorService.extractText).mockResolvedValue({ text: 'Test', html: '<p>Test</p>' });
      vi.mocked(docxProcessorService.getStatistics).mockResolvedValue({ wordCount: 1, pageCount: 1, paragraphCount: 1 });
      vi.mocked(citationStorageService.uploadFile).mockResolvedValue({ storagePath: 'path', storageType: 'local' });
      vi.mocked(prisma.job.create).mockResolvedValue({ id: 'job-1' } as any);
      vi.mocked(prisma.editorialDocument.create).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({ id: 'doc-1' } as any);

      // Simulate AI analysis failure
      vi.mocked(aiCitationDetectorService.analyzeDocument).mockRejectedValue(new Error('AI service unavailable'));

      await uploadController.upload(mockReq as Request, mockRes as Response, mockNext);

      // Should call next with error
      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should maintain tenant isolation throughout workflow', async () => {
      mockReq.params = { documentId: 'doc-from-other-tenant' };
      mockReq.body = { targetStyle: 'APA' };

      // Document exists but belongs to different tenant
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await styleController.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'NOT_FOUND',
          }),
        })
      );
    });
  });
});
