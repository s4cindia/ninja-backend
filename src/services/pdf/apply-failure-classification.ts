/**
 * Classifies an apply-failure reason string (the same text recordApplyFailure
 * persists to AiAnalysis.lastErrorReason, and the Apply Failure Report groups
 * by) into an operator-facing category and plain-English explanation.
 *
 * Deliberately a small, explicitly-maintained pattern table rather than
 * anything smarter (no AI call, no fuzzy matching) -- a wrong classification
 * here is low-stakes (it only affects which bucket a failure is grouped
 * under for a human to read), and a flat table is the easiest thing for a
 * future fix author to extend: when a new "declining rather than guessing"
 * -style string is added to a writer service, register its pattern here too.
 */

export type ApplyFailureCategory = 'correctly_skipped' | 'likely_resolved' | 'needs_investigation';

export interface ApplyFailureClassification {
  category: ApplyFailureCategory;
  categoryLabel: string;
  explanation: string;
}

interface ClassificationRule {
  pattern: RegExp;
  category: ApplyFailureCategory;
  categoryLabel: string;
  explanation: string;
}

// Checked in order, first match wins. Patterns are real substrings pulled
// from the writer services' own decline/error messages (pdf-structure-writer
// .service.ts, pdf-contrast-writer.service.ts) -- not guessed.
//
// "already fixed" / "no longer matches" is checked BEFORE "declining rather
// than guessing" on purpose: at least one real message contains both (a
// stale span/count mismatch that the code then declines to guess at), and
// staleness is the more actionable, more specific signal of the two --
// "re-run AI analysis" beats "working as intended, nothing to do" as the
// operator-facing takeaway for that exact case.
const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    pattern: /already fixed|no longer matches/i,
    category: 'likely_resolved',
    categoryLabel: 'Likely already resolved',
    explanation:
      'The specific thing this fix was looking for (a span, a count, a position) no longer matches what the fix expected -- usually because an earlier fix in the same batch already changed it, or the document moved since the audit that found it. Re-running AI Analysis typically clears this.',
  },
  {
    pattern: /declining rather than guessing/i,
    category: 'correctly_skipped',
    categoryLabel: 'Correctly skipped',
    explanation:
      "The fix found a genuinely ambiguous structure (e.g. an unexpected existing pointer, or more than one plausible target) and declined rather than risk guessing wrong. This is the intended, conservative behavior -- not a bug.",
  },
  {
    pattern: /did not verify even after escalating/i,
    category: 'needs_investigation',
    categoryLabel: 'Needs investigation -- contrast verification',
    explanation:
      "The fix applied a color change but the automated contrast check still measured it as failing, even after forcing the most extreme color (black or white). This can mean the verification step itself sampled the wrong region (e.g. a neighboring fix's own backplate) rather than the color fix being wrong.",
  },
];

const DEFAULT_CLASSIFICATION: ApplyFailureClassification = {
  category: 'needs_investigation',
  categoryLabel: 'Needs investigation',
  explanation:
    "This failure reason doesn't match a known pattern yet. Worth a closer look to tell whether it's a new bug or a case this classifier should learn to recognize.",
};

export function classifyApplyFailureReason(reason: string): ApplyFailureClassification {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(reason)) {
      return { category: rule.category, categoryLabel: rule.categoryLabel, explanation: rule.explanation };
    }
  }
  return DEFAULT_CLASSIFICATION;
}
