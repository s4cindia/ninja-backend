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
 * A "must-contain" check against the normalised copyright text. Code,
 * needle, and severity are mandatory; suggestion is shown to the
 * operator when the needle is missing.
 */
export interface CopyrightContentCheck {
  /** PRH-COPY-* code emitted when the needle is not found. */
  code: string;
  /**
   * Needle to search for in the normalised copyright text. Should be a
   * short distinctive fragment, NOT the whole boilerplate paragraph —
   * matching the entire prose is brittle to typesetting drift. For the
   * TDM-reservation paragraph for example, "Article 4(3) of the DSM
   * Directive" is enough to uniquely identify it.
   */
  needle: string;
  severity: PrhIssueSeverity;
  /**
   * Human-readable note about WHAT the operator should add. The
   * verbatim text is usually too long for the suggestion field; point
   * the operator at the canonical source instead.
   */
  suggestion: string;
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
  // Future fields land in P2/PR2-PR3:
  //   brandPage: { logoAlt: string; brandFigureClass: string };
  //   titlePage: { logoAlt: string; acceptedVariants: TitleVariantFingerprint[] };
  //   socials: { channels: SocialChannel[]; strapline?: string } | null;
}
