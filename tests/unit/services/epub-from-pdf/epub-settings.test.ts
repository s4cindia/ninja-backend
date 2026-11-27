import { describe, it, expect } from 'vitest';
import {
  resolveProduceAccessibleEpub,
  isValidIsbn13,
  normalizeIsbn13,
  parseEpubIsbnField,
} from '../../../../src/services/epub-from-pdf/epub-settings';

describe('resolveProduceAccessibleEpub', () => {
  it('uses the per-job override when set, else the tenant default', () => {
    expect(resolveProduceAccessibleEpub(true, false)).toBe(true);
    expect(resolveProduceAccessibleEpub(false, true)).toBe(false);
    expect(resolveProduceAccessibleEpub(null, true)).toBe(true);
    expect(resolveProduceAccessibleEpub(undefined, false)).toBe(false);
  });
});

describe('isValidIsbn13', () => {
  it.each(['9780306406157', '9791090636071', '9781234567897'])('accepts %s', (isbn) => {
    expect(isValidIsbn13(isbn)).toBe(true);
  });

  it.each([
    ['wrong check digit', '9780306406158'],
    ['12 digits', '978030640615'],
    ['14 digits', '97803064061570'],
    ['not 978/979', '9770306406154'],
    ['ISBN-10', '0306406152'],
    ['non-digits', '97803064061X7'],
  ])('rejects %s', (_label, isbn) => {
    expect(isValidIsbn13(isbn)).toBe(false);
  });
});

describe('normalizeIsbn13', () => {
  it.each([
    '978-0-306-40615-7',
    '978 0 306 40615 7',
    'ISBN 978-0-306-40615-7',
    'ISBN-13: 978-0-306-40615-7',
    'isbn:9780306406157',
    '  9780306406157  ',
  ])('normalises %j to bare digits', (raw) => {
    expect(normalizeIsbn13(raw)).toBe('9780306406157');
  });

  it('returns null for an invalid ISBN in any formatting', () => {
    expect(normalizeIsbn13('978-0-306-40615-8')).toBeNull();
  });
});

describe('parseEpubIsbnField', () => {
  it('undefined means "not sent"', () => {
    expect(parseEpubIsbnField(undefined)).toBeUndefined();
  });

  it('null or blank means "clear it"', () => {
    expect(parseEpubIsbnField(null)).toBeNull();
    expect(parseEpubIsbnField('   ')).toBeNull();
  });

  it('returns the normalised ISBN', () => {
    expect(parseEpubIsbnField('979-10-90636-07-1')).toBe('9791090636071');
  });

  it('rejects a bad checksum with 400 INVALID_EPUB_ISBN', () => {
    expect(() => parseEpubIsbnField('978-0-306-40615-8')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_EPUB_ISBN' }),
    );
  });

  it('rejects a non-string', () => {
    expect(() => parseEpubIsbnField(9780306406157)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_EPUB_ISBN' }),
    );
  });
});
