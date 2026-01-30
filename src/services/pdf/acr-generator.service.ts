/**
 * PDF ACR Generator Service
 *
 * Generates Accessibility Conformance Reports (ACR) from PDF audit results.
 * Implements US-PDF-3.1 requirements.
 */

import { logger } from '../../lib/logger';
import { AuditReport } from '../audit/base-audit.service';

/**
 * WCAG 2.1 conformance level
 */
export type ConformanceLevel = 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';

/**
 * WCAG Level (A, AA, AAA)
 */
export type WcagLevel = 'A' | 'AA' | 'AAA';

/**
 * Product information
 */
export interface ProductInfo {
  name: string;
  version: string;
  vendor: string;
  evaluationDate: string;
  evaluator: string;
}

/**
 * WCAG criterion result
 */
export interface WcagCriterionResult {
  criterion: string;
  name: string;
  level: WcagLevel;
  conformance: ConformanceLevel;
  remarks: string;
  issueCount: number;
}

/**
 * Section 508 result
 */
export interface Section508Result {
  section: string;
  description: string;
  conformance: ConformanceLevel;
  remarks: string;
  wcagMapping: string[];
}

/**
 * EN 301 549 result
 */
export interface EN301549Result {
  clause: string;
  description: string;
  conformance: ConformanceLevel;
  remarks: string;
  wcagMapping: string[];
}

/**
 * Complete ACR report
 */
export interface ACRReport {
  id: string;
  productInfo: ProductInfo;
  wcagResults: WcagCriterionResult[];
  section508Results?: Section508Result[];
  en301549Results?: EN301549Result[];
  summary: string;
  notes: string[];
  generatedAt: Date;
  overallConformance: {
    levelA: ConformanceLevel;
    levelAA: ConformanceLevel;
    levelAAA: ConformanceLevel;
  };
}

/**
 * WCAG 2.1 Criteria Database
 */
const WCAG_CRITERIA: Array<{
  criterion: string;
  name: string;
  level: WcagLevel;
  principle: string;
}> = [
  // Perceivable
  { criterion: '1.1.1', name: 'Non-text Content', level: 'A', principle: 'Perceivable' },
  { criterion: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', principle: 'Perceivable' },
  { criterion: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', principle: 'Perceivable' },
  { criterion: '1.2.3', name: 'Audio Description or Media Alternative (Prerecorded)', level: 'A', principle: 'Perceivable' },
  { criterion: '1.2.4', name: 'Captions (Live)', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.2.5', name: 'Audio Description (Prerecorded)', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.3.1', name: 'Info and Relationships', level: 'A', principle: 'Perceivable' },
  { criterion: '1.3.2', name: 'Meaningful Sequence', level: 'A', principle: 'Perceivable' },
  { criterion: '1.3.3', name: 'Sensory Characteristics', level: 'A', principle: 'Perceivable' },
  { criterion: '1.3.4', name: 'Orientation', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.3.5', name: 'Identify Input Purpose', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.1', name: 'Use of Color', level: 'A', principle: 'Perceivable' },
  { criterion: '1.4.2', name: 'Audio Control', level: 'A', principle: 'Perceivable' },
  { criterion: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.4', name: 'Resize Text', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.5', name: 'Images of Text', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.10', name: 'Reflow', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.11', name: 'Non-text Contrast', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.12', name: 'Text Spacing', level: 'AA', principle: 'Perceivable' },
  { criterion: '1.4.13', name: 'Content on Hover or Focus', level: 'AA', principle: 'Perceivable' },

  // Operable
  { criterion: '2.1.1', name: 'Keyboard', level: 'A', principle: 'Operable' },
  { criterion: '2.1.2', name: 'No Keyboard Trap', level: 'A', principle: 'Operable' },
  { criterion: '2.1.4', name: 'Character Key Shortcuts', level: 'A', principle: 'Operable' },
  { criterion: '2.2.1', name: 'Timing Adjustable', level: 'A', principle: 'Operable' },
  { criterion: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', principle: 'Operable' },
  { criterion: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', principle: 'Operable' },
  { criterion: '2.4.1', name: 'Bypass Blocks', level: 'A', principle: 'Operable' },
  { criterion: '2.4.2', name: 'Page Titled', level: 'A', principle: 'Operable' },
  { criterion: '2.4.3', name: 'Focus Order', level: 'A', principle: 'Operable' },
  { criterion: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', principle: 'Operable' },
  { criterion: '2.4.5', name: 'Multiple Ways', level: 'AA', principle: 'Operable' },
  { criterion: '2.4.6', name: 'Headings and Labels', level: 'AA', principle: 'Operable' },
  { criterion: '2.4.7', name: 'Focus Visible', level: 'AA', principle: 'Operable' },
  { criterion: '2.5.1', name: 'Pointer Gestures', level: 'A', principle: 'Operable' },
  { criterion: '2.5.2', name: 'Pointer Cancellation', level: 'A', principle: 'Operable' },
  { criterion: '2.5.3', name: 'Label in Name', level: 'A', principle: 'Operable' },
  { criterion: '2.5.4', name: 'Motion Actuation', level: 'A', principle: 'Operable' },

  // Understandable
  { criterion: '3.1.1', name: 'Language of Page', level: 'A', principle: 'Understandable' },
  { criterion: '3.1.2', name: 'Language of Parts', level: 'AA', principle: 'Understandable' },
  { criterion: '3.2.1', name: 'On Focus', level: 'A', principle: 'Understandable' },
  { criterion: '3.2.2', name: 'On Input', level: 'A', principle: 'Understandable' },
  { criterion: '3.2.3', name: 'Consistent Navigation', level: 'AA', principle: 'Understandable' },
  { criterion: '3.2.4', name: 'Consistent Identification', level: 'AA', principle: 'Understandable' },
  { criterion: '3.3.1', name: 'Error Identification', level: 'A', principle: 'Understandable' },
  { criterion: '3.3.2', name: 'Labels or Instructions', level: 'A', principle: 'Understandable' },
  { criterion: '3.3.3', name: 'Error Suggestion', level: 'AA', principle: 'Understandable' },
  { criterion: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', principle: 'Understandable' },

  // Robust
  { criterion: '4.1.1', name: 'Parsing', level: 'A', principle: 'Robust' },
  { criterion: '4.1.2', name: 'Name, Role, Value', level: 'A', principle: 'Robust' },
  { criterion: '4.1.3', name: 'Status Messages', level: 'AA', principle: 'Robust' },
];

/**
 * PDF ACR Generator Service
 */
class PdfAcrGeneratorService {
  /**
   * Generate ACR report from PDF audit results
   *
   * @param auditReport - Audit report from pdf-audit.service
   * @param productInfo - Product information
   * @returns Complete ACR report
   */
  async generateAcr(auditReport: AuditReport, productInfo: ProductInfo): Promise<ACRReport> {
    logger.info('[PdfAcrGenerator] Generating ACR report...');

    try {
      // Map issues to WCAG criteria
      const wcagResults = this.generateWcagResults(auditReport);

      // Calculate overall conformance
      const overallConformance = this.calculateOverallConformance(wcagResults);

      // Generate summary
      const summary = this.generateSummary(auditReport, wcagResults, overallConformance);

      // Generate notes
      const notes = this.generateNotes(auditReport);

      const acrReport: ACRReport = {
        id: `acr-${Date.now()}`,
        productInfo,
        wcagResults,
        summary,
        notes,
        generatedAt: new Date(),
        overallConformance,
      };

      logger.info(
        `[PdfAcrGenerator] ACR generated: ${wcagResults.length} criteria evaluated, ` +
        `Level A: ${overallConformance.levelA}, Level AA: ${overallConformance.levelAA}`
      );

      return acrReport;
    } catch (error) {
      logger.error('[PdfAcrGenerator] Failed to generate ACR:', error);
      throw error;
    }
  }

  /**
   * Generate WCAG criterion results from audit issues
   *
   * @param auditReport - Audit report
   * @returns Array of WCAG criterion results
   */
  private generateWcagResults(auditReport: AuditReport): WcagCriterionResult[] {
    const results: WcagCriterionResult[] = [];

    // Group issues by WCAG criteria
    const issuesByCriteria = new Map<string, typeof auditReport.issues>();

    for (const issue of auditReport.issues) {
      if (issue.wcagCriteria) {
        for (const criterion of issue.wcagCriteria) {
          if (!issuesByCriteria.has(criterion)) {
            issuesByCriteria.set(criterion, []);
          }
          issuesByCriteria.get(criterion)!.push(issue);
        }
      }
    }

    // Evaluate each WCAG criterion
    for (const criteriaInfo of WCAG_CRITERIA) {
      // Only include Level A and AA criteria
      if (criteriaInfo.level === 'AAA') {
        continue;
      }

      const issues = issuesByCriteria.get(criteriaInfo.criterion) || [];
      const conformance = this.determineConformance(issues);
      const remarks = this.generateRemarks(criteriaInfo.criterion, issues, conformance);

      results.push({
        criterion: criteriaInfo.criterion,
        name: criteriaInfo.name,
        level: criteriaInfo.level,
        conformance,
        remarks,
        issueCount: issues.length,
      });
    }

    return results;
  }

  /**
   * Determine conformance level based on issues
   *
   * @param issues - Array of issues for this criterion
   * @returns Conformance level
   */
  private determineConformance(issues: AuditReport['issues']): ConformanceLevel {
    if (issues.length === 0) {
      return 'Supports';
    }

    const hasCritical = issues.some(i => i.severity === 'critical');
    const hasSerious = issues.some(i => i.severity === 'serious');

    if (hasCritical || hasSerious) {
      return 'Does Not Support';
    }

    if (issues.length >= 4) {
      return 'Does Not Support';
    }

    if (issues.length >= 1) {
      return 'Partially Supports';
    }

    return 'Supports';
  }

  /**
   * Generate remarks for a criterion
   *
   * @param criterion - WCAG criterion
   * @param issues - Issues for this criterion
   * @param conformance - Conformance level
   * @returns Human-readable remarks
   */
  private generateRemarks(
    criterion: string,
    issues: AuditReport['issues'],
    conformance: ConformanceLevel
  ): string {
    if (conformance === 'Supports') {
      return 'The PDF document meets all requirements for this criterion. No issues detected.';
    }

    if (issues.length === 0) {
      return 'Not applicable to this PDF document.';
    }

    const remarks: string[] = [];

    // Add issue summary
    const severityCounts = {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
    };

    const severityParts: string[] = [];
    if (severityCounts.critical > 0) severityParts.push(`${severityCounts.critical} critical`);
    if (severityCounts.serious > 0) severityParts.push(`${severityCounts.serious} serious`);
    if (severityCounts.moderate > 0) severityParts.push(`${severityCounts.moderate} moderate`);
    if (severityCounts.minor > 0) severityParts.push(`${severityCounts.minor} minor`);

    remarks.push(`Found ${issues.length} issue(s): ${severityParts.join(', ')}.`);

    // Add specific issue examples (up to 3)
    const exampleIssues = issues.slice(0, 3);
    if (exampleIssues.length > 0) {
      remarks.push('Examples:');
      for (const issue of exampleIssues) {
        const location = issue.location ? ` (${issue.location})` : '';
        remarks.push(`- ${issue.message}${location}`);
      }
    }

    // Add remediation suggestion
    if (conformance === 'Does Not Support') {
      remarks.push('Immediate remediation required to meet this criterion.');
    } else if (conformance === 'Partially Supports') {
      remarks.push('Minor improvements recommended to fully support this criterion.');
    }

    return remarks.join(' ');
  }

  /**
   * Calculate overall conformance for each level
   *
   * @param wcagResults - WCAG criterion results
   * @returns Overall conformance by level
   */
  private calculateOverallConformance(wcagResults: WcagCriterionResult[]): {
    levelA: ConformanceLevel;
    levelAA: ConformanceLevel;
    levelAAA: ConformanceLevel;
  } {
    const levelA = wcagResults.filter(r => r.level === 'A');
    const levelAA = wcagResults.filter(r => r.level === 'AA');

    const calculateLevel = (results: WcagCriterionResult[]): ConformanceLevel => {
      if (results.length === 0) return 'Not Applicable';

      const hasDoesNotSupport = results.some(r => r.conformance === 'Does Not Support');
      if (hasDoesNotSupport) return 'Does Not Support';

      const hasPartiallySupports = results.some(r => r.conformance === 'Partially Supports');
      if (hasPartiallySupports) return 'Partially Supports';

      return 'Supports';
    };

    return {
      levelA: calculateLevel(levelA),
      levelAA: calculateLevel([...levelA, ...levelAA]),
      levelAAA: 'Not Applicable', // AAA not included in this evaluation
    };
  }

  /**
   * Generate summary text
   *
   * @param auditReport - Audit report
   * @param wcagResults - WCAG results
   * @param overallConformance - Overall conformance
   * @returns Summary text
   */
  private generateSummary(
    auditReport: AuditReport,
    wcagResults: WcagCriterionResult[],
    overallConformance: ACRReport['overallConformance']
  ): string {
    const parts: string[] = [];

    parts.push(`Accessibility audit of "${auditReport.fileName}" completed on ${new Date().toLocaleDateString()}.`);
    parts.push(`Overall accessibility score: ${auditReport.score}/100.`);
    parts.push(
      `Total issues found: ${auditReport.summary.total} ` +
      `(Critical: ${auditReport.summary.critical}, ` +
      `Serious: ${auditReport.summary.serious}, ` +
      `Moderate: ${auditReport.summary.moderate}, ` +
      `Minor: ${auditReport.summary.minor}).`
    );

    parts.push(`\nWCAG 2.1 Conformance:`);
    parts.push(`- Level A: ${overallConformance.levelA}`);
    parts.push(`- Level AA: ${overallConformance.levelAA}`);

    const criteriaCounts = {
      supports: wcagResults.filter(r => r.conformance === 'Supports').length,
      partiallySupports: wcagResults.filter(r => r.conformance === 'Partially Supports').length,
      doesNotSupport: wcagResults.filter(r => r.conformance === 'Does Not Support').length,
    };

    parts.push(
      `\nOut of ${wcagResults.length} applicable criteria: ` +
      `${criteriaCounts.supports} fully supported, ` +
      `${criteriaCounts.partiallySupports} partially supported, ` +
      `${criteriaCounts.doesNotSupport} not supported.`
    );

    return parts.join(' ');
  }

  /**
   * Generate notes for the report
   *
   * @param auditReport - Audit report
   * @returns Array of notes
   */
  private generateNotes(auditReport: AuditReport): string[] {
    const notes: string[] = [];

    notes.push('This report was automatically generated using PDF accessibility audit tools.');
    notes.push('Conformance levels are based on automated testing and may require manual verification.');
    notes.push(`Audit performed on: ${auditReport.auditedAt.toLocaleString()}`);

    if (auditReport.metadata) {
      const metadata = auditReport.metadata as Record<string, unknown>;
      const validatorErrors = metadata.validatorErrors as Array<{ validator: string; error: string }> | undefined;
      if (validatorErrors && validatorErrors.length > 0) {
        notes.push(
          `Warning: ${validatorErrors.length} validator(s) encountered errors during processing.`
        );
      }
    }

    return notes;
  }
}

export const pdfAcrGeneratorService = new PdfAcrGeneratorService();
