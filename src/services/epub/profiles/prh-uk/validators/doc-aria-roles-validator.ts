/**
 * PRH UK doc-* ARIA role validator (P3/PR1).
 *
 * Per Technical Guide §6.1, chapter / part / dedication / epigraph /
 * appendix sections should carry an ARIA `role="doc-*"` attribute
 * instead of `epub:type` (the latter is forbidden for these types
 * — see epub-type-placement-validator).
 *
 * Detection is filename-driven (heuristic) — we look for the file
 * whose path matches a section pattern, then check whether its first
 * `<section>` or `<blockquote>` carries the matching doc-* role.
 *
 * Scoping decisions baked in (per P3 plan Q4 + Q5):
 *   - FIRST-ONLY: emit at most one issue per section type per EPUB. The
 *     first chapter section without `role="doc-chapter"` fires; later
 *     chapter files don't get nagged repeatedly. PRH's rule is that the
 *     role goes on Chapter 1 / Part 1 only.
 *   - SLIM BOOK GUARD: when the EPUB has zero or one bodymatter
 *     candidate, skip the chapter role check. A single-section
 *     bodymatter book (essay, memoir, novella) probably doesn't have
 *     an explicit chapter division at all, so emitting a "missing
 *     chapter role" issue would be noise.
 *
 * Issue codes:
 *   - PRH-ARIA-CHAPTER-ROLE-MISSING
 *   - PRH-ARIA-PART-ROLE-MISSING
 *   - PRH-ARIA-DEDICATION-ROLE-MISSING
 *   - PRH-ARIA-EPIGRAPH-ROLE-MISSING
 *   - PRH-ARIA-APPENDIX-ROLE-MISSING
 *
 * Detect-only. Auto-fix (insert role attribute) lands in P5.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput, PrhXhtmlFile } from './types';

/**
 * Order the XHTML files by the EPUB spine when possible. The "first
 * chapter section" check needs the AUTHORITATIVE first chapter — zip
 * entry order is usually a good proxy (zips are typically built from
 * spine order) but a re-zipped EPUB could have a different on-disk
 * order than its declared reading order. Spine wins when we have it.
 *
 * Falls back to the raw `xhtmlFiles` order when:
 *   - opfContent has no <spine>
 *   - spine itemrefs don't reference any manifest items
 *   - manifest doesn't carry an href we can resolve to an xhtmlFiles path
 *
 * Files that aren't in the spine (orphans) are appended at the end in
 * their original order, so the SLIM BOOK GUARD's count of
 * chapter-shaped files stays consistent across both code paths.
 */
function orderFilesBySpine(
  opfContent: string,
  opfPath: string,
  xhtmlFiles: PrhXhtmlFile[],
): PrhXhtmlFile[] {
  const manifestMatch = opfContent.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  const spineMatch = opfContent.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!manifestMatch || !spineMatch) return xhtmlFiles;

  // Build idref → resolved zip path.
  const manifest = new Map<string, string>();
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  while ((im = itemRe.exec(manifestMatch[1])) !== null) {
    const idMatch = im[1].match(/\bid\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = im[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!idMatch || !hrefMatch) continue;
    manifest.set(idMatch[1], resolveOpfRelative(opfDir, hrefMatch[1]));
  }

  // Walk spine itemrefs, collecting resolved paths in spine order.
  const spineOrderedPaths: string[] = [];
  const refRe = /<itemref\b([^>]*)\/?>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = refRe.exec(spineMatch[1])) !== null) {
    const idrefMatch = rm[1].match(/\bidref\s*=\s*["']([^"']+)["']/i);
    if (!idrefMatch) continue;
    const resolved = manifest.get(idrefMatch[1]);
    if (resolved) spineOrderedPaths.push(resolved);
  }
  if (spineOrderedPaths.length === 0) return xhtmlFiles;

  const filesByPath = new Map(xhtmlFiles.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const ordered: PrhXhtmlFile[] = [];
  for (const p of spineOrderedPaths) {
    const f = filesByPath.get(p);
    if (f && !seen.has(p)) {
      ordered.push(f);
      seen.add(p);
    }
  }
  // Append any xhtml files not referenced by the spine (orphans).
  for (const f of xhtmlFiles) {
    if (!seen.has(f.path)) ordered.push(f);
  }
  return ordered;
}

function resolveOpfRelative(opfDir: string, href: string): string {
  const combined = opfDir.length > 0 ? `${opfDir}/${href}` : href;
  const segments = combined.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

interface SectionKindRule {
  /** Code to emit when the role is missing. */
  code: keyof typeof PRH_ISSUE_CODES;
  /** Required ARIA role value. */
  docRole: string;
  /** Filename pattern that flags candidate files. Anchored token. */
  pathPattern: RegExp;
  /** Element type to scope the role check to. */
  element: 'section' | 'blockquote';
}

/**
 * Per-section-type rules. Keep this list short and conservative — each
 * entry represents one issue code that can fire AT MOST once per EPUB.
 */
const SECTION_RULES: SectionKindRule[] = [
  {
    code: 'PRH-ARIA-CHAPTER-ROLE-MISSING',
    docRole: 'doc-chapter',
    pathPattern: /(?:^|\/)(?:chapter|chap)[_-]?\d*\.x?html?$/i,
    element: 'section',
  },
  {
    code: 'PRH-ARIA-PART-ROLE-MISSING',
    docRole: 'doc-part',
    pathPattern: /(?:^|\/)part[_-]?\d*\.x?html?$/i,
    element: 'section',
  },
  {
    code: 'PRH-ARIA-DEDICATION-ROLE-MISSING',
    docRole: 'doc-dedication',
    pathPattern: /(?:^|\/)dedication\.x?html?$/i,
    element: 'section',
  },
  {
    code: 'PRH-ARIA-EPIGRAPH-ROLE-MISSING',
    docRole: 'doc-epigraph',
    pathPattern: /(?:^|\/)epigraph\.x?html?$/i,
    element: 'blockquote',
  },
  {
    code: 'PRH-ARIA-APPENDIX-ROLE-MISSING',
    docRole: 'doc-appendix',
    pathPattern: /(?:^|\/)appendix[_-]?\d*\.x?html?$/i,
    element: 'section',
  },
];

export function validatePrhDocAriaRoles(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // Order files by EPUB spine (authoritative reading order). Falls
  // back to xhtmlFiles order when the spine can't be parsed.
  const ordered = orderFilesBySpine(input.opfContent, input.opfPath, input.xhtmlFiles);

  // SLIM BOOK GUARD: count files that LOOK like chapter sections.
  // When we have zero or one chapter-shaped file, skip the chapter
  // check entirely (Q5 default).
  const chapterCandidateCount = ordered.filter((f) =>
    SECTION_RULES[0].pathPattern.test(f.path),
  ).length;

  for (const rule of SECTION_RULES) {
    if (rule.docRole === 'doc-chapter' && chapterCandidateCount <= 1) {
      continue;
    }

    // FIRST-ONLY: find the first file matching the pattern, in spine
    // order. PRH's "Chapter 1 only" rule depends on reading-order
    // "first", not zip-order "first".
    const candidate = firstMatch(ordered, rule.pathPattern);
    if (!candidate) continue;

    if (!hasDocRole(candidate.content, rule.element, rule.docRole)) {
      issues.push(buildIssue(
        rule.code,
        `${candidate.path} does not carry role="${rule.docRole}" on its first <${rule.element}>. PRH requires ${rule.docRole} on the first ${rule.element === 'blockquote' ? 'epigraph blockquote' : 'section of this type'}.`,
        `Add role="${rule.docRole}" to the first <${rule.element}> in ${candidate.path} (drop any epub:type="${rule.docRole.replace(/^doc-/, '')}" attribute on the same element).`,
        candidate.path,
      ));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function firstMatch(
  files: PrhXhtmlFile[],
  pattern: RegExp,
): PrhXhtmlFile | null {
  for (const f of files) {
    if (pattern.test(f.path)) return f;
  }
  return null;
}

/**
 * True when the first occurrence of the target element carries the
 * required `role="doc-*"`. We pick the FIRST match because PRH's
 * rule is about the opening element (the "Chapter 1" container);
 * later siblings inherit by convention.
 *
 * Multiple values in `role="…"` are supported (space-separated). We
 * accept any value that includes the target token.
 */
function hasDocRole(html: string, element: 'section' | 'blockquote', docRole: string): boolean {
  const openTagRe = new RegExp(`<${element}\\b([^>]*)>`, 'i');
  const m = openTagRe.exec(html);
  if (!m) {
    // Element doesn't appear at all — can't enforce the role. Don't
    // emit (would be a noise issue against an unrelated XHTML).
    return true;
  }
  const attrs = m[1];
  const roleAttr = attrs.match(/\brole\s*=\s*["']([^"']+)["']/i);
  if (!roleAttr) return false;
  const roleTokens = roleAttr[1].split(/\s+/).map((t) => t.toLowerCase());
  return roleTokens.includes(docRole.toLowerCase());
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
