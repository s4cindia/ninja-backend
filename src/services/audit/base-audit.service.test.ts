import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  BaseAuditService,
  AuditIssue,
  AuditReport,
  ScoreBreakdown,
  WcagMapping,
} from './base-audit.service';

/**
 * Concrete implementation for testing purposes
 */
class TestAuditService extends BaseAuditService<string, AuditIssue[]> {
  public parseResult: string | null = null;
  public validationResult: AuditIssue[] = [];
  public shouldThrowOnParse = false;
  public shouldThrowOnValidate = false;

  protected async parse(filePath: string): Promise<string> {
    if (this.shouldThrowOnParse) {
      throw new Error('Parse error');
    }
    return this.parseResult || `parsed:${filePath}`;
  }

  protected async validate(_parsed: string): Promise<AuditIssue[]> {
    if (this.shouldThrowOnValidate) {
      throw new Error('Validation error');
    }
    return this.validationResult;
  }

  protected async generateReport(
    validation: AuditIssue[],
    jobId: string,
    fileName: string
  ): Promise<AuditReport> {
    const scoreBreakdown = this.calculateScore(validation);
    const wcagMappings = this.mapToWcag(validation);

    return {
      jobId,
      fileName,
      score: scoreBreakdown.score,
      scoreBreakdown,
      issues: validation,
      summary: this.calculateSummary(validation),
      wcagMappings,
      metadata: {},
      auditedAt: new Date(),
    };
  }

  // Expose protected methods for testing
  public testCalculateScore(issues: AuditIssue[]): ScoreBreakdown {
    return this.calculateScore(issues);
  }

  public testMapToWcag(issues: AuditIssue[]): WcagMapping[] {
    return this.mapToWcag(issues);
  }

  public testCreateIssue(data: Omit<AuditIssue, 'id'>): AuditIssue {
    return this.createIssue(data);
  }

  public testCalculateSummary(issues: AuditIssue[]): AuditReport['summary'] {
    return this.calculateSummary(issues);
  }

  public testDeduplicateIssues(issues: AuditIssue[]): AuditIssue[] {
    return this.deduplicateIssues(issues);
  }
}

describe('BaseAuditService', () => {
  let service: TestAuditService;

  beforeEach(() => {
    service = new TestAuditService();
  });

  describe('runAudit', () => {
    it('should orchestrate parse, validate, and generateReport', async () => {
      service.parseResult = 'test-parsed-content';
      service.validationResult = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'serious',
          code: 'TEST-001',
          message: 'Test issue',
        },
      ];

      const result = await service.runAudit('/test/file.pdf', 'job-123', 'test.pdf');

      expect(result).toBeDefined();
      expect(result.jobId).toBe('job-123');
      expect(result.fileName).toBe('test.pdf');
      expect(result.issues).toHaveLength(1);
      expect(result.score).toBe(92); // 100 - (1 × 8)
    });

    it('should reset issue counter on each audit', async () => {
      service.validationResult = [];

      await service.runAudit('/test/file1.pdf', 'job-1', 'test1.pdf');
      const issue1 = service.testCreateIssue({
        source: 'test',
        severity: 'minor',
        code: 'TEST-001',
        message: 'Issue 1',
      });

      await service.runAudit('/test/file2.pdf', 'job-2', 'test2.pdf');
      const issue2 = service.testCreateIssue({
        source: 'test',
        severity: 'minor',
        code: 'TEST-002',
        message: 'Issue 2',
      });

      expect(issue1.id).toBe('issue-1');
      expect(issue2.id).toBe('issue-1'); // Counter reset
    });

    it('should throw error if parse fails', async () => {
      service.shouldThrowOnParse = true;

      await expect(
        service.runAudit('/test/file.pdf', 'job-123', 'test.pdf')
      ).rejects.toThrow('Parse error');
    });

    it('should throw error if validate fails', async () => {
      service.shouldThrowOnValidate = true;

      await expect(
        service.runAudit('/test/file.pdf', 'job-123', 'test.pdf')
      ).rejects.toThrow('Validation error');
    });
  });

  describe('calculateScore', () => {
    it('should return 100 for no issues', () => {
      const result = service.testCalculateScore([]);

      expect(result.score).toBe(100);
      expect(result.totalDeduction).toBe(0);
    });

    it('should deduct 15 points per critical issue', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Critical issue',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-002',
          message: 'Another critical',
        },
      ];

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(70); // 100 - (2 × 15)
      expect(result.deductions.critical.count).toBe(2);
      expect(result.deductions.critical.points).toBe(30);
    });

    it('should deduct 8 points per serious issue', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'serious',
          code: 'TEST-001',
          message: 'Serious issue',
        },
      ];

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(92); // 100 - 8
      expect(result.deductions.serious.count).toBe(1);
      expect(result.deductions.serious.points).toBe(8);
    });

    it('should deduct 4 points per moderate issue', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'moderate',
          code: 'TEST-001',
          message: 'Moderate issue',
        },
      ];

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(96); // 100 - 4
      expect(result.deductions.moderate.count).toBe(1);
      expect(result.deductions.moderate.points).toBe(4);
    });

    it('should deduct 1 point per minor issue', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'minor',
          code: 'TEST-001',
          message: 'Minor issue',
        },
      ];

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(99); // 100 - 1
      expect(result.deductions.minor.count).toBe(1);
      expect(result.deductions.minor.points).toBe(1);
    });

    it('should handle mixed severity issues', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Critical',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'serious',
          code: 'TEST-002',
          message: 'Serious',
        },
        {
          id: 'issue-3',
          source: 'test',
          severity: 'moderate',
          code: 'TEST-003',
          message: 'Moderate',
        },
        {
          id: 'issue-4',
          source: 'test',
          severity: 'minor',
          code: 'TEST-004',
          message: 'Minor',
        },
      ];

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(72); // 100 - 15 - 8 - 4 - 1 = 72
      expect(result.totalDeduction).toBe(28);
    });

    it('should not go below 0', () => {
      const issues: AuditIssue[] = Array.from({ length: 10 }, (_, i) => ({
        id: `issue-${i}`,
        source: 'test',
        severity: 'critical' as const,
        code: `TEST-${i}`,
        message: `Issue ${i}`,
      }));

      const result = service.testCalculateScore(issues);

      expect(result.score).toBe(0); // Would be -50, but capped at 0
      expect(result.totalDeduction).toBe(150); // 10 × 15
    });
  });

  describe('mapToWcag', () => {
    it('should return empty array for issues without WCAG criteria', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'serious',
          code: 'TEST-001',
          message: 'No WCAG',
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(0);
    });

    it('should map WCAG Level A criteria', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Missing alt text',
          wcagCriteria: ['1.1.1'],
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(1);
      expect(result[0].issueId).toBe('issue-1');
      expect(result[0].criteria).toEqual(['1.1.1']);
      expect(result[0].level).toBe('A');
      expect(result[0].principle).toBe('Perceivable');
    });

    it('should map WCAG Level AA criteria', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'serious',
          code: 'TEST-001',
          message: 'Low contrast',
          wcagCriteria: ['1.4.3'],
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('AA');
      expect(result[0].principle).toBe('Perceivable');
    });

    it('should map WCAG Level AAA criteria', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'moderate',
          code: 'TEST-001',
          message: 'Enhanced contrast issue',
          wcagCriteria: ['1.4.6'],
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('AAA');
      expect(result[0].principle).toBe('Perceivable');
    });

    it('should map different WCAG principles', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Perceivable',
          wcagCriteria: ['1.1.1'],
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'serious',
          code: 'TEST-002',
          message: 'Operable',
          wcagCriteria: ['2.1.1'],
        },
        {
          id: 'issue-3',
          source: 'test',
          severity: 'moderate',
          code: 'TEST-003',
          message: 'Understandable',
          wcagCriteria: ['3.1.1'],
        },
        {
          id: 'issue-4',
          source: 'test',
          severity: 'minor',
          code: 'TEST-004',
          message: 'Robust',
          wcagCriteria: ['4.1.1'],
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(4);
      expect(result[0].principle).toBe('Perceivable');
      expect(result[1].principle).toBe('Operable');
      expect(result[2].principle).toBe('Understandable');
      expect(result[3].principle).toBe('Robust');
    });

    it('should handle multiple WCAG criteria per issue', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Multiple criteria',
          wcagCriteria: ['1.1.1', '2.4.4', '4.1.2'],
        },
      ];

      const result = service.testMapToWcag(issues);

      expect(result).toHaveLength(1);
      expect(result[0].criteria).toEqual(['1.1.1', '2.4.4', '4.1.2']);
    });
  });

  describe('createIssue', () => {
    it('should auto-generate sequential IDs', () => {
      const issue1 = service.testCreateIssue({
        source: 'test',
        severity: 'minor',
        code: 'TEST-001',
        message: 'Issue 1',
      });

      const issue2 = service.testCreateIssue({
        source: 'test',
        severity: 'minor',
        code: 'TEST-002',
        message: 'Issue 2',
      });

      expect(issue1.id).toBe('issue-1');
      expect(issue2.id).toBe('issue-2');
    });

    it('should preserve all issue properties', () => {
      const issueData = {
        source: 'test',
        severity: 'critical' as const,
        code: 'TEST-001',
        message: 'Test message',
        wcagCriteria: ['1.1.1'],
        location: 'page-5',
        suggestion: 'Fix this',
        category: 'images',
        element: 'img',
        context: '<img src="test.jpg">',
      };

      const issue = service.testCreateIssue(issueData);

      expect(issue).toMatchObject(issueData);
      expect(issue.id).toBe('issue-1');
    });
  });

  describe('calculateSummary', () => {
    it('should return zero counts for empty array', () => {
      const result = service.testCalculateSummary([]);

      expect(result).toEqual({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
        total: 0,
      });
    });

    it('should count issues by severity', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Critical',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-002',
          message: 'Critical 2',
        },
        {
          id: 'issue-3',
          source: 'test',
          severity: 'serious',
          code: 'TEST-003',
          message: 'Serious',
        },
        {
          id: 'issue-4',
          source: 'test',
          severity: 'moderate',
          code: 'TEST-004',
          message: 'Moderate',
        },
        {
          id: 'issue-5',
          source: 'test',
          severity: 'minor',
          code: 'TEST-005',
          message: 'Minor',
        },
        {
          id: 'issue-6',
          source: 'test',
          severity: 'minor',
          code: 'TEST-006',
          message: 'Minor 2',
        },
      ];

      const result = service.testCalculateSummary(issues);

      expect(result).toEqual({
        critical: 2,
        serious: 1,
        moderate: 1,
        minor: 2,
        total: 6,
      });
    });
  });

  describe('deduplicateIssues', () => {
    it('should return same array if no duplicates', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Issue 1',
          location: 'page-1',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'serious',
          code: 'TEST-002',
          message: 'Issue 2',
          location: 'page-2',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(2);
      expect(result).toEqual(issues);
    });

    it('should remove exact duplicates', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Duplicate issue',
          location: 'page-1',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Duplicate issue',
          location: 'page-1',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('issue-1');
    });

    it('should keep issues with different sources', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'epubcheck',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Same issue',
          location: 'page-1',
        },
        {
          id: 'issue-2',
          source: 'ace',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Same issue',
          location: 'page-1',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(2);
    });

    it('should keep issues with different codes', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Same message',
          location: 'page-1',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-002',
          message: 'Same message',
          location: 'page-1',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(2);
    });

    it('should keep issues with different locations', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Same message',
          location: 'page-1',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'Same message',
          location: 'page-2',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(2);
    });

    it('should handle issues without location', () => {
      const issues: AuditIssue[] = [
        {
          id: 'issue-1',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'No location',
        },
        {
          id: 'issue-2',
          source: 'test',
          severity: 'critical',
          code: 'TEST-001',
          message: 'No location',
        },
      ];

      const result = service.testDeduplicateIssues(issues);

      expect(result).toHaveLength(1);
    });
  });
});
