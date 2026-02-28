/**
 * Convert HTML to plain text, preserving paragraph structure.
 * Inserts newlines for block elements before stripping tags.
 */
export function htmlToPlainText(html: string): string {
  return html
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
    .replace(/&nbsp;/g, ' ')        // Decode &nbsp;
    .replace(/&amp;/g, '&')         // Decode &amp;
    .replace(/&lt;/g, '<')          // Decode &lt;
    .replace(/&gt;/g, '>')          // Decode &gt;
    .replace(/&quot;/g, '"')        // Decode &quot;
    .replace(/&#39;/g, "'")         // Decode &#39;
    .replace(/[ \t]+/g, ' ')        // Normalize spaces (preserve newlines)
    .replace(/\n\s+/g, '\n')        // Trim leading spaces on lines
    .replace(/\n{3,}/g, '\n\n')     // Collapse excessive newlines
    .trim();
}
