/** Map of common named HTML entities to their character equivalents. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018',
  rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', bull: '\u2022',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
  times: '\u00D7', divide: '\u00F7', plusmn: '\u00B1', frac12: '\u00BD',
  frac14: '\u00BC', frac34: '\u00BE', micro: '\u00B5', para: '\u00B6',
  sect: '\u00A7', laquo: '\u00AB', raquo: '\u00BB', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
};

/**
 * Decode all HTML entities: named (&mdash;), decimal (&#8212;), and hex (&#x2014;).
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[\da-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    // Numeric: &#8212; or &#x2014;
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return isNaN(code) ? match : String.fromCodePoint(code);
    }
    // Named: &mdash;
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Convert HTML to plain text, preserving paragraph structure.
 * Inserts newlines for block elements before stripping tags.
 */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // Remove style blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script blocks
      .replace(/<\/p>/gi, '\n\n')     // Paragraph breaks
      .replace(/<\/div>/gi, '\n')     // Div breaks
      .replace(/<br\s*\/?>/gi, '\n')  // Line breaks
      .replace(/<\/h[1-6]>/gi, '\n\n') // Heading breaks
      .replace(/<\/li>/gi, '\n')      // List item breaks
      .replace(/<\/tr>/gi, '\n')      // Table row breaks
      .replace(/<\/blockquote>/gi, '\n\n') // Blockquote breaks
      .replace(/<[^>]*>/g, ' ')       // Remove remaining HTML tags
  )
    .replace(/[ \t]+/g, ' ')        // Normalize spaces (preserve newlines)
    .replace(/\n\s+/g, '\n')        // Trim leading spaces on lines
    .replace(/\n{3,}/g, '\n\n')     // Collapse excessive newlines
    .trim();
}
