/**
 * BaseAuditService.calculateScore — document-size normalization
 *
 * The flat `100 - critical×15 - serious×8 - moderate×4 - minor×1` formula
 * floors at 0 with as few as ~7 critical issues, regardless of document
 * size — making it uninformative on any real-world document with hundreds
 * of issues. calculateScore now accepts an optional pageCount hint that
 * scales the deduction down for larger documents; omitting it reproduces
 * the exact original behavior.
 */
import { describe, it, expect } from 'vitest';
import { BaseAuditService, AuditIssue, AuditReport, ScoreBreakdown } from '../../../../src/services/audit/base-audit.service';

class TestAuditService extends BaseAuditService<string, AuditIssue[]> {
  protected async parse(filePath: string): Promise<string> {
    return filePath;
  }

  protected async validate(_parsed: string): Promise<AuditIssue[]> {
    return [];
  }

  protected async generateReport(validation: AuditIssue[], jobId: string, fileName: string): Promise<AuditReport> {
    const scoreBreakdown = this.calculateScore(validation);
    return {
      jobId,
      fileName,
      score: scoreBreakdown.score,
      scoreBreakdown,
      issues: validation,
      summary: this.calculateSummary(validation),
      wcagMappings: [],
      metadata: {},
      auditedAt: new Date(),
    };
  }

  public testCalculateScore(issues: AuditIssue[], sizeHint?: { pageCount?: number }): ScoreBreakdown {
    return this.calculateScore(issues, sizeHint);
  }
}

function makeIssue(severity: AuditIssue['severity'], id: string): AuditIssue {
  return { id, source: 'test', severity, code: 'TEST', message: 'test issue' };
}

function makeCriticalIssues(count: number): AuditIssue[] {
  return Array.from({ length: count }, (_, i) => makeIssue('critical', `crit-${i}`));
}

describe('BaseAuditService.calculateScore — size normalization', () => {
  const service = new TestAuditService();

  it('scores a clean document at 100 with no size hint', () => {
    const result = service.testCalculateScore([]);
    expect(result.score).toBe(100);
    expect(result.normalizedBy).toBeUndefined();
  });

  it('floors at 0 with 7 critical issues and no size hint (original behavior, unchanged)', () => {
    const result = service.testCalculateScore(makeCriticalIssues(7));
    expect(result.totalDeduction).toBe(105);
    expect(result.score).toBe(0);
    expect(result.normalizedBy).toBeUndefined();
  });

  it('does not floor the same 7 critical issues on a 100-page document', () => {
    const result = service.testCalculateScore(makeCriticalIssues(7), { pageCount: 100 });
    // scaleFactor = max(1, 100/10) = 10 -> totalDeduction = 105/10 = 10.5
    expect(result.normalizedBy).toEqual({ pageCount: 100, scaleFactor: 10 });
    expect(result.totalDeduction).toBeCloseTo(10.5);
    expect(result.score).toBe(90);
  });

  it('leaves small documents (<=10 pages) numerically identical to the unhinted formula', () => {
    const withHint = service.testCalculateScore(makeCriticalIssues(7), { pageCount: 5 });
    const withoutHint = service.testCalculateScore(makeCriticalIssues(7));
    expect(withHint.score).toBe(withoutHint.score);
    expect(withHint.totalDeduction).toBe(withoutHint.totalDeduction);
    expect(withHint.normalizedBy).toEqual({ pageCount: 5, scaleFactor: 1 });
  });

  it('scales individual severity deductions consistently with totalDeduction', () => {
    const result = service.testCalculateScore(makeCriticalIssues(7), { pageCount: 100 });
    expect(result.deductions.critical.count).toBe(7);
    expect(result.deductions.critical.points).toBeCloseTo(10.5);
    expect(result.deductions.serious.points + result.deductions.moderate.points + result.deductions.minor.points).toBe(0);
  });

  it('ignores a zero or missing page count (falls back to unnormalized behavior)', () => {
    const result = service.testCalculateScore(makeCriticalIssues(7), { pageCount: 0 });
    expect(result.normalizedBy).toBeUndefined();
    expect(result.score).toBe(0);
  });
});
