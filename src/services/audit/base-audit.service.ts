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
 * Smart triage annotation — added by SmartTriageService after validation
 */
export interface IssueTriage {
  disposition: 'auto-resolved' | 'ai-drafted' | 'smart-guided' | 'manual';
  method: 'heuristic' | 'pattern' | 'llm' | 'vision';
  confidence: number;        // 0.0–1.0
  suppressedCount?: number;  // N issues this one replaces
  reclassifiedAs?: string;   // New code if reclassified (e.g., 'TOC-TAGGING')
  autoFix?: {
    description: string;
    value?: string;          // Generated alt text, language code, etc.
    requiresApproval: boolean;
  };
}

/**
 * Summary produced by SmartTriageService for the audit report
 */
export interface TriageSummary {
  version: '1.0';
  totalRaw: number;
  autoResolved: number;
  aiDrafted: number;
  smartGuided: number;
  manual: number;
  suppressedCategories: string[];
}

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
  pageNumber?: number;
  /** Matterhorn Protocol 1.1 condition ID (e.g. "13-001") */
  matterhornCheckpoint?: string;
  /** Testability designation from Matterhorn Protocol 1.1 */
  matterhornHow?: 'M' | 'H' | '--';
  triage?: IssueTriage;
  /**
   * Bounding box of the flagged element, in unscaled PDF points with a
   * TOP-LEFT origin (y grows downward) — the same convention produced by the
   * image/table/link extractors. Validators emitting this must convert any
   * bottom-left (raw PDF user-space / pdfjs) coordinates before populating it.
   */
  boundingBox?: { x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number };
  /**
   * Deterministic pixel-measured contrast data — populated only by PdfContrastValidator
   * for COLOR-CONTRAST issues. Lets downstream consumers (AI analysis) reuse the
   * already-computed measurement instead of re-estimating contrast visually.
   */
  contrastData?: {
    foreground: string;
    background: string;
    ratio: number;
    requiredRatio: number;
    isLargeText: boolean;
  };
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
  /** Present only when a size hint was supplied — the per-severity affected-page ratios the deduction was computed from. */
  normalizedBy?: {
    pageCount: number;
    affectedPageRatios: { critical: number; serious: number; moderate: number; minor: number };
  };
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
  triageSummary?: TriageSummary;
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
   * Continuous (0-1) measure of a document's "badness" for a set of
   * issues. Each page's own contribution saturates smoothly with its own
   * issue count — count / (count + PAGE_SATURATION) — rather than
   * snapping straight to 1 the instant it has any issue at all. That
   * matters for documents where a severity is spread across nearly every
   * page (e.g. missing alt-text on formulas throughout a math textbook):
   * a purely binary "does this page have ≥1 issue" measure can only move
   * once a page is fixed *completely*, so fixing some of a page's issues
   * without fully clearing it was invisible to the ratio. This version
   * gives partial credit for that — a page going from 20 issues to 10 is
   * real, visible progress, not nothing.
   *
   * PAGE_SATURATION=3 means a page needs a handful of issues before it's
   * considered "mostly bad" on its own (3 issues → 0.5 contribution, 12 →
   * 0.8) — a single issue on a page isn't treated as equivalent to a page
   * that's riddled with them.
   *
   * Issues without a pageNumber are document-level concerns (e.g. a
   * missing title) — those affect the whole document when any exist, since
   * there's no partial-title concept to give continuous credit for.
   */
  protected calculateAffectedPageRatio(issues: AuditIssue[], pageCount: number): number {
    const pageNumbers = issues
      .map(i => i.pageNumber)
      .filter((p): p is number => typeof p === 'number');

    if (pageNumbers.length === 0) {
      return issues.length > 0 ? 1 : 0;
    }

    const PAGE_SATURATION = 3;

    const countsByPage = new Map<number, number>();
    for (const p of pageNumbers) {
      countsByPage.set(p, (countsByPage.get(p) ?? 0) + 1);
    }

    let totalContribution = 0;
    for (const count of countsByPage.values()) {
      totalContribution += count / (count + PAGE_SATURATION);
    }

    return Math.min(1, totalContribution / Math.max(1, pageCount));
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
   * @param sizeHint - Optional document size (page count). Without it,
   *   deduction is a flat count × weight per severity — floors at 0 with
   *   as few as ~7 critical issues regardless of document size, which
   *   makes the score useless as a remediation-progress indicator on any
   *   real-world document with substantial content. With a page count,
   *   each severity's deduction is instead driven by what FRACTION of
   *   pages contain an issue of that severity (affectedPageRatio × weight
   *   × 10), not the raw count — a document where 5 critical issues sit
   *   on the same page is treated as less broken than one where 5 critical
   *   issues are spread across 5 different pages, and the deduction stays
   *   naturally bounded regardless of how many issues accumulate. The ×10
   *   multiplier is calibrated so "1 critical issue affecting 1 of 10
   *   pages" (the flat formula's original small-document intuition) still
   *   deducts 15 points either way.
   * @returns Score breakdown with deductions
   */
  protected calculateScore(issues: AuditIssue[], sizeHint?: { pageCount?: number }): ScoreBreakdown {
    const weights = {
      critical: 15,
      serious: 8,
      moderate: 4,
      minor: 1,
    };

    const bySeverity = {
      critical: issues.filter(i => i.severity === 'critical'),
      serious: issues.filter(i => i.severity === 'serious'),
      moderate: issues.filter(i => i.severity === 'moderate'),
      minor: issues.filter(i => i.severity === 'minor'),
    };

    const counts = {
      critical: bySeverity.critical.length,
      serious: bySeverity.serious.length,
      moderate: bySeverity.moderate.length,
      minor: bySeverity.minor.length,
    };

    const pageCount = sizeHint?.pageCount;
    const useDensity = !!pageCount && pageCount > 0;

    const affectedPageRatios = {
      critical: useDensity ? this.calculateAffectedPageRatio(bySeverity.critical, pageCount!) : 0,
      serious: useDensity ? this.calculateAffectedPageRatio(bySeverity.serious, pageCount!) : 0,
      moderate: useDensity ? this.calculateAffectedPageRatio(bySeverity.moderate, pageCount!) : 0,
      minor: useDensity ? this.calculateAffectedPageRatio(bySeverity.minor, pageCount!) : 0,
    };

    const pointsFor = (severity: keyof typeof weights): number =>
      useDensity
        ? affectedPageRatios[severity] * weights[severity] * 10
        : counts[severity] * weights[severity];

    const deductions = {
      critical: { count: counts.critical, points: pointsFor('critical') },
      serious: { count: counts.serious, points: pointsFor('serious') },
      moderate: { count: counts.moderate, points: pointsFor('moderate') },
      minor: { count: counts.minor, points: pointsFor('minor') },
    };

    const totalDeduction =
      deductions.critical.points +
      deductions.serious.points +
      deductions.moderate.points +
      deductions.minor.points;

    const score = Math.max(0, Math.round(100 - totalDeduction));

    logger.info(`[BaseAudit] Score calculation:`, {
      score,
      counts,
      totalDeduction,
      useDensity,
      affectedPageRatios: useDensity ? affectedPageRatios : undefined,
    });

    return {
      score,
      formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
      weights,
      deductions,
      totalDeduction,
      maxScore: 100,
      ...(useDensity ? { normalizedBy: { pageCount: pageCount!, affectedPageRatios } } : {}),
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
      // Use JSON.stringify to create unambiguous key that avoids collisions
      // when fields contain hyphens or other special characters
      const key = JSON.stringify([
        issue.source,
        issue.code,
        issue.matterhornCheckpoint || '',
        issue.pageNumber ?? '',
        issue.location || '',
        issue.boundingBox
          ? `${issue.boundingBox.x}:${issue.boundingBox.y}:${issue.boundingBox.width}:${issue.boundingBox.height}`
          : '',
        issue.message
      ]);

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(issue);
      }
    }

    logger.info(`[BaseAudit] Deduplication: ${issues.length} → ${deduplicated.length} issues`);

    return deduplicated;
  }
}
