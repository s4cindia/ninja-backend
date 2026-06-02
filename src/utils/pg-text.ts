/**
 * Strip bytes that PostgreSQL refuses to store in text/varchar columns.
 *
 * PostgreSQL text columns are UTF-8 and reject the NUL byte (code point 0)
 * with `invalid byte sequence for encoding "UTF8": 0x00`, which aborts the
 * whole surrounding transaction. PDF text extraction (especially via pdfjs on
 * STEM/CID-font PDFs) can emit NUL and other C0 control characters when a
 * glyph has no real Unicode mapping — e.g. math symbols in pdfxt-tagged PDFs.
 *
 * This removes every C0 control character (code points 0-31) and DEL (127)
 * except the ones that are legal and meaningful in stored text:
 * tab (9), line feed (10) and carriage return (13). Returns null for
 * empty/nullish input so the result can be assigned directly to a nullable
 * column.
 */
export function stripPgUnsafeChars(value: string): string;
export function stripPgUnsafeChars(value: null | undefined): null;
export function stripPgUnsafeChars(value: string | null | undefined): string | null;
export function stripPgUnsafeChars(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;

  let cleaned = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !isAllowedControl) || code === 127) continue;
    cleaned += ch;
  }

  return cleaned.length > 0 ? cleaned : null;
}
