import { isColorContrastAutoFixEnabled } from '../config/remediation-config';

const COLOR_CONTRAST_CODES = ['COLOR-CONTRAST', 'EPUB-CONTRAST-001'];

const BASE_AUTO_FIXABLE_CODES = new Set([
  'EPUB-META-001',
  'EPUB-META-002',
  'EPUB-META-003',
  'EPUB-META-004',
  'EPUB-NAV-001',
  'EPUB-SEM-001',
  'EPUB-SEM-002',
  'EPUB-STRUCT-003',
  'EPUB-STRUCT-004',
  'EPUB-FIG-001',
]);

export function getAutoFixableCodes(): Set<string> {
  const codes = new Set(BASE_AUTO_FIXABLE_CODES);
  if (isColorContrastAutoFixEnabled()) {
    COLOR_CONTRAST_CODES.forEach(code => codes.add(code));
  }
  return codes;
}

export const AUTO_FIXABLE_CODES = BASE_AUTO_FIXABLE_CODES;

export const QUICK_FIXABLE_CODES = new Set([
  'METADATA-ACCESSMODE',
  'METADATA-ACCESSMODESUFFICIENT',
  'METADATA-ACCESSIBILITYFEATURE',
  'METADATA-ACCESSIBILITYHAZARD',
  'METADATA-ACCESSIBILITYSUMMARY',
  'EPUB-IMG-001',
  'IMG-001',
  'ACE-IMG-001',
  'EPUB-STRUCT-002',
  'EPUB-SEM-003',
  'LANDMARK-UNIQUE',
  'EPUB-TYPE-HAS-MATCHING-ROLE',
]);

// Map ACE codes to equivalent JS Auditor codes to prevent duplicate processing
export const DUPLICATE_CODE_MAP: Record<string, string> = {
  'METADATA-ACCESSIBILITYFEATURE': 'EPUB-META-002',
  'METADATA-ACCESSIBILITYHAZARD': 'EPUB-META-002',
  'METADATA-ACCESSMODE': 'EPUB-META-004',
  'METADATA-ACCESSMODESUFFICIENT': 'EPUB-META-004',
  'METADATA-ACCESSIBILITYSUMMARY': 'EPUB-META-003',
};

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
  const autoFixable = getAutoFixableCodes();

  if (autoFixable.has(normalized) || autoFixable.has(issueCode)) {
    return 'auto';
  }

  if (QUICK_FIXABLE_CODES.has(normalized) || QUICK_FIXABLE_CODES.has(issueCode)) {
    return 'quickfix';
  }

  if (!isColorContrastAutoFixEnabled() && 
      (COLOR_CONTRAST_CODES.includes(normalized) || COLOR_CONTRAST_CODES.includes(issueCode))) {
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
