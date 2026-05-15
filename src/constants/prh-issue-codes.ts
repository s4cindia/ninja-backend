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
    // Quick-fix: operator supplies alt text via the existing
    // EPUB-IMG-001-style dialog. The controller arm in
    // epub.controller.ts validates the payload — missing/empty
    // imageAlts, missing imageSrc, or whitespace-only altText all
    // produce a 400 with a clear error message rather than silently
    // writing empty alt to the cover image. addAltText is only
    // invoked when the payload is well-formed; we never fabricate
    // cover alt text or fall back to marking the cover decorative.
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

  // ── Forbidden constructs (P3/PR2) ─────────────────────────────────────
  // Publisher-gated. Detect-only — auto-fix (swap <b>→<strong>, etc.)
  // is a P5 concern because the semantic intent isn't always
  // mechanically recoverable.
  'PRH-MARKUP-DEPRECATED-TAG': {
    code: 'PRH-MARKUP-DEPRECATED-TAG',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Body contains deprecated presentational tags (<b>, <i>, <big>, <small>, <u>, <strike>, <center>, <font>) — PRH requires semantic tags (<strong>, <em>) instead',
  },
  'PRH-MARKUP-INLINE-STYLE': {
    code: 'PRH-MARKUP-INLINE-STYLE',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Body element carries inline style attribute — PRH requires styles in CSS, not inline (Technical Guide §15 allows one demo per book; we flag every instance)',
  },
  'PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION': {
    code: 'PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION',
    severity: 'minor',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'Likely layout <table> (no <th>, ≥6 cells, not marked role="presentation") — PRH requires layout tables to declare role="presentation"',
  },

  // ── Notes + page-break shape (P3/PR3) ─────────────────────────────────
  // Publisher-gated. Detect-only — auto-fix lands in P5 where we can
  // safely insert/repair role attributes on the relevant elements.
  'PRH-FOOTNOTE-ID-MISMATCH': {
    code: 'PRH-FOOTNOTE-ID-MISMATCH',
    severity: 'moderate',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: '<a epub:type="noteref"> references an id that doesn\'t exist on any <aside epub:type="footnote"> or <li> inside <section epub:type="endnotes">. Kindle popup behaviour breaks silently on these mismatches',
  },
  'PRH-PAGEBREAK-MALFORMED': {
    code: 'PRH-PAGEBREAK-MALFORMED',
    severity: 'minor',
    wcag: ['2.4.5'],
    fixType: 'manual',
    summary: '<span epub:type="pagebreak"> must carry role="doc-pagebreak" AND a numeric-only aria-label (no "page"/"pg" prefix, no roman-numeral text)',
  },

  // ── Text-pattern heuristics (P3/PR4) ──────────────────────────────────
  // All publisher-gated and explicitly HEURISTIC. False positives are
  // expected on real content — the FE renders these with an info
  // "review manually" marker (P2-P3 frontend follow-up Prompt 8) so
  // operators don't treat them as definitive bugs. Severity stays at
  // `minor` to keep the FP cost low.
  'PRH-LANG-INLINE-NOT-MARKED': {
    code: 'PRH-LANG-INLINE-NOT-MARKED',
    severity: 'minor',
    wcag: ['3.1.2'],
    fixType: 'manual',
    summary: 'Body contains a run of non-Latin-script text not wrapped in <span lang="…"> — screen readers may mispronounce. Heuristic; review manually before fixing',
  },
  'PRH-HASHTAG-NOT-CAMEL-CASE': {
    code: 'PRH-HASHTAG-NOT-CAMEL-CASE',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Hashtag tokens (#example) must be PascalCase/camelCase so screen readers can pronounce them. Heuristic; review manually',
  },
  'PRH-ACRONYM-INSERTED-SEPARATORS': {
    code: 'PRH-ACRONYM-INSERTED-SEPARATORS',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'ALL-CAPS sequence with inserted separators (N.A.S.A. / F, B, I) — PRH wants compact form (NASA / FBI). Heuristic; review manually for legitimate formal abbreviations',
  },

  // ── CSS conventions (P6/PR1) ──────────────────────────────────────────
  // Publisher-gated and detect-only. Per Technical Guide §15 + Style
  // Guide on the canonical stylesheet stack. Renaming basestyles.css,
  // re-ordering @imports, or rewriting class-name conventions cascades
  // across the publisher's dev pipeline; we surface the finding and let
  // the operator fix in their authoring tool, not auto-remediate.
  'PRH-CSS-BASESTYLES-RENAMED': {
    code: 'PRH-CSS-BASESTYLES-RENAMED',
    severity: 'serious',
    wcag: [],
    fixType: 'manual',
    summary: 'No file named basestyles.css under /styles — PRH Technical Guide §15 requires the canonical filename so Kindle ET, NCX-fallback CSS and brand fonts resolve correctly',
  },
  'PRH-CSS-IMPORT-ORDER-WRONG': {
    code: 'PRH-CSS-IMPORT-ORDER-WRONG',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: '@import order in a PRH stylesheet deviates from the required cascade basestyles → complex → bespoke → mediaquery (Technical Guide §15)',
  },
  'PRH-CSS-CLASS-NAME-HYPHEN': {
    code: 'PRH-CSS-CLASS-NAME-HYPHEN',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Publisher-defined class selector uses hyphen separator (e.g. .first-para) — PRH convention is underscore (.first_para). Vendor/utility prefixes (tw-, bs-, ng-) and non-publisher stylesheets are ignored',
  },
  'PRH-CSS-PER-PARAGRAPH-FONT': {
    code: 'PRH-CSS-PER-PARAGRAPH-FONT',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'A class that sets font-family is applied to 10+ <p> elements — PRH disallows per-paragraph fonts because they break Kindle font-customisation. Set primary font on <body>, override only via bespoke.css',
  },
  'PRH-CSS-INLINE-STYLE-AT-SCALE': {
    code: 'PRH-CSS-INLINE-STYLE-AT-SCALE',
    severity: 'serious',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB contains 100+ inline style="…" attributes across all XHTML — book-wide pattern of inline styles; PRH demonstration carve-out (one per book) does not apply at this scale',
  },

  // ── File / directory / size (P6/PR2) ──────────────────────────────────
  // Publisher-gated and detect-only. Per Technical Guide §3 + §15.
  // Renaming files / restructuring directories cascades through the
  // manifest, hrefs and fragment identifiers, so auto-remediation is
  // unsafe; surface the finding and let the operator fix in their
  // authoring tool.
  'PRH-FILE-XHTML-OVERSIZE': {
    code: 'PRH-FILE-XHTML-OVERSIZE',
    severity: 'serious',
    wcag: [],
    fixType: 'manual',
    summary: 'XHTML chapter exceeds 600KB — PRH requires chapter splits at section boundaries to keep Kindle / older e-readers responsive (Technical Guide §3)',
  },
  'PRH-FILE-PLATE-OVERSIZE': {
    code: 'PRH-FILE-PLATE-OVERSIZE',
    severity: 'serious',
    wcag: [],
    fixType: 'manual',
    summary: 'Plate XHTML exceeds 11MB — too large for Kindle ET / KFX rendering; split image-heavy plate sections',
  },
  'PRH-DIR-LAYOUT-NONSTANDARD': {
    code: 'PRH-DIR-LAYOUT-NONSTANDARD',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB content exists outside the canonical /xhtml /images /fonts /styles directory layout — PRH Technical Guide §3 requires resources under fixed sub-directories so reading systems can resolve cross-file references reliably',
  },
  'PRH-FILE-NAMING-NONSTANDARD': {
    code: 'PRH-FILE-NAMING-NONSTANDARD',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Filename contains uppercase / multiple dots / disallowed characters — PRH requires lowercase alphanumeric + underscore + hyphen with a single dot before the extension',
  },
  'PRH-FILE-FIXED-NAME-MISSING': {
    code: 'PRH-FILE-FIXED-NAME-MISSING',
    severity: 'serious',
    wcag: [],
    fixType: 'manual',
    summary: 'EPUB is missing a required fixed-name file (package.opf / toc.ncx when EPUB2-compat / nav.xhtml / cover.<ext>) — Kindle popup links, NCX fallback navigation and the cover-image surface all resolve by canonical filename',
  },

  // ── Image assets (P6/PR3) ─────────────────────────────────────────────
  // Publisher-gated and detect-only. Per Technical Guide §§11-12 image
  // asset rules: canonical capture sizes per CSS class, ≥300dpi, sRGB,
  // PNG-8 for line-drawings, JPEG quality cap. Operator fixes in their
  // image-prep pipeline; auto-resize lives in P7 if/when demanded.
  'PRH-IMG-CAPTURE-SIZE-WRONG': {
    code: 'PRH-IMG-CAPTURE-SIZE-WRONG',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Image width does not match its CSS-class capture size (e.g. .portrait_large requires 1900px ±5%) — Technical Guide §11 per-class capture sizes',
  },
  'PRH-IMG-DPI-TOO-LOW': {
    code: 'PRH-IMG-DPI-TOO-LOW',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'Image density is below the PRH 300dpi minimum — Technical Guide §11. Images with no embedded DPI metadata are NOT flagged here (EXIF-stripped sources are common)',
  },
  'PRH-IMG-COLORSPACE-NOT-SRGB': {
    code: 'PRH-IMG-COLORSPACE-NOT-SRGB',
    severity: 'moderate',
    wcag: [],
    fixType: 'manual',
    summary: 'Image color space is not sRGB — Technical Guide §11 requires all images to be converted to sRGB so Kindle / KFX rendering is colour-accurate',
  },
  'PRH-IMG-PNG-EXPECTED-JPEG': {
    code: 'PRH-IMG-PNG-EXPECTED-JPEG',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'JPEG image is a low-resolution low-colour line drawing / schematic — PRH recommends PNG-8 for line drawings and text-replacement glyphs. Heuristic: width ≤ 800 AND ≤256 distinct colours',
  },
  'PRH-IMG-JPEG-QUALITY-SUSPECT': {
    code: 'PRH-IMG-JPEG-QUALITY-SUSPECT',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'JPEG file-size-to-pixel ratio suggests quality > 9 — PRH wants JPEG quality 8 (NOT max). Heuristic; cover.jpg is exempt because covers are deliberately kept at maximum quality',
  },

  // ── Content-type markup (P6/PR5) ──────────────────────────────────────
  // Publisher-gated and detect-only. Per Technical Guide §§ sidebars /
  // textboxes / floated elements / poetry / speech bubbles / recipes.
  // Each rule only activates when the relevant construct is present in
  // the book — these are content-type-specific (cookbook / poetry /
  // craft titles) so most books trip none of them.
  'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING': {
    code: 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING',
    severity: 'serious',
    wcag: ['1.3.2'],
    fixType: 'manual',
    summary: 'A .sidebar_wrapper is not paired with a .maincontent_wrapper sibling — PRH requires the main-content wrapper as the immediate sibling so Kindle ET can collapse to a single column in reading order',
  },
  'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER': {
    code: 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER',
    severity: 'moderate',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'A text box (.txt_box*) carries the document\'s first real <h*> heading — PRH requires box headers to use <div class="boxhead"> so they don\'t corrupt the page-level heading order',
  },
  'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER': {
    code: 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER',
    severity: 'moderate',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'A floated box (.floatbox_left / .floatbox_right) contains a real <h*> heading — PRH requires <div class="boxhead"> inside floatboxes so heading-navigation isn\'t corrupted',
  },
  'PRH-MARKUP-POETRY-WRONG-STRUCTURE': {
    code: 'PRH-MARKUP-POETRY-WRONG-STRUCTURE',
    severity: 'serious',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'A .poetry_stanza uses <p> for its lines — PRH requires <div class="poetry_line"> (or .poetry_line_indented) so line breaks survive reflow. Detect-only: Style Guide forbids modifying poetry markup without instruction',
  },
  'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS': {
    code: 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'A speech-bubble <figure> uses a non-canonical class — PRH speech bubbles must use exactly speechbubble / speechbubble_r / speechbubble_bl / speechbubble_br so night-mode inversion works',
  },
  'PRH-MARKUP-METHOD-STEPS-NOT-OL': {
    code: 'PRH-MARKUP-METHOD-STEPS-NOT-OL',
    severity: 'moderate',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'A run of <p> paragraphs is numbered like recipe method steps (1. 2. 3.) but not marked up as an <ol> — PRH requires <ol class="method_steps">. Heuristic; only fires when the book already uses .method_steps elsewhere (cookbook signal)',
  },

  // ── Audio / video markup (P6/PR4) ─────────────────────────────────────
  // Publisher-gated and detect-only. The MARKUP rules — these three —
  // are pure XHTML checks. The codec / bitrate / dimensions rules
  // (PRH-MEDIA-VIDEO-NOT-H264-BASELINE etc.) are deferred to a follow-up
  // pending a media-inspection decision; they need ffprobe-grade
  // container parsing that isn't worth building speculatively.
  'PRH-MEDIA-WRAPPER-MISSING': {
    code: 'PRH-MEDIA-WRAPPER-MISSING',
    severity: 'serious',
    wcag: ['1.3.1'],
    fixType: 'manual',
    summary: 'A <video> or <audio> element is not wrapped in <figure class="media_wrapper"> — PRH requires the figure wrapper so media has a consistent structural container and reflows predictably',
  },
  'PRH-MEDIA-FALLBACK-TEXT-MISSING': {
    code: 'PRH-MEDIA-FALLBACK-TEXT-MISSING',
    severity: 'serious',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'A <video> or <audio> element has no fallback text for reading systems that cannot play it — PRH requires fallback content describing the media inside the element',
  },
  'PRH-MEDIA-INLINE-WIDTH': {
    code: 'PRH-MEDIA-INLINE-WIDTH',
    severity: 'minor',
    wcag: [],
    fixType: 'manual',
    summary: 'A <video> or <audio> element sets width via a width attribute or inline style — PRH requires media width to be set in CSS, not on the element',
  },

  // ── Figure long-description detection (P6/PR6) ────────────────────────
  // Publisher-gated and detect-only. Per PRH Technical Guide, long
  // descriptions of complex images belong in a non-linear XHTML
  // appendix (linked via aria-describedby), not inline in <figcaption>.
  // We flag the cases worth refactoring; the actual non-linear-XHTML
  // remediator is deferred until tenant demand surfaces.
  'PRH-FIGURE-LONG-DESC-INLINE': {
    code: 'PRH-FIGURE-LONG-DESC-INLINE',
    severity: 'minor',
    wcag: ['1.1.1'],
    fixType: 'manual',
    summary: 'A <figcaption> contains 250+ characters of text — PRH recommends moving long descriptions to a non-linear XHTML appendix (file_longdesc<N>.xhtml linked via aria-describedby) so the main reading flow stays uncluttered',
  },
} satisfies Record<string, PrhIssueDefinition>;

export type PrhIssueCode = keyof typeof PRH_ISSUE_CODES;

/** Type-safe lookup. Returns undefined if `code` is not a registered PRH code. */
export function getPrhIssueDefinition(code: string): PrhIssueDefinition | undefined {
  return (PRH_ISSUE_CODES as Record<string, PrhIssueDefinition>)[code];
}

/** All codes as a string list, useful for batch operations. */
export const ALL_PRH_ISSUE_CODES: string[] = Object.keys(PRH_ISSUE_CODES);
