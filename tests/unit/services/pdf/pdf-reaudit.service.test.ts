/**
 * PDF Re-Audit Service Tests
 *
 * Unit tests for PDF re-audit and comparison functionality.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pdfReauditService } from '../../../../src/services/pdf/pdf-reaudit.service';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { fileStorageService } from '../../../../src/services/storage/file-storage.service';
import prisma from '../../../../src/lib/prisma';
import { AuditIssue, AuditReport } from '../../../../src/services/audit/base-audit.service';

// Mock dependencies
vi.mock('../../../../src/services/pdf/pdf-audit.service');
vi.mock('../../../../src/services/storage/file-storage.service');
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Mock logger to suppress expected error logs during tests
vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('PdfReauditService', () => {
  // Test data setup
  const mockJobId = 'test-job-123';
  const mockFileName = 'test-document.pdf';
  const mockBuffer = Buffer.from('mock-pdf-content');

  const mockOriginalIssues: AuditIssue[] = [
    {
      id: 'issue-1',
      source: 'structure-validator',
      severity: 'critical',
      code: 'PDF-UNTAGGED',
      message: 'PDF is not tagged',
      wcagCriteria: ['1.3.1'],
      category: 'structure',
    },
    {
      id: 'issue-2',
      source: 'alt-text-validator',
      severity: 'critical',
      code: 'PDF-IMAGE-NO-ALT',
      message: 'Image missing alt text',
      wcagCriteria: ['1.1.1'],
      location: 'Page 1, Image img-1',
      pageNumber: 1,
      category: 'alt-text',
    },
    {
      id: 'issue-3',
      source: 'structure-validator',
      severity: 'serious',
      code: 'PDF-NO-TITLE',
      message: 'PDF has no title',
      wcagCriteria: ['2.4.2'],
      category: 'structure',
    },
    {
      id: 'issue-4',
      source: 'contrast-validator',
      severity: 'moderate',
      code: 'PDF-LOW-CONTRAST',
      message: 'Low contrast detected',
      wcagCriteria: ['1.4.3'],
      location: 'Page 2',
      pageNumber: 2,
      category: 'contrast',
    },
    {
      id: 'issue-5',
      source: 'table-validator',
      severity: 'minor',
      code: 'PDF-TABLE-INACCESSIBLE',
      message: 'Table not accessible',
      wcagCriteria: ['1.3.1'],
      location: 'Page 3, Table table-1',
      pageNumber: 3,
      category: 'table',
    },
  ];

  const mockOriginalAuditReport: AuditReport = {
    jobId: mockJobId,
    fileName: mockFileName,
    score: 45,
    scoreBreakdown: {
      score: 45,
      formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
      weights: { critical: 15, serious: 8, moderate: 4, minor: 1 },
      deductions: {
        critical: { count: 2, points: 30 },
        serious: { count: 1, points: 8 },
        moderate: { count: 1, points: 4 },
        minor: { count: 1, points: 1 },
      },
      totalDeduction: 43,
      maxScore: 100,
    },
    issues: mockOriginalIssues,
    summary: { critical: 2, serious: 1, moderate: 1, minor: 1, total: 5 },
    wcagMappings: [],
    metadata: {},
    auditedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reauditAndCompare', () => {
    it('should run re-audit and compare results successfully', async () => {
      // Setup: Original audit had 5 issues, new audit has 2 issues (3 resolved)
      const mockNewIssues: AuditIssue[] = [
        {
          id: 'new-issue-1',
          source: 'alt-text-validator',
          severity: 'critical',
          code: 'PDF-IMAGE-NO-ALT',
          message: 'Image missing alt text',
          wcagCriteria: ['1.1.1'],
          location: 'Page 1, Image img-1',
          pageNumber: 1,
          category: 'alt-text',
        },
        {
          id: 'new-issue-2',
          source: 'table-validator',
          severity: 'minor',
          code: 'PDF-TABLE-INACCESSIBLE',
          message: 'Table not accessible',
          wcagCriteria: ['1.3.1'],
          location: 'Page 3, Table table-1',
          pageNumber: 3,
          category: 'table',
        },
      ];

      const mockReauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: mockNewIssues,
        summary: { critical: 1, serious: 0, moderate: 0, minor: 1, total: 2 },
      };

      // Mock job lookup
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);

      // Mock re-audit
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(mockReauditReport);

      // Mock file storage
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      // Execute
      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Verify
      expect(result.success).toBe(true);
      expect(result.jobId).toBe(mockJobId);
      expect(result.comparison.resolved.length).toBe(3); // 3 issues fixed
      expect(result.comparison.remaining.length).toBe(2); // 2 issues still present
      expect(result.comparison.regressions.length).toBe(0); // No new issues
      expect(result.metrics.resolutionRate).toBe(60); // 3/5 = 60%
    });

    it('should identify resolved issues correctly', async () => {
      // Setup: Original has 5 issues, new has 2 issues
      const mockNewIssues: AuditIssue[] = [
        // Only remaining: issue-2 and issue-5
        mockOriginalIssues[1], // issue-2 (alt-text)
        mockOriginalIssues[4], // issue-5 (table)
      ];

      const mockReauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: mockNewIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(mockReauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      // Execute
      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Verify resolved issues
      expect(result.comparison.resolved.length).toBe(3);
      expect(result.comparison.resolved.map(i => i.code)).toEqual([
        'PDF-UNTAGGED',
        'PDF-NO-TITLE',
        'PDF-LOW-CONTRAST',
      ]);
    });

    it('should identify regressions (new issues introduced)', async () => {
      // Setup: Original has 3 issues, new has 5 issues (2 new regressions)
      const mockNewIssues: AuditIssue[] = [
        // 3 original issues remain
        mockOriginalIssues[0],
        mockOriginalIssues[1],
        mockOriginalIssues[2],
        // 2 new issues (regressions)
        {
          id: 'regression-1',
          source: 'structure-validator',
          severity: 'critical',
          code: 'PDF-HEADING-SKIPPED',
          message: 'Heading hierarchy broken',
          wcagCriteria: ['1.3.1'],
          category: 'structure',
        },
        {
          id: 'regression-2',
          source: 'contrast-validator',
          severity: 'serious',
          code: 'PDF-LOW-CONTRAST',
          message: 'New contrast issue',
          wcagCriteria: ['1.4.3'],
          location: 'Page 5',
          pageNumber: 5,
          category: 'contrast',
        },
      ];

      const mockReauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: mockNewIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(mockReauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      // Execute
      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Verify
      expect(result.comparison.resolved.length).toBe(2); // 2 fixed
      expect(result.comparison.remaining.length).toBe(3); // 3 still present
      expect(result.comparison.regressions.length).toBe(2); // 2 new issues
      expect(result.comparison.regressions.map(i => i.code)).toEqual([
        'PDF-HEADING-SKIPPED',
        'PDF-LOW-CONTRAST',
      ]);
    });

    it('should calculate success metrics correctly', async () => {
      // Setup: 10 original, 3 remaining = 70% resolution rate
      const originalIssues: AuditIssue[] = Array.from({ length: 10 }, (_, i) => ({
        id: `issue-${i + 1}`,
        source: 'test-validator',
        severity: i < 2 ? 'critical' : i < 5 ? 'serious' : 'moderate',
        code: `TEST-${i + 1}`,
        message: `Test issue ${i + 1}`,
        wcagCriteria: ['1.1.1'],
        category: 'test',
      })) as AuditIssue[];

      const newIssues: AuditIssue[] = [
        originalIssues[0], // 1 critical remains
        originalIssues[2], // 1 serious remains
        originalIssues[5], // 1 moderate remains
      ];

      const auditReport: AuditReport = {
        ...mockOriginalAuditReport,
        issues: originalIssues,
      };

      const reauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: newIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(reauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      // Execute
      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Verify metrics
      expect(result.metrics.totalOriginal).toBe(10);
      expect(result.metrics.totalNew).toBe(3);
      expect(result.metrics.resolvedCount).toBe(7);
      expect(result.metrics.remainingCount).toBe(3);
      expect(result.metrics.resolutionRate).toBe(70);
      expect(result.metrics.criticalResolved).toBe(1); // 2 critical - 1 remaining = 1 resolved
      expect(result.metrics.criticalRemaining).toBe(1);

      // The fresh report must be returned so callers can persist it as the
      // job's new auditReport — otherwise score/Matterhorn/issues would
      // stay stuck at the pre-remediation values forever.
      expect(result.reauditReport).toBe(reauditReport);
      expect(result.reauditReport?.issues).toBe(newIssues);
    });

    it('should handle job not found error', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue(null);

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.comparison.resolved.length).toBe(0);
      expect(result.comparison.remaining.length).toBe(0);
      expect(result.comparison.regressions.length).toBe(0);
      expect(result.reauditReport).toBeUndefined();
    });

    it('should handle missing audit report error', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: {}, // No auditReport
      } as any);

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No audit report found');
    });

    it('re-audits at the comprehensive scan level (not the basic default)', async () => {
      // Regression coverage: reauditAndCompare must not rely on
      // runAuditFromBuffer's own default ('basic'), which excludes 'contrast'
      // and several other validators — a fix whose validator isn't in 'basic'
      // would always misreport as resolved, since the validator that could
      // catch a lingering problem would never re-run.
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: [],
      });
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      await pdfReauditService.reauditAndCompare(mockJobId, mockBuffer, mockFileName);

      expect(pdfAuditService.runAuditFromBuffer).toHaveBeenCalledWith(
        mockBuffer,
        `${mockJobId}-reaudit`,
        mockFileName,
        'comprehensive',
        undefined,
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('writes page and validator progress into job.output.postRemediationProgress as the re-audit runs', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);
      vi.mocked(prisma.job.update).mockResolvedValue({} as any);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      // Simulate runAuditFromBuffer actually driving the progress callbacks
      // mid-run, the way the real implementation does.
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockImplementation(
        async (_buffer, _jobId, _fileName, _scanLevel, _customValidators, onProgress, onValidatorComplete) => {
          onProgress?.(207, 414);
          onValidatorComplete?.('Tables', 39, 4, 8);
          return { ...mockOriginalAuditReport, jobId: `${mockJobId}-reaudit`, issues: [] };
        }
      );

      await pdfReauditService.reauditAndCompare(mockJobId, mockBuffer, mockFileName);

      const progressWrites = vi.mocked(prisma.job.update).mock.calls
        .map(([args]) => (args.data as any).output?.postRemediationProgress)
        .filter(Boolean);

      expect(progressWrites).toContainEqual(
        expect.objectContaining({ currentPage: 207, totalPages: 414 })
      );
      expect(progressWrites).toContainEqual(
        expect.objectContaining({ completedValidators: 4, totalValidators: 8, currentValidator: 'Tables' })
      );
    });

    it('should handle re-audit failure gracefully', async () => {
      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: mockOriginalAuditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockRejectedValue(
        new Error('Re-audit failed')
      );

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Re-audit failed');
    });
  });

  describe('Issue matching algorithm', () => {
    it('should match issues by code and location (strict match)', async () => {
      const originalIssues: AuditIssue[] = [
        {
          id: 'orig-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Test issue',
          wcagCriteria: ['1.1.1'],
          location: 'Page 1, Element A',
          pageNumber: 1,
          category: 'test',
        },
      ];

      const newIssues: AuditIssue[] = [
        {
          id: 'new-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Test issue',
          wcagCriteria: ['1.1.1'],
          location: 'Page 1, Element A',
          pageNumber: 1,
          category: 'test',
        },
      ];

      const auditReport: AuditReport = {
        ...mockOriginalAuditReport,
        issues: originalIssues,
      };

      const reauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: newIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(reauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Should match by strict location
      expect(result.comparison.remaining.length).toBe(1);
      expect(result.comparison.resolved.length).toBe(0);
    });

    it('should handle issues with changed locations (fuzzy match)', async () => {
      // Scenario: Page reflow changed location but issue still exists
      const originalIssues: AuditIssue[] = [
        {
          id: 'orig-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Test issue',
          wcagCriteria: ['1.1.1'],
          location: 'Page 1, Element A',
          pageNumber: 1,
          category: 'test',
        },
      ];

      const newIssues: AuditIssue[] = [
        {
          id: 'new-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Test issue',
          wcagCriteria: ['1.1.1'],
          location: 'Page 2, Element A', // Location changed
          pageNumber: 2,
          category: 'test',
        },
      ];

      const auditReport: AuditReport = {
        ...mockOriginalAuditReport,
        issues: originalIssues,
      };

      const reauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: newIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(reauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Should match by code (fuzzy match) since location changed
      expect(result.comparison.remaining.length).toBe(1);
      expect(result.comparison.resolved.length).toBe(0);
    });

    it('does not cross-match two distinct same-code/same-severity issues that have different bounding boxes', async () => {
      // The bug this tier exists to prevent: the OLD code+severity-only
      // fallback would happily pair these up just because they share a
      // code and severity, even though they're two unrelated elements at
      // different positions -- silently crediting the wrong one as
      // "resolved" and hiding the other's true "regression" status.
      const originalIssues: AuditIssue[] = [
        {
          id: 'orig-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 1,
          // Realistic contrast-issue location string (always includes
          // rounded x/y, per pdf-contrast.validator.ts) -- distinct per
          // element, so tier 1's strict match correctly fails here rather
          // than falling through to isSameLocation's own "same page, no
          // location" degenerate case, which this test isn't about.
          location: 'Page 1 at (100, 100)',
          boundingBox: { x: 100, y: 100, width: 50, height: 12, pageWidth: 612, pageHeight: 792 },
        },
      ];

      const newIssues: AuditIssue[] = [
        {
          id: 'new-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 1,
          // Same code/severity/page, but a clearly different element (far away).
          location: 'Page 1 at (400, 600)',
          boundingBox: { x: 400, y: 600, width: 50, height: 12, pageWidth: 612, pageHeight: 792 },
        },
      ];

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: { ...mockOriginalAuditReport, issues: originalIssues } },
      } as any);
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({
        ...mockOriginalAuditReport, jobId: `${mockJobId}-reaudit`, issues: newIssues,
      });
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(mockJobId, mockBuffer, mockFileName);

      // The original issue was NOT found at its own position -> resolved.
      expect(result.comparison.resolved).toHaveLength(1);
      expect(result.comparison.resolved[0].id).toBe('orig-1');
      // The new issue is a genuinely different element -> a regression, not silently absorbed.
      expect(result.comparison.regressions).toHaveLength(1);
      expect(result.comparison.regressions[0].id).toBe('new-1');
      expect(result.comparison.remaining).toHaveLength(0);
    });

    it('matches by bounding-box position across a page-reflow page-number change', async () => {
      // Same element, same on-page geometry, but shifted to a different
      // page number (e.g. an earlier fix added a page) -- must still match.
      const originalIssues: AuditIssue[] = [
        {
          id: 'orig-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 5,
          boundingBox: { x: 100, y: 100, width: 50, height: 12, pageWidth: 612, pageHeight: 792 },
        },
      ];

      const newIssues: AuditIssue[] = [
        {
          id: 'new-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 6, // shifted by 1
          boundingBox: { x: 101, y: 99, width: 50, height: 12, pageWidth: 612, pageHeight: 792 }, // within tolerance
        },
      ];

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: { ...mockOriginalAuditReport, issues: originalIssues } },
      } as any);
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({
        ...mockOriginalAuditReport, jobId: `${mockJobId}-reaudit`, issues: newIssues,
      });
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(mockJobId, mockBuffer, mockFileName);

      expect(result.comparison.remaining).toHaveLength(1);
      expect(result.comparison.resolved).toHaveLength(0);
      expect(result.comparison.regressions).toHaveLength(0);
    });

    it('still falls back to code+severity matching when only one side has bounding-box data', async () => {
      // Mixed availability (e.g. an older audit report predating boundingBox
      // on this issue type) must not be treated as "compared and failed" --
      // tier 3 should still apply here, same as when neither side has one.
      const originalIssues: AuditIssue[] = [
        {
          id: 'orig-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 1,
          // No boundingBox on this side.
        },
      ];

      const newIssues: AuditIssue[] = [
        {
          id: 'new-1', source: 'test', severity: 'serious', code: 'PDF-LOW-CONTRAST',
          message: 'Low contrast', wcagCriteria: ['1.4.3'], pageNumber: 2,
          boundingBox: { x: 100, y: 100, width: 50, height: 12, pageWidth: 612, pageHeight: 792 },
        },
      ];

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport: { ...mockOriginalAuditReport, issues: originalIssues } },
      } as any);
      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({
        ...mockOriginalAuditReport, jobId: `${mockJobId}-reaudit`, issues: newIssues,
      });
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(mockJobId, mockBuffer, mockFileName);

      expect(result.comparison.remaining).toHaveLength(1);
      expect(result.comparison.resolved).toHaveLength(0);
      expect(result.comparison.regressions).toHaveLength(0);
    });
  });

  describe('Severity breakdown', () => {
    it('should break down metrics by severity correctly', async () => {
      const originalIssues: AuditIssue[] = [
        { id: '1', source: 'test', severity: 'critical', code: 'C1', message: '', wcagCriteria: [], category: 'test' },
        { id: '2', source: 'test', severity: 'critical', code: 'C2', message: '', wcagCriteria: [], category: 'test' },
        { id: '3', source: 'test', severity: 'serious', code: 'S1', message: '', wcagCriteria: [], category: 'test' },
        { id: '4', source: 'test', severity: 'serious', code: 'S2', message: '', wcagCriteria: [], category: 'test' },
        { id: '5', source: 'test', severity: 'moderate', code: 'M1', message: '', wcagCriteria: [], category: 'test' },
        { id: '6', source: 'test', severity: 'minor', code: 'MIN1', message: '', wcagCriteria: [], category: 'test' },
      ];

      const newIssues: AuditIssue[] = [
        // 1 critical remains
        { id: 'n1', source: 'test', severity: 'critical', code: 'C1', message: '', wcagCriteria: [], category: 'test' },
        // 1 serious remains
        { id: 'n2', source: 'test', severity: 'serious', code: 'S1', message: '', wcagCriteria: [], category: 'test' },
      ];

      const auditReport: AuditReport = {
        ...mockOriginalAuditReport,
        issues: originalIssues,
      };

      const reauditReport: AuditReport = {
        ...mockOriginalAuditReport,
        jobId: `${mockJobId}-reaudit`,
        issues: newIssues,
      };

      vi.mocked(prisma.job.findUnique).mockResolvedValue({
        id: mockJobId,
        output: { auditReport },
      } as any);

      vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue(reauditReport);
      vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('/path/to/remediated.pdf');

      const result = await pdfReauditService.reauditAndCompare(
        mockJobId,
        mockBuffer,
        mockFileName
      );

      // Verify severity breakdown
      expect(result.metrics.severityBreakdown).toEqual({
        critical: { resolved: 1, remaining: 1 }, // 2 total, 1 remaining = 1 resolved
        serious: { resolved: 1, remaining: 1 },  // 2 total, 1 remaining = 1 resolved
        moderate: { resolved: 1, remaining: 0 }, // 1 total, 0 remaining = 1 resolved
        minor: { resolved: 1, remaining: 0 },    // 1 total, 0 remaining = 1 resolved
      });
    });
  });
});
