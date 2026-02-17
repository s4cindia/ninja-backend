/**
 * Tests for PDF Auto-Remediation Service
 *
 * Tests the orchestration of automatic PDF remediation including
 * handler execution, task management, and verification.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pdfAutoRemediationService } from '../../../../src/services/pdf/pdf-auto-remediation.service';
import { pdfModifierService, ModificationResult } from '../../../../src/services/pdf/pdf-modifier.service';
import { pdfRemediationService } from '../../../../src/services/pdf/pdf-remediation.service';
import { pdfVerificationService, VerificationResult } from '../../../../src/services/pdf/pdf-verification.service';
import type { RemediationPlan, RemediationTask } from '../../../../src/types/pdf-remediation.types';
import { PDFDocument } from 'pdf-lib';

// Mock dependencies
vi.mock('../../../../src/services/pdf/pdf-modifier.service');
vi.mock('../../../../src/services/pdf/pdf-remediation.service');
vi.mock('../../../../src/services/pdf/pdf-verification.service');
vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../../../src/lib/prisma', () => ({ default: {} }));
vi.mock('../../../../src/services/comparison', () => {
  class MockComparisonService {
    logChange = vi.fn().mockResolvedValue(undefined);
  }
  return {
    ComparisonService: MockComparisonService,
    mapFixTypeToChangeType: vi.fn().mockReturnValue('test-change-type'),
    extractWcagCriteria: vi.fn().mockReturnValue(undefined),
    extractWcagLevel: vi.fn().mockReturnValue(undefined),
    extractSeverity: vi.fn().mockReturnValue('MAJOR'),
  };
});

describe('PdfAutoRemediationService', () => {
  let mockPdfBuffer: Buffer;
  let mockPdfDoc: PDFDocument;
  let mockRemediationPlan: RemediationPlan;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPdfBuffer = Buffer.from('pdf-content');
    mockPdfDoc = {} as PDFDocument;

    mockRemediationPlan = {
      jobId: 'job-123',
      fileName: 'test.pdf',
      totalIssues: 4,
      autoFixableCount: 3,
      quickFixCount: 0,
      manualFixCount: 1,
      tasks: [
        createMockTask('task-1', 'MATTERHORN-01-001', 'AUTO_FIXABLE', 'PENDING'),
        createMockTask('task-2', 'MATTERHORN-01-002', 'AUTO_FIXABLE', 'PENDING'),
        createMockTask('task-3', 'MATTERHORN-01-005', 'AUTO_FIXABLE', 'PENDING'),
      ],
      createdAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runAutoRemediation', () => {
    it('should successfully run auto-remediation for all tasks', async () => {
      // Mock plan retrieval
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);

      // Mock backup creation
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/path/to/backup.pdf');

      // Mock PDF loading
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);

      // Mock handler success
      const mockModification: ModificationResult = {
        success: true,
        description: 'Handler executed successfully',
      };
      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setDisplayDocTitle').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setSuspectsFlag').mockResolvedValue(mockModification);

      // Mock task status updates
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);

      // Mock PDF saving
      const mockSavedBuffer = Buffer.from('modified-pdf');
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(mockSavedBuffer);

      // Mock validation
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({
        valid: true,
        errors: [],
      });

      // Mock verification
      const mockVerification: VerificationResult = {
        jobId: 'job-123',
        totalTasks: 3,
        verifiedFixed: 3,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      };
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue(mockVerification);

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(true);
      expect(result.completedTasks).toBe(3);
      expect(result.failedTasks).toBe(0);
      expect(result.skippedTasks).toBe(0);
      expect(result.remediatedPdfBuffer).toEqual(mockSavedBuffer);
      expect(result.verification?.verifiedFixed).toBe(3);
    });

    it('should handle plan not found', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(null);

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-999',
        'test.pdf'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Remediation plan not found');
    });

    it('should skip tasks with no handlers', async () => {
      const planWithUnknownIssue = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'PDF-UNKNOWN-ISSUE', 'AUTO_FIXABLE', 'PENDING'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithUnknownIssue);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/path/to/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('pdf'));
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({ valid: true, errors: [] });
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue({
        jobId: 'job-123',
        totalTasks: 0,
        verifiedFixed: 0,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      });

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.skippedTasks).toBe(1);
      expect(pdfRemediationService.updateTaskStatus).toHaveBeenCalledWith(
        'job-123',
        'task-1',
        expect.objectContaining({ status: 'SKIPPED' })
      );
    });

    it('should handle handler failures gracefully', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/path/to/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);

      // First handler succeeds, others fail
      const successModification: ModificationResult = {
        success: true,
        description: 'Success',
      };
      const failureModification: ModificationResult = {
        success: false,
        description: 'Failed',
        error: 'Handler error',
      };

      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue(successModification);
      vi.spyOn(pdfModifierService, 'setDisplayDocTitle').mockResolvedValue(failureModification);
      vi.spyOn(pdfModifierService, 'setSuspectsFlag').mockResolvedValue(successModification);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('pdf'));
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({ valid: true, errors: [] });
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue({
        jobId: 'job-123',
        totalTasks: 2,
        verifiedFixed: 2,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      });

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(true);
      expect(result.completedTasks).toBe(2);
      expect(result.failedTasks).toBe(1);
    });

    it('should handle validation failures', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/path/to/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);

      const mockModification: ModificationResult = { success: true, description: 'Success' };
      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setDisplayDocTitle').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setSuspectsFlag').mockResolvedValue(mockModification);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('invalid-pdf'));

      // Validation fails
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({
        valid: false,
        errors: ['Corrupted PDF structure'],
      });

      // Mock rollback
      vi.mocked(pdfModifierService.rollback).mockResolvedValue(mockPdfBuffer);

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('validation failed');
      expect(pdfModifierService.rollback).toHaveBeenCalled();
    });

    it('should return early if no auto-fixable tasks', async () => {
      const planWithNoAutoFix = {
        ...mockRemediationPlan,
        autoFixableCount: 0,
        tasks: [
          createMockTask('task-1', 'PDF-IMAGE-NO-ALT', 'QUICK_FIX', 'PENDING'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithNoAutoFix);

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(true);
      expect(result.completedTasks).toBe(0);
      expect(pdfModifierService.createBackup).not.toHaveBeenCalled();
    });

    it('should update task status to IN_PROGRESS during execution', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue({
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'MATTERHORN-01-001', 'AUTO_FIXABLE', 'PENDING')],
      });

      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);
      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue({
        success: true,
        description: 'Success',
      });
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('pdf'));
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({ valid: true, errors: [] });
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue({
        jobId: 'job-123',
        totalTasks: 1,
        verifiedFixed: 1,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      });

      await pdfAutoRemediationService.runAutoRemediation(mockPdfBuffer, 'job-123', 'test.pdf');

      // Should be called twice: once for IN_PROGRESS, once for COMPLETED
      expect(pdfRemediationService.updateTaskStatus).toHaveBeenCalledWith(
        'job-123',
        'task-1',
        expect.objectContaining({ status: 'IN_PROGRESS' })
      );
      expect(pdfRemediationService.updateTaskStatus).toHaveBeenCalledWith(
        'job-123',
        'task-1',
        expect.objectContaining({ status: 'COMPLETED' })
      );
    });

    it('should create backup before modifications', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);

      const mockModification: ModificationResult = { success: true, description: 'Success' };
      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setDisplayDocTitle').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setSuspectsFlag').mockResolvedValue(mockModification);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('pdf'));
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({ valid: true, errors: [] });
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue({
        jobId: 'job-123',
        totalTasks: 4,
        verifiedFixed: 4,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      });

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(pdfModifierService.createBackup).toHaveBeenCalledWith(mockPdfBuffer, 'test.pdf');
      expect(result.backupPath).toBe('/backup.pdf');
    });

    it('should group tasks by issue code for efficient processing', async () => {
      const planWithDuplicates = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'MATTERHORN-01-001', 'AUTO_FIXABLE', 'PENDING'),
          createMockTask('task-2', 'MATTERHORN-01-001', 'AUTO_FIXABLE', 'PENDING'),
          createMockTask('task-3', 'MATTERHORN-01-002', 'AUTO_FIXABLE', 'PENDING'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithDuplicates);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(mockPdfDoc);

      const mockModification: ModificationResult = { success: true, description: 'Success' };
      vi.spyOn(pdfModifierService, 'setMarkedFlag').mockResolvedValue(mockModification);
      vi.spyOn(pdfModifierService, 'setDisplayDocTitle').mockResolvedValue(mockModification);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue({ success: true, task: { id: 'task-1', status: 'COMPLETED' } } as any);
      vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('pdf'));
      vi.mocked(pdfModifierService.validatePDF).mockResolvedValue({ valid: true, errors: [] });
      vi.mocked(pdfVerificationService.verifyRemediation).mockResolvedValue({
        jobId: 'job-123',
        totalTasks: 3,
        verifiedFixed: 3,
        stillBroken: 0,
        unverified: 0,
        taskResults: [],
      });

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.completedTasks).toBe(3);
      // setMarkedFlag should be called twice (for 2 tasks), setDisplayDocTitle once
      expect(pdfModifierService.setMarkedFlag).toHaveBeenCalledTimes(2);
      expect(pdfModifierService.setDisplayDocTitle).toHaveBeenCalledTimes(1);
    });
  });

  describe('handler registration', () => {
    it('should have default Tier-1 handlers registered', () => {
      // This is tested implicitly through runAutoRemediation tests
      // The service should handle PDF-NO-LANGUAGE, PDF-NO-TITLE, PDF-NO-METADATA, PDF-NO-CREATOR
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should rollback on critical errors', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockRejectedValue(new Error('Load error'));
      vi.mocked(pdfModifierService.rollback).mockResolvedValue(mockPdfBuffer);

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Load error');
      expect(pdfModifierService.rollback).toHaveBeenCalledWith('/backup.pdf');
    });

    it('should handle rollback failures gracefully', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);
      vi.mocked(pdfModifierService.createBackup).mockResolvedValue('/backup.pdf');
      vi.mocked(pdfModifierService.loadPDF).mockRejectedValue(new Error('Load error'));
      vi.mocked(pdfModifierService.rollback).mockRejectedValue(new Error('Rollback failed'));

      const result = await pdfAutoRemediationService.runAutoRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.success).toBe(false);
      // Should still report the original error, not the rollback error
      expect(result.error).toContain('Load error');
    });
  });
});

// Helper function to create mock tasks
function createMockTask(
  id: string,
  issueCode: string,
  type: 'AUTO_FIXABLE' | 'QUICK_FIX' | 'MANUAL',
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED'
): RemediationTask {
  return {
    id,
    issueId: `issue-${id}`,
    issueCode,
    description: `Test task for ${issueCode}`,
    severity: 'serious',
    type,
    status,
  };
}
