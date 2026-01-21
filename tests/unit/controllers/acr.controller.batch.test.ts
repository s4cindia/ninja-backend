import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { AcrController } from '../../../src/controllers/acr.controller';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    acrJob: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../../src/services/acr/batch-acr-generator.service', () => ({
  batchAcrGeneratorService: {
    generateBatchAcr: vi.fn(),
  },
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
import { batchAcrGeneratorService } from '../../../src/services/acr/batch-acr-generator.service';

describe('AcrController - Batch ACR Endpoints', () => {
  let controller: AcrController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    controller = new AcrController();
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    
    mockRes = {
      status: statusMock,
      json: jsonMock,
    };

    mockReq = {
      user: {
        id: 'user-123',
        tenantId: 'tenant-123',
        email: 'test@example.com',
        role: 'USER',
      },
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateBatchAcr', () => {
    it('should generate individual ACRs with valid payload', async () => {
      mockReq.body = {
        batchId: 'batch-123',
        mode: 'individual',
      };

      const mockResult = {
        mode: 'individual' as const,
        acrWorkflowIds: ['acr-1', 'acr-2'],
        totalAcrs: 2,
        message: '2 ACRs generated successfully',
      };

      vi.mocked(batchAcrGeneratorService.generateBatchAcr).mockResolvedValue(mockResult);

      await controller.generateBatchAcr(mockReq as Request, mockRes as Response);

      expect(batchAcrGeneratorService.generateBatchAcr).toHaveBeenCalledWith(
        'batch-123',
        'tenant-123',
        'user-123',
        'individual',
        undefined
      );
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: mockResult,
      });
    });

    it('should generate aggregate ACR with valid payload', async () => {
      mockReq.body = {
        batchId: 'batch-123',
        mode: 'aggregate',
        options: {
          edition: 'VPAT2.5-WCAG',
          batchName: 'Test Batch',
          vendor: 'Test Vendor',
          contactEmail: 'test@example.com',
          aggregationStrategy: 'conservative',
        },
      };

      const mockResult = {
        mode: 'aggregate' as const,
        acrWorkflowId: 'acr-batch-123',
        totalDocuments: 3,
        totalCriteria: 50,
        message: 'Aggregate ACR generated successfully',
      };

      vi.mocked(batchAcrGeneratorService.generateBatchAcr).mockResolvedValue(mockResult);

      await controller.generateBatchAcr(mockReq as Request, mockRes as Response);

      expect(batchAcrGeneratorService.generateBatchAcr).toHaveBeenCalledWith(
        'batch-123',
        'tenant-123',
        'user-123',
        'aggregate',
        mockReq.body.options
      );
      expect(statusMock).toHaveBeenCalledWith(201);
    });

    it('should return 500 on service error', async () => {
      mockReq.body = {
        batchId: 'batch-123',
        mode: 'individual',
      };

      vi.mocked(batchAcrGeneratorService.generateBatchAcr).mockRejectedValue(
        new Error('Service error')
      );

      await controller.generateBatchAcr(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: {
          message: 'Service error',
          code: 'BATCH_ACR_GENERATION_FAILED',
        },
      });
    });
  });

  describe('getBatchAcr', () => {
    it('should return batch ACR document', async () => {
      mockReq.params = { batchAcrId: 'acr-batch-123' };

      const mockJob = {
        id: 'acr-batch-123',
        tenantId: 'tenant-123',
        type: 'ACR_WORKFLOW',
        isBatchAcr: true,
        status: 'completed',
        createdAt: new Date(),
        completedAt: new Date(),
        output: {
          documentTitle: 'Test Batch ACR',
          criteria: [],
        },
        batchSourceJobIds: ['job-1', 'job-2'],
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockJob as never);

      await controller.getBatchAcr(mockReq as Request, mockRes as Response);

      expect(prisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'acr-batch-123',
          tenantId: 'tenant-123',
          type: 'ACR_WORKFLOW',
          isBatchAcr: true,
        },
      });
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          acrDocument: mockJob.output,
          metadata: {
            id: mockJob.id,
            status: mockJob.status,
            createdAt: mockJob.createdAt,
            completedAt: mockJob.completedAt,
            sourceJobIds: mockJob.batchSourceJobIds,
          },
        },
      });
    });

    it('should return 404 when batch ACR not found', async () => {
      mockReq.params = { batchAcrId: 'nonexistent' };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await controller.getBatchAcr(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: {
          message: 'Batch ACR not found',
          code: 'BATCH_ACR_NOT_FOUND',
        },
      });
    });
  });

  describe('getBatchAcrHistory', () => {
    it('should return ACR generation history', async () => {
      mockReq.params = { batchId: 'batch-123' };

      const mockBatchJob = {
        id: 'batch-123',
        tenantId: 'tenant-123',
        type: 'BATCH_VALIDATION',
        output: {
          acrGenerated: true,
          acrMode: 'individual',
          acrWorkflowIds: ['acr-1', 'acr-2'],
          acrGeneratedAt: '2026-01-21T00:00:00.000Z',
          acrGenerationHistory: [
            {
              mode: 'individual',
              acrWorkflowIds: ['acr-1', 'acr-2'],
              generatedAt: '2026-01-21T00:00:00.000Z',
              generatedBy: 'user-123',
            },
          ],
        },
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockBatchJob as never);

      await controller.getBatchAcrHistory(mockReq as Request, mockRes as Response);

      expect(prisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'batch-123',
          tenantId: 'tenant-123',
          type: 'BATCH_VALIDATION',
        },
      });
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          history: mockBatchJob.output.acrGenerationHistory,
          currentAcr: {
            generated: true,
            mode: 'individual',
            workflowIds: ['acr-1', 'acr-2'],
            generatedAt: '2026-01-21T00:00:00.000Z',
          },
        },
      });
    });

    it('should return 404 when batch not found', async () => {
      mockReq.params = { batchId: 'nonexistent' };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(null);

      await controller.getBatchAcrHistory(mockReq as Request, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: {
          message: 'Batch not found',
          code: 'BATCH_NOT_FOUND',
        },
      });
    });
  });
});
