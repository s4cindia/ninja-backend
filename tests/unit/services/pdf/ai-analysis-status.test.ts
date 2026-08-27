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

  it('treats a value-less suggestion (undefined) as matching a stored null value', () => {
    // Prisma stores an absent `value` as null; AiSuggestionResult.value is undefined
    // when absent — these must compare as equal, not as a spurious "changed".
    const existing = { status: 'applied', suggestionType: 'heading-fix', value: null };
    const suggestion = { suggestionType: 'heading-fix', value: undefined };

    expect(resolveSuggestionStatus(existing, suggestion, 'apply-to-pdf')).toBe('applied');
  });
});
