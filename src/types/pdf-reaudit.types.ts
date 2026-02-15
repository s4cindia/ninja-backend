/**
 * PDF Re-Audit Types
 *
 * Type definitions for PDF re-audit and comparison functionality.
 * Implements Phase 3 BE-T1 requirements for before/after comparison.
 */

import { AuditIssue } from '../services/audit/base-audit.service';

/**
 * Result of re-auditing and comparing a remediated PDF
 */
export interface ReauditComparisonResult {
  success: boolean;
  jobId: string;
  originalAuditId: string;
  reauditId: string;
  fileName: string;
  comparison: IssueComparison;
  metrics: SuccessMetrics;
  remediatedFileUrl?: string;
  error?: string;
}

/**
 * Categorized comparison of issues before and after remediation
 */
export interface IssueComparison {
  /** Issues that were in original audit but not in re-audit (fixed) */
  resolved: AuditIssue[];

  /** Issues that appear in both original and re-audit (not fixed) */
  remaining: AuditIssue[];

  /** Issues that were NOT in original but appear in re-audit (new problems) */
  regressions: AuditIssue[];
}

/**
 * Success metrics for remediation effectiveness
 */
export interface SuccessMetrics {
  /** Total issues in original audit */
  totalOriginal: number;

  /** Total issues in re-audit */
  totalNew: number;

  /** Number of resolved issues */
  resolvedCount: number;

  /** Number of remaining issues */
  remainingCount: number;

  /** Number of regression issues */
  regressionCount: number;

  /** Percentage of issues resolved (0-100) */
  resolutionRate: number;

  /** Number of critical issues resolved */
  criticalResolved: number;

  /** Number of critical issues remaining */
  criticalRemaining: number;

  /** Breakdown of issues by severity */
  severityBreakdown: {
    critical: { resolved: number; remaining: number };
    serious: { resolved: number; remaining: number };
    moderate: { resolved: number; remaining: number };
    minor: { resolved: number; remaining: number };
  };
}

/**
 * Request payload for re-audit endpoint
 */
export interface ReauditRequest {
  jobId: string;
  file: Express.Multer.File;
}
