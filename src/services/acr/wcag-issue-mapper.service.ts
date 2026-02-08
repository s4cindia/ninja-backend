/**
 * WCAG Issue Mapper Service
 * Maps EPUB audit issues (ACE rules) to WCAG success criteria
 */

export const RULE_TO_CRITERIA_MAP: Record<string, string[]> = {
  // ============= CUSTOM PLATFORM RULES =============
  // Resource errors (epubcheck)
  'RSC-001': [],
  'RSC-002': [],
  'RSC-005': [],
  'RSC-006': [],
  'RSC-007': [],
  'RSC-008': [],
  'RSC-010': [],
  'RSC-011': [],
  'RSC-012': [],
  'RSC-015': [],
  'RSC-016': [],
  'RSC-017': [],

  // Structure issues (js-auditor)
  'EPUB-STRUCT-001': ['1.3.1'],
  'EPUB-STRUCT-002': ['1.3.1'],
  'EPUB-STRUCT-003': ['1.3.1'],
  'EPUB-STRUCT-004': ['1.3.1'],
  'EPUB-IMG-001': ['1.1.1'],
  'EPUB-PAGE-001': ['2.4.5'],
  'EPUB-LANG-001': ['3.1.1'],
  'EPUB-TITLE-001': ['2.4.2'],
  
  // Metadata issues (js-auditor)
  'EPUB-META-001': ['3.1.1'],
  'EPUB-META-002': [],
  'EPUB-META-003': [],
  'EPUB-META-004': [],
  
  // Semantic issues (js-auditor)
  'EPUB-SEM-001': ['3.1.1', '3.1.2'],
  'EPUB-SEM-002': ['2.4.4'],
  
  // Navigation issues
  'EPUB-NAV-001': ['2.4.1'],
  
  // Figure issues
  'EPUB-FIG-001': ['1.1.1'],
  
  // EPUBCheck resource errors
  'RSC-003': [],

  // ============= STANDARD ACE RULES =============
  // Images and Non-text Content
  'img-alt': ['1.1.1'],
  'area-alt': ['1.1.1'],
  'input-image-alt': ['1.1.1'],
  'object-alt': ['1.1.1'],
  'svg-img-alt': ['1.1.1'],

  // Document Structure
  'html-has-lang': ['3.1.1'],
  'html-lang-valid': ['3.1.1'],
  'valid-lang': ['3.1.2'],

  // Heading Structure
  'heading-order': ['1.3.1', '2.4.6'],
  'empty-heading': ['1.3.1', '2.4.6'],
  'p-as-heading': ['1.3.1'],

  // Lists
  'list': ['1.3.1'],
  'listitem': ['1.3.1'],
  'definition-list': ['1.3.1'],

  // Tables
  'table-duplicate-name': ['1.3.1'],
  'td-headers-attr': ['1.3.1', '4.1.1'],
  'th-has-data-cells': ['1.3.1'],
  'layout-table': ['1.3.1'],
  'scope-attr-valid': ['1.3.1'],
  'td-has-header': ['1.3.1'],

  // Links
  'link-name': ['2.4.4', '4.1.2'],
  'link-in-text-block': ['1.4.1'],

  // Color and Contrast
  'color-contrast': ['1.4.3'],
  'color-contrast-enhanced': ['1.4.6'],
  'use-of-color': ['1.4.1'],

  // Forms
  'label': ['1.3.1', '3.3.2', '4.1.2'],
  'label-title-only': ['3.3.2'],
  'button-name': ['4.1.2'],
  'input-button-name': ['4.1.2'],
  'select-name': ['4.1.2'],
  'textarea-label': ['4.1.2'],

  // ARIA
  'aria-allowed-attr': ['4.1.2'],
  'aria-required-attr': ['4.1.2'],
  'aria-required-children': ['1.3.1', '4.1.2'],
  'aria-required-parent': ['1.3.1', '4.1.2'],
  'aria-roles': ['4.1.2'],
  'aria-valid-attr-value': ['4.1.2'],
  'aria-valid-attr': ['4.1.2'],
  'aria-hidden-focus': ['4.1.2'],

  // Page Title
  'document-title': ['2.4.2'],

  // Landmarks
  'landmark-one-main': ['1.3.1'],
  'landmark-no-duplicate-banner': ['1.3.1'],
  'landmark-no-duplicate-contentinfo': ['1.3.1'],
  'region': ['1.3.1'],

  // Keyboard
  'accesskeys': ['2.4.1'],
  'tabindex': ['2.4.3'],

  // Parsing
  'duplicate-id': ['4.1.1'],
  'duplicate-id-active': ['4.1.1'],
  'duplicate-id-aria': ['4.1.1'],

  // Bypass Blocks
  'bypass': ['2.4.1'],
  'skip-link': ['2.4.1'],

  // Page Language
  'meta-refresh': ['2.2.1', '2.2.4', '3.2.5'],
  'meta-viewport': ['1.4.4'],

  // Sensory Characteristics
  'audio-caption': ['1.2.2'],
  'video-caption': ['1.2.2'],
  'video-description': ['1.2.3', '1.2.5'],

  // Focus
  'focus-order-semantics': ['2.4.3'],

  // Consistent Navigation
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

export interface RemediatedIssue {
  ruleId: string;
  message: string;
  filePath: string;
  remediationInfo: {
    status: 'REMEDIATED';
    method: 'autofix' | 'quickfix' | 'manual';
    description: string;
    completedAt: string;
  };
}

export interface FixedModification {
  issueCode?: string;
  ruleId?: string;
  success?: boolean;
  method?: 'autofix' | 'quickfix' | 'manual';
  description?: string;
  completedAt?: string;
  targetFile?: string;
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

  /**
   * Maps fixed issues (from autoRemediation.modifications) to WCAG criteria
   * @param fixedModifications Array of successfully remediated modifications
   * @param allAuditIssues All audit issues (to get original issue details)
   * @returns Map of criterionId to array of RemediatedIssue
   */
  mapFixedIssuesToCriteria(
    fixedModifications: FixedModification[],
    allAuditIssues: AuditIssueInput[]
  ): Map<string, RemediatedIssue[]> {
    const criteriaMap = new Map<string, RemediatedIssue[]>();

    for (const modification of fixedModifications) {
      // Get the rule ID from either issueCode or ruleId field
      const ruleId = modification.issueCode || modification.ruleId;
      if (!ruleId) continue;

      // Map this rule to WCAG criteria
      const criteriaIds = RULE_TO_CRITERIA_MAP[ruleId] || [];
      if (criteriaIds.length === 0) continue;

      // Find the original issue to get message and details
      const originalIssue = allAuditIssues.find(issue =>
        issue.ruleId === ruleId || issue.ruleId.includes(ruleId)
      );

      const remediatedIssue: RemediatedIssue = {
        ruleId,
        message: originalIssue?.message || `Fixed issue: ${ruleId}`,
        filePath: modification.targetFile || originalIssue?.filePath || 'unknown',
        remediationInfo: {
          status: 'REMEDIATED',
          method: modification.method || 'autofix',
          description: modification.description || `Automatically fixed ${ruleId}`,
          completedAt: modification.completedAt || new Date().toISOString()
        }
      };

      // Add this remediated issue to all relevant criteria
      for (const criterionId of criteriaIds) {
        const existing = criteriaMap.get(criterionId) || [];
        existing.push(remediatedIssue);
        criteriaMap.set(criterionId, existing);
      }
    }

    return criteriaMap;
  }
}

export const wcagIssueMapperService = new WcagIssueMapperService();
