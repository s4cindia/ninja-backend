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
  'PDF-NO-LANGUAGE',        // Missing document language
  'PDF-NO-TITLE',           // Missing document title
  'PDF-NO-METADATA',        // Missing accessibility metadata
  'PDF-NO-CREATOR',         // Missing creator metadata
  'PDF-EMPTY-HEADING',      // Empty heading tags
  'PDF-REDUNDANT-TAG',      // Redundant structure tags
]);

/**
 * Issues that require user input but can be fixed through guided workflow
 *
 * These require content decisions but don't need external PDF editing tools
 */
export const QUICK_FIXABLE_CODES = new Set([
  'PDF-IMAGE-NO-ALT',       // Images missing alt text
  'PDF-TABLE-NO-HEADERS',   // Tables missing header definitions
  'PDF-FORM-NO-LABEL',      // Form fields missing labels
  'PDF-LINK-NO-TEXT',       // Links with no descriptive text
  'PDF-FIGURE-NO-CAPTION',  // Figures missing captions
]);

/**
 * Issues that require manual intervention in a PDF editor
 *
 * These are complex issues that can't be automatically fixed
 */
export const MANUAL_CODES = new Set([
  'PDF-UNTAGGED',           // Document is not tagged at all
  'PDF-READING-ORDER',      // Incorrect reading order
  'PDF-COMPLEX-TABLE',      // Complex table structure issues
  'PDF-CONTRAST-FAIL',      // Color contrast failures
  'PDF-MISSING-STRUCTURE',  // Missing structural tags
  'PDF-NESTED-STRUCTURE',   // Incorrect tag nesting
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
