/**
 * PRH UK metadata validator.
 *
 * Checks the OPF for the 6 publisher-specific metadata strings PRH UK
 * requires (per `accessibility_meta_boilerplates.txt` in the Technical
 * Guide). Pure function — no I/O — so it's cheap to test against fixture
 * OPF strings.
 *
 * Mapped issue codes (registered in `src/constants/prh-issue-codes.ts`):
 *   PRH-META-CONFORMS-TO       — dcterms:conformsTo value
 *   PRH-META-CERTIFIED-BY      — a11y:certifiedBy value
 *   PRH-META-CERTIFIER-CRED    — a11y:certifierCredential value
 *   PRH-META-CERTIFIER-LINK    — link rel="a11y:certifierCredential" presence
 *   PRH-META-TDM-RESERVATION   — tdm:reservation meta + prefix
 *   PRH-META-A11Y-SUMMARY-URL  — accessibilitySummary references PRH URL
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorInput, PrhValidatorIssue } from './types';

/** Literal expected values from PRH spec. */
export const PRH_METADATA_EXPECTED = {
  conformsTo: 'EPUB Accessibility 1.1 - WCAG 2.2 Level AA',
  certifiedBy: 'Penguin Random House UK',
  certifierCredential: 'Ace by DAISY OK',
  certifierLinkHref: 'https://daisy.github.io/ace',
  tdmReservationValue: '1',
  /** Substring expected in the accessibilitySummary value. */
  a11ySummaryUrlSubstring: 'penguin.co.uk/accessibility',
} as const;

export function validatePrhMetadata(input: PrhValidatorInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];
  const opf = input.opfContent;
  const location = input.opfPath || 'package.opf';

  // ── 1. dcterms:conformsTo ──────────────────────────────────────────────
  const conformsToValue = readMetaValue(opf, 'dcterms:conformsTo');
  if (conformsToValue !== PRH_METADATA_EXPECTED.conformsTo) {
    issues.push(
      buildIssue('PRH-META-CONFORMS-TO', location, {
        message: conformsToValue == null
          ? 'OPF is missing dcterms:conformsTo metadata'
          : `OPF dcterms:conformsTo is "${conformsToValue}", not "${PRH_METADATA_EXPECTED.conformsTo}"`,
        suggestion: `Add or replace the conformsTo meta with: <meta property="dcterms:conformsTo" id="conf">${PRH_METADATA_EXPECTED.conformsTo}</meta>`,
      }),
    );
  }

  // ── 2. a11y:certifiedBy ────────────────────────────────────────────────
  const certifiedByValue = readMetaValue(opf, 'a11y:certifiedBy');
  if (certifiedByValue !== PRH_METADATA_EXPECTED.certifiedBy) {
    issues.push(
      buildIssue('PRH-META-CERTIFIED-BY', location, {
        message: certifiedByValue == null
          ? 'OPF is missing a11y:certifiedBy metadata'
          : `OPF a11y:certifiedBy is "${certifiedByValue}", not "${PRH_METADATA_EXPECTED.certifiedBy}"`,
        suggestion: `Add or replace the certifiedBy meta with: <meta property="a11y:certifiedBy" refines="#conf" id="certifier">${PRH_METADATA_EXPECTED.certifiedBy}</meta>`,
      }),
    );
  }

  // ── 3. a11y:certifierCredential (meta value) ───────────────────────────
  const credValue = readMetaValue(opf, 'a11y:certifierCredential');
  if (credValue !== PRH_METADATA_EXPECTED.certifierCredential) {
    issues.push(
      buildIssue('PRH-META-CERTIFIER-CRED', location, {
        message: credValue == null
          ? 'OPF is missing a11y:certifierCredential meta'
          : `OPF a11y:certifierCredential is "${credValue}", not "${PRH_METADATA_EXPECTED.certifierCredential}"`,
        suggestion: `Add or replace the certifierCredential meta with: <meta property="a11y:certifierCredential" refines="#certifier">${PRH_METADATA_EXPECTED.certifierCredential}</meta>`,
      }),
    );
  }

  // ── 4. <link rel="a11y:certifierCredential" href="..."> ────────────────
  if (!hasCertifierLink(opf, PRH_METADATA_EXPECTED.certifierLinkHref)) {
    issues.push(
      buildIssue('PRH-META-CERTIFIER-LINK', location, {
        message: 'OPF is missing <link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>',
        suggestion: 'Add: <link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>',
      }),
    );
  }

  // ── 5. tdm:reservation ─────────────────────────────────────────────────
  const tdmValue = readMetaValue(opf, 'tdm:reservation');
  const hasTdmPrefix = /\btdm\s*:\s*http:\/\/www\.w3\.org\/ns\/tdmrep#/i.test(opf)
    // Or declared on the package element via prefix attribute:
    || /\bprefix\s*=\s*["'][^"']*tdm:\s*http:\/\/www\.w3\.org\/ns\/tdmrep#[^"']*["']/i.test(opf);
  if (tdmValue !== PRH_METADATA_EXPECTED.tdmReservationValue || !hasTdmPrefix) {
    const reasons: string[] = [];
    if (tdmValue !== PRH_METADATA_EXPECTED.tdmReservationValue) {
      reasons.push(
        tdmValue == null
          ? 'tdm:reservation meta is missing'
          : `tdm:reservation is "${tdmValue}", expected "1"`,
      );
    }
    if (!hasTdmPrefix) {
      reasons.push('tdm: prefix is not declared on the <package> element');
    }
    issues.push(
      buildIssue('PRH-META-TDM-RESERVATION', location, {
        message: `Text-and-data-mining reservation is incomplete: ${reasons.join('; ')}`,
        suggestion: 'On <package>: add prefix="tdm: http://www.w3.org/ns/tdmrep#". In <metadata>: add <meta property="tdm:reservation">1</meta>',
      }),
    );
  }

  // ── 6. accessibilitySummary references penguin.co.uk/accessibility ─────
  const summaryValue =
    readMetaValue(opf, 'schema:accessibilitySummary')
    ?? readDcMetaValue(opf, 'accessibilitySummary');
  if (
    summaryValue == null
    || !summaryValue.toLowerCase().includes(PRH_METADATA_EXPECTED.a11ySummaryUrlSubstring)
  ) {
    issues.push(
      buildIssue('PRH-META-A11Y-SUMMARY-URL', location, {
        message: summaryValue == null
          ? 'OPF accessibilitySummary is missing'
          : `accessibilitySummary does not reference ${PRH_METADATA_EXPECTED.a11ySummaryUrlSubstring}`,
        suggestion: 'Update accessibilitySummary to end with the PRH accessibility URL: https://www.penguin.co.uk/accessibility',
      }),
    );
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Read a `<meta property="...">value</meta>` from the OPF. Tolerant of
 * either quote style and arbitrary attribute order on the element. Returns
 * the trimmed inner text, or null if not found.
 */
function readMetaValue(opf: string, propertyName: string): string | null {
  // Escape any regex specials in the property name.
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta\\b[^>]*\\bproperty\\s*=\\s*["']${escaped}["'][^>]*>([\\s\\S]*?)</meta>`,
    'i',
  );
  const m = opf.match(re);
  if (!m) return null;
  return m[1].trim();
}

/** Read a `<dc:foo>value</dc:foo>` from the OPF (Dublin Core fallback). */
function readDcMetaValue(opf: string, name: string): string | null {
  const re = new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'i');
  const m = opf.match(re);
  if (!m) return null;
  return m[1].trim();
}

function hasCertifierLink(opf: string, expectedHref: string): boolean {
  // Find <link rel="a11y:certifierCredential" ... href="..."/>. Exact-match
  // the href (after normalising trailing slash + case) so we don't accept
  // values like "https://example.com/?next=https://daisy.github.io/ace".
  const re = /<link\b[^>]*\brel\s*=\s*["']a11y:certifierCredential["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i;
  let m = opf.match(re);
  if (!m) {
    // Try with attribute order reversed (href before rel).
    const re2 = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']a11y:certifierCredential["']/i;
    m = opf.match(re2);
    if (!m) return false;
  }
  return normaliseHref(m[1]) === normaliseHref(expectedHref);
}

function normaliseHref(href: string): string {
  return href.trim().toLowerCase().replace(/\/+$/, '');
}

function buildIssue(
  code: keyof typeof PRH_ISSUE_CODES,
  location: string,
  parts: { message: string; suggestion: string },
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: parts.message,
    suggestion: parts.suggestion,
    location,
  };
}
