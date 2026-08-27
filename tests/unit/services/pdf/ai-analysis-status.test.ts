import { describe, it, expect } from 'vitest';
import { resolveSuggestionStatus } from '../../../../src/services/pdf/ai-analysis.service';

describe('resolveSuggestionStatus', () => {
  it('preserves "applied" when suggestionType and value are both unchanged', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple' };
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('applied');
  });

  it('resets to the default status when suggestionType changed', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple' };
    const suggestion = { suggestionType: 'alt-text-decorative', value: undefined };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('pending');
  });

  it('resets to the default status when value changed', () => {
    const existing = { status: 'applied', suggestionType: 'alt-text', value: 'A red apple' };
    const suggestion = { suggestionType: 'alt-text', value: 'A green pear' };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('pending');
  });

  it.each(['pending', 'rejected', 'approved'])(
    'falls through to the default status when the existing status is %s (not applied)',
    (existingStatus) => {
      const existing = { status: existingStatus, suggestionType: 'alt-text', value: 'A red apple' };
      const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };

      expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('pending');
    }
  );

  it('uses the default status when there is no existing row (first analysis)', () => {
    const suggestion = { suggestionType: 'alt-text', value: 'A red apple' };
    expect(resolveSuggestionStatus(null, suggestion, 'apply-to-pdf')).toBe('pending');
  });

  it('defaults to "approved" (not "pending") for auto-resolve suggestions', () => {
    const suggestion = { suggestionType: 'pdfua-identifier', value: undefined };
    expect(resolveSuggestionStatus(null, suggestion, 'auto-resolve')).toBe('approved');
  });

  it('never preserves "applied" for a value-less suggestion, even when suggestionType matches', () => {
    // Regression: issueId is a per-audit sequential counter (BaseAuditService),
    // not a stable fingerprint — applyAll's internal re-audit regenerates every
    // issue's id from scratch, so a still-open finding can inherit the id an
    // already-fixed finding used to have. Value-less, rule-based suggestions
    // (table-header-fix, heading-fix, alt-text-decorative, ...) compute
    // identically regardless of which element they're about, so matching on
    // suggestionType alone would wrongly transfer 'applied' onto a genuinely
    // different, still-unfixed issue. Must always reset to the default instead.
    const existing = { status: 'applied', suggestionType: 'heading-fix', value: null };
    const suggestion = { suggestionType: 'heading-fix', value: undefined };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('pending');
  });

  it('preserves "applied" for a genuine, matching non-null value', () => {
    const existing = { status: 'applied', suggestionType: 'color-contrast-fix', value: '#1a1a1a' };
    const suggestion = { suggestionType: 'color-contrast-fix', value: '#1a1a1a' };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('applied');
  });
});
