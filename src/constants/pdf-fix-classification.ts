/**
 * PDF Fix Classification Constants
 *
 * Categorizes PDF accessibility issues by fix type
 */

import { FixType } from '../types/pdf-remediation.types';

/**
 * Issues that can be automatically fixed without user intervention
 *
 * These are typically metadata-related issues that don't affect content
 */
export const AUTO_FIXABLE_CODES = new Set([
  // Actual validator codes - PDF/UA flags (fully automatic)
  'MATTERHORN-01-001',      // PDF not marked for accessibility (Marked flag)
  'MATTERHORN-01-002',      // DisplayDocTitle not set
  'MATTERHORN-01-005',      // Suspects flag not set correctly
]);

/**
 * Issues that require user input but can be fixed through guided workflow
 *
 * These require content decisions but don't need external PDF editing tools
 */
export const QUICK_FIXABLE_CODES = new Set<string>([
  // TEMPORARILY MOVED FROM AUTO_FIXABLE FOR TESTING QUICK-FIX UI
  // Legacy codes (from stub validators)
  'PDF-NO-LANGUAGE',        // Missing document language - user can specify
  'PDF-NO-TITLE',           // Missing document title - user can specify
  'PDF-NO-CREATOR',         // Missing creator metadata - user can specify

  // Actual validator codes - Document metadata
  'MATTERHORN-11-001',      // Document language not specified - user can specify
  'MATTERHORN-01-003',      // Document title missing - user can specify
  'WCAG-2.4.2',             // Document title not present - user can specify
]);

/**
 * Issues that require manual intervention in a PDF editor
 *
 * These are complex issues that can't be automatically fixed
 */
export const MANUAL_CODES = new Set([
  // Legacy codes (from stub validators)
  'PDF-UNTAGGED',           // Document is not tagged at all
  'PDF-READING-ORDER',      // Incorrect reading order
  'PDF-COMPLEX-TABLE',      // Complex table structure issues
  'PDF-CONTRAST-FAIL',      // Color contrast failures
  'PDF-MISSING-STRUCTURE',  // Missing structural tags
  'PDF-NESTED-STRUCTURE',   // Incorrect tag nesting
  'PDF-EMPTY-HEADING',      // Empty heading tags - requires structure manipulation
  'PDF-REDUNDANT-TAG',      // Redundant structure tags - requires tag tree editing

  // Metadata issues requiring tag tree creation
  'PDF-NO-METADATA',        // Missing MarkInfo - requires actual tag tree, not just flag
  'MATTERHORN-07-001',      // Metadata missing - requires StructTreeRoot creation

  // Actual validator codes - Structure
  'MATTERHORN-01-004',      // Suspect tag structure
  'MATTERHORN-09-004',      // Reading order not logical

  // Heading structure issues (require document restructuring)
  'HEADING-SKIP',           // Skipped heading levels
  'HEADING-MULTIPLE-H1',    // Multiple H1 headings
  'HEADING-IMPROPER-NESTING', // Improper heading hierarchy

  // Complex table issues (require manual table restructuring)
  'TABLE-ACCESSIBILITY',    // General table accessibility issues
  'TABLE-INACCESSIBLE',     // Table not properly structured
  'TABLE-COMPLEX-STRUCTURE', // Complex table structure
  'MATTERHORN-15-005',      // Table structure issues
  'TABLE-MISSING-SUMMARY',  // Table missing summary/caption - MOVED FROM QUICK_FIXABLE
  'TABLE-MISSING-HEADERS',  // Table missing header definitions - MOVED FROM QUICK_FIXABLE
  'MATTERHORN-15-002',      // Table without TH cells - MOVED FROM QUICK_FIXABLE
  'MATTERHORN-15-003',      // Table header not marked - MOVED FROM QUICK_FIXABLE

  // List structure issues
  'LIST-NOT-TAGGED',        // Lists in untagged PDF
  'LIST-IMPROPER-MARKUP',   // List not properly tagged

  // Contrast and visual issues
  'PDF-LOW-CONTRAST',       // Color contrast failures
  'CONTRAST-FAIL',          // Contrast ratio too low

  // Content issues requiring manual editing (moved from QUICK_FIXABLE)
  'PDF-IMAGE-NO-ALT',       // Images missing alt text
  'PDF-TABLE-NO-HEADERS',   // Tables missing header definitions
  'PDF-FORM-NO-LABEL',      // Form fields missing labels
  'PDF-LINK-NO-TEXT',       // Links with no descriptive text
  'PDF-FIGURE-NO-CAPTION',  // Figures missing captions
  'MATTERHORN-13-002',      // Image without alt text
  'MATTERHORN-13-003',      // Insufficient alt text
  'ALT-TEXT-QUALITY',       // Alt text quality issues
  'ALT-TEXT-REDUNDANT-PREFIX', // Redundant prefix in alt text
  'MATTERHORN-17-001',      // Link without text
  'MATTERHORN-19-006',      // Form field missing label
]);

/**
 * Classify an issue by its code to determine the fix type
 *
 * @param code - Issue code (e.g., "PDF-IMAGE-NO-ALT")
 * @returns Fix type classification
 */
export function classifyIssueType(code: string): FixType {
  if (AUTO_FIXABLE_CODES.has(code)) {
    return 'AUTO_FIXABLE';
  }
  if (QUICK_FIXABLE_CODES.has(code)) {
    return 'QUICK_FIX';
  }
  return 'MANUAL';
}

/**
 * Get human-readable description of fix type
 *
 * @param fixType - Fix type classification
 * @returns Description string
 */
export function getFixTypeDescription(fixType: FixType): string {
  switch (fixType) {
    case 'AUTO_FIXABLE':
      return 'Can be automatically fixed';
    case 'QUICK_FIX':
      return 'Requires user input through guided workflow';
    case 'MANUAL':
      return 'Requires manual intervention in PDF editor';
    default:
      return 'Unknown fix type';
  }
}

/**
 * Check if an issue code is valid
 *
 * @param code - Issue code to validate
 * @returns True if the code is recognized
 */
export function isValidIssueCode(code: string): boolean {
  return (
    AUTO_FIXABLE_CODES.has(code) ||
    QUICK_FIXABLE_CODES.has(code) ||
    MANUAL_CODES.has(code)
  );
}

/**
 * Get all issue codes by fix type
 *
 * @param fixType - Fix type to filter by
 * @returns Array of issue codes for that fix type
 */
export function getIssueCodesByType(fixType: FixType): string[] {
  switch (fixType) {
    case 'AUTO_FIXABLE':
      return Array.from(AUTO_FIXABLE_CODES);
    case 'QUICK_FIX':
      return Array.from(QUICK_FIXABLE_CODES);
    case 'MANUAL':
      return Array.from(MANUAL_CODES);
    default:
      return [];
  }
}
