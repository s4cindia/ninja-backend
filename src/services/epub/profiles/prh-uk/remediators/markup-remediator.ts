/**
 * PRH UK markup remediators (P5/PR3).
 *
 * Each fix wires a P3 detect-only code into auto-remediation.
 * Idempotent — running twice on the same EPUB is a no-op once the
 * file is conformant. Returns a `ChangeResult[]` (one entry per
 * mutated file) so the auto-remediation pipeline can attribute
 * changes back to specific files for the comparison report.
 *
 * Fixes shipped:
 *   - fixDeprecatedTags         → PRH-MARKUP-DEPRECATED-TAG
 *   - fixInlineStyles           → PRH-MARKUP-INLINE-STYLE
 *   - fixEpubTypePlacement      → PRH-MARKUP-EPUB-TYPE-MISPLACED
 *   - addDocAriaRoles           → PRH-ARIA-*-ROLE-MISSING (5 codes)
 *   - fixBodyPurity             → PRH-BODY-HAS-ARIA
 *   - fixPagebreakMalformed     → PRH-PAGEBREAK-MALFORMED
 *
 * All operate on XHTML files. None mutate the OPF, manifest, or
 * spine — they're content-only transformations.
 */

import JSZip from 'jszip';
import { logger } from '../../../../../lib/logger';

interface ChangeResult {
  success: boolean;
  description: string;
  before?: string;
  after?: string;
}

/**
 * Inline-style files with more than this many style attributes
 * trigger an operator-defer rather than auto-strip. Hits the
 * sweet spot per the P5 plan (Q3): catches accidental template
 * bugs (one or two stripped) without auto-erasing legitimate
 * heavy inline-styling (more often a P6 CSS-extraction concern).
 */
const INLINE_STYLE_AUTO_THRESHOLD = 50;

/** Deprecated-tag swap map. `null` means strip the wrapper, keep inner text. */
const DEPRECATED_TAG_REWRITES: Record<string, string | null> = {
  b: 'strong',
  i: 'em',
  big: null,
  small: null,
  font: null,
  center: null,
  strike: 'del',
  // `<u>` is intentionally absent — could be a real semantic
  // underline ("the *not* in 'not allowed' is underlined"). Skip
  // and let the operator decide.
};

/**
 * <section epub:type="X"> values that PRH forbids. Each maps to
 * the canonical doc-* role replacement. Per Technical Guide §6.1.
 */
const SECTION_EPUB_TYPE_TO_ROLE: Record<string, string> = {
  chapter: 'doc-chapter',
  part: 'doc-part',
  dedication: 'doc-dedication',
  epigraph: 'doc-epigraph',
  appendix: 'doc-appendix',
  prologue: 'doc-prologue',
  preface: 'doc-preface',
  acknowledgements: 'doc-acknowledgments',
  acknowledgments: 'doc-acknowledgments',
};

// ── fixDeprecatedTags ────────────────────────────────────────────────────

/**
 * Walk every XHTML file. For each deprecated tag with a known
 * replacement, swap the opening + closing tag in-place; for tags
 * marked `null` (strip), remove the wrapper but keep the inner
 * text content. Self-closing variants are normalised to opening
 * tags first.
 *
 * Idempotent — a file with no deprecated tags is left untouched.
 */
export async function fixDeprecatedTags(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];

  for (const filePath of Object.keys(zip.files)) {
    if (!/\.x?html?$/i.test(filePath)) continue;
    const entry = zip.file(filePath);
    if (!entry) continue;
    const original = await entry.async('text');

    // Don't mutate <head>; scope to <body>…</body>.
    const bodyMatch = original.match(/(<body\b[^>]*>)([\s\S]*?)(<\/body>)/i);
    if (!bodyMatch) continue;
    const [, bodyOpen, bodyInner, bodyClose] = bodyMatch;

    let mutatedInner = bodyInner;
    let changeCount = 0;

    for (const [tag, replacement] of Object.entries(DEPRECATED_TAG_REWRITES)) {
      // Tag-boundary regex — `<b ...>` / `<b>` / `<b/>` but NOT
      // `<body>` / `<br>` / `<blockquote>`. The lookahead requires
      // whitespace, `/`, or `>` immediately after the tag name.
      const openRe = new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, 'gi');
      const selfCloseRe = new RegExp(`<${tag}(?=[\\s/])([^>]*)\\/>`, 'gi');
      const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');

      if (replacement === null) {
        // Strip path: remove wrappers (open + close), preserve inner.
        const openCount = (mutatedInner.match(openRe) || []).length;
        const closeCount = (mutatedInner.match(closeRe) || []).length;
        const selfClose = (mutatedInner.match(selfCloseRe) || []).length;
        if (openCount + closeCount + selfClose === 0) continue;
        mutatedInner = mutatedInner
          .replace(selfCloseRe, '')
          .replace(openRe, '')
          .replace(closeRe, '');
        changeCount += openCount + selfClose;
      } else {
        // Swap path: rewrite tag name on open + close.
        const openCount = (mutatedInner.match(openRe) || []).length;
        const closeCount = (mutatedInner.match(closeRe) || []).length;
        const selfClose = (mutatedInner.match(selfCloseRe) || []).length;
        if (openCount + closeCount + selfClose === 0) continue;
        mutatedInner = mutatedInner
          .replace(selfCloseRe, `<${replacement}$1/>`)
          .replace(openRe, `<${replacement}$1>`)
          .replace(closeRe, `</${replacement}>`);
        changeCount += openCount + selfClose;
      }
    }

    if (changeCount === 0) continue;

    const mutatedFull = original.replace(bodyMatch[0], bodyOpen + mutatedInner + bodyClose);
    zip.file(filePath, mutatedFull);
    results.push({
      success: true,
      description: `Rewrote ${changeCount} deprecated tag(s) in ${filePath}`,
      before: bodyInner.slice(0, 200),
      after: mutatedInner.slice(0, 200),
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No deprecated tags found — no changes needed' }];
  }
  return results;
}

// ── fixInlineStyles ──────────────────────────────────────────────────────

/**
 * Strip `style="…"` attributes from body elements. Files with
 * more than INLINE_STYLE_AUTO_THRESHOLD inline styles are
 * deferred to operator review (returned as `success: true` with
 * a `skipped` description so the operator sees the deferral).
 *
 * Anchored on whitespace (not `\b`) per the attribute-regex rule
 * in feedback_attribute_regex_anchor — prevents false-matching
 * inside `data-style=` etc.
 */
export async function fixInlineStyles(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  // Backreference (\2) ensures the closing quote matches the opening
  // quote. Without it, an attribute like style="font-family: 'Times
  // New Roman'" would have its value truncated at the inner single
  // quote (the regex would see `style="font-family: '` as a full
  // match), leaving `Times New Roman'"` orphaned in the markup.
  // The (\s) capture preserves leading whitespace so the strip
  // doesn't collapse adjacent attributes.
  const inlineStyleRe = /(\s)style\s*=\s*(["'])([\s\S]*?)\2/gi;

  for (const filePath of Object.keys(zip.files)) {
    if (!/\.x?html?$/i.test(filePath)) continue;
    const entry = zip.file(filePath);
    if (!entry) continue;
    const original = await entry.async('text');

    inlineStyleRe.lastIndex = 0;
    const matches = original.match(inlineStyleRe);
    if (!matches || matches.length === 0) continue;

    if (matches.length > INLINE_STYLE_AUTO_THRESHOLD) {
      // Deferred ≠ fixed. Return success: false so the auto-
      // remediation pipeline counts this file as outstanding rather
      // than counting it toward the "resolved" tally. The operator
      // sees the file in the still-needs-review bucket.
      results.push({
        success: false,
        description: `${filePath} has ${matches.length} inline styles — deferred to operator review (auto threshold is ${INLINE_STYLE_AUTO_THRESHOLD})`,
      });
      continue;
    }

    inlineStyleRe.lastIndex = 0;
    const mutated = original.replace(inlineStyleRe, '');
    zip.file(filePath, mutated);
    results.push({
      success: true,
      description: `Stripped ${matches.length} inline style attribute(s) from ${filePath}`,
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No inline styles found — no changes needed' }];
  }
  return results;
}

// ── fixEpubTypePlacement ────────────────────────────────────────────────

/**
 * Swap forbidden `<section epub:type="chapter">` style markup
 * to `<section role="doc-chapter">`, dropping the epub:type
 * attribute. Idempotent — sections already carrying the role get
 * the duplicate `epub:type` stripped but `role` is preserved.
 *
 * Only handles the forbidden `<section>` values per PRH spec.
 * `<body epub:type="…">` is left alone (PRH allows the 4
 * transition types there).
 */
export async function fixEpubTypePlacement(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];

  for (const filePath of Object.keys(zip.files)) {
    if (!/\.x?html?$/i.test(filePath)) continue;
    const entry = zip.file(filePath);
    if (!entry) continue;
    const original = await entry.async('text');

    let mutated = original;
    let swapCount = 0;

    // Match every <section …epub:type="X" …> opening tag. Iterate
    // the matches; for each forbidden X, rewrite the attributes
    // (strip epub:type, add role if absent).
    const sectionRe = /<section\b([^>]*?)>/gi;
    mutated = mutated.replace(sectionRe, (match, attrs) => {
      const epubTypeMatch = attrs.match(/(\s)epub:type\s*=\s*["']([^"']+)["']/i);
      if (!epubTypeMatch) return match;
      const tokens = epubTypeMatch[2].split(/\s+/).map((t: string) => t.toLowerCase());
      const forbidden = tokens.find((t: string) => SECTION_EPUB_TYPE_TO_ROLE[t]);
      if (!forbidden) return match;

      const docRole = SECTION_EPUB_TYPE_TO_ROLE[forbidden];

      // Strip the epub:type attribute entirely. We don't try to
      // preserve other tokens — PRH's rule is "no epub:type on
      // these sections", full stop.
      let newAttrs = attrs.replace(/(\s)epub:type\s*=\s*["'][^"']*["']/i, '');

      // Add role="doc-*" when no role attribute is present;
      // otherwise leave the existing role alone (operator may
      // have already set the correct value).
      if (!/(?:^|\s)role\s*=/i.test(newAttrs)) {
        newAttrs = `${newAttrs.trimEnd()} role="${docRole}"`;
      }
      swapCount += 1;
      return `<section${newAttrs}>`;
    });

    if (swapCount === 0) continue;

    zip.file(filePath, mutated);
    results.push({
      success: true,
      description: `Swapped ${swapCount} forbidden section epub:type value(s) to role attribute(s) in ${filePath}`,
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No misplaced epub:type values found — no changes needed' }];
  }
  return results;
}

// ── addDocAriaRoles ──────────────────────────────────────────────────────

/**
 * Insert `role="doc-*"` on the first matching section per
 * filename-driven heuristic. Same logic as the validator but
 * mutating instead of detecting. Adds the role; leaves any
 * existing attributes alone.
 */
export async function addDocAriaRoles(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];

  const SECTION_RULES: Array<{
    pathPattern: RegExp;
    docRole: string;
    element: 'section' | 'blockquote';
  }> = [
    { pathPattern: /(?:^|\/)(?:chapter|chap)[_-]?\d*\.x?html?$/i, docRole: 'doc-chapter', element: 'section' },
    { pathPattern: /(?:^|\/)part[_-]?\d*\.x?html?$/i, docRole: 'doc-part', element: 'section' },
    { pathPattern: /(?:^|\/)dedication\.x?html?$/i, docRole: 'doc-dedication', element: 'section' },
    { pathPattern: /(?:^|\/)epigraph\.x?html?$/i, docRole: 'doc-epigraph', element: 'blockquote' },
    { pathPattern: /(?:^|\/)appendix[_-]?\d*\.x?html?$/i, docRole: 'doc-appendix', element: 'section' },
  ];

  for (const rule of SECTION_RULES) {
    // First-only per the validator's FIRST-ONLY rule.
    const candidatePath = Object.keys(zip.files).find((p) => rule.pathPattern.test(p));
    if (!candidatePath) continue;
    const entry = zip.file(candidatePath);
    if (!entry) continue;
    const original = await entry.async('text');

    // Locate the first matching element opening tag.
    const openRe = new RegExp(`<${rule.element}\\b([^>]*)>`, 'i');
    const m = original.match(openRe);
    if (!m) continue;

    const existingRole = m[1].match(/(?:^|\s)role\s*=\s*["']([^"']+)["']/i);
    if (existingRole) {
      // Role already set — leave it alone, even if it isn't doc-*.
      // Operator may have a reason; validator will re-flag if so.
      continue;
    }

    const updatedTag = `<${rule.element}${m[1].trimEnd()} role="${rule.docRole}">`;
    const mutated = original.replace(m[0], updatedTag);
    zip.file(candidatePath, mutated);
    results.push({
      success: true,
      description: `Added role="${rule.docRole}" to first <${rule.element}> in ${candidatePath}`,
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No matching first-of-type sections needed doc-* roles — no changes needed' }];
  }
  return results;
}

// ── fixBodyPurity ────────────────────────────────────────────────────────

/**
 * Strip `role`, `aria-label`, and `aria-labelledby` from every
 * `<body>` element. PRH explicitly prohibits ARIA on body. Same
 * whitespace-anchor regex as the validator.
 */
export async function fixBodyPurity(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];
  const BANNED = ['role', 'aria-label', 'aria-labelledby'] as const;

  for (const filePath of Object.keys(zip.files)) {
    if (!/\.x?html?$/i.test(filePath)) continue;
    const entry = zip.file(filePath);
    if (!entry) continue;
    const original = await entry.async('text');

    const bodyOpenMatch = original.match(/<body\b([^>]*)>/i);
    if (!bodyOpenMatch) continue;

    let attrs = bodyOpenMatch[1];
    const offenders: string[] = [];
    for (const attr of BANNED) {
      // Backreference pattern handles `aria-label="Chapter's start"`
      // and similar attributes that contain inner quotes. Without it
      // the strip would truncate at the inner apostrophe.
      const re = new RegExp(`(\\s)${attr}\\s*=\\s*(["'])[\\s\\S]*?\\2`, 'i');
      if (re.test(attrs)) {
        offenders.push(attr);
        attrs = attrs.replace(re, '');
      }
    }
    if (offenders.length === 0) continue;

    const mutated = original.replace(bodyOpenMatch[0], `<body${attrs}>`);
    zip.file(filePath, mutated);
    results.push({
      success: true,
      description: `Stripped ${offenders.join(' / ')} from <body> in ${filePath}`,
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No <body> ARIA attributes found — no changes needed' }];
  }
  return results;
}

// ── fixPagebreakMalformed ────────────────────────────────────────────────

/**
 * Repair `<span epub:type="pagebreak">` elements:
 *   - Ensure `role="doc-pagebreak"` is set (add when absent or
 *     when role doesn't include the doc-pagebreak token).
 *   - Rewrite `aria-label` to a bare digit string when it currently
 *     carries "page 12" / "pg 12" / "page12" prefixes. Leave bare
 *     digit / roman-numeral text aria-labels alone; the validator
 *     surfaces those separately for operator review.
 */
export async function fixPagebreakMalformed(zip: JSZip): Promise<ChangeResult[]> {
  const results: ChangeResult[] = [];

  for (const filePath of Object.keys(zip.files)) {
    if (!/\.x?html?$/i.test(filePath)) continue;
    const entry = zip.file(filePath);
    if (!entry) continue;
    const original = await entry.async('text');

    let mutated = original;
    let repairCount = 0;

    const tagRe = /<span\b([^>]*(?:^|\s)epub:type\s*=\s*["'][^"']*\bpagebreak\b[^"']*["'][^>]*)(\s*\/?\s*)>/gi;
    mutated = mutated.replace(tagRe, (match, attrs, trailing) => {
      let newAttrs = attrs;
      let mutatedHere = false;

      // 1. role attribute
      const roleMatch = newAttrs.match(/(?:^|\s)role\s*=\s*["']([^"']+)["']/i);
      const hasDocPagebreakRole =
        !!roleMatch && roleMatch[1].split(/\s+/).map((t: string) => t.toLowerCase()).includes('doc-pagebreak');
      if (!hasDocPagebreakRole) {
        if (roleMatch) {
          // Append doc-pagebreak to the existing role tokens.
          newAttrs = newAttrs.replace(
            /((?:^|\s)role\s*=\s*["'])([^"']+)(["'])/i,
            (_m: string, prefix: string, tokens: string, suffix: string) => `${prefix}${tokens} doc-pagebreak${suffix}`,
          );
        } else {
          newAttrs = `${newAttrs.trimEnd()} role="doc-pagebreak"`;
        }
        mutatedHere = true;
      }

      // 2. aria-label — rewrite "page 12" → "12", "pg 12" → "12".
      const labelMatch = newAttrs.match(/(\s)aria-label\s*=\s*["']([^"']*)["']/i);
      if (labelMatch) {
        const labelValue = labelMatch[2];
        const digitsOnly = labelValue.match(/\b(\d+)\b/);
        if (digitsOnly && /^(?:page|pg)\s*\d+/i.test(labelValue.trim())) {
          newAttrs = newAttrs.replace(
            /(\s)aria-label\s*=\s*["'][^"']*["']/i,
            `$1aria-label="${digitsOnly[1]}"`,
          );
          mutatedHere = true;
        }
      }

      if (!mutatedHere) return match;
      repairCount += 1;
      return `<span${newAttrs}${trailing}>`;
    });

    if (repairCount === 0) continue;

    zip.file(filePath, mutated);
    results.push({
      success: true,
      description: `Repaired ${repairCount} pagebreak span(s) in ${filePath}`,
    });
  }

  if (results.length === 0) {
    return [{ success: true, description: 'No malformed pagebreaks found — no changes needed' }];
  }
  return results;
}

// ── Logger wrapper (intentionally unused export — for future debug hook) ──

void logger;
