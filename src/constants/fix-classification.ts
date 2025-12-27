export const AUTO_FIXABLE_CODES = new Set([
  'EPUB-META-001',
  'OPF-014',
  'OPF-014b',
  'EPUB-NAV-001',
  'EPUB-SEM-002',
  'EPUB-STRUCT-003',
  'EPUB-STRUCT-004',
  'EPUB-FIG-001',
  'EPUB-SEM-001',
]);

export const QUICK_FIXABLE_CODES = new Set([
  'METADATA-ACCESSMODE',
  'METADATA-ACCESSIBILITYFEATURE',
  'METADATA-ACCESSIBILITYHAZARD',
  'METADATA-ACCESSIBILITYSUMMARY',
  'EPUB-META-002',
  'EPUB-META-003',
  'EPUB-META-004',
  'EPUB-IMG-001',
  'IMG-001',
  'ACE-IMG-001',
  'EPUB-CONTRAST-001',
  'COLOR-CONTRAST',
  'EPUB-STRUCT-002',
  'EPUB-SEM-003',
  'LANDMARK-UNIQUE',
]);

export const CODE_MAPPING: Record<string, string> = {
  'metadata-accessmode-missing': 'METADATA-ACCESSMODE',
  'metadata-accessibilityfeature-missing': 'METADATA-ACCESSIBILITYFEATURE',
  'metadata-accessibilityhazard-missing': 'METADATA-ACCESSIBILITYHAZARD',
  'metadata-accessibilitysummary-missing': 'METADATA-ACCESSIBILITYSUMMARY',
  'metadata-accessmode': 'METADATA-ACCESSMODE',
  'metadata-accessibilityFeature': 'METADATA-ACCESSIBILITYFEATURE',
  'metadata-accessibilityHazard': 'METADATA-ACCESSIBILITYHAZARD',
  'metadata-accessibilitySummary': 'METADATA-ACCESSIBILITYSUMMARY',
};

export type FixType = 'auto' | 'quickfix' | 'manual';

export function normalizeIssueCode(code: string): string {
  const mapped = CODE_MAPPING[code] || CODE_MAPPING[code.toLowerCase()];
  if (mapped) return mapped;
  return code.toUpperCase();
}

export function getFixType(issueCode: string): FixType {
  const normalized = normalizeIssueCode(issueCode);

  if (AUTO_FIXABLE_CODES.has(normalized) || AUTO_FIXABLE_CODES.has(issueCode)) {
    return 'auto';
  }

  if (QUICK_FIXABLE_CODES.has(normalized) || QUICK_FIXABLE_CODES.has(issueCode)) {
    return 'quickfix';
  }

  return 'manual';
}

export function isAutoFixable(issueCode: string): boolean {
  return getFixType(issueCode) === 'auto';
}

export function isQuickFixable(issueCode: string): boolean {
  return getFixType(issueCode) === 'quickfix';
}

export function requiresManualFix(issueCode: string): boolean {
  return getFixType(issueCode) === 'manual';
}

export function canFixInApp(issueCode: string): boolean {
  const fixType = getFixType(issueCode);
  return fixType === 'auto' || fixType === 'quickfix';
}

export function getFixTypeLabel(fixType: FixType): string {
  switch (fixType) {
    case 'auto': return 'Auto-Fixable';
    case 'quickfix': return 'Quick Fix';
    case 'manual': return 'Manual';
  }
}

export function getFixTypeBadgeColor(fixType: FixType): string {
  switch (fixType) {
    case 'auto': return 'green';
    case 'quickfix': return 'blue';
    case 'manual': return 'yellow';
  }
}
