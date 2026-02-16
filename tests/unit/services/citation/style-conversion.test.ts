/**
 * Citation Style Conversion Tests
 *
 * End-to-end tests for style conversion functionality
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Hoist mock function so it's available when vi.mock is hoisted
const { mockConvertStyle } = vi.hoisted(() => ({
  mockConvertStyle: vi.fn(),
}));

// Mock Prisma
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    editorialDocument: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    referenceListEntry: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    citationChange: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock AI Format Converter Service
vi.mock('../../../../src/services/citation/ai-format-converter.service', () => ({
  CitationStyle: {},
  aiFormatConverterService: {
    convertStyle: mockConvertStyle,
  },
}));

import prisma from '../../../../src/lib/prisma';
import { CitationStyleController } from '../../../../src/controllers/citation/citation-style.controller';

describe('Citation Style Conversion', () => {
  let controller: CitationStyleController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  const TENANT_ID = 'tenant-123';

  beforeEach(() => {
    controller = new CitationStyleController();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockNext = vi.fn();

    mockRes = {
      status: statusMock,
      json: jsonMock,
    };

    mockReq = {
      user: {
        id: 'user-123',
        tenantId: TENANT_ID,
        email: 'test@example.com',
        role: 'USER',
      },
      params: {},
      body: {},
    };

    vi.clearAllMocks();

    // Default mock for aiFormatConverterService.convertStyle
    mockConvertStyle.mockResolvedValue({
      convertedReferences: [],
      convertedCitations: [],
      citationConversions: [],
      targetStyle: 'APA',
      changes: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Supported Styles', () => {
    it('should return all supported citation styles', async () => {
      await controller.getStyles(mockReq as Request, mockRes as Response);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            styles: expect.arrayContaining([
              expect.objectContaining({ id: 'APA', name: 'APA 7th Edition' }),
              expect.objectContaining({ id: 'MLA', name: 'MLA 9th Edition' }),
              expect.objectContaining({ id: 'Chicago', name: 'Chicago 17th Edition' }),
              expect.objectContaining({ id: 'Vancouver', name: 'Vancouver' }),
              expect.objectContaining({ id: 'IEEE', name: 'IEEE' }),
              expect.objectContaining({ id: 'Harvard', name: 'Harvard' }),
              expect.objectContaining({ id: 'AMA', name: 'AMA 11th Edition' }),
            ]),
          }),
        })
      );
    });

    it('should include descriptions for each style', async () => {
      await controller.getStyles(mockReq as Request, mockRes as Response);

      const response = jsonMock.mock.calls[0][0];
      const styles = response.data.styles;

      styles.forEach((style: { id: string; description: string }) => {
        expect(style.description).toBeDefined();
        expect(style.description.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Style Validation', () => {
    const invalidStyles = ['invalid', 'UNKNOWN', 'apa', 'mla', ''];

    it.each(invalidStyles)('should reject invalid style: %s', async (invalidStyle) => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: invalidStyle };

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

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

    const validStyles = ['APA', 'MLA', 'Chicago', 'Vancouver', 'IEEE', 'Harvard', 'AMA'];

    it.each(validStyles)('should accept valid style: %s', async (validStyle) => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: validStyle };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', formattedApa: 'Reference 1', authors: ['Smith'], year: '2023', title: 'Title' },
        ],
        citations: [],
      } as any);

      // Mock AI converter to return conversion results
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [{ id: 'ref-1', rawText: 'Converted Reference 1' }],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: validStyle,
        changes: [{ referenceId: 'ref-1', oldFormat: 'Reference 1', newFormat: 'Converted Reference 1' }],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).not.toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            targetStyle: validStyle,
          }),
        })
      );
    });
  });

  describe('Conversion Process', () => {
    it('should convert all references in document', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'APA' };

      const mockReferences = [
        { id: 'ref-1', formattedApa: 'Smith J. Title. Journal. 2023;1:1-10.', authors: ['Smith J'], year: '2023', title: 'Title' },
        { id: 'ref-2', formattedApa: 'Jones A. Paper. Science. 2022;2:20.', authors: ['Jones A'], year: '2022', title: 'Paper' },
        { id: 'ref-3', formattedApa: 'Brown B. Research. Nature. 2021;3:30.', authors: ['Brown B'], year: '2021', title: 'Research' },
      ];

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListStyle: 'Vancouver',
        referenceListEntries: mockReferences,
        citations: [],
      } as any);

      // Mock AI converter to return conversion results for all references
      mockConvertStyle.mockResolvedValue({
        convertedReferences: mockReferences.map(r => ({ id: r.id, rawText: `APA: ${r.title}` })),
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'APA',
        changes: mockReferences.map(r => ({
          referenceId: r.id,
          oldFormat: r.formattedApa,
          newFormat: `APA: ${r.title}`,
        })),
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({
        referenceListStyle: 'APA',
      } as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      // Should create a change record for each reference
      expect(prisma.citationChange.create).toHaveBeenCalledTimes(3);

      // Each change should record the conversion
      expect(prisma.citationChange.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            documentId: 'doc-123',
            changeType: 'REFERENCE_STYLE_CONVERSION',
            appliedBy: 'ai',
          }),
        })
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            totalConverted: 3,
            totalFailed: 0,
          }),
        })
      );
    });

    it('should update document style after conversion', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'Chicago' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListStyle: 'APA',
        referenceListEntries: [{ id: 'ref-1', formattedApa: 'Ref 1', title: 'Title' }],
        citations: [],
      } as any);

      // Mock AI converter
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [{ id: 'ref-1', rawText: 'Chicago Ref 1' }],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'Chicago',
        changes: [{ referenceId: 'ref-1', oldFormat: 'Ref 1', newFormat: 'Chicago Ref 1' }],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(prisma.editorialDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-123' },
          data: { referenceListStyle: 'Chicago' },
        })
      );
    });

    it('should return conversion results for each reference', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'MLA' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListStyle: 'APA',
        referenceListEntries: [
          { id: 'ref-1', formattedApa: 'Original 1', title: 'Title 1' },
          { id: 'ref-2', formattedApa: 'Original 2', title: 'Title 2' },
        ],
        citations: [],
      } as any);

      // Mock AI converter
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [
          { id: 'ref-1', rawText: 'MLA 1' },
          { id: 'ref-2', rawText: 'MLA 2' },
        ],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'MLA',
        changes: [
          { referenceId: 'ref-1', oldFormat: 'Original 1', newFormat: 'MLA 1' },
          { referenceId: 'ref-2', oldFormat: 'Original 2', newFormat: 'MLA 2' },
        ],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.data.results).toHaveLength(2);
      expect(response.data.results[0]).toHaveProperty('referenceId');
      expect(response.data.results[0]).toHaveProperty('originalText');
      expect(response.data.results[0]).toHaveProperty('convertedText');
      expect(response.data.results[0]).toHaveProperty('success');
    });
  });

  describe('Edge Cases', () => {
    it('should handle document with no references', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'APA' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [],
        citations: [],
      } as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'NO_REFERENCES',
          }),
        })
      );
    });

    it('should handle document not found', async () => {
      mockReq.params = { documentId: 'non-existent' };
      mockReq.body = { targetStyle: 'APA' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

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

    it('should handle references without formattedApa field', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'IEEE' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', formattedApa: null, title: 'Fallback Title' },
        ],
        citations: [],
      } as any);

      // Mock AI converter - the service receives "Fallback Title" as rawText
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [{ id: 'ref-1', rawText: 'IEEE Fallback Title' }],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'IEEE',
        changes: [{ referenceId: 'ref-1', oldFormat: 'Fallback Title', newFormat: 'IEEE Fallback Title' }],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      // Should use title as fallback (from the conversion result)
      expect(prisma.citationChange.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            beforeText: 'Fallback Title',
          }),
        })
      );
    });

    it('should handle references with empty fields', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'Harvard' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', formattedApa: '', title: '' },
        ],
        citations: [],
      } as any);

      // Mock AI converter
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [{ id: 'ref-1', rawText: '' }],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'Harvard',
        changes: [{ referenceId: 'ref-1', oldFormat: '', newFormat: '' }],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });

  describe('Tenant Isolation', () => {
    it('should only convert documents belonging to tenant', async () => {
      mockReq.params = { documentId: 'doc-from-other-tenant' };
      mockReq.body = { targetStyle: 'APA' };

      // findFirst with tenantId filter returns null for other tenant's doc
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(prisma.editorialDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'doc-from-other-tenant',
            tenantId: TENANT_ID,
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(404);
    });
  });

  describe('Error Handling', () => {
    it('should call next with error on database failure', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'APA' };

      const dbError = new Error('Database connection failed');
      vi.mocked(prisma.editorialDocument.findFirst).mockRejectedValue(dbError);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(dbError);
    });

    it('should handle partial conversion failures', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'APA' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [
          { id: 'ref-1', formattedApa: 'Good reference', title: 'Good' },
          { id: 'ref-2', formattedApa: 'Another reference', title: 'Another' },
        ],
        citations: [],
      } as any);

      // Mock AI converter
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [
          { id: 'ref-1', rawText: 'APA Good' },
          { id: 'ref-2', rawText: 'APA Another' },
        ],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'APA',
        changes: [
          { referenceId: 'ref-1', oldFormat: 'Good reference', newFormat: 'APA Good' },
          { referenceId: 'ref-2', oldFormat: 'Another reference', newFormat: 'APA Another' },
        ],
      });

      // First reference update succeeds, second fails
      vi.mocked(prisma.referenceListEntry.update)
        .mockResolvedValueOnce({} as any)
        .mockRejectedValueOnce(new Error('Update failed'));

      // First change record succeeds, second fails due to the update failure
      vi.mocked(prisma.citationChange.create)
        .mockResolvedValueOnce({} as any)
        .mockResolvedValueOnce({} as any);

      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      // Results contain both success and failure entries
      expect(response.data.results.length).toBeGreaterThanOrEqual(2);
      // At least one reference should have failed
      const hasFailedResult = response.data.results.some((r: { success: boolean }) => !r.success);
      expect(hasFailedResult).toBe(true);
    });
  });

  describe('Style Conversion Quality', () => {
    it('should preserve reference metadata during conversion', async () => {
      mockReq.params = { documentId: 'doc-123' };
      mockReq.body = { targetStyle: 'Vancouver' };

      const originalRef = {
        id: 'ref-1',
        formattedApa: 'Smith, J. (2023). Title. Journal, 1(1), 1-10. https://doi.org/10.1000/test',
        authors: ['Smith, J.'],
        year: '2023',
        title: 'Title',
        journalName: 'Journal',
        volume: '1',
        issue: '1',
        pages: '1-10',
        doi: '10.1000/test',
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-123',
        tenantId: TENANT_ID,
        referenceListEntries: [originalRef],
        citations: [],
      } as any);

      // Mock AI converter
      mockConvertStyle.mockResolvedValue({
        convertedReferences: [{ id: 'ref-1', rawText: 'Vancouver formatted ref' }],
        convertedCitations: [],
        citationConversions: [],
        targetStyle: 'Vancouver',
        changes: [{
          referenceId: 'ref-1',
          oldFormat: originalRef.formattedApa,
          newFormat: 'Vancouver formatted ref',
        }],
      });

      vi.mocked(prisma.referenceListEntry.update).mockResolvedValue({} as any);
      vi.mocked(prisma.citationChange.create).mockResolvedValue({} as any);
      vi.mocked(prisma.editorialDocument.update).mockResolvedValue({} as any);

      await controller.convertStyle(mockReq as Request, mockRes as Response, mockNext);

      // Change should record original text
      expect(prisma.citationChange.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            beforeText: originalRef.formattedApa,
          }),
        })
      );
    });
  });
});
