/**
 * PDF Remediation Types
 *
 * TypeScript interfaces and types for PDF remediation workflow
 */

/**
 * Remediation plan containing all tasks needed to fix accessibility issues
 */
export interface RemediationPlan {
  /** Job ID this plan belongs to */
  jobId: string;
  /** Name of the PDF file being remediated */
  fileName: string;
  /** Total number of accessibility issues found */
  totalIssues: number;
  /** Number of issues that can be automatically fixed */
  autoFixableCount: number;
  /** Number of issues requiring quick fixes (guided workflow) */
  quickFixCount: number;
  /** Number of issues requiring manual intervention */
  manualFixCount: number;
  /** List of remediation tasks */
  tasks: RemediationTask[];
  /** When the plan was created */
  createdAt: Date;
}

/**
 * Individual remediation task for a specific issue
 */
export interface RemediationTask {
  /** Unique task identifier */
  id: string;
  /** Reference to the accessibility issue ID */
  issueId: string;
  /** Issue code (e.g., "PDF-IMAGE-NO-ALT") */
  issueCode: string;
  /** Human-readable description of the issue */
  description: string;
  /** Severity level (critical, serious, moderate, minor) */
  severity: string;
  /** Type of fix required */
  type: FixType;
  /** Current status of the task */
  status: TaskStatus;
  /** File path where the issue was found */
  filePath?: string;
  /** Specific location within the file */
  location?: string;
}

/**
 * Task completion status
 */
export type TaskStatus =
  | 'PENDING'       // Not started
  | 'IN_PROGRESS'   // Currently being worked on
  | 'COMPLETED'     // Successfully fixed
  | 'FAILED'        // Fix attempt failed
  | 'SKIPPED';      // User chose to skip

/**
 * Type of fix required for an issue
 */
export type FixType =
  | 'AUTO_FIXABLE'  // Can be automatically fixed by the system
  | 'QUICK_FIX'     // Requires user input through guided workflow
  | 'MANUAL';       // Requires manual intervention in PDF editor

/**
 * Summary statistics for a remediation plan
 */
export interface RemediationSummary {
  /** Total number of tasks */
  total: number;
  /** Tasks by status */
  byStatus: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  /** Tasks by type */
  byType: {
    autoFixable: number;
    quickFix: number;
    manual: number;
  };
  /** Overall completion percentage (0-100) */
  completionPercentage: number;
}

/**
 * Request to update task status
 */
export interface UpdateTaskStatusRequest {
  /** New status for the task */
  status: TaskStatus;
  /** Optional error message if status is FAILED */
  errorMessage?: string;
  /** Optional notes about the status change */
  notes?: string;
}

/**
 * Response after updating task status
 */
export interface UpdateTaskStatusResponse {
  /** Updated task */
  task: RemediationTask;
  /** Updated plan summary */
  summary: RemediationSummary;
}
