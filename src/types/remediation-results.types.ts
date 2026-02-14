/**
 * Shared TypeScript types for EPUB Remediation Results
 * Used by both backend and frontend for type safety
 */

/**
 * Audit coverage information showing what percentage of files were scanned
 */
export interface AuditCoverage {
  /** Total number of content files (XHTML/HTML) in the EPUB */
  totalFiles: number;
  /** Number of files that were scanned during audit */
  filesScanned: number;
  /** Percentage of files scanned (0-100) */
  percentage: number;
  /** Breakdown of files by category */
  fileCategories: {
    /** Front matter files (cover, title page, copyright, TOC, etc.) */
    frontMatter: number;
    /** Chapter files */
    chapters: number;
    /** Back matter files (acknowledgments, appendix, glossary, etc.) */
    backMatter: number;
  };
}

/**
 * Detailed remediation results returned by the API
 */
export interface RemediationResultDetails {
  /** Number of issues found in original audit */
  originalIssues: number;
  /** Number of issues that were fixed */
  fixedIssues: number;
  /** Number of new issues discovered during re-audit */
  newIssues: number;
  /** Total number of issues remaining */
  remainingIssues: number;
  /** Audit coverage information */
  auditCoverage: AuditCoverage;
  /** List of remaining issues with details */
  remainingIssuesList?: RemainingIssue[];
}

/**
 * Information about a remaining issue
 */
export interface RemainingIssue {
  /** Issue code (e.g., "EPUB-STRUCT-004") */
  code: string;
  /** Severity level */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** Human-readable description of the issue */
  message: string;
  /** File path where the issue was found (optional) */
  filePath?: string;
  /** Location within the file (optional) */
  location?: string;
  /** Whether this is a new issue discovered in re-audit */
  isNew?: boolean;
}

/**
 * Complete API response for remediation results
 */
export interface RemediationApiResponse {
  /** Whether remediation was successful (true = no remaining issues) */
  success: boolean;
  /** Human-readable status message */
  message: string;
  /** Detailed remediation data */
  data: RemediationResultDetails;
  /** Raw result from remediation service (for backward compatibility) */
  rawResult?: unknown;
}

/**
 * Before/After comparison data
 */
export interface RemediationComparison {
  before: {
    score: number;
    issuesCount: number;
    filesScanned: number;
  };
  after: {
    score: number;
    issuesCount: number;
    filesScanned: number;
  };
  improvement: {
    scoreChange: number;
    issuesFixed: number;
    newIssuesFound: number;
  };
}
