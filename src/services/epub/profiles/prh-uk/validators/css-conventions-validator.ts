/**
 * PRH UK CSS-conventions validator (P6/PR1).
 *
 * Per Technical Guide §15 + Style Guide, PRH expects a specific
 * stylesheet stack and naming convention:
 *
 *   1. basestyles.css      (REQUIRED, MUST NOT be renamed)
 *   2. complex.css         (optional, for complex layouts)
 *   3. bespoke.css         (optional, book-specific overrides)
 *   4. mediaquery.css      (REQUIRED-IF-PRESENT to be LAST)
 *
 * Class names use underscores (`.first_para`), not hyphens. Inline
 * `style="…"` is disallowed at scale (P3 already flags per-instance;
 * this rule fires on books with 100+ inline styles across all XHTML
 * — a book-wide pattern the demonstration carve-out can't cover).
 * Per-paragraph fonts break Kindle font-customisation; primary font
 * goes on <body>, overrides in bespoke.css.
 *
 * Detect-only. Auto-remediation defers to publisher tooling because
 * renaming basestyles.css, re-ordering @imports, or refactoring class
 * names cascades through the publisher's dev pipeline.
 *
 * Vendor / utility classes (tw-, bs-, ng-) and classes declared in
 * non-publisher stylesheets are exempt from the underscore rule.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type {
  PrhValidatorIssue,
  PrhCssConventionsInput,
  PrhCssFile,
} from './types';

const CANONICAL_BASESTYLES = 'basestyles.css';
const CANONICAL_STACK_ORDER = ['basestyles', 'complex', 'bespoke', 'mediaquery'] as const;
const PER_PARAGRAPH_FONT_THRESHOLD = 10;
const INLINE_STYLE_AT_SCALE_THRESHOLD = 100;

/**
 * Class-name prefixes that come from third-party utility frameworks.
 * Any selector starting with one of these is ignored for the
 * underscore-only rule because the publisher doesn't control the
 * naming.
 */
const VENDOR_CLASS_PREFIXES = ['tw-', 'bs-', 'ng-'] as const;

const INLINE_STYLE_REGEX = /(?:^|\s)style\s*=\s*["'][^"']*["']/gi;

export function validatePrhCssConventions(input: PrhCssConventionsInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  if (!hasBasestyles(input.cssFiles)) {
    issues.push(buildIssue('PRH-CSS-BASESTYLES-RENAMED', '/styles'));
  }

  for (const css of input.cssFiles) {
    if (!isImportOrderValid(css.content)) {
      issues.push(buildIssue('PRH-CSS-IMPORT-ORDER-WRONG', css.path));
    }
  }

  const hyphenClasses = collectHyphenatedPublisherClasses(input.cssFiles);
  if (hyphenClasses.length > 0) {
    issues.push(
      buildIssue(
        'PRH-CSS-CLASS-NAME-HYPHEN',
        '/styles',
        ` (${hyphenClasses.length} class(es): ${formatSample(hyphenClasses)})`,
      ),
    );
  }

  const perParaFontClasses = findPerParagraphFontClasses(input);
  if (perParaFontClasses.length > 0) {
    issues.push(
      buildIssue(
        'PRH-CSS-PER-PARAGRAPH-FONT',
        '/styles',
        ` (class(es): ${formatSample(perParaFontClasses)})`,
      ),
    );
  }

  const inlineCount = countInlineStyles(input);
  if (inlineCount >= INLINE_STYLE_AT_SCALE_THRESHOLD) {
    issues.push(
      buildIssue(
        'PRH-CSS-INLINE-STYLE-AT-SCALE',
        'EPUB',
        ` (${inlineCount} inline style attributes across all XHTML)`,
      ),
    );
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * basestyles.css must live UNDER `/styles/` per Technical Guide §15.
 * A file at the EPUB root or under a different directory is still a
 * violation because Kindle ET, NCX-fallback CSS, and the brand-font
 * lookup all resolve relative to the canonical /styles location.
 */
function hasBasestyles(cssFiles: PrhCssFile[]): boolean {
  return cssFiles.some((f) => {
    const lower = f.path.toLowerCase();
    return lower.endsWith(`/styles/${CANONICAL_BASESTYLES}`) || lower === `styles/${CANONICAL_BASESTYLES}`;
  });
}

/**
 * Walk the file's `@import` statements top-to-bottom and check the
 * canonical stack order is respected. We only enforce the *relative*
 * order — a file may legitimately omit `complex.css` or `bespoke.css`,
 * but if both are present, basestyles must come before complex, complex
 * before bespoke, bespoke before mediaquery.
 *
 * Returns true (valid) when:
 *   - The file has zero @imports.
 *   - All @imports we recognise appear in canonical order.
 *   - Unknown filenames are ignored (they're publisher-extension files).
 */
function isImportOrderValid(cssContent: string): boolean {
  const importPaths = [...cssContent.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)].map(
    (m) => basename(m[1]).toLowerCase().replace(/\.css$/, ''),
  );

  const positions: number[] = [];
  for (const name of importPaths) {
    const idx = CANONICAL_STACK_ORDER.findIndex((canonical) => name === canonical);
    if (idx === -1) continue;
    positions.push(idx);
  }

  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1]) return false;
  }
  return true;
}

/**
 * Extract class selectors that use hyphen separators, scoped to
 * publisher-owned stylesheets only. We strip vendor prefixes and skip
 * leading/trailing single-token selectors (`.btn`) — only multi-token
 * hyphenated names (`.first-para`) violate the PRH underscore
 * convention. Returns a deduped list, sorted, capped at a reasonable
 * sample.
 */
function collectHyphenatedPublisherClasses(cssFiles: PrhCssFile[]): string[] {
  const found = new Set<string>();
  for (const css of cssFiles) {
    if (!css.isPublisherOwned) continue;
    const matches = css.content.matchAll(/\.([a-z][a-z0-9_-]*)\b/gi);
    for (const m of matches) {
      const name = m[1];
      if (!name.includes('-')) continue;
      if (VENDOR_CLASS_PREFIXES.some((p) => name.startsWith(p))) continue;
      found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * Find classes that:
 *   1. Declare a `font-family` in a publisher stylesheet, AND
 *   2. Are applied to ≥ PER_PARAGRAPH_FONT_THRESHOLD <p> elements
 *      across the book.
 *
 * Returns the offending class names. Per-class font on a <span> or
 * heading is fine; the rule is specifically about per-paragraph fonts
 * because that's what breaks Kindle font-customisation.
 */
function findPerParagraphFontClasses(input: PrhCssConventionsInput): string[] {
  // Collect groups of classes that share a single font-family rule.
  // Grouped selectors (`.a, .b { font-family: ... }`) form ONE scope:
  // their per-paragraph counts aggregate because the font is applied
  // identically to every paragraph carrying any of those classes.
  const fontGroups: string[][] = [];
  for (const css of input.cssFiles) {
    if (!css.isPublisherOwned) continue;
    // Match `<selector> { <body> }` blocks. `[^{}@]+` skips at-rules
    // (e.g. `@media`) which would otherwise confuse the flat parser.
    const blocks = css.content.matchAll(/([^{}@]+)\{([^{}]*)\}/g);
    for (const m of blocks) {
      const selector = m[1];
      const body = m[2];
      if (!/font-family\s*:/i.test(body)) continue;
      const group: string[] = [];
      for (const cm of selector.matchAll(/\.([a-z][a-z0-9_-]*)\b/gi)) {
        group.push(cm[1]);
      }
      if (group.length > 0) fontGroups.push(group);
    }
  }
  if (fontGroups.length === 0) return [];

  const offenders = new Set<string>();
  for (const group of fontGroups) {
    // Count <p> usages of ANY class in the group across all XHTML.
    // The `class` attribute can carry multiple space-separated tokens,
    // so we use a token-aware regex rather than a substring match.
    const alternation = group.map(escapeRegex).join('|');
    const tokenRegex = new RegExp(
      `<p\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b(?:${alternation})\\b[^"']*["']`,
      'gi',
    );
    let total = 0;
    for (const file of input.xhtmlFiles) {
      tokenRegex.lastIndex = 0;
      const matches = file.content.match(tokenRegex);
      if (matches) total += matches.length;
      if (total >= PER_PARAGRAPH_FONT_THRESHOLD) break;
    }
    if (total >= PER_PARAGRAPH_FONT_THRESHOLD) {
      for (const c of group) offenders.add(c);
    }
  }
  return [...offenders].sort();
}

function countInlineStyles(input: PrhCssConventionsInput): number {
  let total = 0;
  for (const file of input.xhtmlFiles) {
    INLINE_STYLE_REGEX.lastIndex = 0;
    const matches = file.content.match(INLINE_STYLE_REGEX);
    if (matches) total += matches.length;
  }
  return total;
}

function basename(zipPath: string): string {
  const idx = zipPath.lastIndexOf('/');
  return idx === -1 ? zipPath : zipPath.slice(idx + 1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSample(items: string[]): string {
  const max = 5;
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, …`;
}

function buildIssue(
  code:
    | 'PRH-CSS-BASESTYLES-RENAMED'
    | 'PRH-CSS-IMPORT-ORDER-WRONG'
    | 'PRH-CSS-CLASS-NAME-HYPHEN'
    | 'PRH-CSS-PER-PARAGRAPH-FONT'
    | 'PRH-CSS-INLINE-STYLE-AT-SCALE',
  location: string,
  detail = '',
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}${detail}`,
    suggestion: suggestionFor(code),
    location,
  };
}

function suggestionFor(code: string): string {
  switch (code) {
    case 'PRH-CSS-BASESTYLES-RENAMED':
      return 'Rename your primary stylesheet to basestyles.css and reference it from every XHTML <link>. Keep the file in /styles. See Technical Guide §15.';
    case 'PRH-CSS-IMPORT-ORDER-WRONG':
      return 'Re-order @import statements so the cascade reads basestyles → complex (when present) → bespoke (when present) → mediaquery (always last).';
    case 'PRH-CSS-CLASS-NAME-HYPHEN':
      return 'Replace hyphenated class names with underscored equivalents in your publisher stylesheets and the XHTML class="…" attributes that reference them. Vendor / utility prefixes (tw-, bs-, ng-) are exempt.';
    case 'PRH-CSS-PER-PARAGRAPH-FONT':
      return 'Move the primary font declaration onto <body>; isolate any genuine font overrides into bespoke.css scoped narrowly. Per-paragraph fonts break Kindle font-customisation.';
    case 'PRH-CSS-INLINE-STYLE-AT-SCALE':
      return 'Lift inline style="…" declarations into CSS classes in basestyles.css / bespoke.css. PRH allows one demonstration inline style per book; book-wide patterns must be classed.';
    default:
      return '';
  }
}
