/**
 * Shared HTML parser utility for integrity checks.
 * Uses cheerio for safe HTML parsing with graceful fallback.
 */

import * as cheerio from 'cheerio';

export type CheerioRoot = ReturnType<typeof cheerio.load>;

/**
 * Load and parse an HTML string. Returns null if the input is empty/falsy.
 */
export function loadHtml(html: string): CheerioRoot | null {
  if (!html?.trim()) return null;
  return cheerio.load(html);
}
