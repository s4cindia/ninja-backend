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
    // Marked `manual` for now: the existing applyBatchQuickFix
    // controller switch has no case for this code (would 400 on
    // "unknown fix code"). Operator fixes the cover alt manually until
    // a follow-up wires the quick-fix route to addAltText for the cover.
    severity: 'serious',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'Cover image alt must be non-empty (e.g. "Cover for [Book Title]")',
  },
  'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE': {
    code: 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE',
    severity: 'minor',
    wcag: ['4.1.2'],
    fixType: 'auto',
    summary: 'Decorative images must declare role="presentation" alongside alt=""',
  },

  // ── Copyright content (P2/PR1) ─────────────────────────────────────────
  // All publisher-specific; mostly empty WCAG (legal/branding rather than
  // accessibility). Auto-fix is intentionally deferred to P5 — pasting
  // verbatim legal boilerplate is operator-supervised work.
  'PRH-COPY-TDM-PARAGRAPH-MISSING': {
    code: 'PRH-COPY-TDM-PARAGRAPH-MISSING',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the PRH TDM-reservation paragraph (DSM Directive 2019/790 opt-out)',
  },
  'PRH-COPY-EEA-LINE-MISSING': {
    code: 'PRH-COPY-EEA-LINE-MISSING',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the EEA-representative line (Penguin Random House Ireland, Dublin)',
  },
  'PRH-COPY-BL-CIP-MISSING': {
    code: 'PRH-COPY-BL-CIP-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the British Library CIP statement',
  },
  'PRH-COPY-ADDRESS-BLOCK-MISSING': {
    code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the PRH correspondence address (imprint-specific)',
  },
  'PRH-COPY-GROUP-STATEMENT-MISSING': {
    code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the PRH group-of-companies statement',
  },
  'PRH-COPY-IMPRINT-URL-MISSING': {
    code: 'PRH-COPY-IMPRINT-URL-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must reference the imprint URL (penguin.co.uk for adult; three URLs for children\'s; penguin.co.uk/vintage for Vintage)',
  },
  'PRH-COPY-PRH-LOGO-MISSING': {
    code: 'PRH-COPY-PRH-LOGO-MISSING',
    severity: 'minor',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'Copyright page must include the Penguin Random House UK logo via <figure class="copyright_logo">',
  },
  'PRH-COPY-ISBN-MISSING': {
    code: 'PRH-COPY-ISBN-MISSING',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must include the ISBN in 978-X-XXX-XXXXX-X format',
  },

  // ── Brand page (P2/PR2) ────────────────────────────────────────────────
  // Imprint-conditional. #Merky and Cornerstone Saga have no brand page in
  // the canonical template — the validator gates on the imprint rules and
  // does not emit these codes for those imprints.
  'PRH-BRAND-PAGE-MISSING': {
    code: 'PRH-BRAND-PAGE-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB must include a brand page: <body epub:type="frontmatter" id="brand_page">',
  },
  'PRH-BRAND-PAGE-WRONG-CLASS': {
    code: 'PRH-BRAND-PAGE-WRONG-CLASS',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Brand-page <figure> must use the imprint-specific CSS class (.brand_logo_solo for most; .image_full for Vintage)',
  },
  'PRH-BRAND-PAGE-WRONG-LOGO-ALT': {
    code: 'PRH-BRAND-PAGE-WRONG-LOGO-ALT',
    severity: 'minor',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'Brand-page logo alt text must match the imprint name (e.g. "Penguin Random House", "Puffin Books")',
  },

  // ── Title page (P2/PR2) ────────────────────────────────────────────────
  // Imprint-conditional. Vintage and Cornerstone Saga don't ship a separate
  // titlepage section in their canonical templates.
  'PRH-TITLE-PAGE-MISSING': {
    code: 'PRH-TITLE-PAGE-MISSING',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB must include a title page: <section epub:type="titlepage">',
  },
  'PRH-TITLE-PAGE-WRONG-STRUCTURE': {
    code: 'PRH-TITLE-PAGE-WRONG-STRUCTURE',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Title page must use <section epub:type="titlepage" class="titlepage"> with book title (.booktitle)',
  },
  'PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO': {
    code: 'PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Title page must include <figure class="imprint_logo"> with the imprint logo image',
  },
  'PRH-TITLE-PAGE-WRONG-LOGO-ALT': {
    code: 'PRH-TITLE-PAGE-WRONG-LOGO-ALT',
    severity: 'minor',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'Title-page imprint logo alt text must match the imprint expectation (most imprints: "Penguin Random House"; Pelican: "Pelican Books"; Ladybird: "Ladybird Books")',
  },

  // ── Socials page (P2/PR3) ──────────────────────────────────────────────
  // Imprint-conditional. Only Penguin / Vintage / Cornerstone Saga ship a
  // canonical socials page. Puffin / Pelican / Ladybird / #Merky have
  // `socials: null` in the imprint registry and the validator skips them.
  'PRH-SOCIALS-PAGE-MISSING': {
    code: 'PRH-SOCIALS-PAGE-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB must include a socials / "Follow us" page in backmatter',
  },
  'PRH-SOCIALS-CHANNEL-MISSING': {
    code: 'PRH-SOCIALS-CHANNEL-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Socials page is missing one or more expected channels for the imprint',
  },
  'PRH-SOCIALS-CHANNEL-ORDER-WRONG': {
    code: 'PRH-SOCIALS-CHANNEL-ORDER-WRONG',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Socials channels appear in a different order than the imprint specifies (Penguin: Twitter, Facebook, Instagram, YouTube, Pinterest, LinkedIn, TikTok)',
  },
  'PRH-SOCIALS-HANDLE-WRONG': {
    code: 'PRH-SOCIALS-HANDLE-WRONG',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Socials page references a channel but with an unexpected handle (e.g. twitter.com/penguinbooks instead of twitter.com/penguinukbooks)',
  },
  'PRH-SOCIALS-STRAPLINE-MISSING': {
    code: 'PRH-SOCIALS-STRAPLINE-MISSING',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Socials page must include the imprint strapline (Penguin: "Find out more…at Penguin.co.uk"; Vintage: "World-class writing. Beautiful design. Ideas that matter.")',
  },

  // ── Content order (P2/PR4) ─────────────────────────────────────────────
  // Walks the spine and asserts PRH's mandated reading order. All
  // detect-only (spine reordering is risky enough to require operator
  // review). Imprint-gated like the other P2 validators.
  'PRH-ORDER-COVER-NOT-FIRST': {
    code: 'PRH-ORDER-COVER-NOT-FIRST',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Cover spine entry must be the first item in <spine>',
  },
  'PRH-ORDER-MISSING-BRAND-PAGE': {
    code: 'PRH-ORDER-MISSING-BRAND-PAGE',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Brand page must appear in the spine — required by PRH UK mandatory boilerplate (Branding Guide §7) for imprints that ship one',
  },
  'PRH-ORDER-FOOTNOTES-NOT-LAST': {
    code: 'PRH-ORDER-FOOTNOTES-NOT-LAST',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Footnotes file must be the last entry in the spine (separate from the spine-flag rule PRH-SPINE-FOOTNOTES-LAST — this one flags ORDERING, not linear="no")',
  },
  'PRH-ORDER-COPYRIGHT-WRONG-POSITION': {
    code: 'PRH-ORDER-COPYRIGHT-WRONG-POSITION',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Copyright page must appear in the frontmatter portion of the spine (PRH treats copyright as frontmatter, not backmatter)',
  },
  'PRH-ORDER-MISSING-ABOUT-AUTHOR': {
    code: 'PRH-ORDER-MISSING-ABOUT-AUTHOR',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB is missing an About-the-Author section — required in every PRH reflow EPUB (Style Guide §6.6)',
  },

  // ── Body epub:type + doc-* ARIA (P3/PR1) ──────────────────────────────
  // Publisher-gated (not imprint-gated) — these markup rules apply to
  // every PRH UK build regardless of imprint. Detect-only in P3.
  'PRH-MARKUP-EPUB-TYPE-MISPLACED': {
    code: 'PRH-MARKUP-EPUB-TYPE-MISPLACED',
    severity: 'moderate',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'epub:type is allowed on <body> only for cover/frontmatter/bodymatter/backmatter; on <section> chapter/part/dedication/epigraph/appendix are forbidden (use ARIA doc-* role instead)',
  },
  'PRH-MARKUP-EPUB-TYPE-DUPLICATE': {
    code: 'PRH-MARKUP-EPUB-TYPE-DUPLICATE',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Each of cover/frontmatter/bodymatter/backmatter must appear on at most one <body> across the EPUB',
  },
  'PRH-ARIA-CHAPTER-ROLE-MISSING': {
    code: 'PRH-ARIA-CHAPTER-ROLE-MISSING',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'First chapter section should carry role="doc-chapter" instead of epub:type="chapter"',
  },
  'PRH-ARIA-PART-ROLE-MISSING': {
    code: 'PRH-ARIA-PART-ROLE-MISSING',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'First part section should carry role="doc-part" instead of epub:type="part"',
  },
  'PRH-ARIA-DEDICATION-ROLE-MISSING': {
    code: 'PRH-ARIA-DEDICATION-ROLE-MISSING',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'Dedication section should carry role="doc-dedication" instead of epub:type="dedication"',
  },
  'PRH-ARIA-EPIGRAPH-ROLE-MISSING': {
    code: 'PRH-ARIA-EPIGRAPH-ROLE-MISSING',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'Epigraph block should be a <blockquote role="doc-epigraph">',
  },
  'PRH-ARIA-APPENDIX-ROLE-MISSING': {
    code: 'PRH-ARIA-APPENDIX-ROLE-MISSING',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'Appendix section should carry role="doc-appendix" instead of epub:type="appendix"',
  },
  'PRH-BODY-HAS-ARIA': {
    code: 'PRH-BODY-HAS-ARIA',
    severity: 'moderate',
    wcag: ['4.1.2'],
    fixType: 'manual',
    summary: '<body> must NOT carry role / aria-label / aria-labelledby (PRH explicitly prohibits)',
  },
} satisfies Record<string, PrhIssueDefinition>;

export type PrhIssueCode = keyof typeof PRH_ISSUE_CODES;

/** Type-safe lookup. Returns undefined if `code` is not a registered PRH code. */
export function getPrhIssueDefinition(code: string): PrhIssueDefinition | undefined {
  return (PRH_ISSUE_CODES as Record<string, PrhIssueDefinition>)[code];
}

/** All codes as a string list, useful for batch operations. */
export const ALL_PRH_ISSUE_CODES: string[] = Object.keys(PRH_ISSUE_CODES);
