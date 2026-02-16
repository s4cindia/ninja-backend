/**
 * Maps issue/fix codes to human-readable change types
 *
 * @param fixCode - Issue code (e.g., 'EPUB-IMG-001', 'PDF-NO-LANGUAGE', 'MATTERHORN-01-001')
 * @returns Change type string (e.g., 'add-alt-text', 'add-language', 'set-marked-flag')
 * @example
 * mapFixTypeToChangeType('PDF-NO-LANGUAGE') // Returns 'add-language'
 * mapFixTypeToChangeType('MATTERHORN-01-001') // Returns 'set-marked-flag'
 */
export function mapFixTypeToChangeType(fixCode: string): string {
  const mappings: Record<string, string> = {
    // EPUB codes
    'EPUB-META-001': 'add-language',
    'EPUB-META-002': 'add-accessibility-features',
    'EPUB-META-003': 'add-accessibility-summary',
    'EPUB-META-004': 'add-access-modes',
    'EPUB-SEM-001': 'add-html-lang',
    'EPUB-SEM-002': 'fix-empty-link',
    'EPUB-SEM-003': 'add-aria-role',
    'EPUB-IMG-001': 'add-alt-text',
    'EPUB-STRUCT-002': 'add-table-headers',
    'EPUB-STRUCT-003': 'fix-heading-hierarchy',
    'EPUB-STRUCT-004': 'add-aria-landmarks',
    'EPUB-NAV-001': 'add-skip-navigation',
    'EPUB-FIG-001': 'add-figure-structure',
    'EPUB-CONTRAST-001': 'fix-color-contrast',
    'EPUB-TYPE-HAS-MATCHING-ROLE': 'add-aria-role',
    'COLOR-CONTRAST': 'fix-color-contrast',

    // PDF Auto-fixable codes
    'MATTERHORN-01-001': 'set-marked-flag',
    'MATTERHORN-01-002': 'set-display-doc-title',
    'MATTERHORN-01-005': 'set-suspects-flag',

    // PDF Quick-fix codes
    'PDF-NO-LANGUAGE': 'add-language',
    'PDF-NO-TITLE': 'add-title',
    'PDF-NO-CREATOR': 'add-creator',
    'PDF-NO-METADATA': 'add-metadata',
    'MATTERHORN-11-001': 'add-language',
    'MATTERHORN-01-003': 'add-title',
    'WCAG-2.4.2': 'add-title',
  };

  return mappings[fixCode] || fixCode.toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * Extracts WCAG success criterion number from issue/rule code
 *
 * @param ruleId - Issue or rule code
 * @returns WCAG criterion number (e.g., '1.1.1', '2.4.2', '3.1.1') or undefined
 * @example
 * extractWcagCriteria('PDF-NO-LANGUAGE') // Returns '3.1.1'
 * extractWcagCriteria('MATTERHORN-01-001') // Returns '1.3.1'
 * extractWcagCriteria('WCAG-2.4.2') // Returns '2.4.2' (extracted from code)
 */
export function extractWcagCriteria(ruleId: string): string | undefined {
  const wcagMappings: Record<string, string> = {
    // EPUB codes
    'EPUB-META-001': '3.1.1',
    'EPUB-META-002': '4.1.2',
    'EPUB-META-003': '4.1.2',
    'EPUB-META-004': '4.1.2',
    'EPUB-SEM-001': '3.1.1',
    'EPUB-SEM-002': '2.4.4',
    'EPUB-SEM-003': '4.1.2',
    'EPUB-IMG-001': '1.1.1',
    'EPUB-STRUCT-002': '1.3.1',
    'EPUB-STRUCT-003': '1.3.1',
    'EPUB-STRUCT-004': '1.3.1',
    'EPUB-NAV-001': '2.4.1',
    'EPUB-FIG-001': '1.1.1',
    'EPUB-CONTRAST-001': '1.4.3',
    'COLOR-CONTRAST': '1.4.3',

    // PDF Auto-fixable codes
    'MATTERHORN-01-001': '1.3.1', // Marked flag (Info and Relationships)
    'MATTERHORN-01-002': '2.4.2', // DisplayDocTitle
    'MATTERHORN-01-005': '1.3.1', // Suspects flag (Info and Relationships)

    // PDF Quick-fix codes
    'PDF-NO-LANGUAGE': '3.1.1',
    'PDF-NO-TITLE': '2.4.2',
    'PDF-NO-CREATOR': '4.1.2',
    'PDF-NO-METADATA': '1.3.1', // Metadata (Info and Relationships)
    'MATTERHORN-11-001': '3.1.1', // Document language
    'MATTERHORN-01-003': '2.4.2', // Document title
    'WCAG-2.4.2': '2.4.2', // Page titled
  };

  if (wcagMappings[ruleId]) {
    return wcagMappings[ruleId];
  }

  const wcagMatch = ruleId.match(/(\d+\.\d+\.\d+)/);
  if (wcagMatch) {
    return wcagMatch[1];
  }

  return undefined;
}

/**
 * Extracts WCAG conformance level from issue/rule code
 *
 * @param ruleId - Issue or rule code
 * @returns WCAG level ('A', 'AA', or 'AAA'), defaults to 'A' if unknown
 * @example
 * extractWcagLevel('EPUB-IMG-001') // Returns 'A'
 * extractWcagLevel('EPUB-CONTRAST-001') // Returns 'AA'
 */
export function extractWcagLevel(ruleId: string): string {
  const levelMappings: Record<string, string> = {
    // EPUB codes
    'EPUB-META-001': 'A',
    'EPUB-META-002': 'A',
    'EPUB-META-003': 'A',
    'EPUB-META-004': 'A',
    'EPUB-SEM-001': 'A',
    'EPUB-SEM-002': 'A',
    'EPUB-SEM-003': 'A',
    'EPUB-IMG-001': 'A',
    'EPUB-STRUCT-002': 'A',
    'EPUB-STRUCT-003': 'A',
    'EPUB-STRUCT-004': 'A',
    'EPUB-NAV-001': 'A',
    'EPUB-FIG-001': 'A',
    'EPUB-CONTRAST-001': 'AA',
    'COLOR-CONTRAST': 'AA',

    // PDF Auto-fixable codes
    'MATTERHORN-01-001': 'A', // Marked flag
    'MATTERHORN-01-002': 'A', // DisplayDocTitle
    'MATTERHORN-01-005': 'A', // Suspects flag

    // PDF Quick-fix codes
    'PDF-NO-LANGUAGE': 'A',
    'PDF-NO-TITLE': 'A',
    'PDF-NO-CREATOR': 'A',
    'PDF-NO-METADATA': 'A',
    'MATTERHORN-11-001': 'A', // Document language
    'MATTERHORN-01-003': 'A', // Document title
    'WCAG-2.4.2': 'A', // Page titled
  };

  return levelMappings[ruleId] || 'A';
}

/**
 * Extracts severity level for an issue/rule code
 *
 * Severity Classification Rationale:
 * - CRITICAL: Issues that completely break accessibility or PDF/UA compliance
 *   - Missing structure tree (MATTERHORN-01-001) - AT cannot navigate
 *   - Suspect elements (MATTERHORN-01-005) - structural integrity compromised
 *   - Missing alt text (EPUB-IMG-001) - images invisible to screen readers
 *
 * - MAJOR: Issues that significantly impact accessibility but don't prevent usage
 *   - Missing language (PDF-NO-LANGUAGE) - AT may use wrong pronunciation
 *   - Missing page title (WCAG-2.4.2) - navigation/orientation issues
 *   - Structural issues (heading hierarchy, landmarks) - navigation harder
 *
 * - MINOR: Issues that improve accessibility but have workarounds
 *   - DisplayDocTitle preference (MATTERHORN-01-002) - cosmetic
 *   - Creator metadata (PDF-NO-CREATOR) - informational only
 *   - Document title (PDF-NO-TITLE) - filename provides fallback
 *
 * @param ruleId - Issue or rule code
 * @returns Severity level ('CRITICAL', 'MAJOR', or 'MINOR'), defaults to 'MAJOR' if unknown
 * @example
 * extractSeverity('MATTERHORN-01-001') // Returns 'CRITICAL' - structure required
 * extractSeverity('PDF-NO-LANGUAGE') // Returns 'MAJOR' - impacts AT
 * extractSeverity('PDF-NO-TITLE') // Returns 'MINOR' - cosmetic improvement
 */
export function extractSeverity(ruleId: string): string {
  const severityMappings: Record<string, string> = {
    // PDF Auto-fixable codes (Critical - these break PDF/UA compliance)
    'MATTERHORN-01-001': 'CRITICAL', // Marked flag - PDF not tagged
    'MATTERHORN-01-005': 'CRITICAL', // Suspects flag - structural issues

    // PDF Auto-fixable codes (Minor - metadata improvements)
    'MATTERHORN-01-002': 'MINOR', // DisplayDocTitle - UI preference

    // PDF Quick-fix codes (Major - important accessibility)
    'PDF-NO-LANGUAGE': 'MAJOR',      // Language affects screen readers
    'MATTERHORN-11-001': 'MAJOR',    // Document language
    'WCAG-2.4.2': 'MAJOR',           // Page title for navigation

    // PDF Quick-fix codes (Minor - metadata)
    'PDF-NO-TITLE': 'MINOR',         // Title is helpful but not critical
    'MATTERHORN-01-003': 'MINOR',    // Document title
    'PDF-NO-CREATOR': 'MINOR',       // Creator metadata
    'PDF-NO-METADATA': 'MINOR',      // General metadata

    // EPUB codes (default to MAJOR)
    'EPUB-META-001': 'MAJOR',
    'EPUB-META-002': 'MAJOR',
    'EPUB-SEM-001': 'MAJOR',
    'EPUB-IMG-001': 'CRITICAL',      // Alt text is critical
    'EPUB-STRUCT-002': 'MAJOR',
    'EPUB-STRUCT-003': 'MAJOR',
    'EPUB-NAV-001': 'MAJOR',
    'EPUB-CONTRAST-001': 'MAJOR',
    'COLOR-CONTRAST': 'MAJOR',
  };

  return severityMappings[ruleId] || 'MAJOR';
}
