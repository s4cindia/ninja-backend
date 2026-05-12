/**
 * PRH UK inline-style validator (P3/PR2).
 *
 * Per Technical Guide §15, PRH disallows inline `style="…"` attributes
 * on body content. The spec carves out one demonstration exception
 * per book, but in practice operators copy patterns across chapters
 * and the carve-out is hard to enforce. We flag every occurrence and
 * surface the count — the operator can dismiss expected demo cases
 * via the FE dismiss workflow (see P2-P3-Frontend-Followups Prompt 9).
 *
 * Issue code: PRH-MARKUP-INLINE-STYLE. One issue per offending file
 * with the aggregate count. Same shape as forbidden-tags-validator so
 * the FE grouping treatment works identically. Detect-only — auto-fix
 * (extract to CSS class) is risky and lands in P5.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * Matches `style="…"` (or `style='…'`) on ANY element. The leading
 * anchor MUST be start-of-string or whitespace — using `\b` alone
 * would false-match `data-style`/`data-base-style` because the
 * regex-word-boundary `\b` lands between `-` and `s` (transition
 * from non-word to word). Whitespace anchoring is how HTML
 * attributes actually serialise, so this is both stricter and more
 * accurate.
 *
 * The regex deliberately operates on the entire file (head + body)
 * because PRH bans inline style globally; we don't want to miss head-
 * level <link rel="stylesheet" style=""> oddities. False positives on
 * `<style>…</style>` ELEMENTS aren't possible because we require an
 * `=` sign after `style`.
 */
const INLINE_STYLE_REGEX = /(?:^|\s)style\s*=\s*["'][^"']*["']/gi;

export function validatePrhInlineStyles(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    INLINE_STYLE_REGEX.lastIndex = 0;
    const matches = file.content.match(INLINE_STYLE_REGEX);
    if (!matches || matches.length === 0) continue;

    issues.push(buildIssue(file.path, matches.length));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildIssue(location: string, count: number): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-MARKUP-INLINE-STYLE'];
  return {
    code: 'PRH-MARKUP-INLINE-STYLE',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} contains ${count} inline style attribute(s).`,
    suggestion:
      `Move per-element style declarations into a CSS class in your stylesheet (see Technical Guide §15). PRH allows one demonstration inline style per book; dismiss this issue if the affected element is the one demo case.`,
    location,
  };
}
