/**
 * Identifier Format Check (ISBN + DOI)
 *
 * ISBN_FORMAT:
 * - ISBN-13 check digit validation (alternating multiply by 1/3)
 * - ISBN-10 check digit validation (weighted sum mod 11)
 * - Invalid checksum → ERROR
 *
 * DOI_FORMAT:
 * - Must match 10.NNNN/... pattern
 * - DOI wrapped in incorrect URL → WARNING
 */

import { ISBN_13, ISBN_10, DOI_PATTERN } from '../rules/regex-patterns';
import type { CheckResult } from './figure-table-ref.check';

function stripDashes(isbn: string): string {
  return isbn.replace(/[-\s]/g, '');
}

function validateIsbn13(raw: string): boolean {
  const digits = stripDashes(raw);
  if (digits.length !== 13) return false;
  if (!/^\d{13}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(digits[12], 10);
}

function validateIsbn10(raw: string): boolean {
  const digits = stripDashes(raw);
  if (digits.length !== 10) return false;
  if (!/^\d{9}[\dX]$/i.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i], 10) * (10 - i);
  }
  const lastChar = digits[9].toUpperCase();
  const lastVal = lastChar === 'X' ? 10 : parseInt(lastChar, 10);
  sum += lastVal;

  return sum % 11 === 0;
}

export function checkIdentifierFormats(text: string, _html: string): CheckResult {
  const issues: CheckResult['issues'] = [];
  let isbn13Count = 0;
  let isbn10Count = 0;
  let doiCount = 0;
  let invalidIsbns = 0;
  let invalidDois = 0;

  // ── ISBN-13 ──────────────────────────────────────────────────

  const isbn13Re = new RegExp(ISBN_13.source, ISBN_13.flags);
  let m: RegExpExecArray | null;

  while ((m = isbn13Re.exec(text)) !== null) {
    isbn13Count++;
    const raw = m[1];
    if (!validateIsbn13(raw)) {
      invalidIsbns++;
      issues.push({
        checkType: 'ISBN_FORMAT',
        severity: 'ERROR',
        title: 'Invalid ISBN-13 checksum',
        description: `ISBN-13 "${m[0].trim()}" has an invalid check digit.`,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        originalText: m[0].trim(),
        actualValue: raw,
        suggestedFix: 'Verify the ISBN-13 and correct the check digit.',
      });
    }
  }

  // ── ISBN-10 ──────────────────────────────────────────────────

  const isbn10Re = new RegExp(ISBN_10.source, ISBN_10.flags);
  while ((m = isbn10Re.exec(text)) !== null) {
    isbn10Count++;
    const raw = m[1];
    // Skip if this was already caught as part of an ISBN-13
    if (raw.length === 10 || stripDashes(raw).length === 10) {
      if (!validateIsbn10(raw)) {
        invalidIsbns++;
        issues.push({
          checkType: 'ISBN_FORMAT',
          severity: 'ERROR',
          title: 'Invalid ISBN-10 checksum',
          description: `ISBN-10 "${m[0].trim()}" has an invalid check digit.`,
          startOffset: m.index,
          endOffset: m.index + m[0].length,
          originalText: m[0].trim(),
          actualValue: raw,
          suggestedFix: 'Verify the ISBN-10 and correct the check digit.',
        });
      }
    }
  }

  // ── DOI ──────────────────────────────────────────────────────

  const doiRe = new RegExp(DOI_PATTERN.source, DOI_PATTERN.flags);
  while ((m = doiRe.exec(text)) !== null) {
    doiCount++;
    const doi = m[1];

    // Must have registrant code + / + suffix
    const parts = doi.split('/');
    if (parts.length < 2 || !parts[1]) {
      invalidDois++;
      issues.push({
        checkType: 'DOI_FORMAT',
        severity: 'ERROR',
        title: 'Malformed DOI',
        description: `DOI "${doi}" is missing a suffix after the registrant code.`,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        originalText: doi,
        suggestedFix: 'A valid DOI must have the format 10.XXXX/suffix.',
      });
      continue;
    }

    // Check if DOI ends with common punctuation (probably part of surrounding text)
    if (/[.,;:)}\]]$/.test(doi)) {
      issues.push({
        checkType: 'DOI_FORMAT',
        severity: 'WARNING',
        title: 'DOI may include trailing punctuation',
        description: `DOI "${doi}" ends with punctuation that may not be part of the identifier.`,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        originalText: doi,
        suggestedFix: 'Verify the DOI does not include trailing punctuation from the surrounding text.',
      });
    }

    // Check for DOI wrapped in non-standard URL prefix
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (/https?:\/\/(?!doi\.org\/)[\w.]+\//.test(before)) {
      issues.push({
        checkType: 'DOI_FORMAT',
        severity: 'WARNING',
        title: 'DOI uses non-standard URL resolver',
        description: `DOI "${doi}" is wrapped in a non-standard URL. Use https://doi.org/ prefix.`,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        originalText: doi,
        suggestedFix: `Use https://doi.org/${doi} as the canonical URL.`,
      });
    }
  }

  return {
    checkType: 'IDENTIFIER_FORMAT',
    issues,
    metadata: {
      isbn13Found: isbn13Count,
      isbn10Found: isbn10Count,
      doisFound: doiCount,
      invalidIsbns,
      invalidDois,
    },
  };
}
