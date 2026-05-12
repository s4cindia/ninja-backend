/**
 * PRH UK page-break shape validator (P3/PR3).
 *
 * Per Technical Guide §6.1, every print-page break placeholder in
 * reflowable content must carry:
 *
 *   <span epub:type="pagebreak" role="doc-pagebreak" aria-label="12"/>
 *
 * Rules enforced:
 *   - role="doc-pagebreak" MUST be present (and exactly that value
 *     among the role tokens).
 *   - aria-label MUST be present.
 *   - aria-label MUST be a bare digit sequence ("12", "203"). Variants
 *     like "page 12", "pg 12", or roman-numeral text ("xii", "iv")
 *     fail the rule. Real screen-reader behaviour is sensitive to
 *     the format — Apple Books reads "page page 12" out loud when
 *     the label carries the word "page", and roman text isn't
 *     normalised consistently across reading systems.
 *
 * Issue code: PRH-PAGEBREAK-MALFORMED. One issue per malformed
 * pagebreak (these can stack — a book with 300 print pages can fire
 * 300 instances if the format is wrong, which is exactly what the FE
 * grouping prompt is designed for).
 *
 * Detect-only. Auto-fix (insert role / rewrite aria-label) lands in P5.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * aria-label values that satisfy the "bare digit sequence" rule.
 * Leading zeros tolerated ("012" — unusual but valid). The rule
 * deliberately rejects roman numerals as text — roman page numbers
 * still need to surface as digits in aria-label so reading systems
 * announce them numerically.
 */
const NUMERIC_LABEL_REGEX = /^\d+$/;

export function validatePrhPageBreakShape(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    // Match <span …epub:type="pagebreak"…> opening tags (self-closing
    // variant `<span … />` and explicit-close `<span …></span>` both
    // pass — the validator only reads the open tag's attributes).
    const tagRe = /<span\b([^>]*\bepub:type\s*=\s*["'][^"']*\bpagebreak\b[^"']*["'][^>]*)\/?>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(file.content)) !== null) {
      const attrs = m[1];

      // 1. role must include doc-pagebreak. Whitespace anchor (not \b)
      //    so data-role doesn't false-match — see memory:
      //    feedback_attribute_regex_anchor.md.
      const roleMatch = attrs.match(/(?:^|\s)role\s*=\s*["']([^"']+)["']/i);
      const hasDocPagebreakRole =
        !!roleMatch && roleMatch[1].split(/\s+/).map((t) => t.toLowerCase()).includes('doc-pagebreak');

      // 2. aria-label must be present AND must be a bare digit sequence.
      const ariaLabelMatch = attrs.match(/(?:^|\s)aria-label\s*=\s*["']([^"']*)["']/i);
      const labelValue = ariaLabelMatch ? ariaLabelMatch[1].trim() : null;
      const hasNumericLabel = labelValue !== null && NUMERIC_LABEL_REGEX.test(labelValue);

      if (hasDocPagebreakRole && hasNumericLabel) continue;

      // Aggregate the problems into one message per malformed
      // pagebreak so operators see the full picture per instance.
      const problems: string[] = [];
      if (!hasDocPagebreakRole) {
        problems.push(roleMatch
          ? `role="${roleMatch[1]}" is missing the doc-pagebreak token`
          : 'role attribute is missing (need role="doc-pagebreak")');
      }
      if (!hasNumericLabel) {
        if (labelValue === null) {
          problems.push('aria-label is missing (need aria-label="N" where N is a bare digit sequence)');
        } else {
          problems.push(`aria-label="${labelValue}" is not a bare digit sequence (no "page"/"pg" prefix, no roman-numeral text)`);
        }
      }

      issues.push(buildIssue(file.path, problems.join('; ')));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function buildIssue(location: string, details: string): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-PAGEBREAK-MALFORMED'];
  return {
    code: 'PRH-PAGEBREAK-MALFORMED',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} — ${details}.`,
    suggestion:
      `Use <span epub:type="pagebreak" role="doc-pagebreak" aria-label="N"/> where N is the print page number as a bare digit sequence (e.g. "12", not "page 12" or "xii").`,
    location,
  };
}
