/**
 * Issue Tally Tracking System
 * Tracks issue counts through the pipeline to ensure no issues are lost
 */

export interface SourceTally {
  epubCheck: number;
  ace: number;
  jsAuditor: number;
  total: number;
}

export interface SeverityTally {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
}

export interface ClassificationTally {
  autoFixable: number;
  quickFix: number;
  manual: number;
  total: number;
}

export interface StatusTally {
  pending: number;
  inProgress: number;
  fixed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface IssueTally {
  stage: 'audit' | 'remediation_plan' | 'in_progress' | 'completed';
  timestamp: string;
  bySource: SourceTally;
  bySeverity: SeverityTally;
  byClassification: ClassificationTally;
  byStatus: StatusTally;
  grandTotal: number;
  isValid: boolean;
  validationErrors: string[];
}

export interface TallyValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  discrepancies: {
    field: string;
    expected: number;
    actual: number;
    difference: number;
  }[];
}

/**
 * Normalize source string for consistent comparison
 */
export function normalizeSource(source: string): string {
  if (!source) return 'unknown';
  const s = source.toLowerCase().replace(/[^a-z]/g, '');
  if (s.includes('epub') && s.includes('check')) return 'epubcheck';
  if (s.includes('ace')) return 'ace';
  if (s.includes('js') || s.includes('auditor')) return 'jsauditor';
  return 'unknown';
}

/**
 * Get fix type for an issue code
 */
export function getFixTypeForCode(code: string): 'auto' | 'quickfix' | 'manual' {
  const QUICK_FIXABLE = new Set([
    'METADATA-ACCESSMODE', 'METADATA-ACCESSIBILITYFEATURE',
    'METADATA-ACCESSIBILITYHAZARD', 'METADATA-ACCESSIBILITYSUMMARY',
    'EPUB-IMG-001', 'IMG-001', 'ACE-IMG-001',
    'EPUB-CONTRAST-001', 'COLOR-CONTRAST',
  ]);

  const AUTO_FIXABLE = new Set([
    'EPUB-META-001', 'EPUB-NAV-001', 'EPUB-SEM-002',
    'EPUB-STRUCT-003', 'EPUB-STRUCT-004',
  ]);

  const upperCode = code?.toUpperCase() || '';
  if (AUTO_FIXABLE.has(upperCode)) return 'auto';
  if (QUICK_FIXABLE.has(upperCode)) return 'quickfix';
  return 'manual';
}

/**
 * Create a tally from a list of issues
 */
export function createTally(
  issues: any[],
  stage: IssueTally['stage']
): IssueTally {
  const bySource: SourceTally = { epubCheck: 0, ace: 0, jsAuditor: 0, total: 0 };
  const bySeverity: SeverityTally = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
  const byClassification: ClassificationTally = { autoFixable: 0, quickFix: 0, manual: 0, total: 0 };
  const byStatus: StatusTally = { pending: 0, inProgress: 0, fixed: 0, failed: 0, skipped: 0, total: 0 };

  for (const issue of issues) {
    // By source
    const source = normalizeSource(issue.source || issue.ruleSource || '');
    if (source === 'epubcheck') bySource.epubCheck++;
    else if (source === 'ace') bySource.ace++;
    else if (source === 'jsauditor') bySource.jsAuditor++;
    bySource.total++;

    // By severity
    const severity = (issue.severity || 'moderate').toLowerCase();
    if (severity === 'critical') bySeverity.critical++;
    else if (severity === 'serious') bySeverity.serious++;
    else if (severity === 'moderate') bySeverity.moderate++;
    else bySeverity.minor++;
    bySeverity.total++;

    // By classification
    const fixType = issue.fixType || getFixTypeForCode(issue.code);
    if (fixType === 'auto') byClassification.autoFixable++;
    else if (fixType === 'quickfix') byClassification.quickFix++;
    else byClassification.manual++;
    byClassification.total++;

    // By status
    const status = (issue.status || 'pending').toLowerCase().replace('_', '');
    if (status === 'pending') byStatus.pending++;
    else if (status === 'inprogress') byStatus.inProgress++;
    else if (status === 'fixed') byStatus.fixed++;
    else if (status === 'failed') byStatus.failed++;
    else if (status === 'skipped') byStatus.skipped++;
    byStatus.total++;
  }

  // Validate internal consistency
  const validationErrors: string[] = [];
  if (bySource.total !== bySeverity.total) {
    validationErrors.push(`Source total (${bySource.total}) !== Severity total (${bySeverity.total})`);
  }
  if (bySource.total !== byClassification.total) {
    validationErrors.push(`Source total (${bySource.total}) !== Classification total (${byClassification.total})`);
  }

  return {
    stage,
    timestamp: new Date().toISOString(),
    bySource,
    bySeverity,
    byClassification,
    byStatus,
    grandTotal: bySource.total,
    isValid: validationErrors.length === 0,
    validationErrors,
  };
}

/**
 * Validate that current tally matches previous stage
 */
export function validateTallyTransition(
  previousTally: IssueTally,
  currentTally: IssueTally
): TallyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const discrepancies: TallyValidationResult['discrepancies'] = [];

  // Check grand total
  if (previousTally.grandTotal !== currentTally.grandTotal) {
    const diff = previousTally.grandTotal - currentTally.grandTotal;
    discrepancies.push({
      field: 'grandTotal',
      expected: previousTally.grandTotal,
      actual: currentTally.grandTotal,
      difference: diff,
    });
    errors.push(`Issue count changed: ${previousTally.grandTotal} → ${currentTally.grandTotal} (${diff} missing)`);
  }

  // Check by source
  if (previousTally.bySource.ace !== currentTally.bySource.ace) {
    discrepancies.push({
      field: 'bySource.ace',
      expected: previousTally.bySource.ace,
      actual: currentTally.bySource.ace,
      difference: previousTally.bySource.ace - currentTally.bySource.ace,
    });
    errors.push(`ACE issues: ${previousTally.bySource.ace} → ${currentTally.bySource.ace}`);
  }

  if (previousTally.bySource.jsAuditor !== currentTally.bySource.jsAuditor) {
    discrepancies.push({
      field: 'bySource.jsAuditor',
      expected: previousTally.bySource.jsAuditor,
      actual: currentTally.bySource.jsAuditor,
      difference: previousTally.bySource.jsAuditor - currentTally.bySource.jsAuditor,
    });
    errors.push(`JS Auditor issues: ${previousTally.bySource.jsAuditor} → ${currentTally.bySource.jsAuditor}`);
  }

  if (previousTally.bySource.epubCheck !== currentTally.bySource.epubCheck) {
    discrepancies.push({
      field: 'bySource.epubCheck',
      expected: previousTally.bySource.epubCheck,
      actual: currentTally.bySource.epubCheck,
      difference: previousTally.bySource.epubCheck - currentTally.bySource.epubCheck,
    });
    errors.push(`EPUBCheck issues: ${previousTally.bySource.epubCheck} → ${currentTally.bySource.epubCheck}`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    discrepancies,
  };
}
