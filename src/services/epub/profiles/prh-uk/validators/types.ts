/**
 * Shared types for PRH UK validators. Validators are pure functions over
 * pre-parsed EPUB inputs and return a list of `PrhValidatorIssue` objects
 * that the orchestrator translates into the audit pipeline's
 * `AccessibilityIssue` shape.
 */

import type { PrhIssueSeverity } from '../../../../../constants/prh-issue-codes';

export interface PrhValidatorIssue {
  /** PRH-* code from prh-issue-codes.ts. */
  code: string;
  severity: PrhIssueSeverity;
  /** WCAG criteria this maps to (may be empty for publisher-specific rules). */
  wcag: string[];
  /** Human-readable message shown in the UI. */
  message: string;
  /** Concrete remediation hint shown in the UI. */
  suggestion: string;
  /** File or location the issue applies to (e.g. 'package.opf'). */
  location: string;
}

/**
 * Inputs every PRH validator can read. Parsed once in the orchestrator so
 * each validator is cheap and pure.
 */
export interface PrhValidatorInput {
  /** Full OPF (package.opf) content as string. */
  opfContent: string;
  /** Path of the OPF inside the zip (e.g. 'EPUB/package.opf'). */
  opfPath: string;
}
