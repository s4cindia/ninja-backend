/**
 * Tests for PDF Verification Service
 *
 * Tests verification of remediation fixes by checking PDF metadata
 * and confirming issues were resolved.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pdfVerificationService } from '../../../../src/services/pdf/pdf-verification.service';
import { pdfRemediationService } from '../../../../src/services/pdf/pdf-remediation.service';
import type { RemediationPlan, RemediationTask } from '../../../../src/types/pdf-remediation.types';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'fs/promises';

// Mock dependencies
vi.mock('../../../../src/services/pdf/pdf-remediation.service');
vi.mock('fs/promises');
vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('PdfVerificationService', () => {
  let mockPdfBuffer: Buffer;
  let mockRemediationPlan: RemediationPlan;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPdfBuffer = Buffer.from('pdf-content');

    mockRemediationPlan = {
      jobId: 'job-123',
      fileName: 'test.pdf',
      totalIssues: 4,
      autoFixableCount: 4,
      quickFixCount: 0,
      manualFixCount: 0,
      tasks: [
        createMockTask('task-1', 'PDF-NO-LANGUAGE', 'AUTO_FIXABLE', 'COMPLETED'),
        createMockTask('task-2', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED'),
        createMockTask('task-3', 'PDF-NO-METADATA', 'AUTO_FIXABLE', 'COMPLETED'),
        createMockTask('task-4', 'PDF-NO-CREATOR', 'AUTO_FIXABLE', 'COMPLETED'),
      ],
      createdAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('verifyRemediation', () => {
    it('should verify all completed tasks successfully', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);

      // Mock PDFDocument.load to return mock with verified metadata
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: {
          lookup: vi.fn().mockReturnValue({ value: 'en' }), // Language exists
          context: { obj: vi.fn((name: string) => ({ name })) },
        },
        getTitle: vi.fn().mockReturnValue('Test Document'),
        getAuthor: vi.fn().mockReturnValue('Test Author'),
        getSubject: vi.fn().mockReturnValue('Test Subject'),
        getCreator: vi.fn().mockReturnValue('Ninja Platform'),
      } as any);

      // Mock temp file operations
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.jobId).toBe('job-123');
      expect(result.totalTasks).toBe(4);
      expect(result.verifiedFixed).toBe(4);
      expect(result.stillBroken).toBe(0);
      expect(result.unverified).toBe(0);
      expect(result.taskResults).toHaveLength(4);
    });

    it('should identify tasks that are still broken', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockRemediationPlan);

      // Mock PDFDocument.load to return mock WITHOUT language
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: {
          lookup: vi.fn().mockReturnValue(null), // Language missing
          context: { obj: vi.fn((name: string) => ({ name })) },
        },
        getTitle: vi.fn().mockReturnValue('Test Document'),
        getAuthor: vi.fn().mockReturnValue('Test Author'),
        getSubject: vi.fn().mockReturnValue('Test Subject'),
        getCreator: vi.fn().mockReturnValue('Ninja Platform'),
      } as any);

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.verifiedFixed).toBe(3); // Title, metadata, creator verified
      expect(result.stillBroken).toBe(1); // Language still broken

      const brokenTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-LANGUAGE');
      expect(brokenTask?.stillPresent).toBe(true);
      expect(brokenTask?.wasFixed).toBe(false);

      // Should update task status to FAILED
      expect(pdfRemediationService.updateTaskStatus).toHaveBeenCalledWith(
        'job-123',
        'task-1',
        expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringContaining('still present'),
        })
      );
    });

    it('should handle plan not found', async () => {
      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(null);

      await expect(
        pdfVerificationService.verifyRemediation(mockPdfBuffer, 'job-999', 'test.pdf')
      ).rejects.toThrow('Remediation plan not found');
    });

    it('should skip non-completed tasks', async () => {
      const planWithPendingTasks = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'PDF-NO-LANGUAGE', 'AUTO_FIXABLE', 'PENDING'),
          createMockTask('task-2', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithPendingTasks);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: { lookup: vi.fn(), context: { obj: vi.fn() } },
        getTitle: vi.fn().mockReturnValue('Test'),
      } as any);

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      // Should only verify the COMPLETED task
      expect(result.totalTasks).toBe(1);
      expect(result.taskResults).toHaveLength(1);
      expect(result.taskResults[0].issueCode).toBe('PDF-NO-TITLE');
    });

    it('should skip non-AUTO_FIXABLE tasks', async () => {
      const planWithMixedTypes = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'PDF-NO-LANGUAGE', 'AUTO_FIXABLE', 'COMPLETED'),
          createMockTask('task-2', 'PDF-IMAGE-NO-ALT', 'QUICK_FIX', 'COMPLETED'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithMixedTypes);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: {
          lookup: vi.fn().mockReturnValue({ value: 'en' }),
          context: { obj: vi.fn() },
        },
      } as any);

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      // Should only verify AUTO_FIXABLE tasks
      expect(result.totalTasks).toBe(1);
      expect(result.taskResults[0].issueCode).toBe('PDF-NO-LANGUAGE');
    });

    it('should return early if no completed auto-fixable tasks', async () => {
      const planWithNoCompletedAutoFix = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'PDF-IMAGE-NO-ALT', 'QUICK_FIX', 'PENDING'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(planWithNoCompletedAutoFix);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      expect(result.totalTasks).toBe(0);
      expect(result.verifiedFixed).toBe(0);
      expect(result.taskResults).toHaveLength(0);
    });
  });

  describe('verifyLanguageFixed', () => {
    it('should verify language was added', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-LANGUAGE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: {
          lookup: vi.fn().mockReturnValue({ value: 'en' }), // Language present
          context: { obj: vi.fn() },
        },
      } as any);

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const langTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-LANGUAGE');
      expect(langTask?.wasFixed).toBe(true);
      expect(langTask?.stillPresent).toBe(false);
      expect(langTask?.verificationMethod).toBe('metadata');
    });

    it('should detect language still missing', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-LANGUAGE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        catalog: {
          lookup: vi.fn().mockReturnValue(null), // Language missing
          context: { obj: vi.fn() },
        },
      } as any);

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const langTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-LANGUAGE');
      expect(langTask?.wasFixed).toBe(false);
      expect(langTask?.stillPresent).toBe(true);
    });
  });

  describe('verifyTitleFixed', () => {
    it('should verify title was added', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue('Test Document'),
      } as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const titleTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-TITLE');
      expect(titleTask?.wasFixed).toBe(true);
      expect(titleTask?.stillPresent).toBe(false);
    });

    it('should detect title still missing', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue(undefined),
      } as any);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const titleTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-TITLE');
      expect(titleTask?.wasFixed).toBe(false);
      expect(titleTask?.stillPresent).toBe(true);
    });

    it('should reject empty title', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue(''),
      } as any);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const titleTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-TITLE');
      expect(titleTask?.wasFixed).toBe(false);
    });
  });

  describe('verifyMetadataFixed', () => {
    it('should verify metadata was added', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-METADATA', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue('Title'),
        getAuthor: vi.fn().mockReturnValue('Author'),
        getSubject: vi.fn().mockReturnValue('Subject'),
      } as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const metaTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-METADATA');
      expect(metaTask?.wasFixed).toBe(true);
    });

    it('should accept partial metadata', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-METADATA', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue('Title'),
        getAuthor: vi.fn().mockReturnValue(undefined),
        getSubject: vi.fn().mockReturnValue(undefined),
      } as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const metaTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-METADATA');
      expect(metaTask?.wasFixed).toBe(true); // At least one field present
    });

    it('should detect metadata still missing', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-METADATA', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getTitle: vi.fn().mockReturnValue(undefined),
        getAuthor: vi.fn().mockReturnValue(undefined),
        getSubject: vi.fn().mockReturnValue(undefined),
      } as any);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const metaTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-METADATA');
      expect(metaTask?.wasFixed).toBe(false);
      expect(metaTask?.stillPresent).toBe(true);
    });
  });

  describe('verifyCreatorFixed', () => {
    it('should verify creator was added', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-CREATOR', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getCreator: vi.fn().mockReturnValue('Ninja Platform'),
      } as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const creatorTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-CREATOR');
      expect(creatorTask?.wasFixed).toBe(true);
    });

    it('should detect creator still missing', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-CREATOR', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockResolvedValue({
        getCreator: vi.fn().mockReturnValue(undefined),
      } as any);

      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const creatorTask = result.taskResults.find(t => t.issueCode === 'PDF-NO-CREATOR');
      expect(creatorTask?.wasFixed).toBe(false);
      expect(creatorTask?.stillPresent).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle verification errors gracefully', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);
      vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('Load error'));
      vi.mocked(pdfRemediationService.updateTaskStatus).mockResolvedValue(undefined as any);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      // Verification methods catch errors internally and return false
      // So the task will be marked as stillBroken, not as having verification errors
      expect(result.taskResults).toHaveLength(1);
      expect(result.taskResults[0].wasFixed).toBe(false);
      expect(result.taskResults[0].stillPresent).toBe(true);
      expect(result.stillBroken).toBe(1);
    });

    it('should continue verification even if one task fails', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [
          createMockTask('task-1', 'PDF-NO-TITLE', 'AUTO_FIXABLE', 'COMPLETED'),
          createMockTask('task-2', 'PDF-NO-CREATOR', 'AUTO_FIXABLE', 'COMPLETED'),
        ],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);

      // First call fails, second succeeds
      let callCount = 0;
      vi.spyOn(PDFDocument, 'load').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First load failed');
        }
        return {
          getCreator: vi.fn().mockReturnValue('Ninja'),
        } as any;
      });

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      // Should have results for both tasks
      expect(result.taskResults).toHaveLength(2);
    });
  });

  describe('unknown issue codes', () => {
    it('should mark unknown issue codes as requiring manual verification', async () => {
      const mockPlan = {
        ...mockRemediationPlan,
        tasks: [createMockTask('task-1', 'PDF-UNKNOWN-ISSUE', 'AUTO_FIXABLE', 'COMPLETED')],
      };

      vi.mocked(pdfRemediationService.getRemediationPlan).mockResolvedValue(mockPlan);

      const result = await pdfVerificationService.verifyRemediation(
        mockPdfBuffer,
        'job-123',
        'test.pdf'
      );

      const unknownTask = result.taskResults[0];
      expect(unknownTask.verificationMethod).toBe('manual');
      expect(unknownTask.notes).toContain('Manual verification required');
      expect(result.unverified).toBe(1);
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
