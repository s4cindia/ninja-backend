/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock prisma before importing service
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    styleValidationJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    editorialDocument: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    editorialDocumentContent: {
      update: vi.fn(),
      create: vi.fn(),
    },
    documentContent: {
      findUnique: vi.fn(),
    },
    styleViolation: {
      createMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      groupBy: vi.fn(),
    },
    houseRuleSet: {
      findMany: vi.fn(),
    },
    houseStyleRule: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Mock the editorial AI client
vi.mock('../../../../src/services/shared/editorial-ai-client', () => ({
  editorialAi: {
    validateStyle: vi.fn(),
    getStyleGuideRules: vi.fn().mockReturnValue({
      name: 'Test Style Guide',
      referencePrefix: 'TEST',
      rules: 'Test rules',
    }),
  },
}));

// Mock claude service
vi.mock('../../../../src/services/ai/claude.service', () => ({
  claudeService: {
    generateJSON: vi.fn().mockResolvedValue([]),
  },
}));

// Mock text chunker
vi.mock('../../../../src/utils/text-chunker', () => ({
  splitTextIntoChunks: vi.fn().mockReturnValue([{ text: 'This is sample text for validation.', offset: 0 }]),
}));

// Mock house style engine
vi.mock('../../../../src/services/style/house-style-engine.service', () => ({
  houseStyleEngine: {
    getRulesFromSets: vi.fn().mockResolvedValue([]),
    getActiveRules: vi.fn().mockResolvedValue([]),
  },
}));

// Mock logger
vi.mock('../../../../src/lib/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { claudeService } from '../../../../src/services/ai/claude.service';
import { styleValidation as styleValidationService } from '../../../../src/services/style/style-validation.service';

describe('StyleValidationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('executeValidation', () => {
    it('should throw error if job not found', async () => {
      vi.mocked(prisma.styleValidationJob.findUnique).mockResolvedValue(null);

      await expect(styleValidationService.executeValidation('non-existent-job'))
        .rejects.toThrow('Validation job not found');
    });

    it('should throw error if document not found', async () => {
      vi.mocked(prisma.styleValidationJob.findUnique).mockResolvedValue({
        id: 'job-1',
        documentId: 'doc-1',
        status: 'PROCESSING',
        tenantId: 'tenant-1',
        userId: 'user-1',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        totalViolations: 0,
        fixedViolations: 0,
        ignoredViolations: 0,
        ruleSetIds: [],
        options: null,
      });
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue(null);

      await expect(styleValidationService.executeValidation('job-1'))
        .rejects.toThrow('Document content not found');
    });

    it('should throw error if document has no content', async () => {
      const mockJob = {
        id: 'job-1',
        documentId: 'doc-1',
        status: 'PROCESSING',
        tenantId: 'tenant-1',
        userId: 'user-1',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        totalViolations: 0,
        fixedViolations: 0,
        ignoredViolations: 0,
        ruleSetIds: [],
        options: null,
      };

      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        name: 'test.docx',
        fileName: 'test.docx',
        fileType: 'docx',
        filePath: '/path/to/test.docx',
        fileSize: 1000,
        status: 'UPLOADED',
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: 'user-1',
        documentContent: null, // No content
      };

      vi.mocked(prisma.styleValidationJob.findUnique).mockResolvedValue(mockJob);
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue(mockDocument as any);

      await expect(styleValidationService.executeValidation('job-1'))
        .rejects.toThrow(/content/i);
    });

    it('should process document with content and return violation count', async () => {
      const mockJob = {
        id: 'job-1',
        documentId: 'doc-1',
        status: 'PROCESSING',
        tenantId: 'tenant-1',
        userId: 'user-1',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        totalViolations: 0,
        fixedViolations: 0,
        ignoredViolations: 0,
        ruleSetIds: ['ruleset-1'],
        options: { styleGuide: 'CHICAGO' },
      };

      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        name: 'test.docx',
        fileName: 'test.docx',
        fileType: 'docx',
        filePath: '/path/to/test.docx',
        fileSize: 1000,
        status: 'UPLOADED',
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: 'user-1',
        documentContent: {
          id: 'content-1',
          fullText: 'This is sample text for validation.',
        },
      };

      vi.mocked(prisma.styleValidationJob.findUnique).mockResolvedValue(mockJob);
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue(mockJob);
      vi.mocked(prisma.houseRuleSet.findMany).mockResolvedValue([]);
      vi.mocked(prisma.houseStyleRule.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        const txMock = {
          styleViolation: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return callback(txMock);
      });
      vi.mocked(claudeService.generateJSON).mockResolvedValue([
        {
          rule: 'Test Rule',
          ruleReference: 'CHICAGO 1.1',
          originalText: 'sample',
          suggestedFix: 'example',
          explanation: 'Use example instead of sample',
          severity: 'WARNING',
        },
      ]);
      vi.mocked(prisma.styleViolation.createMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(1);

      const progressCallback = vi.fn();
      const result = await styleValidationService.executeValidation('job-1', progressCallback);

      expect(result).toBe(1);
      expect(prisma.styleValidationJob.update).toHaveBeenCalled();
      expect(claudeService.generateJSON).toHaveBeenCalled();
    });

    it('should call progress callback during execution', async () => {
      const mockJob = {
        id: 'job-1',
        documentId: 'doc-1',
        status: 'PROCESSING',
        tenantId: 'tenant-1',
        userId: 'user-1',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        totalViolations: 0,
        fixedViolations: 0,
        ignoredViolations: 0,
        ruleSetIds: [],
        options: null,
      };

      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        name: 'test.docx',
        fileName: 'test.docx',
        fileType: 'docx',
        filePath: '/path/to/test.docx',
        fileSize: 1000,
        status: 'UPLOADED',
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: 'user-1',
        documentContent: {
          id: 'content-1',
          fullText: 'Short text.',
        },
      };

      vi.mocked(prisma.styleValidationJob.findUnique).mockResolvedValue(mockJob);
      vi.mocked(prisma.editorialDocument.findUnique).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleValidationJob.update).mockResolvedValue(mockJob);
      vi.mocked(prisma.houseRuleSet.findMany).mockResolvedValue([]);
      vi.mocked(prisma.houseStyleRule.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        const txMock = {
          styleViolation: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        };
        return callback(txMock);
      });
      vi.mocked(claudeService.generateJSON).mockResolvedValue([]);
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(0);

      const progressCallback = vi.fn();
      await styleValidationService.executeValidation('job-1', progressCallback);

      expect(progressCallback).toHaveBeenCalled();
    });
  });

  describe('getViolations', () => {
    it('should return violations with pagination', async () => {
      const mockDocument = { id: 'doc-1' };
      const mockViolations = [
        {
          id: 'v1',
          jobId: 'job-1',
          rule: 'Test Rule',
          severity: 'WARNING',
          originalText: 'test',
          suggestedFix: 'Test',
          status: 'PENDING',
          category: 'TERMINOLOGY',
          explanation: 'Test explanation',
          ruleReference: 'TEST-1',
          characterOffset: 0,
          lineNumber: 1,
          pageNumber: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue(mockViolations);
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(1);

      const result = await styleValidationService.getViolations('doc-1', 'tenant-1', {});

      expect(result.violations).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should apply pagination parameters', async () => {
      const mockDocument = { id: 'doc-1' };
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(0);

      await styleValidationService.getViolations('doc-1', 'tenant-1', undefined, { skip: 10, take: 5 });

      expect(prisma.styleViolation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 5,
        })
      );
    });

    it('should cap pagination at max value', async () => {
      const mockDocument = { id: 'doc-1' };
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue([]);
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(0);

      // Request more than max
      await styleValidationService.getViolations('doc-1', 'tenant-1', undefined, { take: 1000 });

      expect(prisma.styleViolation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 200, // Should be capped at 200 (matches schema)
        })
      );
    });
  });

  describe('ignoreViolation', () => {
    it('should ignore a violation with a reason', async () => {
      const mockViolation = {
        id: 'v1',
        jobId: 'job-1',
        status: 'PENDING',
        document: {
          tenantId: 'tenant-1',
        },
      };

      const mockUpdatedViolation = {
        ...mockViolation,
        status: 'IGNORED',
        ignoredReason: 'False positive',
      };

      vi.mocked(prisma.styleViolation.findFirst).mockResolvedValue(mockViolation as any);
      vi.mocked(prisma.styleViolation.update).mockResolvedValue(mockUpdatedViolation as any);

      const result = await styleValidationService.ignoreViolation(
        'v1',           // violationId
        'tenant-1',     // tenantId
        'user-1',       // userId
        'False positive' // reason
      );

      expect(result.status).toBe('IGNORED');
      expect(prisma.styleViolation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'v1' },
          data: expect.objectContaining({
            status: 'IGNORED',
            ignoredReason: 'False positive',
          }),
        })
      );
    });
  });

  describe('startValidation', () => {
    it('should create a validation job for a document with content', async () => {
      const mockDocument = {
        id: 'doc-1',
        tenantId: 'tenant-1',
        documentContent: {
          fullText: 'Test document content for validation.',
        },
      };

      const mockJob = {
        id: 'job-1',
        documentId: 'doc-1',
        tenantId: 'tenant-1',
        status: 'QUEUED',
        ruleSetIds: ['chicago'],
        totalRules: 10,
        createdAt: new Date(),
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleValidationJob.create).mockResolvedValue(mockJob as any);

      const result = await styleValidationService.startValidation('tenant-1', 'user-1', {
        documentId: 'doc-1',
        ruleSetIds: ['chicago'],
      });

      expect(result.id).toBe('job-1');
      expect(result.status).toBe('QUEUED');
      expect(prisma.styleValidationJob.create).toHaveBeenCalled();
    });

    it('should throw error if document not found', async () => {
      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await expect(
        styleValidationService.startValidation('tenant-1', 'user-1', {
          documentId: 'non-existent',
          ruleSetIds: ['chicago'],
        })
      ).rejects.toThrow('Document not found');
    });
  });

  describe('bulkAction', () => {
    it('should batch update violations for ignore action', async () => {
      const mockViolations = [
        { id: 'v1' },
        { id: 'v2' },
      ];

      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue(mockViolations as any);
      vi.mocked(prisma.styleViolation.updateMany).mockResolvedValue({ count: 2 });

      const result = await styleValidationService.bulkAction({
        violationIds: ['v1', 'v2'],
        action: 'ignore',
        userId: 'user-1',
        tenantId: 'tenant-1',
        reason: 'Bulk ignore',
      });

      expect(result.succeeded).toBe(2);
      expect(prisma.styleViolation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'IGNORED',
            ignoredReason: 'Bulk ignore',
          }),
        })
      );
    });

    it('should batch update violations for wont_fix action', async () => {
      const mockViolations = [
        { id: 'v1' },
        { id: 'v2' },
        { id: 'v3' },
      ];

      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue(mockViolations as any);
      vi.mocked(prisma.styleViolation.updateMany).mockResolvedValue({ count: 3 });

      const result = await styleValidationService.bulkAction({
        violationIds: ['v1', 'v2', 'v3'],
        action: 'wont_fix',
        userId: 'user-1',
        tenantId: 'tenant-1',
        reason: 'Not applicable to our style',
      });

      expect(result.succeeded).toBe(3);
      expect(prisma.styleViolation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'WONT_FIX',
            ignoredReason: 'Not applicable to our style',
          }),
        })
      );
    });

    it('should track failed violations when not found', async () => {
      // Only one violation is valid
      vi.mocked(prisma.styleViolation.findMany).mockResolvedValue([{ id: 'v1' }] as any);
      vi.mocked(prisma.styleViolation.updateMany).mockResolvedValue({ count: 1 });

      const result = await styleValidationService.bulkAction({
        violationIds: ['v1', 'v2-not-found'],
        action: 'ignore',
        userId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('markWontFix', () => {
    it('should mark a violation as wont fix with reason', async () => {
      const mockViolation = {
        id: 'v1',
        status: 'PENDING',
      };

      const mockUpdatedViolation = {
        ...mockViolation,
        status: 'WONT_FIX',
        ignoredReason: 'Style choice',
      };

      vi.mocked(prisma.styleViolation.findFirst).mockResolvedValue(mockViolation as any);
      vi.mocked(prisma.styleViolation.update).mockResolvedValue(mockUpdatedViolation as any);

      const result = await styleValidationService.markWontFix(
        'v1',
        'tenant-1',
        'user-1',
        'Style choice'
      );

      expect(result.status).toBe('WONT_FIX');
      expect(prisma.styleViolation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'WONT_FIX',
            ignoredReason: 'Style choice',
          }),
        })
      );
    });

    it('should throw error if violation already resolved', async () => {
      const mockViolation = {
        id: 'v1',
        status: 'FIXED', // Already resolved
      };

      vi.mocked(prisma.styleViolation.findFirst).mockResolvedValue(mockViolation as any);

      await expect(
        styleValidationService.markWontFix('v1', 'tenant-1', 'user-1')
      ).rejects.toThrow('already');
    });
  });

  describe('getValidationSummary', () => {
    it('should return summary with category and severity counts', async () => {
      const mockDocument = {
        id: 'doc-1',
        fileName: 'test.docx',
        originalName: 'Original Test.docx',
      };

      const mockJob = {
        id: 'job-1',
        documentId: 'doc-1',
        tenantId: 'tenant-1',
        status: 'COMPLETED',
        progress: 100,
        startedAt: new Date(),
        completedAt: new Date(),
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleValidationJob.findFirst).mockResolvedValue(mockJob as any);
      vi.mocked(prisma.styleViolation.groupBy).mockResolvedValueOnce([
        { category: 'GRAMMAR', _count: { category: 5 } },
        { category: 'PUNCTUATION', _count: { category: 3 } },
      ] as any);
      vi.mocked(prisma.styleViolation.groupBy).mockResolvedValueOnce([
        { severity: 'ERROR', _count: { severity: 2 } },
        { severity: 'WARNING', _count: { severity: 6 } },
      ] as any);
      vi.mocked(prisma.styleViolation.groupBy).mockResolvedValueOnce([
        { status: 'PENDING', _count: { status: 5 } },
        { status: 'FIXED', _count: { status: 3 } },
      ] as any);
      vi.mocked(prisma.styleViolation.groupBy).mockResolvedValueOnce([
        { ruleId: 'rule-1', title: 'Serial Comma', _count: { ruleId: 4 } },
      ] as any);
      vi.mocked(prisma.styleViolation.count).mockResolvedValue(8);

      const result = await styleValidationService.getValidationSummary('doc-1', 'tenant-1');

      expect(result).not.toBeNull();
      expect(result?.totalViolations).toBe(8);
      expect(result?.fileName).toBe('Original Test.docx');
      expect(result?.status).toBe('COMPLETED');
    });

    it('should return null if no validation job exists', async () => {
      const mockDocument = { id: 'doc-1' };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(mockDocument as any);
      vi.mocked(prisma.styleValidationJob.findFirst).mockResolvedValue(null);

      const result = await styleValidationService.getValidationSummary('doc-1', 'tenant-1');

      expect(result).toBeNull();
    });
  });
});
