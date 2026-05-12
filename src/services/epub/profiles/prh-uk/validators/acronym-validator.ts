/**
 * PRH UK acronym separator detector (P3/PR4).
 *
 * Per Style Guide §13, acronyms must appear in compact form
 * (`NASA`, `USA`, `FBI`), not with separators between each letter
 * (`N.A.S.A.`, `U S A`, `F.B.I.`). Reading systems often re-announce
 * separator-inserted acronyms letter-by-letter twice (once for each
 * separator, once for the letter group), producing audio like
 * "n dot a dot s dot a dot".
 *
 * The rule is the HIGHEST false-positive risk of P3 — formal English
 * abbreviations legitimately use periods (`U.S.`, `e.g.`, `Ph.D.`).
 * We minimise FPs with two thresholds:
 *   - REQUIRE ≥3 letters with separators between EACH pair. Two-letter
 *     sequences with separators (`U.S.`, `J.K.`) are skipped — those
 *     are routine and rarely cause TTS problems.
 *   - Accepted separators: `.`, `,`, single space.
 *   - One issue per file with the full list of offenders (up to 5
 *     shown). Same high-volume design as hashtag-validator.
 *
 * Issue code: PRH-ACRONYM-INSERTED-SEPARATORS. Heuristic — severity
 * minor, surfaced with the "review manually" FE cue. Detect-only.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import { stripHtmlMarkup } from './text-utils';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * Match runs of ≥3 capital letters separated by `.`, `,`, or single
 * space between each pair. Examples that match:
 *   N.A.S.A.   F.B.I.   U S A    A,B,C    R.S.V.P.
 * Examples that DON'T match (rejected by thresholds):
 *   U.S.    J.K.    e.g.    a.m.    NASA    N.A.    A B C D
 *                                                        ^ runs of >1 space break it
 *
 * Pattern: letter, then 2+ groups of (separator + letter). After
 * the leading letter we require an OPTIONAL trailing separator. The
 * `\b` boundary at the start prevents matching the middle of a
 * longer word.
 */
const ACRONYM_REGEX = /\b([A-Z])([.,] |[.,]|\s)([A-Z])(?:\2([A-Z]))+\2?/g;

export function validatePrhAcronyms(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    const text = stripHtmlMarkup(file.content);
    ACRONYM_REGEX.lastIndex = 0;

    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = ACRONYM_REGEX.exec(text)) !== null) {
      offenders.push(m[0].trim());
    }

    if (offenders.length === 0) continue;

    const unique = Array.from(new Set(offenders));
    issues.push(buildIssue(file.path, unique));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildIssue(location: string, offenders: string[]): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-ACRONYM-INSERTED-SEPARATORS'];
  const sample = offenders.slice(0, 5).map((o) => `"${o}"`).join(', ');
  const moreNote = offenders.length > 5 ? ` (+${offenders.length - 5} more)` : '';
  return {
    code: 'PRH-ACRONYM-INSERTED-SEPARATORS',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} — ${offenders.length} acronym(s) with inserted separators: ${sample}${moreNote}.`,
    suggestion:
      `Rewrite each acronym in compact form: e.g. "N.A.S.A." → "NASA", "F, B, I" → "FBI". Two-letter abbreviations (U.S., J.K.) are not flagged; review individually if your house style differs.`,
    location,
  };
}
