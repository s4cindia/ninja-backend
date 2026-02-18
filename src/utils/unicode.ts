/**
 * Unicode utility functions for text normalization
 */

/**
 * Map of Unicode superscript characters to their regular digit equivalents
 */
const SUPERSCRIPT_MAP: Record<string, string> = {
  '\u00B9': '1', // ¹
  '\u00B2': '2', // ²
  '\u00B3': '3', // ³
  '\u2074': '4', // ⁴
  '\u2075': '5', // ⁵
  '\u2076': '6', // ⁶
  '\u2077': '7', // ⁷
  '\u2078': '8', // ⁸
  '\u2079': '9', // ⁹
  '\u2070': '0', // ⁰
};

/**
 * Normalize Unicode superscript characters to regular digits
 * Example: "¹²³" → "123"
 *
 * @param text - Text containing potential superscript characters
 * @returns Text with superscripts converted to regular digits
 */
export function normalizeSuperscripts(text: string): string {
  return Object.entries(SUPERSCRIPT_MAP).reduce(
    (acc, [sup, digit]) => acc.replaceAll(sup, digit),
    text
  );
}

/**
 * Check if text contains any Unicode superscript characters
 *
 * @param text - Text to check
 * @returns true if text contains superscript characters
 */
export function hasSuperscripts(text: string): boolean {
  return Object.keys(SUPERSCRIPT_MAP).some(sup => text.includes(sup));
}
