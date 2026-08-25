/**
 * BaseAuditService.calculateScore — page-density-based deduction
 *
 * The flat `100 - critical×15 - serious×8 - moderate×4 - minor×1` formula
 * floors at 0 with as few as ~7 critical issues, regardless of document
 * size or how concentrated those issues are — making it uninformative on
 * any real-world document with hundreds of issues. With a pageCount hint,
 * calculateScore now deducts based on what FRACTION of pages are affected
 * per severity (affectedPageRatio × weight × 10), not raw issue count —
 * consistent with the same density approach used for Matterhorn
 * compliance. Omitting the hint reproduces the exact original flat-count
 * behavior.
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

function makeIssue(severity: AuditIssue['severity'], id: string, pageNumber?: number): AuditIssue {
  return { id, source: 'test', severity, code: 'TEST', message: 'test issue', pageNumber };
}

/** N critical issues, each on its own page starting at page 1 — no clustering. */
function spreadCriticalIssues(count: number): AuditIssue[] {
  return Array.from({ length: count }, (_, i) => makeIssue('critical', `crit-${i}`, i + 1));
}

describe('BaseAuditService.calculateScore', () => {
  const service = new TestAuditService();

  it('scores a clean document at 100 with no size hint', () => {
    const result = service.testCalculateScore([]);
    expect(result.score).toBe(100);
    expect(result.normalizedBy).toBeUndefined();
  });

  it('floors at 0 with 7 critical issues and no size hint (original flat-count behavior, unchanged)', () => {
    const result = service.testCalculateScore(spreadCriticalIssues(7));
    expect(result.totalDeduction).toBe(105);
    expect(result.score).toBe(0);
    expect(result.normalizedBy).toBeUndefined();
  });

  it('does not floor 7 critical issues spread across a 100-page document', () => {
    const result = service.testCalculateScore(spreadCriticalIssues(7), { pageCount: 100 });
    // affectedPageRatio = 7/100 = 0.07 -> deduction = 0.07 * 15 * 10 = 10.5
    expect(result.normalizedBy).toEqual({
      pageCount: 100,
      affectedPageRatios: { critical: 0.07, serious: 0, moderate: 0, minor: 0 },
    });
    expect(result.totalDeduction).toBeCloseTo(10.5);
    expect(result.score).toBe(90);
  });

  it('scores the same issue count as less severe when concentrated on one page than when spread across many', () => {
    const concentrated = Array.from({ length: 7 }, (_, i) => makeIssue('critical', `crit-${i}`, 1));
    const spread = spreadCriticalIssues(7);

    const concentratedResult = service.testCalculateScore(concentrated, { pageCount: 50 });
    const spreadResult = service.testCalculateScore(spread, { pageCount: 50 });

    expect(concentratedResult.totalDeduction).toBeLessThan(spreadResult.totalDeduction);
    expect(concentratedResult.score).toBeGreaterThan(spreadResult.score);
  });

  it('still floors when a severity genuinely affects every page (honest worst case)', () => {
    const everyPage = Array.from({ length: 20 }, (_, i) => makeIssue('critical', `crit-${i}`, i + 1));
    const result = service.testCalculateScore(everyPage, { pageCount: 20 });
    // affectedPageRatio = 20/20 = 1 -> deduction = 1 * 15 * 10 = 150
    expect(result.normalizedBy?.affectedPageRatios.critical).toBe(1);
    expect(result.score).toBe(0);
  });

  it('keeps per-severity deduction points consistent with totalDeduction', () => {
    const result = service.testCalculateScore(spreadCriticalIssues(7), { pageCount: 100 });
    expect(result.deductions.critical.count).toBe(7);
    expect(result.deductions.critical.points).toBeCloseTo(10.5);
    expect(result.deductions.serious.points + result.deductions.moderate.points + result.deductions.minor.points).toBe(0);
    expect(
      result.deductions.critical.points +
      result.deductions.serious.points +
      result.deductions.moderate.points +
      result.deductions.minor.points
    ).toBeCloseTo(result.totalDeduction);
  });

  it('ignores a zero or missing page count (falls back to flat-count behavior)', () => {
    const result = service.testCalculateScore(spreadCriticalIssues(7), { pageCount: 0 });
    expect(result.normalizedBy).toBeUndefined();
    expect(result.score).toBe(0);
  });

  it('treats document-level issues (no pageNumber) as affecting the whole document', () => {
    const documentLevel = [makeIssue('critical', 'no-title')]; // no pageNumber
    const result = service.testCalculateScore(documentLevel, { pageCount: 50 });
    expect(result.normalizedBy?.affectedPageRatios.critical).toBe(1);
    // 1 * 15 * 10 = 150 -> floors
    expect(result.score).toBe(0);
  });
});
