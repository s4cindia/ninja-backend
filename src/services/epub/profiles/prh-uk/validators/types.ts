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

/** One XHTML file's content + path, surfaced to per-XHTML validators. */
export interface PrhXhtmlFile {
  path: string;
  content: string;
}

/** Inputs the per-XHTML validator reads — extends the OPF input. */
export interface PrhPerXhtmlInput extends PrhValidatorInput {
  /** dc:title from the OPF, if present. Used to flag generic page titles. */
  bookTitle: string | null;
  /** Every XHTML/HTML file in the EPUB. */
  xhtmlFiles: PrhXhtmlFile[];
}

/** Inputs the nav-doc validator reads — extends the OPF input. */
export interface PrhNavInput extends PrhValidatorInput {
  /** Full nav.xhtml content, or null if no nav doc was located. */
  navContent: string | null;
  /** Path of the nav doc inside the zip, or null. */
  navPath: string | null;
}
