/**
 * @fileoverview Issue categorizer for batch policy evaluation.
 * Maps EPUBCheck / ACE / Matterhorn rule IDs and WCAG criterion IDs
 * to human-readable category strings used in per-issue-type policy rules.
 *
 * Category strings (kebab-case) are the keys in BatchGatePolicy.conditions.issueTypeRules.
 */

/** Canonical category names used in issueTypeRules policy keys. */
export type IssueCategory =
  | 'alt-text'
  | 'color-contrast'
  | 'heading-hierarchy'
  | 'link-text'
  | 'table-headers'
  | 'language'
  | 'aria'
  | 'reading-order'
  | 'metadata'
  | 'duplicate-id'
  | 'page-list'
  | 'timing'
  | 'keyboard'
  | 'focus'
  | 'form-labels'
  | 'other';

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

/**
 * ACE / axe-core ruleId → category.
 * Keys are lowercased for case-insensitive matching.
 */
const ACE_RULE_MAP: Record<string, IssueCategory> = {
  // Alt text
  'image-alt':                 'alt-text',
  'input-image-alt':           'alt-text',
  'image-redundant-alt':       'alt-text',
  'role-img-alt':              'alt-text',
  'svg-img-alt':               'alt-text',
  'area-alt':                  'alt-text',
  'object-alt':                'alt-text',

  // Color contrast
  'color-contrast':            'color-contrast',
  'color-contrast-enhanced':   'color-contrast',

  // Headings
  'heading-order':             'heading-hierarchy',
  'empty-heading':             'heading-hierarchy',
  'p-as-heading':              'heading-hierarchy',

  // Links
  'link-name':                 'link-text',
  'link-in-text-block':        'link-text',

  // Tables
  'td-headers-attr':           'table-headers',
  'th-has-data-cells':         'table-headers',
  'scope-attr-valid':          'table-headers',
  'table-duplicate-name':      'table-headers',
  'table-fake-caption':        'table-headers',
  'layout-table':              'table-headers',

  // Language
  'html-lang-valid':           'language',
  'html-has-lang':             'language',
  'valid-lang':                'language',

  // ARIA
  'aria-allowed-attr':         'aria',
  'aria-required-attr':        'aria',
  'aria-required-children':    'aria',
  'aria-required-parent':      'aria',
  'aria-roles':                'aria',
  'aria-valid-attr':           'aria',
  'aria-valid-attr-value':     'aria',
  'aria-hidden-body':          'aria',
  'aria-hidden-focus':         'aria',
  'aria-label':                'aria',
  'aria-labelledby':           'aria',

  // Keyboard / Focus
  'bypass':                    'keyboard',
  'scrollable-region-focusable': 'keyboard',
  'focus-trap':                'focus',
  'focus-order-semantics':     'focus',

  // Forms
  'label':                     'form-labels',
  'label-content-name-mismatch': 'form-labels',
  'select-name':               'form-labels',
  'input-button-name':         'form-labels',

  // Duplicate IDs
  'duplicate-id':              'duplicate-id',
  'duplicate-id-active':       'duplicate-id',
  'duplicate-id-aria':         'duplicate-id',

  // Metadata / document
  'document-title':            'metadata',
  'meta-viewport':             'metadata',
  'meta-refresh':              'timing',
};

/**
 * EPUBCheck / Matterhorn error code prefix → category.
 * Codes are matched by prefix (e.g. RSC-, ACC-, OPF-).
 */
const EPUBCHECK_PREFIX_MAP: Array<{ prefix: string; category: IssueCategory }> = [
  { prefix: 'ACC-001', category: 'alt-text' },
  { prefix: 'ACC-002', category: 'color-contrast' },
  { prefix: 'ACC-003', category: 'heading-hierarchy' },
  { prefix: 'ACC-004', category: 'table-headers' },
  { prefix: 'ACC-005', category: 'language' },
  { prefix: 'ACC-006', category: 'reading-order' },
  { prefix: 'ACC-007', category: 'metadata' },
  { prefix: 'ACC-008', category: 'aria' },
  { prefix: 'ACC-',    category: 'other' },           // catch-all ACC
  { prefix: 'OPF-',    category: 'metadata' },
  { prefix: 'RSC-',    category: 'other' },
  { prefix: 'HTM-',    category: 'other' },
  { prefix: 'CSS-',    category: 'other' },
  { prefix: 'NCX-',    category: 'reading-order' },
  { prefix: 'NAV-',    category: 'reading-order' },
  { prefix: 'PKG-',    category: 'metadata' },
];

/**
 * WCAG criterion ID → category.
 * Covers all WCAG 2.1 Level A & AA criteria.
 */
const WCAG_CRITERION_MAP: Record<string, IssueCategory> = {
  // 1.1 — Text alternatives
  '1.1.1': 'alt-text',

  // 1.2 — Time-based media
  '1.2.1': 'timing', '1.2.2': 'timing', '1.2.3': 'timing',
  '1.2.4': 'timing', '1.2.5': 'timing',

  // 1.3 — Adaptable
  '1.3.1': 'reading-order',
  '1.3.2': 'reading-order',
  '1.3.3': 'reading-order',
  '1.3.4': 'reading-order',
  '1.3.5': 'form-labels',

  // 1.4 — Distinguishable
  '1.4.1': 'color-contrast',
  '1.4.2': 'timing',
  '1.4.3': 'color-contrast',
  '1.4.4': 'other',
  '1.4.5': 'other',
  '1.4.10': 'other',
  '1.4.11': 'color-contrast',
  '1.4.12': 'other',
  '1.4.13': 'other',

  // 2.1 — Keyboard
  '2.1.1': 'keyboard', '2.1.2': 'keyboard', '2.1.4': 'keyboard',

  // 2.2 — Timing
  '2.2.1': 'timing', '2.2.2': 'timing',

  // 2.3 — Seizures
  '2.3.1': 'other',

  // 2.4 — Navigable
  '2.4.1': 'keyboard',
  '2.4.2': 'metadata',
  '2.4.3': 'focus',
  '2.4.4': 'link-text',
  '2.4.5': 'other',
  '2.4.6': 'heading-hierarchy',
  '2.4.7': 'focus',

  // 2.5 — Input modalities
  '2.5.1': 'other', '2.5.2': 'other', '2.5.3': 'form-labels', '2.5.4': 'other',

  // 3.1 — Readable
  '3.1.1': 'language', '3.1.2': 'language',

  // 3.2 — Predictable
  '3.2.1': 'focus', '3.2.2': 'other', '3.2.3': 'other', '3.2.4': 'other',

  // 3.3 — Input assistance
  '3.3.1': 'form-labels', '3.3.2': 'form-labels',
  '3.3.3': 'form-labels', '3.3.4': 'form-labels',

  // 4.1 — Compatible
  '4.1.1': 'duplicate-id',
  '4.1.2': 'aria',
  '4.1.3': 'aria',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Categorize an issue by its code or ruleId.
 *
 * Resolution order:
 *  1. Exact ACE ruleId match (case-insensitive)
 *  2. WCAG criterion ID match (e.g. "1.1.1", "2.4.6")
 *  3. EPUBCheck/Matterhorn prefix match (longest prefix wins)
 *  4. Keyword heuristics on the raw code string
 *  5. 'other' fallback
 *
 * @param code - Issue code, ruleId, or WCAG criterion ID from any audit tool.
 */
export function categorizeIssue(code: string): IssueCategory {
  if (!code) return 'other';

  const lower = code.toLowerCase().trim();

  // 1. ACE ruleId exact match
  if (ACE_RULE_MAP[lower]) return ACE_RULE_MAP[lower];

  // 2. WCAG criterion match (e.g. "1.1.1", "WCAG 1.1.1", "wcag:1.1.1")
  const wcagMatch = lower.match(/(\d+\.\d+\.\d+)/);
  if (wcagMatch) {
    const criterion = wcagMatch[1];
    if (WCAG_CRITERION_MAP[criterion]) return WCAG_CRITERION_MAP[criterion];
  }

  // 3. EPUBCheck prefix match (longer prefixes take priority)
  const sortedPrefixes = [...EPUBCHECK_PREFIX_MAP].sort(
    (a, b) => b.prefix.length - a.prefix.length
  );
  for (const { prefix, category } of sortedPrefixes) {
    if (code.toUpperCase().startsWith(prefix.toUpperCase())) return category;
  }

  // 4. Keyword heuristics
  if (lower.includes('alt') || lower.includes('image'))          return 'alt-text';
  if (lower.includes('contrast') || lower.includes('color'))     return 'color-contrast';
  if (lower.includes('heading') || lower.includes('h1') || lower.includes('h2')) return 'heading-hierarchy';
  if (lower.includes('link'))                                    return 'link-text';
  if (lower.includes('table') || lower.includes('header'))       return 'table-headers';
  if (lower.includes('lang'))                                    return 'language';
  if (lower.includes('aria') || lower.includes('role'))          return 'aria';
  if (lower.includes('order') || lower.includes('sequence'))     return 'reading-order';
  if (lower.includes('label') || lower.includes('form'))         return 'form-labels';
  if (lower.includes('duplicate') || lower.includes('unique'))   return 'duplicate-id';
  if (lower.includes('keyboard') || lower.includes('focus'))     return 'keyboard';
  if (lower.includes('meta') || lower.includes('title'))         return 'metadata';

  return 'other';
}

/**
 * Returns the full list of known category names.
 * Useful for building policy rule dropdowns in the UI.
 */
export const ALL_ISSUE_CATEGORIES: IssueCategory[] = [
  'alt-text',
  'color-contrast',
  'heading-hierarchy',
  'link-text',
  'table-headers',
  'language',
  'aria',
  'reading-order',
  'metadata',
  'duplicate-id',
  'page-list',
  'timing',
  'keyboard',
  'focus',
  'form-labels',
  'other',
];
