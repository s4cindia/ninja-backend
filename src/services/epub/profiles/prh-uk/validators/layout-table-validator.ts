/**
 * PRH UK layout-table validator (P3/PR2).
 *
 * Per Technical Guide §6.2, layout tables are forbidden EXCEPT when
 * they declare `role="presentation"` (the dialogue-table pattern is
 * the canonical example). A `<table>` without any `<th>` AND without
 * `role="presentation"` is therefore likely a layout table.
 *
 * Heuristic + threshold to keep false-positive rate manageable:
 *   - Skip <table> with `role="presentation"` (or `role="none"`).
 *   - Skip <table> with at least one `<th>` (legitimate data table —
 *     ACE's own EPUB-STRUCT-002 covers the "no <th>" case separately,
 *     so we don't compete with that rule).
 *   - Require ≥6 cells before flagging. Small 2–3 cell tables in
 *     fiction (recipe ingredients lists, dedications, ornament rows)
 *     genuinely lack <th> without being layout tables.
 *   - One issue per offending table, with the file as the location
 *     and a 1-based table index in the message.
 *
 * Issue code: PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION. Detect-only.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/** Minimum cell count before a no-<th> table is considered layout. */
const LAYOUT_TABLE_MIN_CELLS = 6;

export function validatePrhLayoutTables(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    // Find each <table>…</table> block. The regex is non-greedy so
    // nested or sibling tables are handled independently.
    const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
    let m: RegExpExecArray | null;
    let tableIndex = 0;
    while ((m = tableRe.exec(file.content)) !== null) {
      tableIndex += 1;
      const openAttrs = m[1];
      const innerHtml = m[2];

      // Skip if the table declares role="presentation" (or "none" —
      // ARIA treats them as synonyms for "no semantic role"). The
      // leading anchor MUST be start-of-string or whitespace, NOT
      // `\b`: `\b` would land between `-` and `r` in `data-role`,
      // letting a `data-role="presentation"` metadata attribute
      // silently suppress the issue. Whitespace anchoring is how
      // HTML attributes actually serialise.
      const roleMatch = openAttrs.match(/(?:^|\s)role\s*=\s*["']([^"']+)["']/i);
      if (roleMatch) {
        const tokens = roleMatch[1].split(/\s+/).map((t) => t.toLowerCase());
        if (tokens.includes('presentation') || tokens.includes('none')) continue;
      }

      // Skip if the table has at least one <th>. The "no <th>" case
      // is covered by a separate accessibility rule (EPUB-STRUCT-002);
      // we focus on the layout-table-without-presentation gap PRH
      // calls out.
      if (/<th\b/i.test(innerHtml)) continue;

      // Count cells. We treat <td> as the canonical cell tag — a
      // layout table by definition has no <th>, so <td> count alone
      // is the heuristic threshold.
      const cellMatches = innerHtml.match(/<td\b/gi);
      const cellCount = cellMatches ? cellMatches.length : 0;
      if (cellCount < LAYOUT_TABLE_MIN_CELLS) continue;

      issues.push(buildIssue(file.path, tableIndex, cellCount));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildIssue(location: string, tableIndex: number, cellCount: number): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION'];
  return {
    code: 'PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} table #${tableIndex} (${cellCount} cells, no <th>) is likely a layout table and must declare role="presentation".`,
    suggestion:
      `If this is a layout table (e.g. dialogue, sidebar arrangement), add role="presentation" to the <table>. If it's a data table, add header cells with <th scope="col"> / <th scope="row"> per Technical Guide §6.3.`,
    location,
  };
}
