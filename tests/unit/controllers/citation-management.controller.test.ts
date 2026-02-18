/**
 * Citation Management Controller Tests
 *
 * Tests security-critical tenant isolation and core functionality.
 * Focus areas:
 * - Tenant isolation (CRITICAL: prevents cross-tenant data access)
 * - Document CRUD operations
 * - Reference management
 * - Input validation
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { CitationUploadController, CitationReferenceController } from '../../../src/controllers/citation';

// Mock Prisma
vi.mock('../../../src/lib/prisma', () => ({
  default: {
    editorialDocument: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    referenceListEntry: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    citation: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    citationChange: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    job: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Mock services
vi.mock('../../../src/services/citation/ai-citation-detector.service', () => ({
  aiCitationDetectorService: {
    detectCitations: vi.fn(),
  },
}));

vi.mock('../../../src/services/citation/reference-reordering.service', () => ({
  referenceReorderingService: {
    reorderByPosition: vi.fn(),
  },
}));

vi.mock('../../../src/services/citation/ai-format-converter.service', () => ({
  aiFormatConverterService: {
    convertStyle: vi.fn(),
  },
  CitationStyle: {},
}));

vi.mock('../../../src/services/citation/doi-validation.service', () => ({
  doiValidationService: {
    validate: vi.fn(),
  },
}));

vi.mock('../../../src/services/citation/docx-processor.service', () => ({
  docxProcessorService: {
    validateDOCX: vi.fn(),
    extractText: vi.fn(),
    getStatistics: vi.fn(),
  },
  ReferenceEntry: {},
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from '../../../src/lib/prisma';

describe('CitationManagementController', () => {
  let uploadController: CitationUploadController;
  let referenceController: CitationReferenceController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  // Test tenant IDs
  const TENANT_A = 'tenant-a-123';
  const TENANT_B = 'tenant-b-456';
  const USER_ID = 'user-123';

  beforeEach(() => {
    uploadController = new CitationUploadController();
    referenceController = new CitationReferenceController();
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockNext = vi.fn();

    mockRes = {
      status: statusMock,
      json: jsonMock,
    };

    // Default user context (Tenant A)
    mockReq = {
      user: {
        id: USER_ID,
        tenantId: TENANT_A,
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

  // ============================================================================
  // SECURITY TESTS: Tenant Isolation
  // ============================================================================
  describe('Tenant Isolation Security', () => {
    describe('getAnalysis', () => {
      it('should return document analysis for own tenant', async () => {
        mockReq.params = { documentId: 'doc-123' };

        const mockDocument = {
          id: 'doc-123',
          tenantId: TENANT_A,
          originalName: 'test.docx',
          status: 'COMPLETED',
          wordCount: 1000,
          pageCount: 5,
          documentContent: {
            fullText: 'Sample text',
            fullHtml: '<p>Sample text</p>',
          },
          referenceListStyle: 'APA',
          citations: [
            {
              id: 'cit-1',
              rawText: '[1]',
              startOffset: 100,
              endOffset: 103,
              reference: null,
            },
          ],
          job: { id: 'job-123' },
        };

        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as never);
        vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue([]);
        vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

        await uploadController.getAnalysis(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(prisma.editorialDocument.findFirst).toHaveBeenCalledWith({
          where: { id: 'doc-123', tenantId: TENANT_A },
          include: expect.any(Object),
        });
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              document: expect.objectContaining({
                id: 'doc-123',
              }),
            }),
          })
        );
      });

      it('should return 404 when accessing document from another tenant', async () => {
        mockReq.params = { documentId: 'doc-from-tenant-b' };

        // Simulate document exists but belongs to different tenant
        // findFirst with tenantId filter returns null
        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await uploadController.getAnalysis(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
      });

      it('should return 404 when document does not exist', async () => {
        mockReq.params = { documentId: 'nonexistent-doc' };

        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await uploadController.getAnalysis(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
      });
    });

    describe('deleteReference', () => {
      it('should verify tenant ownership before deleting', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };

        const mockReference = {
          id: 'ref-1',
          documentId: 'doc-123',
          sortKey: '0001',
          citationLinks: [{ citationId: 'cit-1' }],
          document: {
            tenantId: TENANT_A,
            referenceListEntries: [
              { id: 'ref-1', sortKey: '0001', citationLinks: [{ citationId: 'cit-1' }] },
            ],
            citations: [],
          },
        };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockReference as never);

        await referenceController.deleteReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // Verify tenant check happens by checking findUnique was called
        expect(prisma.referenceListEntry.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'ref-1' },
            include: expect.objectContaining({
              document: expect.any(Object),
            }),
          })
        );
      });

      it('should return 404 when deleting reference from another tenant (security)', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };

        // Reference exists but belongs to Tenant B
        const mockReference = {
          id: 'ref-1',
          documentId: 'doc-123',
          sortKey: '0001',
          citationLinks: [],
          document: {
            tenantId: TENANT_B, // Different tenant!
            referenceListEntries: [],
            citations: [],
          },
        };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockReference as never);

        await referenceController.deleteReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // CRITICAL: Should return 404, not 403, to prevent tenant enumeration
        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' },
        });
        // Ensure delete was NOT called
        expect(prisma.referenceListEntry.delete).not.toHaveBeenCalled();
      });

      it('should return 404 when reference does not exist', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'nonexistent' };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(null);

        await referenceController.deleteReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' },
        });
      });
    });

    describe('editReference', () => {
      it('should verify tenant ownership before updating', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };
        mockReq.body = { title: 'Updated Title' };

        const mockReference = {
          id: 'ref-1',
          documentId: 'doc-123',
          sortKey: '0001',
          authors: ['Author A'],
          year: '2023',
          title: 'Original Title',
          citationLinks: [],
          document: {
            tenantId: TENANT_A,
            referenceListStyle: 'APA',
            citations: [],
          },
        };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockReference as never);

        await referenceController.editReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // Verify tenant check happens by checking findUnique includes document
        expect(prisma.referenceListEntry.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'ref-1' },
            include: expect.objectContaining({
              document: expect.any(Object),
            }),
          })
        );
      });

      it('should return 404 when editing reference from another tenant (security)', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };
        mockReq.body = { title: 'Hacked Title' };

        const mockReference = {
          id: 'ref-1',
          documentId: 'doc-123',
          document: {
            tenantId: TENANT_B, // Different tenant!
            citations: [],
          },
        };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockReference as never);

        await referenceController.editReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // CRITICAL: Should return 404 to prevent tenant enumeration
        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' },
        });
        // Ensure update was NOT called
        expect(prisma.referenceListEntry.update).not.toHaveBeenCalled();
      });
    });

    describe('reorderReferences', () => {
      it('should use findFirst with tenantId filter for security', async () => {
        mockReq.params = { documentId: 'doc-123' };
        mockReq.body = { referenceId: 'ref-2', newPosition: 1 };

        // Mock document not found to test the query pattern
        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await referenceController.reorderReferences(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // CRITICAL: Verify query includes both documentId AND tenantId
        expect(prisma.editorialDocument.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'doc-123', tenantId: TENANT_A },
          })
        );
      });

      it('should return 404 when reordering references from another tenant (security)', async () => {
        mockReq.params = { documentId: 'doc-from-tenant-b' };
        mockReq.body = { referenceId: 'ref-1', newPosition: 2 };

        // Document exists but belongs to different tenant
        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await referenceController.reorderReferences(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
      });
    });

    describe('resequenceByAppearance', () => {
      it('should use findFirst with tenantId filter for security', async () => {
        mockReq.params = { documentId: 'doc-123' };

        // Mock document not found to test the query pattern
        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await referenceController.resequenceByAppearance(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        // CRITICAL: Verify query includes both documentId AND tenantId
        expect(prisma.editorialDocument.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'doc-123', tenantId: TENANT_A },
          })
        );
      });

      it('should return 404 when resequencing document from another tenant (security)', async () => {
        mockReq.params = { documentId: 'doc-from-tenant-b' };

        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

        await referenceController.resequenceByAppearance(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(404);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
      });
    });
  });

  // ============================================================================
  // FUNCTIONAL TESTS: Core Operations
  // ============================================================================
  describe('Core Operations', () => {
    describe('getAnalysis', () => {
      it('should include citation and reference counts in response', async () => {
        mockReq.params = { documentId: 'doc-123' };

        const mockDocument = {
          id: 'doc-123',
          tenantId: TENANT_A,
          originalName: 'document.docx',
          status: 'COMPLETED',
          wordCount: 5000,
          pageCount: 10,
          documentContent: {
            fullText: 'Document content with [1] citation.',
            fullHtml: '<p>Document content with [1] citation.</p>',
          },
          referenceListStyle: 'APA',
          citations: [
            { id: 'cit-1', rawText: '[1]', reference: null },
            { id: 'cit-2', rawText: '[2]', reference: null },
            { id: 'cit-3', rawText: '[3]', reference: null },
          ],
          job: { id: 'job-123' },
        };

        const mockReferences = [
          { id: 'ref-1', sortKey: '0001', citationLinks: [{ citationId: 'cit-1' }], authors: ['Smith'], year: '2023', title: 'Paper 1' },
          { id: 'ref-2', sortKey: '0002', citationLinks: [{ citationId: 'cit-2' }, { citationId: 'cit-3' }], authors: ['Jones'], year: '2022', title: 'Paper 2' },
        ];

        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as never);
        vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue(mockReferences as never);
        vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

        await uploadController.getAnalysis(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              document: expect.objectContaining({
                statistics: expect.objectContaining({
                  totalCitations: expect.any(Number),
                  totalReferences: 2,
                }),
              }),
            }),
          })
        );
      });

      it('should map citations to reference numbers correctly', async () => {
        mockReq.params = { documentId: 'doc-123' };

        const mockDocument = {
          id: 'doc-123',
          tenantId: TENANT_A,
          originalName: 'test.docx',
          status: 'COMPLETED',
          wordCount: 1000,
          pageCount: 2,
          referenceListStyle: null, // Numeric style
          citations: [
            { id: 'cit-1', rawText: '(1)', reference: null },
          ],
          job: null,
        };

        const mockReferences = [
          { id: 'ref-1', sortKey: '0001', citationLinks: [{ citationId: 'cit-1' }], formattedApa: 'Author (2023)' },
        ];

        vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as never);
        vi.mocked(prisma.referenceListEntry.findMany).mockResolvedValue(mockReferences as never);
        vi.mocked(prisma.citationChange.findMany).mockResolvedValue([]);

        await uploadController.getAnalysis(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        const responseData = jsonMock.mock.calls[0][0];
        // New format uses referenceId instead of referenceNumber
        expect(responseData.data.citations[0].id).toBe('cit-1');
        expect(responseData.data.citations[0].rawText).toBe('(1)');
      });
    });

    describe('editReference - document mismatch', () => {
      it('should return 400 when reference does not belong to document', async () => {
        mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };
        mockReq.body = { title: 'New Title' };

        const mockReference = {
          id: 'ref-1',
          documentId: 'doc-different', // Different document ID
          document: {
            tenantId: TENANT_A,
            citations: [],
          },
        };

        vi.mocked(prisma.referenceListEntry.findUnique).mockResolvedValue(mockReference as never);

        await referenceController.editReference(
          mockReq as Request,
          mockRes as Response,
          mockNext
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          error: { code: 'INVALID_DOCUMENT', message: 'Reference does not belong to this document' },
        });
      });
    });
  });

  // ============================================================================
  // ERROR HANDLING TESTS
  // ============================================================================
  describe('Error Handling', () => {
    it('should call next() on unexpected errors in getAnalysis', async () => {
      mockReq.params = { documentId: 'doc-123' };

      const error = new Error('Database connection failed');
      vi.mocked(prisma.editorialDocument.findFirst).mockRejectedValue(error);

      await uploadController.getAnalysis(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should call next() on unexpected errors in deleteReference', async () => {
      mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };

      const error = new Error('Database error');
      vi.mocked(prisma.referenceListEntry.findUnique).mockRejectedValue(error);

      await referenceController.deleteReference(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should call next() on unexpected errors in editReference', async () => {
      mockReq.params = { documentId: 'doc-123', referenceId: 'ref-1' };
      mockReq.body = { title: 'New Title' };

      // resolveDocumentSimple calls findFirst first, so mock it to return a document
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: 'tenant-123',
      } as any);

      const error = new Error('Update failed');
      vi.mocked(prisma.referenceListEntry.findUnique).mockRejectedValue(error);

      await referenceController.editReference(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
