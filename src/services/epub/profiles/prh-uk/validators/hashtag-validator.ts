/**
 * PRH UK hashtag camelCase validator (P3/PR4).
 *
 * Per Style Guide §13, hashtags in body text must use PascalCase or
 * camelCase so screen readers can split the token into pronounceable
 * words. A lowercase hashtag like `#womenintech` is announced as one
 * un-parseable string; `#WomenInTech` lets the screen reader read
 * "women in tech" word-by-word.
 *
 * Detection rule:
 *   - Strip HTML markup. Then scan visible text for `#<token>`
 *     occurrences where <token> is alphanumeric (no spaces).
 *   - Skip tokens that are all-digits (`#1`, `#42` — page refs and
 *     numbers, not hashtags).
 *   - A token PASSES when it contains at least one internal capital
 *     letter at position ≥1 (so `#WomenInTech`, `#nytBestseller`,
 *     `#PRHUK` all pass). Tokens that are all-lower / all-upper
 *     (`#womenintech`, `#NYTBESTSELLER`) FAIL.
 *   - One issue per file with the full list of offending tokens (up
 *     to 5 shown in the message).
 *
 * Issue code: PRH-HASHTAG-NOT-CAMEL-CASE. Heuristic — severity minor,
 * surfaced with a "review manually" cue (FE Prompt 8). Detect-only.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import { stripHtmlMarkup } from './text-utils';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * Hashtag token: `#` followed by ≥2 alphanumeric characters. The
 * minimum-length guard avoids matching `#1` (page number style) and
 * single-letter fragments. The token continues through letters /
 * digits / underscores; it terminates at the first character that
 * isn't part of `\w`.
 */
const HASHTAG_TOKEN_REGEX = /#(\w{2,})/g;

export function validatePrhHashtags(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    const text = stripHtmlMarkup(file.content);
    HASHTAG_TOKEN_REGEX.lastIndex = 0;

    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_TOKEN_REGEX.exec(text)) !== null) {
      const token = m[1];
      // Skip all-digit tokens (e.g. "#42" — a page reference, not a
      // hashtag).
      if (/^\d+$/.test(token)) continue;
      if (!isPascalOrCamelCase(token)) {
        offenders.push(`#${token}`);
      }
    }

    if (offenders.length === 0) continue;

    // De-duplicate — same hashtag appearing multiple times shouldn't
    // inflate the count.
    const unique = Array.from(new Set(offenders));
    issues.push(buildIssue(file.path, unique));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * True when the token is camelCase or PascalCase — i.e. contains a
 * mix of lower and upper case letters with at least one capital at
 * position ≥1 (or is an Acronym-style mixed-case token like `PRHUK`).
 *
 * We treat ALL-UPPER as a fail because screen readers don't get a
 * pronunciation hint from it — Style Guide §13 example is
 * `#WomenInTech` not `#WOMENINTECH`. ALL-LOWER also fails.
 */
function isPascalOrCamelCase(token: string): boolean {
  // Strip leading digits (rare but possible, e.g. `#1stPlace`).
  const letterPart = token.replace(/^\d+/, '');
  if (letterPart.length < 2) return true; // too short to assess
  const hasLower = /[a-z]/.test(letterPart);
  const hasUpper = /[A-Z]/.test(letterPart);
  // Need BOTH cases present. All-lower or all-upper fails.
  return hasLower && hasUpper;
}

function buildIssue(location: string, offenders: string[]): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-HASHTAG-NOT-CAMEL-CASE'];
  const sample = offenders.slice(0, 5).join(', ');
  const moreNote = offenders.length > 5 ? ` (+${offenders.length - 5} more)` : '';
  return {
    code: 'PRH-HASHTAG-NOT-CAMEL-CASE',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} — ${offenders.length} unique non-camelCase hashtag(s): ${sample}${moreNote}.`,
    suggestion:
      `Rewrite each hashtag using internal capitals so a screen reader can split words: e.g. "#womenintech" → "#WomenInTech", "#nytbestseller" → "#nytBestseller".`,
    location,
  };
}
