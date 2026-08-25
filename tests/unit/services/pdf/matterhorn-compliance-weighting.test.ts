/**
 * PdfAuditService — Matterhorn compliance density-weighting
 *
 * Each of the 8 implemented checkpoints used to be zero-tolerance: one
 * issue anywhere in a category failed the whole checkpoint identically to
 * a category that's 100% broken, and "Overall Compliance" was just
 * passed/total — a flat count that can't distinguish "almost done" from
 * "barely started". These tests cover the new affectedPageRatio (per
 * checkpoint) and weightedCompliance (headline) calculations, accessed via
 * the service's private methods directly since there's no public seam and
 * a full end-to-end run would require mocking the entire validator stack.
 */
import { describe, it, expect } from 'vitest';
import { pdfAuditService, PdfValidationResult, MatterhornCheckResult } from '../../../../src/services/pdf/pdf-audit.service';
import { AuditIssue } from '../../../../src/services/audit/base-audit.service';

const service = pdfAuditService as unknown as {
  calculateAffectedPageRatio(issues: AuditIssue[], pageCount: number): number;
  generateMatterhornResults(validation: PdfValidationResult, pageCount: number): MatterhornCheckResult[];
  generateMatterhornSummary(results: MatterhornCheckResult[]): {
    totalCheckpoints: number;
    passed: number;
    failed: number;
    notApplicable: number;
    weightedCompliance: number;
    categories: Array<{ checkpoints: Array<{ status: string; completionRatio: number }> }>;
  };
};

function makeIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return { id: `issue-${Math.random()}`, source: 'test', severity: 'serious', code: 'TEST', message: 'test', ...overrides };
}

function emptyValidation(): PdfValidationResult {
  return {
    issues: [], structureIssues: [], altTextIssues: [], contrastIssues: [], tableIssues: [],
    linkIssues: [], formIssues: [], bookmarkIssues: [], matterhornResults: [], validatorErrors: [],
  };
}

describe('calculateAffectedPageRatio', () => {
  it('returns the fraction of unique pages touched by page-attributed issues', () => {
    const issues = [makeIssue({ pageNumber: 1 }), makeIssue({ pageNumber: 2 }), makeIssue({ pageNumber: 1 })];
    expect(service.calculateAffectedPageRatio(issues, 10)).toBeCloseTo(0.2); // pages {1,2} of 10
  });

  it('treats issues with no pageNumber as document-level (full document when any exist)', () => {
    const issues = [makeIssue({ pageNumber: undefined })];
    expect(service.calculateAffectedPageRatio(issues, 50)).toBe(1);
  });

  it('returns 0 for an empty issue list', () => {
    expect(service.calculateAffectedPageRatio([], 50)).toBe(0);
  });

  it('clamps at 1 even if unique pages somehow exceed pageCount', () => {
    const issues = [makeIssue({ pageNumber: 1 }), makeIssue({ pageNumber: 2 }), makeIssue({ pageNumber: 3 })];
    expect(service.calculateAffectedPageRatio(issues, 2)).toBe(1);
  });
});

describe('generateMatterhornResults — per-checkpoint affectedPageRatio', () => {
  it('gives a page-scoped checkpoint (alt text) a partial ratio when only some pages are affected', () => {
    const validation = emptyValidation();
    validation.altTextIssues = [makeIssue({ pageNumber: 1 }), makeIssue({ pageNumber: 2 })];
    const results = service.generateMatterhornResults(validation, 4);
    const altText = results.find(r => r.checkpointId === '13')!;
    expect(altText.passed).toBe(false);
    expect(altText.affectedPageRatio).toBeCloseTo(0.5);
  });

  it('gives a document-level checkpoint (tagged) a full ratio when failed', () => {
    const validation = emptyValidation();
    validation.structureIssues = [makeIssue({ code: 'PDF-UNTAGGED', pageNumber: undefined })];
    const results = service.generateMatterhornResults(validation, 50);
    const tagged = results.find(r => r.checkpointId === '01')!;
    expect(tagged.passed).toBe(false);
    expect(tagged.affectedPageRatio).toBe(1);
  });

  it('gives every checkpoint a 0 ratio on a fully clean document', () => {
    const results = service.generateMatterhornResults(emptyValidation(), 20);
    expect(results).toHaveLength(8);
    expect(results.every(r => r.passed && r.affectedPageRatio === 0)).toBe(true);
  });
});

describe('generateMatterhornSummary — weightedCompliance', () => {
  it('is 100 when every checkpoint passed', () => {
    const results = service.generateMatterhornResults(emptyValidation(), 20);
    const summary = service.generateMatterhornSummary(results);
    expect(summary.weightedCompliance).toBe(100);
    expect(summary.passed).toBe(8);
    expect(summary.failed).toBe(0);
  });

  it('matches the old passed/total ratio when checkpoints are either fully clean or fully broken', () => {
    const validation = emptyValidation();
    // Fail exactly 4 of 8 checkpoints completely (document-level, no pageNumber -> ratio 1).
    validation.structureIssues = [
      makeIssue({ code: 'PDF-UNTAGGED' }),           // checkpoint 01
      makeIssue({ code: 'PDF-NO-TITLE' }),            // checkpoint 07
      makeIssue({ code: 'PDF-NO-LANGUAGE' }),          // checkpoint 16
      makeIssue({ category: 'headings', code: 'HEADING-SKIP' }), // checkpoint 06
    ];
    const results = service.generateMatterhornResults(validation, 20);
    const summary = service.generateMatterhornSummary(results);
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(4);
    expect(summary.weightedCompliance).toBe(50); // same as the old passed/total in this all-or-nothing case
  });

  it('moves above the old passed/total floor when a failed checkpoint is only partially affected', () => {
    const validation = emptyValidation();
    // Alt-text fails, but only 1 of 20 pages is affected — mostly clean, not "barely started".
    validation.altTextIssues = [makeIssue({ pageNumber: 1 })];
    const results = service.generateMatterhornResults(validation, 20);
    const summary = service.generateMatterhornSummary(results);

    expect(summary.passed).toBe(7);
    expect(summary.failed).toBe(1);
    // Old-style compliance would report 7/8 = 87.5% -> 88; weighted should be higher
    // since the one failed checkpoint is 95% clean, not 0% clean.
    const oldStyleCompliance = Math.round((summary.passed / summary.totalCheckpoints) * 100);
    expect(summary.weightedCompliance).toBeGreaterThan(oldStyleCompliance);

    const altTextCategory = summary.categories.find(c => c.checkpoints.some(cp => cp.status === 'failed'))!;
    const altTextCheckpoint = altTextCategory.checkpoints.find(cp => cp.status === 'failed')!;
    expect(altTextCheckpoint.completionRatio).toBe(95); // 1 - (1/20) = 0.95 -> 95%
  });
});
