/**
 * PRH UK inline-language detector (P3/PR4).
 *
 * Per Technical Guide §6.3, body content in a non-document language
 * must be wrapped in `<span lang="…">` so screen readers switch
 * pronunciation rules at the run boundary. Real EPUBs frequently
 * forget to mark inline foreign phrases — a single Russian quote in
 * an English novel will be mispronounced as English without the
 * wrapper.
 *
 * SCOPE: this validator detects NON-LATIN-SCRIPT runs only. Latin-
 * script foreign content (French, German, Spanish, etc.) shares the
 * Latin Unicode range with English and can't be distinguished by
 * Unicode block alone — that would need a language-detection model.
 * Latin-script detection is explicitly out of scope (P4 territory).
 *
 * Detection rule:
 *   - Strip HTML markup. Strip text inside any element that already
 *     carries `lang="…"` (those are already marked).
 *   - Scan the remaining visible text for runs of ≥3 characters in
 *     one of the targeted non-Latin Unicode blocks (Cyrillic,
 *     Devanagari, Arabic, Hebrew, Greek, CJK Han, Hiragana, Katakana,
 *     Hangul, Thai). Three-char threshold avoids FPs on stray special
 *     characters (em-dashes, smart quotes, single emoji).
 *   - One issue per file, regardless of how many runs are found
 *     (high-volume rule — the FE grouping prompt collapses these).
 *
 * Issue code: PRH-LANG-INLINE-NOT-MARKED. Heuristic; severity minor.
 * Detect-only.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import { stripHtmlMarkup } from './text-utils';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * Per-script minimum-run thresholds:
 *
 *   - Logographic / syllabic scripts (Han / Hiragana / Katakana /
 *     Hangul) carry one full word per 1–2 glyphs. A 2-character run
 *     like `北京` (Beijing) is a real word; demanding 3 would miss
 *     most realistic inline-CJK cases in English text.
 *   - Alphabetic scripts (Cyrillic, Devanagari, Arabic, Hebrew, Greek,
 *     Thai) need ≥3 letters to represent a meaningful run. The 3-char
 *     gate excludes stray special-character noise (single emoji,
 *     transliterated diacritics) without missing real phrases.
 *
 * Two regexes, OR-combined per scan. `u` flag is required for the
 * Unicode-property classes.
 */
const NON_LATIN_HIGH_DENSITY_REGEX = new RegExp(
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]{2,}',
  'gu',
);
const NON_LATIN_ALPHABETIC_REGEX = new RegExp(
  '[\\p{Script=Cyrillic}\\p{Script=Devanagari}\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Greek}\\p{Script=Thai}]{3,}',
  'gu',
);

export function validatePrhInlineLang(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    // Strip elements that already carry a lang attribute — anything
    // inside is correctly marked, so it shouldn't count toward the
    // "missing wrap" heuristic. We do this by removing the entire
    // element-content span between a lang-bearing open tag and its
    // matching close tag. The regex is intentionally non-greedy AND
    // shallow (single-level): nested lang attributes are rare enough
    // that ignoring them is acceptable for a heuristic detector.
    const withoutLangWraps = stripLangBearingElements(file.content);
    const withoutMarkup = stripHtmlMarkup(withoutLangWraps);

    NON_LATIN_HIGH_DENSITY_REGEX.lastIndex = 0;
    NON_LATIN_ALPHABETIC_REGEX.lastIndex = 0;
    // Two independent scans — one per threshold class — then merge.
    // Han/Hiragana/Katakana/Hangul match at 2+ chars; the alphabetic
    // scripts at 3+. Runs from each regex are stable substrings so
    // a simple concat is fine.
    const matches = [
      ...(withoutMarkup.match(NON_LATIN_HIGH_DENSITY_REGEX) ?? []),
      ...(withoutMarkup.match(NON_LATIN_ALPHABETIC_REGEX) ?? []),
    ];
    if (matches.length === 0) continue;

    // Show up to 3 sample runs in the message so operators can find
    // the offending text quickly. Trim each sample so a multi-line
    // run doesn't bloat the message.
    const samples = matches
      .slice(0, 3)
      .map((m) => m.trim().slice(0, 40))
      .filter((s) => s.length > 0);

    issues.push(buildIssue(file.path, matches.length, samples));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Remove the content of every INNER element that opens with a
 * `lang=` attribute (or `xml:lang=`). Document-level lang on `<html>`
 * / `<body>` is intentionally NOT stripped — that's the DEFAULT
 * language of the document, against which the rest of the content is
 * already assumed to be aligned. Foreign-language runs are
 * deviations from that default and must be wrapped in INNER
 * `<span lang="…">` / `<section lang="…">` elements; only those
 * inner wraps should suppress the heuristic.
 *
 * Missed nested wraps (a lang span inside another lang span) are
 * tolerated — for a heuristic detector, the worst case is a false
 * positive the operator dismisses.
 */
function stripLangBearingElements(html: string): string {
  // Match INNER open tags that carry lang or xml:lang, then everything
  // up to the corresponding close tag for the SAME tag name. The
  // negative lookahead `(?!html|body)\b` rejects the document-level
  // wrappers — without it, an outer `<html lang="en">` would scoop
  // up the entire body content and silence every foreign-language
  // run, defeating the validator.
  return html.replace(
    /<(?!html\b|body\b)([a-z][a-z0-9]*)\b[^>]*(?:^|\s)(?:lang|xml:lang)\s*=\s*["'][^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
}

function buildIssue(location: string, runCount: number, samples: string[]): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-LANG-INLINE-NOT-MARKED'];
  const samplesPart = samples.length > 0 ? ` Examples: ${samples.map((s) => `"${s}"`).join(', ')}.` : '';
  return {
    code: 'PRH-LANG-INLINE-NOT-MARKED',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} contains ${runCount} unmarked non-Latin-script run(s).${samplesPart}`,
    suggestion:
      `Wrap each foreign-language run in <span lang="<ISO-639-1>">…</span> (e.g. <span lang="ru">…</span> for Russian). For long-form passages, set lang on the containing section instead. Latin-script foreign content (French, German, etc.) is not auto-detected — wrap manually.`,
    location,
  };
}
