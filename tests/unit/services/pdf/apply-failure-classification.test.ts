/**
 * classifyApplyFailureReason
 *
 * A small, explicitly-maintained pattern table mapping known apply-failure
 * reason strings (the same text recordApplyFailure persists to
 * AiAnalysis.lastErrorReason) to an operator-facing category + plain-English
 * explanation, for the Apply Failure Report. Patterns are real substrings
 * pulled from pdf-structure-writer.service.ts / pdf-contrast-writer.service.ts's
 * own decline/error messages -- these tests pin down that those exact
 * messages classify as intended, and that anything unrecognized still gets a
 * sane catch-all instead of throwing or mis-categorizing.
 */
import { describe, it, expect } from 'vitest';
import { classifyApplyFailureReason } from '../../../../src/services/pdf/apply-failure-classification';

describe('classifyApplyFailureReason', () => {
  it('classifies a real "declining rather than guessing" decline as correctly_skipped', () => {
    const result = classifyApplyFailureReason(
      "Row already has a /P, but it does not match this row's own natural reattachment point -- declining rather than guessing"
    );
    expect(result.category).toBe('correctly_skipped');
    expect(result.categoryLabel).toBe('Correctly skipped');
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('classifies a real "already fixed or moved" message as likely_resolved', () => {
    const result = classifyApplyFailureReason(
      'No untagged painted-path regions found on this page (already fixed or moved)'
    );
    expect(result.category).toBe('likely_resolved');
    expect(result.categoryLabel).toBe('Likely already resolved');
  });

  it('classifies a real "no longer matches" stale-count message as likely_resolved', () => {
    const result = classifyApplyFailureReason(
      "Page's oversized-Artifact-span count (3) no longer matches the analyzed count (5) -- declining rather than guessing which spans still apply"
    );
    // Contains BOTH "no longer matches" and "declining rather than guessing" --
    // likely_resolved must win since it's checked first (the count mismatch
    // is the more specific, more actionable signal: this is stale, not a
    // genuinely ambiguous structure).
    expect(result.category).toBe('likely_resolved');
  });

  it('classifies a real "declining rather than deleting real content" decline (table-artifact-fix) as correctly_skipped', () => {
    const result = classifyApplyFailureReason(
      'Table has a descendant cell with real painted content (a genuine MCID) -- not the always-empty decorative box this fix is safe for; declining rather than deleting real content'
    );
    expect(result.category).toBe('correctly_skipped');
    expect(result.categoryLabel).toBe('Correctly skipped');
  });

  it('classifies a real "cannot safely determine a positional insertion point" decline (non-ascending MCIDs) as correctly_skipped', () => {
    const result = classifyApplyFailureReason(
      "Table's existing rows on this page do not have ascending MCIDs -- cannot safely determine a positional insertion point"
    );
    expect(result.category).toBe('correctly_skipped');
    expect(result.categoryLabel).toBe('Correctly skipped');
  });

  it('classifies a real color-contrast verification failure as needs_investigation with a contrast-specific label', () => {
    const result = classifyApplyFailureReason(
      'Fix did not verify even after escalating to #000000 (measured ratio 1.06:1, needs 4.5:1)'
    );
    expect(result.category).toBe('needs_investigation');
    expect(result.categoryLabel).toMatch(/contrast/i);
  });

  it('falls back to a generic needs_investigation classification for an unrecognized reason', () => {
    const result = classifyApplyFailureReason('Some brand-new error nobody has seen before');
    expect(result.category).toBe('needs_investigation');
    expect(result.categoryLabel).toBe('Needs investigation');
  });

  it('is case-insensitive', () => {
    const result = classifyApplyFailureReason('DECLINING RATHER THAN GUESSING which one is right');
    expect(result.category).toBe('correctly_skipped');
  });
});
