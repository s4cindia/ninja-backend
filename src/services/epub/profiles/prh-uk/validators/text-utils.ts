/**
 * Shared text-normalisation helpers used by P3/PR4's heuristic
 * validators (inline-lang / hashtag / acronym). All three need the
 * same "strip markup, return visible text" pass — extracting it here
 * keeps the behaviour aligned across detectors so a fix in one is a
 * fix in all.
 */

/**
 * Strip XHTML markup down to its visible text. Removes:
 *   - <script>…</script> + <style>…</style> blocks (their contents are
 *     never visible text — leaving them in would surface spurious
 *     matches against CSS class names, hashtag-looking selectors, etc.)
 *   - all element tags (replaced with space so adjacent words stay
 *     separate after collapse)
 *   - named entities (&nbsp; etc.) — replaced with space
 *   - numeric entities (&#160; / &#x00a0;) — replaced with space
 *
 * Output is NOT whitespace-collapsed — callers may need the
 * positional information of the original text (e.g. for run-detection
 * regex). Use a separate `.replace(/\s+/g, ' ').trim()` step if you
 * need normalised whitespace.
 */
export function stripHtmlMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#x?[0-9a-f]+;/gi, ' ');
}
