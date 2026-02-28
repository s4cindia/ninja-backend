/**
 * Terminology Consistency Check
 *
 * Detects inconsistent usage of spelling/hyphenation variants:
 * - Both forms appear 2+ times → WARNING
 * - One form once, other 5+ times → SUGGESTION
 *
 * Covers:
 * - Hyphenation variants (e-mail/email, on-line/online, etc.)
 * - British/American spelling variants (colour/color, analyse/analyze, etc.)
 */

import { HYPHENATION_VARIANTS, SPELLING_VARIANTS } from '../rules/regex-patterns';
import type { CheckResult } from './figure-table-ref.check';

function countWordOccurrences(text: string, word: string): number {
  // Word-boundary match, case-insensitive
  const escaped = word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function checkVariantPairs(
  text: string,
  pairs: [string, string][],
  category: string,
): CheckResult['issues'] {
  const issues: CheckResult['issues'] = [];

  for (const [variant1, variant2] of pairs) {
    const count1 = countWordOccurrences(text, variant1);
    const count2 = countWordOccurrences(text, variant2);

    if (count1 === 0 || count2 === 0) continue;

    // Both forms used multiple times → definite inconsistency
    if (count1 >= 2 && count2 >= 2) {
      issues.push({
        checkType: 'TERMINOLOGY',
        severity: 'WARNING',
        title: `Inconsistent ${category}: "${variant1}" vs "${variant2}"`,
        description: `Document uses both "${variant1}" (${count1}×) and "${variant2}" (${count2}×). Choose one form consistently.`,
        actualValue: `${variant1}: ${count1}, ${variant2}: ${count2}`,
        suggestedFix: `Use "${count1 >= count2 ? variant1 : variant2}" consistently throughout (the more frequent form).`,
      });
    }
    // One form is rare (1×), other is dominant (5+×) → likely typo
    else if ((count1 === 1 && count2 >= 5) || (count2 === 1 && count1 >= 5)) {
      const rare = count1 === 1 ? variant1 : variant2;
      const dominant = count1 === 1 ? variant2 : variant1;
      const dominantCount = count1 === 1 ? count2 : count1;

      issues.push({
        checkType: 'TERMINOLOGY',
        severity: 'SUGGESTION',
        title: `Possible inconsistency: "${rare}" may be a variant of "${dominant}"`,
        description: `"${rare}" appears once while "${dominant}" appears ${dominantCount} times. This may be an inconsistency.`,
        actualValue: `${rare}: 1, ${dominant}: ${dominantCount}`,
        suggestedFix: `Replace the single occurrence of "${rare}" with "${dominant}" for consistency.`,
      });
    }
  }

  return issues;
}

export function checkTerminologyConsistency(text: string, _html: string): CheckResult {
  const hyphenationIssues = checkVariantPairs(text, HYPHENATION_VARIANTS, 'hyphenation');
  const spellingIssues = checkVariantPairs(text, SPELLING_VARIANTS, 'spelling');

  return {
    checkType: 'TERMINOLOGY',
    issues: [...hyphenationIssues, ...spellingIssues],
    metadata: {
      hyphenationIssues: hyphenationIssues.length,
      spellingIssues: spellingIssues.length,
      pairsChecked: HYPHENATION_VARIANTS.length + SPELLING_VARIANTS.length,
    },
  };
}
