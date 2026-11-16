import { describe, it, expect } from 'vitest';
import { joinLinesDehyphenated } from '../../../../src/services/pdf/text-extractor.service';

describe('joinLinesDehyphenated', () => {
  it('merges a word split across a line-wrap hyphen', () => {
    expect(joinLinesDehyphenated(['This is an exam-', 'ple of a sentence.'])).toBe(
      'This is an example of a sentence.'
    );
  });

  it('does not merge when the next line starts with an uppercase letter', () => {
    expect(joinLinesDehyphenated(['End of paragraph-', 'New sentence starts here.'])).toBe(
      'End of paragraph-\nNew sentence starts here.'
    );
  });

  it('does not merge when the next line starts with a digit', () => {
    expect(joinLinesDehyphenated(['See page-', '42 for details.'])).toBe(
      'See page-\n42 for details.'
    );
  });

  it('does not merge a hyphen preceded by whitespace (e.g. a spaced dash)', () => {
    expect(joinLinesDehyphenated(['This is a line -', 'continued elsewhere.'])).toBe(
      'This is a line -\ncontinued elsewhere.'
    );
  });

  it('joins normally with a newline when there is no trailing hyphen', () => {
    expect(joinLinesDehyphenated(['First line.', 'Second line.'])).toBe('First line.\nSecond line.');
  });

  it('merges across more than two lines when each break qualifies', () => {
    expect(joinLinesDehyphenated(['multi-', 'line hyphen-', 'ation test'])).toBe(
      'multiline hyphenation test'
    );
  });

  it('returns an empty string for an empty input', () => {
    expect(joinLinesDehyphenated([])).toBe('');
  });

  it('returns the single line unchanged when given one line', () => {
    expect(joinLinesDehyphenated(['Only one line-'])).toBe('Only one line-');
  });

  it('documents the known compound-word limitation: a real compound breaking at a line end is merged too', () => {
    expect(joinLinesDehyphenated(['This is well-', 'known to everyone.'])).toBe(
      'This is wellknown to everyone.'
    );
  });
});
