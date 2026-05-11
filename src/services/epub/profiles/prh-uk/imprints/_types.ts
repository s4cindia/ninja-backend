/**
 * Shape of per-imprint rules used by P2 boilerplate validators.
 *
 * Each imprint exports an `ImprintRules` object listing the verbatim
 * strings that must appear in its copyright page, the brand-page logo
 * alt text, the title-page logo alt text, and the socials-page rules
 * (when applicable). The matcher (`copyright-content-validator.ts`)
 * normalises whitespace and case before searching, so the strings here
 * should be the *canonical* PRH form — not regex-tolerant fragments.
 */

import type { PrhIssueSeverity } from '../../../../../constants/prh-issue-codes';

/**
 * A "must-contain" check against the normalised copyright text. Provide
 * either a `needle` (substring match, case-insensitive after
 * normalisation) OR a `regex` (pattern match against the normalised
 * text). Use `regex` for format checks like ISBN where presence of the
 * word alone isn't enough.
 */
export interface CopyrightContentCheck {
  /** PRH-COPY-* code emitted when the needle/regex doesn't match. */
  code: string;
  /**
   * Substring to search for in the normalised copyright text. Should be
   * a short distinctive fragment, NOT the whole boilerplate paragraph —
   * matching the entire prose is brittle to typesetting drift. Provide
   * either `needle` OR `regex`; if both are supplied the regex wins.
   */
  needle?: string;
  /**
   * Pattern to match against the normalised text. Use this for format
   * checks (e.g. ISBN-13 digit pattern) where a plain substring match
   * would let placeholders like "ISBN pending" pass.
   */
  regex?: RegExp;
  severity: PrhIssueSeverity;
  /**
   * Human-readable note about WHAT the operator should add. The
   * verbatim text is usually too long for the suggestion field; point
   * the operator at the canonical source instead.
   */
  suggestion: string;
}

/**
 * Brand-page rules per imprint (P2/PR2).
 *
 * Per Branding Guide §6, every imprint except #Merky and Cornerstone Saga
 * ships a dedicated brand page — a frontmatter section with
 * `<body epub:type="frontmatter" id="brand_page">` containing a full-bleed
 * imprint logo. The logo's CSS class differs by imprint (`.brand_logo_solo`
 * for most, `.image_full` for Vintage) and the alt text matches the
 * imprint's marketing name ("Penguin Random House", "Puffin Books", etc.).
 *
 * When `null`, the imprint has no brand page in the canonical template
 * and the validator should not emit `PRH-BRAND-PAGE-MISSING` for that
 * imprint.
 */
export interface BrandPageRules {
  /** Expected CSS class on the brand-page <figure>. */
  figureClass: 'brand_logo_solo' | 'image_full';
  /**
   * Expected alt text on the brand-page <img>. Matched
   * case-insensitively after whitespace normalisation.
   */
  logoAlt: string;
}

/**
 * Title-page rules per imprint (P2/PR2).
 *
 * Every PRH imprint ships a title page, but the shape differs:
 *   - Penguin (adult) — six structural variants. The validator does
 *     a soft fingerprint match (which structural elements are present)
 *     so any of the 6 variants passes.
 *   - Puffin — full-bleed image-only title page (`<figure class="image_full">`
 *     with descriptive alt text).
 *   - Pelican — `<body class="pelican_titlepage">`, drops `<hr/>`.
 *   - Ladybird — adds `<figure class="portrait_small">` interior
 *     illustration + credits.
 *   - #Merky — single bespoke title page (Penguin Random House logo
 *     parent group).
 *   - Vintage — n/a (Vintage's bespoke template doesn't include a
 *     separate title-page section).
 *   - Cornerstone Saga — n/a.
 *
 * Imprints with `titlePage: null` are skipped by the validator (the
 * imprint genuinely doesn't have one in the canonical template).
 */
export interface TitlePageRules {
  /**
   * Expected alt text on the `<figure class="imprint_logo">` <img>.
   * Matched case-insensitively after whitespace normalisation. Most
   * imprints reference the parent group ("Penguin Random House"); a few
   * use their own marketing name (Pelican → "Pelican Books").
   */
  logoAlt: string;
  /**
   * Whether this imprint uses the image-only title page (Puffin's full-bleed
   * pattern). When true the validator looks for `<figure class="image_full">`
   * instead of the structured `<section epub:type="titlepage">`, and the
   * imprint_logo check is dropped (Puffin embeds the logo inside the
   * full-bleed image).
   */
  imageOnly?: boolean;
}

export interface ImprintRules {
  /**
   * Stable identifier — must match a `PrhImprint` value. Used to look up
   * rules from `getImprintRules()`.
   */
  imprint: string;
  /** Display name surfaced in issue messages. */
  displayName: string;
  /**
   * Which copyright template this imprint uses. Most imprints use the
   * adult or children's template (with imprint-specific deltas); Vintage
   * is bespoke.
   */
  copyrightTemplate: 'adult' | 'children' | 'vintage-bespoke';
  /**
   * Ordered list of must-contain checks the copyright-content validator
   * runs. Each missing needle emits its `code` against the copyright
   * XHTML's path.
   */
  copyrightContentChecks: CopyrightContentCheck[];
  /**
   * Brand-page expectations. `null` when the imprint has no brand page
   * in the canonical template (#Merky, Cornerstone Saga).
   */
  brandPage: BrandPageRules | null;
  /**
   * Title-page expectations. `null` when the imprint has no separate
   * title page (Vintage, Cornerstone Saga).
   */
  titlePage: TitlePageRules | null;
  // Future fields land in P2/PR3:
  //   socials: { channels: SocialChannel[]; strapline?: string } | null;
}
