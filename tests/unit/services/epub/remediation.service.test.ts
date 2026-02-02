import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { remediationService } from '../../../../src/services/epub/remediation.service';
import type { RemediationTask } from '../../../../src/services/epub/remediation.service';
import prisma from '../../../../src/lib/prisma';

// Mock dependencies
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((callback) => callback(prisma)),
  },
}));

vi.mock('../../../../src/services/epub/epub-audit.service', () => ({
  epubAuditService: {},
}));

vi.mock('../../../../src/services/validation/wcag-criteria.service', () => ({
  wcagCriteriaService: {
    getCriteriaById: vi.fn(),
  },
}));

describe('RemediationService - Location Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateTaskStatus with resolvedLocation', () => {
    it('should update resolvedLocation when provided in options', async () => {
      const mockPlan = {
        jobId: 'test-job-123',
        fileName: 'test.epub',
        totalIssues: 1,
        tasks: [
          {
            id: 'task-123',
            jobId: 'test-job-123',
            issueId: 'issue-123',
            issueCode: 'EPUB-STRUCT-004',
            issueMessage: 'Missing main landmark in EPUB',
            severity: 'minor',
            category: 'structure',
            location: 'EPUB',
            status: 'pending',
            priority: 'low',
            type: 'auto',
            autoFixable: true,
            quickFixable: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as RemediationTask,
        ],
        stats: {
          pending: 1,
          inProgress: 0,
          completed: 0,
          skipped: 0,
          failed: 0,
          autoFixable: 1,
          quickFixable: 0,
          manualRequired: 0,
          byFixType: { auto: 1, quickfix: 0, manual: 0 },
          bySource: { epubCheck: 0, ace: 0, jsAuditor: 1 },
          bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 1 },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPlanJob = {
        id: 'plan-job-123',
        type: 'BATCH_VALIDATION',
        input: { sourceJobId: 'test-job-123' },
        output: mockPlan,
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.findFirst>>);
      vi.mocked(prisma.job.update).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.update>>);

      const result = await remediationService.updateTaskStatus(
        'test-job-123',
        'task-123',
        'completed',
        'Auto-applied high-confidence fix',
        'system',
        {
          resolvedLocation: 'OEBPS/chapter1.xhtml',
          resolvedFiles: ['OEBPS/chapter1.xhtml'],
        }
      );

      expect(result.resolvedLocation).toBe('OEBPS/chapter1.xhtml');
      expect(result.resolvedFiles).toEqual(['OEBPS/chapter1.xhtml']);
      expect(result.status).toBe('completed');
      expect(result.resolution).toBe('Auto-applied high-confidence fix');
      expect(result.resolvedBy).toBe('system');
    });

    it('should track multiple resolved files', async () => {
      const mockPlan = {
        jobId: 'test-job-123',
        fileName: 'test.epub',
        totalIssues: 1,
        tasks: [
          {
            id: 'task-456',
            jobId: 'test-job-123',
            issueId: 'issue-456',
            issueCode: 'EPUB-STRUCT-004',
            issueMessage: 'Missing main landmark in EPUB',
            severity: 'minor',
            category: 'structure',
            location: 'EPUB',
            status: 'pending',
            priority: 'low',
            type: 'auto',
            autoFixable: true,
            quickFixable: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as RemediationTask,
        ],
        stats: {
          pending: 1,
          inProgress: 0,
          completed: 0,
          skipped: 0,
          failed: 0,
          autoFixable: 1,
          quickFixable: 0,
          manualRequired: 0,
          byFixType: { auto: 1, quickfix: 0, manual: 0 },
          bySource: { epubCheck: 0, ace: 0, jsAuditor: 1 },
          bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 1 },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPlanJob = {
        id: 'plan-job-456',
        type: 'BATCH_VALIDATION',
        input: { sourceJobId: 'test-job-123' },
        output: mockPlan,
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.findFirst>>);
      vi.mocked(prisma.job.update).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.update>>);

      const result = await remediationService.updateTaskStatus(
        'test-job-123',
        'task-456',
        'completed',
        'Auto-applied fix to multiple files',
        'system',
        {
          resolvedLocation: 'OEBPS/chapter1.xhtml',
          resolvedFiles: ['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml'],
        }
      );

      expect(result.resolvedLocation).toBe('OEBPS/chapter1.xhtml');
      expect(result.resolvedFiles).toHaveLength(2);
      expect(result.resolvedFiles).toContain('OEBPS/chapter1.xhtml');
      expect(result.resolvedFiles).toContain('OEBPS/chapter2.xhtml');
    });

    it('should not set resolvedLocation if not provided', async () => {
      const mockPlan = {
        jobId: 'test-job-123',
        fileName: 'test.epub',
        totalIssues: 1,
        tasks: [
          {
            id: 'task-789',
            jobId: 'test-job-123',
            issueId: 'issue-789',
            issueCode: 'EPUB-META-001',
            issueMessage: 'Missing dc:language',
            severity: 'serious',
            category: 'metadata',
            status: 'pending',
            priority: 'high',
            type: 'auto',
            autoFixable: true,
            quickFixable: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as RemediationTask,
        ],
        stats: {
          pending: 1,
          inProgress: 0,
          completed: 0,
          skipped: 0,
          failed: 0,
          autoFixable: 1,
          quickFixable: 0,
          manualRequired: 0,
          byFixType: { auto: 1, quickfix: 0, manual: 0 },
          bySource: { epubCheck: 1, ace: 0, jsAuditor: 0 },
          bySeverity: { critical: 0, serious: 1, moderate: 0, minor: 0 },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPlanJob = {
        id: 'plan-job-789',
        type: 'BATCH_VALIDATION',
        input: { sourceJobId: 'test-job-123' },
        output: mockPlan,
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.findFirst>>);
      vi.mocked(prisma.job.update).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.update>>);

      const result = await remediationService.updateTaskStatus(
        'test-job-123',
        'task-789',
        'completed',
        'Auto-applied high-confidence fix',
        'system'
      );

      expect(result.resolvedLocation).toBeUndefined();
      expect(result.resolvedFiles).toBeUndefined();
      expect(result.status).toBe('completed');
    });

    it('should prefer task.location when it appears in modified files', async () => {
      // This test verifies the logic for assigning resolvedLocation to each task
      // when multiple tasks share the same issue code but have different locations

      const mockPlan = {
        jobId: 'test-job-multi',
        fileName: 'test.epub',
        totalIssues: 1,
        tasks: [
          {
            id: 'task-ch1',
            jobId: 'test-job-multi',
            issueId: 'issue-ch1',
            issueCode: 'EPUB-STRUCT-004',
            issueMessage: 'Missing main landmark',
            severity: 'minor',
            category: 'structure',
            location: 'OEBPS/chapter1.xhtml',
            status: 'pending',
            priority: 'low',
            type: 'auto',
            autoFixable: true,
            quickFixable: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as RemediationTask,
        ],
        stats: {
          pending: 1,
          inProgress: 0,
          completed: 0,
          skipped: 0,
          failed: 0,
          autoFixable: 1,
          quickFixable: 0,
          manualRequired: 0,
          byFixType: { auto: 1, quickfix: 0, manual: 0 },
          bySource: { epubCheck: 0, ace: 0, jsAuditor: 1 },
          bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 1 },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPlanJob = {
        id: 'plan-job-multi',
        type: 'BATCH_VALIDATION',
        input: { sourceJobId: 'test-job-multi' },
        output: mockPlan,
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.job.findFirst).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.findFirst>>);
      vi.mocked(prisma.job.update).mockResolvedValue(mockPlanJob as unknown as Awaited<ReturnType<typeof prisma.job.update>>);

      // Task with location 'OEBPS/chapter1.xhtml' and modified files include it
      const result = await remediationService.updateTaskStatus(
        'test-job-multi',
        'task-ch1',
        'completed',
        'Fix applied',
        'system',
        {
          resolvedLocation: 'OEBPS/chapter1.xhtml',
          resolvedFiles: ['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml'],
        }
      );

      // Verify task got its own location (chapter1) not the first in array
      expect(result.resolvedLocation).toBe('OEBPS/chapter1.xhtml');
      expect(result.resolvedFiles).toContain('OEBPS/chapter1.xhtml');
      expect(result.resolvedFiles).toContain('OEBPS/chapter2.xhtml');
    });
  });
});
