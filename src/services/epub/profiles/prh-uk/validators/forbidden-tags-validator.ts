/**
 * PRH UK forbidden-tags validator (P3/PR2).
 *
 * Per Technical Guide §6.2, PRH bans the following presentational
 * tags everywhere in body content:
 *   <b>     — use <strong>
 *   <i>     — use <em>
 *   <big>   — drop or restyle via CSS
 *   <small> — drop or restyle via CSS
 *   <u>     — discouraged (looks like a link); restyle via CSS class
 *   <strike>/<s> — use <del> with explanatory text where semantically valid
 *   <center>— layout via CSS
 *   <font>  — layout via CSS
 *
 * Real PRH books that pre-date the current Style Guide carry these
 * legacy tags routinely — a single book can fire 50–300 instances.
 * To keep the issue list manageable we emit ONE issue per offending
 * file with the aggregate count, not one issue per tag occurrence.
 * The FE grouping prompt (P2-P3-Frontend-Followups Prompt 7) will
 * collapse multiple files into a single header row.
 *
 * Issue code: PRH-MARKUP-DEPRECATED-TAG. Detect-only (auto-swap
 * <b>→<strong> lands in P5 where we can review semantic intent).
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/** Deprecated / forbidden tags. Order is irrelevant. */
const FORBIDDEN_TAGS = ['b', 'i', 'big', 'small', 'u', 'strike', 's', 'center', 'font'] as const;

/**
 * Single regex per tag that matches the opening tag in body content.
 * Boundary on the character following the tag name so `<b>` matches
 * but `<body>` / `<br>` / `<blockquote>` don't.
 *
 * Self-closing variants (`<i/>`) are uncommon in XHTML but tolerated.
 */
const FORBIDDEN_TAG_REGEXES: Record<string, RegExp> = Object.fromEntries(
  FORBIDDEN_TAGS.map((tag) => [tag, new RegExp(`<${tag}(?=[\\s/>])`, 'gi')]),
);

export function validatePrhForbiddenTags(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    // Strip <head>…</head> before scanning — `<style>` / `<title>`
    // shouldn't be examined as body content, and head-resident styles
    // can carry forbidden tag NAMES in CSS selectors (e.g. a stylesheet
    // that selects `b { font-weight: ... }`). Body-only scope avoids
    // false positives there.
    const body = stripHead(file.content);

    const counts: Record<string, number> = {};
    let total = 0;
    for (const tag of FORBIDDEN_TAGS) {
      // Reset the regex `lastIndex` for global regexes between files.
      FORBIDDEN_TAG_REGEXES[tag].lastIndex = 0;
      const matches = body.match(FORBIDDEN_TAG_REGEXES[tag]);
      if (matches && matches.length > 0) {
        counts[tag] = matches.length;
        total += matches.length;
      }
    }
    if (total === 0) continue;

    const breakdown = Object.entries(counts)
      .map(([tag, n]) => `<${tag}>×${n}`)
      .join(', ');
    issues.push(buildIssue(file.path, total, breakdown));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function stripHead(html: string): string {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
}

function buildIssue(location: string, total: number, breakdown: string): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-MARKUP-DEPRECATED-TAG'];
  return {
    code: 'PRH-MARKUP-DEPRECATED-TAG',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} contains ${total} deprecated tag(s) — ${breakdown}.`,
    suggestion:
      `Replace <b>/<i> with semantic <strong>/<em>; drop <big>/<small>/<font>/<center> and restyle via CSS; reserve <u> for genuine semantic underlines (rare). See Technical Guide §6.2.`,
    location,
  };
}
