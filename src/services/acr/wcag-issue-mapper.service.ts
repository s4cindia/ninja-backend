/**
 * WCAG Issue Mapper Service
 * Maps EPUB audit issues (ACE rules) to WCAG success criteria
 */

export const RULE_TO_CRITERIA_MAP: Record<string, string[]> = {
  'img-alt': ['1.1.1'],
  'area-alt': ['1.1.1'],
  'input-image-alt': ['1.1.1'],
  'object-alt': ['1.1.1'],
  'svg-img-alt': ['1.1.1'],

  'html-has-lang': ['3.1.1'],
  'html-lang-valid': ['3.1.1'],
  'valid-lang': ['3.1.2'],

  'heading-order': ['1.3.1', '2.4.6'],
  'empty-heading': ['1.3.1', '2.4.6'],
  'p-as-heading': ['1.3.1'],

  'list': ['1.3.1'],
  'listitem': ['1.3.1'],
  'definition-list': ['1.3.1'],

  'table-duplicate-name': ['1.3.1'],
  'td-headers-attr': ['1.3.1', '4.1.1'],
  'th-has-data-cells': ['1.3.1'],
  'layout-table': ['1.3.1'],
  'scope-attr-valid': ['1.3.1'],
  'td-has-header': ['1.3.1'],

  'link-name': ['2.4.4', '4.1.2'],
  'link-in-text-block': ['1.4.1'],

  'color-contrast': ['1.4.3'],
  'color-contrast-enhanced': ['1.4.6'],
  'use-of-color': ['1.4.1'],

  'label': ['1.3.1', '3.3.2', '4.1.2'],
  'label-title-only': ['3.3.2'],
  'button-name': ['4.1.2'],
  'input-button-name': ['4.1.2'],
  'select-name': ['4.1.2'],
  'textarea-label': ['4.1.2'],

  'aria-allowed-attr': ['4.1.2'],
  'aria-required-attr': ['4.1.2'],
  'aria-required-children': ['1.3.1', '4.1.2'],
  'aria-required-parent': ['1.3.1', '4.1.2'],
  'aria-roles': ['4.1.2'],
  'aria-valid-attr-value': ['4.1.2'],
  'aria-valid-attr': ['4.1.2'],
  'aria-hidden-focus': ['4.1.2'],

  'document-title': ['2.4.2'],

  'landmark-one-main': ['1.3.1'],
  'landmark-no-duplicate-banner': ['1.3.1'],
  'landmark-no-duplicate-contentinfo': ['1.3.1'],
  'region': ['1.3.1'],

  'accesskeys': ['2.4.1'],
  'tabindex': ['2.4.3'],

  'duplicate-id': ['4.1.1'],
  'duplicate-id-active': ['4.1.1'],
  'duplicate-id-aria': ['4.1.1'],

  'bypass': ['2.4.1'],
  'skip-link': ['2.4.1'],

  'meta-refresh': ['2.2.1', '2.2.4', '3.2.5'],
  'meta-viewport': ['1.4.4'],

  'audio-caption': ['1.2.2'],
  'video-caption': ['1.2.2'],
  'video-description': ['1.2.3', '1.2.5'],

  'focus-order-semantics': ['2.4.3'],

  'identical-links-same-purpose': ['2.4.4'],
};

export interface IssueMapping {
  issueId: string;
  ruleId: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  filePath: string;
  location?: {
    startLine?: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
  };
  htmlSnippet?: string;
  xpath?: string;
}

export interface CriterionWithIssues {
  criterionId: string;
  issueCount: number;
  issues: IssueMapping[];
}

export interface AuditIssueInput {
  id: string;
  ruleId: string;
  impact: string;
  message: string;
  filePath: string;
  location?: unknown;
  htmlSnippet?: string | null;
  xpath?: string | null;
}

export class WcagIssueMapperService {
  mapIssuesToCriteria(auditIssues: AuditIssueInput[]): Map<string, IssueMapping[]> {
    const criteriaMap = new Map<string, IssueMapping[]>();

    for (const issue of auditIssues) {
      const criteriaIds = RULE_TO_CRITERIA_MAP[issue.ruleId] || [];

      const issueMapping: IssueMapping = {
        issueId: issue.id,
        ruleId: issue.ruleId,
        impact: issue.impact as 'critical' | 'serious' | 'moderate' | 'minor',
        message: issue.message,
        filePath: issue.filePath,
        location: issue.location ? (issue.location as IssueMapping['location']) : undefined,
        htmlSnippet: issue.htmlSnippet || undefined,
        xpath: issue.xpath || undefined,
      };

      for (const criterionId of criteriaIds) {
        const existing = criteriaMap.get(criterionId) || [];
        existing.push(issueMapping);
        criteriaMap.set(criterionId, existing);
      }
    }

    return criteriaMap;
  }

  getIssuesForCriterion(
    criterionId: string,
    auditIssues: AuditIssueInput[]
  ): IssueMapping[] {
    const criteriaMap = this.mapIssuesToCriteria(auditIssues);
    return criteriaMap.get(criterionId) || [];
  }

  getCriteriaSummary(auditIssues: AuditIssueInput[]): CriterionWithIssues[] {
    const criteriaMap = this.mapIssuesToCriteria(auditIssues);
    const summary: CriterionWithIssues[] = [];

    for (const [criterionId, issues] of criteriaMap.entries()) {
      summary.push({
        criterionId,
        issueCount: issues.length,
        issues,
      });
    }

    return summary.sort((a, b) => b.issueCount - a.issueCount);
  }

  hasCriterionIssues(criterionId: string, auditIssues: AuditIssueInput[]): boolean {
    const issues = this.getIssuesForCriterion(criterionId, auditIssues);
    return issues.length > 0;
  }
}

export const wcagIssueMapperService = new WcagIssueMapperService();
