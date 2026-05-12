/**
 * PRH UK epub:type placement validator (P3/PR1).
 *
 * Per the Technical Guide §6.1, PRH's `epub:type` rules are stricter
 * than the EPUB 3 spec:
 *
 *   - On `<body>`: only ONE of `cover` / `frontmatter` / `bodymatter` /
 *     `backmatter` is allowed (the four transition points). Each of
 *     those four MUST appear at most once across the entire EPUB.
 *   - On `<section>`: the following values are FORBIDDEN — `chapter`,
 *     `part`, `dedication`, `epigraph`, `appendix`, `prologue`,
 *     `preface`, `acknowledgements`. PRH wants these expressed via
 *     ARIA `role="doc-*"` instead (see doc-aria-roles-validator).
 *   - Other section types (titlepage, copyright-page, footnotes,
 *     endnotes, glossary, bibliography, index, toc, page-list, etc.)
 *     are allowed.
 *
 * Issue codes:
 *   - PRH-MARKUP-EPUB-TYPE-MISPLACED  — bad value on body or section
 *   - PRH-MARKUP-EPUB-TYPE-DUPLICATE  — same transition type on multiple <body>
 *
 * Detect-only. Auto-fix (swap epub:type → role) lands in P5.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/** epub:type values allowed on <body> per PRH spec. */
const ALLOWED_BODY_EPUB_TYPES = new Set([
  'cover',
  'frontmatter',
  'bodymatter',
  'backmatter',
]);

/**
 * epub:type values FORBIDDEN on <section>. PRH wants these expressed
 * via `role="doc-*"` instead. Not exhaustive — only the values PRH
 * explicitly calls out in Technical Guide §6.1.
 */
const FORBIDDEN_SECTION_EPUB_TYPES = new Set([
  'chapter',
  'part',
  'dedication',
  'epigraph',
  'appendix',
  'prologue',
  'preface',
  'acknowledgements',
  'acknowledgments', // tolerate US spelling
]);

export function validatePrhEpubTypePlacement(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  /**
   * Track which transition types we've seen on <body> across the EPUB.
   * Used to fire DUPLICATE when the same transition appears twice
   * (e.g. two files marked `<body epub:type="frontmatter">`).
   */
  const transitionTypeSeenIn = new Map<string, string[]>();

  for (const file of input.xhtmlFiles) {
    // ── <body epub:type="…"> ───────────────────────────────────────────
    const bodyTypes = extractBodyEpubTypes(file.content);
    if (bodyTypes !== null) {
      for (const tok of bodyTypes) {
        if (!ALLOWED_BODY_EPUB_TYPES.has(tok)) {
          issues.push(buildIssue(
            'PRH-MARKUP-EPUB-TYPE-MISPLACED',
            `<body epub:type="${tok}"> is not allowed. PRH restricts body epub:type to one of: cover, frontmatter, bodymatter, backmatter.`,
            `Move "${tok}" to the section level if it's a section type, or remove it if it duplicates the surrounding transition. Use role="doc-${tok.replace(/-page$/, '')}" if a doc-* ARIA role exists for this semantic.`,
            file.path,
          ));
          continue;
        }
        // Track for duplicate detection.
        const existing = transitionTypeSeenIn.get(tok);
        if (existing) {
          existing.push(file.path);
        } else {
          transitionTypeSeenIn.set(tok, [file.path]);
        }
      }
    }

    // ── <section epub:type="…"> ────────────────────────────────────────
    // We don't want to walk every section node — that's costly on big
    // books. A simple regex scan over <section ...> opening tags is
    // sufficient for the forbidden-type check, because forbidden
    // values only appear in `epub:type` attribute syntax. False
    // positives from these values appearing INSIDE element text (e.g. a
    // chapter title that contains the word "chapter") are not possible
    // because we anchor on `epub:type="…"`.
    const sectionOpenRe = /<section\b[^>]*\bepub:type\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = sectionOpenRe.exec(file.content)) !== null) {
      const tokens = m[1].split(/\s+/);
      for (const tok of tokens) {
        if (FORBIDDEN_SECTION_EPUB_TYPES.has(tok.toLowerCase())) {
          issues.push(buildIssue(
            'PRH-MARKUP-EPUB-TYPE-MISPLACED',
            `<section epub:type="${tok}"> is forbidden by PRH. Replace with role="doc-${tok.toLowerCase()}" (no epub:type).`,
            `Change <section epub:type="${tok}"> to <section role="doc-${tok.toLowerCase()}">. See Technical Guide §6.1.`,
            file.path,
          ));
        }
      }
    }
  }

  // ── Duplicate transition types across <body> elements ────────────────
  for (const [tok, paths] of transitionTypeSeenIn) {
    if (paths.length > 1) {
      // Emit one issue per duplicate occurrence (skip the first
      // canonical use). The operator can keep one, drop the others.
      for (let i = 1; i < paths.length; i += 1) {
        issues.push(buildIssue(
          'PRH-MARKUP-EPUB-TYPE-DUPLICATE',
          `<body epub:type="${tok}"> appears in multiple files (${paths.join(', ')}). Each transition type must appear on at most one <body> across the EPUB.`,
          `Keep <body epub:type="${tok}"> on ${paths[0]} and remove the attribute from ${paths[i]}.`,
          paths[i],
        ));
      }
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Pull the lowercase token list from a `<body epub:type="…">` attribute.
 * Returns `null` when the file has no body epub:type attribute (common
 * for files that don't carry a transition marker — nav.xhtml, etc.).
 */
function extractBodyEpubTypes(html: string): string[] | null {
  const m = html.match(/<body\b[^>]*\bepub:type\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  return m[1].split(/\s+/).map((s) => s.toLowerCase()).filter(Boolean);
}

function buildIssue(
  code: keyof typeof PRH_ISSUE_CODES,
  message: string,
  suggestion: string,
  location: string,
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${message}`,
    suggestion,
    location,
  };
}
