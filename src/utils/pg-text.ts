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

/**
 * Recursively apply stripPgUnsafeChars to every string leaf in an
 * arbitrarily-nested JSON-like value (objects, arrays, or a bare string).
 * Non-string leaves (numbers, booleans, null) pass through unchanged.
 *
 * For a large structured value being written to a jsonb column as a
 * single unit — e.g. a full audit report — sanitizing at the individual
 * extraction call site isn't enough coverage on its own: any string
 * anywhere in the tree (an issue message, an ActualText value, a table
 * cell) can carry a stray NUL byte and abort the entire write. This is
 * the defense-in-depth backstop for that case.
 */
export function stripPgUnsafeCharsDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return (stripPgUnsafeChars(value) ?? '') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPgUnsafeCharsDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = stripPgUnsafeCharsDeep(val);
    }
    return result as T;
  }
  return value;
}
