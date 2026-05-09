/**
 * Registry of PRH UK profile-specific issue codes.
 *
 * PR1 (this file) defines the codes only. Validators that emit them land in
 * PR2 (metadata + spine), PR3 (nav + per-XHTML), and PR4 (image specifics).
 *
 * Convention: `PRH-<AREA>-<CHECK>`. Severities use the same vocabulary as the
 * existing audit pipeline (`critical | serious | moderate | minor`). WCAG
 * mappings are merged into `wcag-issue-mapper.service.ts` in the PR that
 * actually starts emitting the code, so this file is the single source of
 * truth for downstream consumers.
 */

import type { FixType } from './fix-classification';

export type PrhIssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface PrhIssueDefinition {
  code: string;
  severity: PrhIssueSeverity;
  /** WCAG criteria this maps to. Empty when the rule is publisher-specific (no WCAG analogue). */
  wcag: string[];
  /** Fix mode the auto-remediation pipeline should treat this as. */
  fixType: FixType;
  /** Short human-readable summary used in the UI / logs. */
  summary: string;
}

export const PRH_ISSUE_CODES = {
  // ── Metadata (PR2) ─────────────────────────────────────────────────────
  'PRH-META-CONFORMS-TO': {
    code: 'PRH-META-CONFORMS-TO',
    severity: 'moderate',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'OPF dcterms:conformsTo must be "EPUB Accessibility 1.1 - WCAG 2.2 Level AA"',
  },
  'PRH-META-CERTIFIED-BY': {
    code: 'PRH-META-CERTIFIED-BY',
    severity: 'moderate',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'OPF a11y:certifiedBy must be "Penguin Random House UK"',
  },
  'PRH-META-CERTIFIER-CRED': {
    code: 'PRH-META-CERTIFIER-CRED',
    severity: 'moderate',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'OPF a11y:certifierCredential must be "Ace by DAISY OK"',
  },
  'PRH-META-CERTIFIER-LINK': {
    code: 'PRH-META-CERTIFIER-LINK',
    severity: 'moderate',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'OPF must include <link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>',
  },
  'PRH-META-TDM-RESERVATION': {
    code: 'PRH-META-TDM-RESERVATION',
    severity: 'moderate',
    wcag: [],
    fixType: 'auto',
    summary: 'OPF must declare <meta property="tdm:reservation">1</meta> with the tdm: prefix',
  },
  'PRH-META-A11Y-SUMMARY-URL': {
    code: 'PRH-META-A11Y-SUMMARY-URL',
    severity: 'minor',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'OPF accessibilitySummary must reference penguin.co.uk/accessibility',
  },

  // ── Spine (PR2) ────────────────────────────────────────────────────────
  'PRH-SPINE-COVER-LINEAR': {
    code: 'PRH-SPINE-COVER-LINEAR',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Cover spine entry must have linear="no"',
  },
  'PRH-SPINE-FOOTNOTES-LAST': {
    code: 'PRH-SPINE-FOOTNOTES-LAST',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Footnotes file must be the last entry in the spine and marked linear="no"',
  },

  // ── Nav (PR3) ──────────────────────────────────────────────────────────
  'PRH-NAV-MISSING-PAGELIST': {
    code: 'PRH-NAV-MISSING-PAGELIST',
    severity: 'moderate',
    wcag: ['2.4.5'],
    fixType: 'manual',
    summary: 'nav.xhtml must include a <nav epub:type="page-list"> block',
  },
  'PRH-NAV-PAGELIST-NOT-HIDDEN': {
    code: 'PRH-NAV-PAGELIST-NOT-HIDDEN',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'page-list nav must be hidden via hidden="hidden" AND class="hidden_content"',
  },
  'PRH-NAV-LANDMARKS-MISSING-COVER': {
    code: 'PRH-NAV-LANDMARKS-MISSING-COVER',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'landmarks nav must include an entry with epub:type="cover"',
  },
  'PRH-NAV-LANDMARKS-MISSING-FRONTMATTER': {
    code: 'PRH-NAV-LANDMARKS-MISSING-FRONTMATTER',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'landmarks nav must include an entry with epub:type="frontmatter"',
  },
  'PRH-NAV-LANDMARKS-MISSING-TOC': {
    code: 'PRH-NAV-LANDMARKS-MISSING-TOC',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'landmarks nav must include an entry with epub:type="toc"',
  },
  'PRH-NAV-LANDMARKS-MISSING-BODYMATTER': {
    code: 'PRH-NAV-LANDMARKS-MISSING-BODYMATTER',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'landmarks nav must include an entry with epub:type="bodymatter"',
  },

  // ── Per-XHTML (PR3) ────────────────────────────────────────────────────
  'PRH-XHTML-XML-LANG': {
    code: 'PRH-XHTML-XML-LANG',
    severity: 'moderate',
    wcag: ['3.1.1'],
    fixType: 'auto',
    summary: 'Every XHTML <html> must carry both lang and xml:lang attributes',
  },
  'PRH-XHTML-TITLE-EMPTY-OR-GENERIC': {
    code: 'PRH-XHTML-TITLE-EMPTY-OR-GENERIC',
    severity: 'minor',
    wcag: ['2.4.2'],
    fixType: 'manual',
    summary: '<head><title> must include a chapter or section identifier, not just the book title',
  },

  // ── Image (PR4) ────────────────────────────────────────────────────────
  'PRH-COVER-ALT-EMPTY': {
    code: 'PRH-COVER-ALT-EMPTY',
    severity: 'serious',
    wcag: ['1.1.1'],
    fixType: 'quickfix',
    summary: 'Cover image alt must be non-empty (e.g. "Cover for [Book Title]")',
  },
  'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE': {
    code: 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE',
    severity: 'minor',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'Decorative images must declare role="presentation" alongside alt=""',
  },
} satisfies Record<string, PrhIssueDefinition>;

export type PrhIssueCode = keyof typeof PRH_ISSUE_CODES;

/** Type-safe lookup. Returns undefined if `code` is not a registered PRH code. */
export function getPrhIssueDefinition(code: string): PrhIssueDefinition | undefined {
  return (PRH_ISSUE_CODES as Record<string, PrhIssueDefinition>)[code];
}

/** All codes as a string list, useful for batch operations. */
export const ALL_PRH_ISSUE_CODES: string[] = Object.keys(PRH_ISSUE_CODES);
