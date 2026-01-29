/**
 * BaseAuditService - Abstract base class for accessibility audits
 *
 * Provides shared audit logic for EPUB and PDF accessibility audits.
 * Implements the Template Method pattern for audit workflow.
 */

import { logger } from '../../lib/logger';

/**
 * Severity levels for accessibility issues
 */
export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/**
 * Common structure for accessibility issues across all audit types
 */
export interface AuditIssue {
  id: string;
  source: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria?: string[];
  location?: string;
  suggestion?: string;
  category?: string;
  element?: string;
  context?: string;
}

/**
 * Score breakdown with deduction details
 */
export interface ScoreBreakdown {
  score: number;
  formula: string;
  weights: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  deductions: {
    critical: { count: number; points: number };
    serious: { count: number; points: number };
    moderate: { count: number; points: number };
    minor: { count: number; points: number };
  };
  totalDeduction: number;
  maxScore: number;
}

/**
 * WCAG criteria mapping for an issue
 */
export interface WcagMapping {
  issueId: string;
  criteria: string[];
  level: 'A' | 'AA' | 'AAA';
  principle: 'Perceivable' | 'Operable' | 'Understandable' | 'Robust';
}

/**
 * Common audit report structure
 */
export interface AuditReport {
  jobId: string;
  fileName: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  issues: AuditIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  wcagMappings: WcagMapping[];
  metadata: Record<string, unknown>;
  auditedAt: Date;
}

/**
 * Abstract base class for audit services
 *
 * @template TParseResult - Type of the parsed file structure
 * @template TValidationResult - Type of the validation result
 */
export abstract class BaseAuditService<TParseResult, TValidationResult> {
  protected issueCounter = 0;

  /**
   * Parse the file and extract structure
   *
   * @param filePath - Path to the file to parse
   * @returns Parsed file structure
   */
  protected abstract parse(filePath: string): Promise<TParseResult>;

  /**
   * Validate the parsed structure and find accessibility issues
   *
   * @param parsed - Parsed file structure
   * @returns Validation result with issues
   */
  protected abstract validate(parsed: TParseResult): Promise<TValidationResult>;

  /**
   * Generate the final audit report from validation results
   *
   * @param validation - Validation results
   * @param jobId - Job ID for tracking
   * @param fileName - Name of the audited file
   * @returns Complete audit report
   */
  protected abstract generateReport(
    validation: TValidationResult,
    jobId: string,
    fileName: string
  ): Promise<AuditReport>;

  /**
   * Run the complete audit workflow
   *
   * Orchestrates: parse → validate → generate report
   *
   * @param filePath - Path to the file to audit
   * @param jobId - Job ID for tracking
   * @param fileName - Name of the file
   * @returns Complete audit report
   */
  public async runAudit(
    filePath: string,
    jobId: string,
    fileName: string
  ): Promise<AuditReport> {
    try {
      logger.info(`[BaseAudit] Starting audit for ${fileName} (job: ${jobId})`);

      // Reset issue counter for each audit
      this.issueCounter = 0;

      // Parse the file
      logger.info(`[BaseAudit] Parsing file...`);
      const parsed = await this.parse(filePath);
      logger.info(`[BaseAudit] File parsed successfully`);

      // Validate and find issues
      logger.info(`[BaseAudit] Validating...`);
      const validation = await this.validate(parsed);
      logger.info(`[BaseAudit] Validation complete`);

      // Generate report
      logger.info(`[BaseAudit] Generating report...`);
      const report = await this.generateReport(validation, jobId, fileName);
      logger.info(`[BaseAudit] Audit complete - Score: ${report.score}, Issues: ${report.issues.length}`);

      return report;
    } catch (error) {
      logger.error(`[BaseAudit] Audit failed for ${fileName}:`, error);
      throw error;
    }
  }

  /**
   * Calculate accessibility score with weighted deductions
   *
   * Uses standard weights:
   * - Critical: 15 points
   * - Serious: 8 points
   * - Moderate: 4 points
   * - Minor: 1 point
   *
   * @param issues - Array of audit issues
   * @returns Score breakdown with deductions
   */
  protected calculateScore(issues: AuditIssue[]): ScoreBreakdown {
    const weights = {
      critical: 15,
      serious: 8,
      moderate: 4,
      minor: 1,
    };

    const counts = {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
    };

    const deductions = {
      critical: { count: counts.critical, points: counts.critical * weights.critical },
      serious: { count: counts.serious, points: counts.serious * weights.serious },
      moderate: { count: counts.moderate, points: counts.moderate * weights.moderate },
      minor: { count: counts.minor, points: counts.minor * weights.minor },
    };

    const totalDeduction =
      deductions.critical.points +
      deductions.serious.points +
      deductions.moderate.points +
      deductions.minor.points;

    const score = Math.max(0, 100 - totalDeduction);

    logger.info(`[BaseAudit] Score calculation:`, {
      score,
      counts,
      totalDeduction,
    });

    return {
      score,
      formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
      weights,
      deductions,
      totalDeduction,
      maxScore: 100,
    };
  }

  /**
   * Map issues to WCAG 2.1 criteria
   *
   * @param issues - Array of audit issues
   * @returns Array of WCAG mappings
   */
  protected mapToWcag(issues: AuditIssue[]): WcagMapping[] {
    const mappings: WcagMapping[] = [];

    for (const issue of issues) {
      if (!issue.wcagCriteria || issue.wcagCriteria.length === 0) {
        continue;
      }

      // Determine WCAG level and principle from criteria
      const level = this.determineWcagLevel(issue.wcagCriteria);
      const principle = this.determineWcagPrinciple(issue.wcagCriteria);

      mappings.push({
        issueId: issue.id,
        criteria: issue.wcagCriteria,
        level,
        principle,
      });
    }

    return mappings;
  }

  /**
   * Determine WCAG conformance level from criteria strings
   *
   * @param criteria - Array of WCAG criteria (e.g., ["1.1.1", "2.4.4"])
   * @returns WCAG level (A, AA, or AAA)
   */
  private determineWcagLevel(criteria: string[]): 'A' | 'AA' | 'AAA' {
    // WCAG 2.1 Level mapping (simplified - can be extended)
    const levelAAA = ['1.2.6', '1.2.7', '1.2.8', '1.2.9', '1.4.6', '1.4.7', '2.1.3', '2.2.3', '2.2.4', '2.2.5', '2.3.2', '2.4.8', '2.4.9', '2.4.10', '2.5.5', '3.1.3', '3.1.4', '3.1.5', '3.1.6', '3.2.5', '3.3.5', '3.3.6'];
    const levelAA = ['1.2.4', '1.2.5', '1.4.3', '1.4.4', '1.4.5', '2.4.5', '2.4.6', '2.4.7', '3.1.2', '3.2.4', '3.3.3', '3.3.4'];

    for (const criterion of criteria) {
      if (levelAAA.includes(criterion)) {
        return 'AAA';
      }
      if (levelAA.includes(criterion)) {
        return 'AA';
      }
    }

    return 'A';
  }

  /**
   * Determine WCAG principle from criteria strings
   *
   * @param criteria - Array of WCAG criteria
   * @returns WCAG principle
   */
  private determineWcagPrinciple(criteria: string[]): 'Perceivable' | 'Operable' | 'Understandable' | 'Robust' {
    // WCAG principles based on first digit
    const firstCriterion = criteria[0];
    if (!firstCriterion) {
      return 'Perceivable';
    }

    const principleNum = parseInt(firstCriterion.charAt(0), 10);
    switch (principleNum) {
      case 1: return 'Perceivable';
      case 2: return 'Operable';
      case 3: return 'Understandable';
      case 4: return 'Robust';
      default: return 'Perceivable';
    }
  }

  /**
   * Create a new issue with auto-incremented ID
   *
   * @param data - Issue data without ID
   * @returns Complete issue with ID
   */
  protected createIssue(data: Omit<AuditIssue, 'id'>): AuditIssue {
    return {
      id: `issue-${++this.issueCounter}`,
      ...data,
    };
  }

  /**
   * Calculate summary counts by severity
   *
   * @param issues - Array of audit issues
   * @returns Summary with counts by severity
   */
  protected calculateSummary(issues: AuditIssue[]): AuditReport['summary'] {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }

  /**
   * Deduplicate issues based on key attributes
   *
   * @param issues - Array of issues that may contain duplicates
   * @returns Deduplicated array of issues
   */
  protected deduplicateIssues(issues: AuditIssue[]): AuditIssue[] {
    const seen = new Set<string>();
    const deduplicated: AuditIssue[] = [];

    for (const issue of issues) {
      const key = `${issue.source}-${issue.code}-${issue.location || ''}-${issue.message}`;

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(issue);
      }
    }

    logger.info(`[BaseAudit] Deduplication: ${issues.length} → ${deduplicated.length} issues`);

    return deduplicated;
  }
}
