/**
 * EPUB-from-certified-PDF: per-job request flag + EPUB ISBN.
 *
 * Job.produceAccessibleEpub follows the same three-state override pattern
 * as Job.fullQC: null = inherit the tenant's
 * aiRemediation.epubFromPdfDefault, true/false = explicit per-job choice.
 * Unlike fullQC it stays editable after upload (a customer can ask for the
 * EPUB late), via PATCH /pdf/:jobId/settings/epub.
 *
 * Job.epubIsbn is the publisher-supplied ISBN for the EPUB edition. Ninja
 * never generates one; the EPUB is built with a urn:uuid identifier until
 * this is set, and delivery stays blocked until it is (Q1). Stored
 * normalised: 13 digits, no hyphens, checksum verified.
 *
 * Lives here rather than next to resolveFullQC (auto-remediation-loop) so
 * the EPUB feature stays out of the PDF remediation pipeline's files.
 */

import { AppError } from '../../utils/app-error';

export function resolveProduceAccessibleEpub(override: boolean | null | undefined, tenantDefault: boolean): boolean {
  return override ?? tenantDefault;
}

/** True for a 13-digit ISBN (978/979 prefix) whose check digit is correct. */
export function isValidIsbn13(digits: string): boolean {
  if (!/^97[89]\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

/**
 * Accepts the forms people actually paste ("978-1-23456-789-7",
 * "ISBN 978 1 23456 789 7", "ISBN-13: 9781234567897") and returns the bare
 * 13 digits, or null when it isn't a valid ISBN-13.
 */
export function normalizeIsbn13(raw: string): string | null {
  const stripped = raw.trim().replace(/^isbn(-?13)?:?/i, '').replace(/[\s-]/g, '');
  return isValidIsbn13(stripped) ? stripped : null;
}

/**
 * Parses the optional EPUB-ISBN field from an upload or settings request.
 * undefined → field not sent; null/"" → explicitly cleared; anything else
 * must be a valid ISBN-13 (400 INVALID_EPUB_ISBN otherwise -- a typo is
 * caught at entry, not discovered at delivery).
 */
export function parseEpubIsbnField(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string') {
    throw AppError.badRequest('EPUB ISBN must be a string', 'INVALID_EPUB_ISBN');
  }
  const normalized = normalizeIsbn13(raw);
  if (!normalized) {
    throw AppError.badRequest(
      'EPUB ISBN must be a valid ISBN-13 (978/979 prefix, correct check digit)',
      'INVALID_EPUB_ISBN',
    );
  }
  return normalized;
}
