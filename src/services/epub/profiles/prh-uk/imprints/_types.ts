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
/**
 * Discriminated union: the structured-titlepage path validates an
 * imprint-logo alt, but the image-only path skips that check entirely
 * (the logo is baked into the full-bleed image). Modelling these as
 * separate variants prevents config drift — e.g. setting both
 * `imageOnly: true` and `logoAlt: 'Puffin Books'` (where the alt would
 * silently be ignored).
 */
export type TitlePageRules =
  | {
      /**
       * Image-only title page (Puffin's full-bleed pattern). The
       * validator looks for `<figure class="image_full">` inside a
       * frontmatter body and skips the imprint-logo check — the image
       * itself carries the imprint mark + descriptive alt.
       */
      imageOnly: true;
    }
  | {
      /**
       * Structured title page (Penguin / Pelican / Ladybird / #Merky).
       * `imageOnly` is omitted or explicitly false on this branch.
       */
      imageOnly?: false;
      /**
       * Expected alt text on the `<figure class="imprint_logo">` <img>.
       * Matched case-insensitively after whitespace normalisation. Most
       * imprints reference the parent group ("Penguin Random House");
       * a few use their own marketing name (Pelican → "Pelican Books").
       */
      logoAlt: string;
    };

/**
 * Per-channel needle for a socials page (P2/PR3).
 *
 * Each channel has a stable `id` (used to detect missing channels and
 * to assert ordering) and a `handle` — a URL or @-handle fragment that
 * MUST appear in the socials page content. The handle is matched as a
 * lowercased substring after whitespace normalisation, so it tolerates
 * markup variations like `<a href="...">@vintagebooks</a>` vs
 * `Twitter: @vintagebooks` vs link wrapping.
 */
export interface SocialChannel {
  /** Channel identifier — used for ordering and missing-channel diagnostics. */
  id: 'twitter' | 'facebook' | 'instagram' | 'youtube' | 'pinterest' | 'linkedin' | 'tiktok' | 'newsletter';
  /** Substring that must appear in the socials page (case-insensitive, post-normalisation). */
  handle: string;
  /**
   * Optional context-aware matcher used when the bare `handle` is
   * ambiguous across channels. Vintage is the motivating case — three
   * of its four channels share the handle "@vintagebooks", so a plain
   * `includes('@vintagebooks')` returns the same index for all three
   * and silently bypasses the order check. When `detector` is set, the
   * validator uses its match position for ordering/presence; `handle`
   * is still surfaced in messages and suggestions as the canonical
   * text the operator should display. The detector should be
   * case-insensitive (the haystack is lowercased before matching).
   */
  detector?: RegExp;
}

/**
 * Socials-page rules per imprint (P2/PR3).
 *
 * Per Branding Guide §6, the "Follow us" / socials page is in
 * `<body epub:type="backmatter">`. Only a handful of imprints ship
 * one in the canonical template:
 *
 *   - Penguin → 7 channels in a prescribed order, plus a closing
 *     strapline pointing at Penguin.co.uk.
 *   - Vintage → 4 channels (Twitter / Instagram / TikTok / Facebook),
 *     all under `@vintagebooks` except TikTok (`@vintageukbooks`),
 *     plus the Vintage strapline.
 *   - Cornerstone Saga → Facebook + Penny Street newsletter URL.
 *   - Puffin / Pelican / Ladybird / #Merky → no socials page;
 *     `socials: null` skips the validator entirely.
 *
 * Penguin's "YA cut-down" socials page (`follow_penguin_ya.xhtml`,
 * Instagram + YouTube + TikTok @houseofya only) is treated as an
 * alternate Penguin variant in the detector; the validator falls
 * back to the full 7-channel ruleset when both variants are absent
 * but doesn't false-positive on a conformant YA-only build.
 */
export interface SocialsRules {
  /**
   * Ordered list of expected channels. Order is enforced via
   * `PRH-SOCIALS-CHANNEL-ORDER-WRONG`; presence is enforced via
   * `PRH-SOCIALS-CHANNEL-MISSING`; handle correctness is enforced via
   * `PRH-SOCIALS-HANDLE-WRONG`.
   */
  channels: SocialChannel[];
  /**
   * Optional verbatim strapline expected at the foot of the socials
   * page. When set, `PRH-SOCIALS-STRAPLINE-MISSING` fires when it's
   * absent. Match is case-insensitive substring after whitespace
   * collapse.
   */
  strapline?: string;
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
  /**
   * Socials-page expectations. `null` when the imprint has no
   * dedicated socials page in the canonical template (Puffin, Pelican,
   * Ladybird, #Merky).
   */
  socials: SocialsRules | null;
  /**
   * Optional secondary socials ruleset for imprints that ship a
   * cut-down variant (Penguin's `follow_penguin_ya.xhtml` is the
   * motivating case — YA editions list Instagram + YouTube + TikTok
   * only, with TikTok pointing at `@houseofya`). When the validator
   * detects the YA-variant filename it switches to these rules in
   * place of the full set; otherwise undefined means the imprint
   * has no YA variant.
   */
  socialsYa?: SocialsRules;
}
