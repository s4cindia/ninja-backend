import { describe, it, expect } from 'vitest';
import { resolveSuggestionStatus, buildIssueFingerprint, resolveCarriedFailedAttempts } from '../../../../src/services/pdf/ai-analysis.service';

const FP = 'MATTERHORN-13-001:img_p150_0_Im0';

describe('resolveSuggestionStatus', () => {
  it('preserves "applied" when fingerprint, suggestionType, and value are all unchanged', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('applied');
  });

  it('resets to the default status when suggestionType changed', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text-decorative', value: undefined };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('pending');
  });

  it('resets to the default status when value changed', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text', value: 'A green pear' };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('pending');
  });

  it('resets to the default status when the issue fingerprint changed, even with the same type and value', () => {
    // The exact collision CodeRabbit flagged: two genuinely different issues (here,
    // different images) can coincidentally compute the same suggestionType + value.
    // Without the fingerprint check this would wrongly stay 'applied'.
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };
    const differentFingerprint = 'MATTERHORN-13-001:img_p151_0_Im0';

    expect(resolveSuggestionStatus(existing, suggestion, differentFingerprint, 'apply-to-pdf')).toBe('pending');
  });

  it('resets to the default status when the existing row has no fingerprint (pre-migration row)', () => {
    // A null issueFingerprint never equals a freshly computed one, so pre-migration
    // rows safely fall through exactly once — identical to the prior unconditional
    // reset behavior, not a regression — then self-heal once repopulated.
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: null };
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('pending');
  });

  it.each(['pending', 'rejected', 'approved'])(
    'falls through to the default status when the existing status is %s (not applied)',
    (existingStatus) => {
      const existing = { status: existingStatus, suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
      const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

      expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('pending');
    }
  );

  it('uses the default status when there is no existing row (first analysis)', () => {
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };
    expect(resolveSuggestionStatus(null, suggestion, FP, 'apply-to-pdf')).toBe('pending');
  });

  it('defaults to "approved" (not "pending") for auto-resolve suggestions', () => {
    const suggestion = { suggestionType: 'pdfua-identifier', value: undefined };
    expect(resolveSuggestionStatus(null, suggestion, 'PDFUA-IDENTIFIER-MISSING', 'auto-resolve')).toBe('approved');
  });

  it('never preserves "applied" for a value-less suggestion, even when fingerprint and suggestionType match', () => {
    // Value-less, rule-based suggestions (table-header-fix, heading-fix,
    // alt-text-decorative, ...) compute identically regardless of which element
    // they're about, and doc-level codes share one fingerprint for the whole
    // document — so requiring a genuine value stays a second, independent guard.
    const existing = { status: 'applied', suggestionType: 'heading-fix', value: null, issueFingerprint: 'HEADING-SKIP' };
    const suggestion = { suggestionType: 'heading-fix', value: undefined };

    expect(resolveSuggestionStatus(existing, suggestion, 'HEADING-SKIP', 'apply-to-pdf')).toBe('pending');
  });

  it('preserves "applied" for a genuine, matching non-null value with a matching fingerprint', () => {
    const cfp = 'COLOR-CONTRAST:3:100:450';
    const existing = { status: 'applied', suggestionType: 'color-contrast-fix', value: '#1a1a1a', issueFingerprint: cfp };
    const suggestion = { suggestionType: 'color-contrast-fix', value: '#1a1a1a' };

    expect(resolveSuggestionStatus(existing, suggestion, cfp, 'apply-to-pdf')).toBe('applied');
  });

  /**
   * Real incident (Math_Olszewski_PDF.pdf, 2026-10-20): 'failed' (set by
   * applyApprovedSuggestions once a suggestion has failed MAX_APPLY_ATTEMPTS
   * times) must be preserved the same way 'applied' is -- without this, the
   * very next re-analysis pass would silently overwrite 'failed' back to
   * 'approved'/'pending' (since 'failed' !== 'applied' fell straight through
   * to defaultStatus), completely undoing the retry cap and reproducing the
   * exact bug it exists to prevent.
   */
  it('preserves "failed" when fingerprint, suggestionType, and value are all unchanged -- a permanently-broken suggestion must not be silently resurrected', () => {
    const existing = { status: 'failed', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('failed');
  });

  it('resets a "failed" suggestion to the default status when the underlying finding genuinely changed -- a different finding deserves a fresh attempt', () => {
    const existing = { status: 'failed', suggestionType: 'alt-text', value: 'A red apple', issueFingerprint: FP };
    const suggestion = { suggestionType: 'alt-text', value: 'A green pear' };

    expect(resolveSuggestionStatus(existing, suggestion, FP, 'apply-to-pdf')).toBe('pending');
  });
});

// Real, live-confirmed incident, 2026-11-05 (Farrar_2E_Comp_188910.pdf):
// 18-20 suggestions failed to apply EVERY single Auto Mode round, never
// shrinking, across 10+ rounds -- MAX_APPLY_ATTEMPTS (2) never actually
// engaged for any of them, because issue.id regenerates every round (a
// per-audit sequential counter, not a stable identity) and the upsert's
// `create` branch silently reset failedAttempts to 0 every time it fired.
describe('resolveCarriedFailedAttempts', () => {
  it('carries the fingerprint-matched OLD row\'s failedAttempts forward when this round\'s issue.id has changed (the real bug)', () => {
    // The exact shape analyzeJob hits every round once issue ids start
    // churning: `existing` was found via the fingerprint fallback (a
    // DIFFERENT physical row than the one this round's upsert `where`
    // targets), already carrying 1 real failed attempt from last round.
    const existing = { failedAttempts: 1 };
    expect(resolveCarriedFailedAttempts(existing, false)).toBe(1);
  });

  it('starts a genuinely new row (no existing match at all) at 0', () => {
    expect(resolveCarriedFailedAttempts(null, false)).toBe(0);
  });

  it('resets to 0 when the finding genuinely changed out from under a previously-failed row', () => {
    const existing = { failedAttempts: 2 }; // already at the cap, under the OLD finding
    expect(resolveCarriedFailedAttempts(existing, true)).toBe(0);
  });

  it('keeps counting across repeated real failures once the carry-forward is in place (reaches the cap)', () => {
    // Simulates 3 consecutive rounds of the same real failure, each under a
    // DIFFERENT issue.id (the actual production shape) -- confirms the
    // count genuinely climbs to and past MAX_APPLY_ATTEMPTS instead of
    // forever resetting to 1.
    let row: { failedAttempts: number } | null = null;
    for (let round = 0; round < 3; round++) {
      const carried = resolveCarriedFailedAttempts(row, false);
      row = { failedAttempts: carried + 1 }; // what recordApplyFailure does after this round's own failure
    }
    expect(row!.failedAttempts).toBe(3);
  });
});

describe('buildIssueFingerprint', () => {
  it('keys a document-level code by the code alone', () => {
    const fp = buildIssueFingerprint({ code: 'HEADING-SKIP', element: undefined, pageNumber: undefined, boundingBox: undefined });
    expect(fp).toBe('HEADING-SKIP');
  });

  it('keys an element-bearing issue by code + element', () => {
    const fp = buildIssueFingerprint({
      code: 'MATTERHORN-13-001',
      element: 'img_p150_0_Im0',
      pageNumber: 150,
      boundingBox: undefined,
    });
    expect(fp).toBe('MATTERHORN-13-001:img_p150_0_Im0');
  });

  it('falls back to code + pageNumber when there is no element', () => {
    const fp = buildIssueFingerprint({ code: 'READING-ORDER-SUSPECT', element: undefined, pageNumber: 5, boundingBox: undefined });
    expect(fp).toBe('READING-ORDER-SUSPECT:5');
  });

  const box = (x: number, y: number) => ({ x, y, width: 100, height: 14, pageWidth: 400, pageHeight: 600 });

  it('keys a contrast issue by code + page + rounded position', () => {
    const fp = buildIssueFingerprint({ code: 'COLOR-CONTRAST', element: undefined, pageNumber: 3, boundingBox: box(100.4, 449.6) });
    expect(fp).toBe('COLOR-CONTRAST:3:100:450');
  });

  it('gives two contrast issues on the same page at different positions distinct fingerprints', () => {
    const a = buildIssueFingerprint({ code: 'COLOR-CONTRAST', element: undefined, pageNumber: 3, boundingBox: box(100, 450) });
    const b = buildIssueFingerprint({ code: 'COLOR-CONTRAST', element: undefined, pageNumber: 3, boundingBox: box(300, 50) });
    expect(a).not.toBe(b);
  });

  it('gives the same contrast issue the same fingerprint on repeat calls', () => {
    const issue = { code: 'COLOR-CONTRAST', element: undefined, pageNumber: 3, boundingBox: box(100, 450) };
    expect(buildIssueFingerprint(issue)).toBe(buildIssueFingerprint({ ...issue }));
  });
});
