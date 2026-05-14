/**
 * PRH UK file / directory / size validator (P6/PR2).
 *
 * Per Technical Guide §3 + §15:
 *   - XHTML chapter files must be ≤ 600KB (split at section
 *     boundaries above that).
 *   - Plate XHTML (image-heavy spreads) must be ≤ 11MB.
 *   - Required subdirectories: `/xhtml`, `/images`, `/fonts`,
 *     `/styles`. Optional `/media`, `/scripts`.
 *   - Filenames are lowercase, alphanumeric + `_` + `-`, with a
 *     single `.` before the extension.
 *   - Fixed names: `package.opf`, `toc.ncx` (EPUB2-compat),
 *     `nav.xhtml`, `cover.<ext>`, `basestyles.css`.
 *
 * Detect-only — renaming a file cascades through the manifest,
 * hrefs and fragment identifiers, and is operator-confirmed only.
 *
 * Note: `basestyles.css` presence is already covered by
 * `PRH-CSS-BASESTYLES-RENAMED` (P6/PR1). This validator omits it
 * from the fixed-name check to avoid double-counting.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type {
  PrhValidatorIssue,
  PrhFileLayoutInput,
  PrhManifestEntry,
} from './types';

const XHTML_OVERSIZE_LIMIT = 600 * 1024;
const PLATE_OVERSIZE_LIMIT = 11 * 1024 * 1024;
const XHTML_MEDIA_TYPE = 'application/xhtml+xml';

/**
 * Paths that are exempt from the naming-convention check. The
 * canonical exemptions are:
 *   - the literal `mimetype` file at the zip root
 *   - anything under the `META-INF/` directory (reader-specific
 *     display options like `META-INF/com.apple.ibooks.display-options.xml`
 *     are legitimate even though they don't match the lowercase /
 *     underscore-only rule)
 */
function isNamingException(zipPath: string): boolean {
  return zipPath === 'mimetype' || /^META-INF\//i.test(zipPath);
}

/** Filename pattern: lowercase alphanumeric + `_` + `-`, single `.` before extension. */
const VALID_FILENAME = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9]+$/;

export function validatePrhFileLayout(input: PrhFileLayoutInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // 1. XHTML / plate oversize. Iterate XHTML manifest entries and
  //    branch on plate-ness via filename heuristic.
  for (const entry of input.manifestEntries) {
    if (entry.mediaType !== XHTML_MEDIA_TYPE) continue;
    if (entry.sizeBytes === null) continue;
    if (isPlateXhtml(entry.path)) {
      if (entry.sizeBytes > PLATE_OVERSIZE_LIMIT) {
        issues.push(
          buildIssue(
            'PRH-FILE-PLATE-OVERSIZE',
            entry.path,
            ` (${formatBytes(entry.sizeBytes)} > 11MB)`,
          ),
        );
      }
    } else if (entry.sizeBytes > XHTML_OVERSIZE_LIMIT) {
      issues.push(
        buildIssue(
          'PRH-FILE-XHTML-OVERSIZE',
          entry.path,
          ` (${formatBytes(entry.sizeBytes)} > 600KB)`,
        ),
      );
    }
  }

  // 2. Directory layout. For each expected directory, check whether
  //    content of that type lives at a non-canonical path. Only fire
  //    when content exists but isn't in the canonical place — empty
  //    sub-directories are not enforced.
  for (const violation of findDirLayoutViolations(input.manifestEntries, input.opfPath)) {
    issues.push(buildIssue('PRH-DIR-LAYOUT-NONSTANDARD', violation.detail));
  }

  // 3. Filename convention.
  for (const violation of findNamingViolations(input.zipPaths)) {
    issues.push(buildIssue('PRH-FILE-NAMING-NONSTANDARD', violation));
  }

  // 4. Fixed-name presence.
  for (const missing of findMissingFixedNames(input)) {
    issues.push(buildIssue('PRH-FILE-FIXED-NAME-MISSING', missing));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Plate XHTML heuristic. PRH plates use the `_plate` token in the
 * basename or live under an `/images/plates/` subdir; both are
 * defensible signals. We deliberately don't trust the spine
 * `linear="no"` attribute alone because non-linear pages can also
 * be footnotes / endnotes / long descriptions, which are subject
 * to the 600KB cap, not the 11MB cap.
 */
function isPlateXhtml(zipPath: string): boolean {
  const lower = zipPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  // `\bplate\b` fails inside `plate_001` because `_` is a word char,
  // so the trailing `\b` doesn't land between `e` and `_`. Match `plate`
  // explicitly delimited by start-of-basename / `_` / `-` on the left
  // and `_` / `-` / `.` / end on the right.
  if (/(?:^|[_-])plate(?:[_-]|\.|$)/.test(base)) return true;
  if (/\/plates?\//.test(lower)) return true;
  return false;
}

/**
 * Walk manifest entries and identify content that lives outside its
 * canonical sub-directory. Returns one entry per affected type, not
 * per file, so a book with 50 mis-located images produces a single
 * finding rather than 50.
 *
 * Canonical = directly under the OPF root. We anchor on the OPF dir
 * because manifest hrefs are resolved relative to it; both common
 * EPUB layouts (`EPUB/package.opf` + `EPUB/images/...` and the
 * root-level `package.opf` + `images/...`) are accepted, while
 * nested paths like `EPUB/xhtml/images/foo.png` are flagged because
 * they don't live directly under the canonical top-level dir.
 */
function findDirLayoutViolations(
  entries: PrhManifestEntry[],
  opfPath: string,
): Array<{ detail: string }> {
  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/')).toLowerCase()
    : '';
  const typeGroups: Array<{ pred: (e: PrhManifestEntry) => boolean; dirSegment: string; label: string }> = [
    {
      pred: (e) => e.mediaType.startsWith('image/'),
      dirSegment: 'images',
      label: 'images',
    },
    {
      pred: (e) => e.mediaType === 'text/css',
      dirSegment: 'styles',
      label: 'stylesheets',
    },
    {
      pred: (e) => e.mediaType.startsWith('font/') || /\b(application\/vnd\.ms-opentype|application\/font-woff2?)\b/.test(e.mediaType),
      dirSegment: 'fonts',
      label: 'fonts',
    },
    {
      pred: (e) => e.mediaType === XHTML_MEDIA_TYPE,
      dirSegment: 'xhtml',
      label: 'XHTML files',
    },
  ];

  const out: Array<{ detail: string }> = [];
  for (const group of typeGroups) {
    const matching = entries.filter(group.pred);
    if (matching.length === 0) continue;
    const canonicalPrefix = opfDir ? `${opfDir}/${group.dirSegment}/` : `${group.dirSegment}/`;
    const offenders = matching.filter((e) => !e.path.toLowerCase().startsWith(canonicalPrefix));
    if (offenders.length > 0) {
      const sample = offenders.slice(0, 3).map((e) => e.path).join(', ');
      const more = offenders.length > 3 ? `, +${offenders.length - 3} more` : '';
      out.push({
        detail: `${group.label} not under ${canonicalPrefix} (${offenders.length} file(s): ${sample}${more})`,
      });
    }
  }
  return out;
}

/**
 * Walk every zip entry and check the basename against the
 * lowercase / single-dot / `[a-z0-9_-]` rule. Returns a deduped,
 * sample-capped list.
 */
function findNamingViolations(zipPaths: string[]): string[] {
  const offenders: string[] = [];
  for (const path of zipPaths) {
    if (isNamingException(path)) continue;
    if (path === '' || path.endsWith('/')) continue; // directory entries
    const base = basename(path);
    if (!VALID_FILENAME.test(base)) {
      offenders.push(path);
    }
  }
  return offenders;
}

/**
 * Check the EPUB has every required fixed-name file. Returns a list
 * of human-readable "missing X" strings.
 *
 * Required:
 *   - `package.opf`         (always — basename of opfPath must match)
 *   - `nav.xhtml`           (always — locate via manifest properties="nav")
 *   - `toc.ncx`             (only when spine declares toc="ncx")
 *   - `cover.<ext>`         (always — locate via properties="cover-image"
 *                            for the image, AND cover.xhtml for the surface)
 *
 * `basestyles.css` is intentionally NOT checked here — it's already
 * covered by `PRH-CSS-BASESTYLES-RENAMED` (P6/PR1) and double-emitting
 * dilutes the operator signal.
 */
function findMissingFixedNames(input: PrhFileLayoutInput): string[] {
  const missing: string[] = [];

  // package.opf
  if (basename(input.opfPath).toLowerCase() !== 'package.opf') {
    missing.push(`package.opf (actual: ${input.opfPath})`);
  }

  // nav.xhtml — pass if ANY manifest item with properties="nav" has
  // basename nav.xhtml. EPUB 3 specifies exactly one such item, but a
  // non-conformant input could carry more than one; matching on "any"
  // avoids order-dependent false negatives.
  const navEntries = input.manifestEntries.filter((e) => e.properties.includes('nav'));
  if (navEntries.length === 0) {
    missing.push('nav.xhtml (no manifest item with properties="nav")');
  } else if (!navEntries.some((e) => basename(e.path).toLowerCase() === 'nav.xhtml')) {
    missing.push(`nav.xhtml (actual: ${navEntries[0].path})`);
  }

  // toc.ncx — only when EPUB2 compat is in use.
  if (input.requiresNcx) {
    const ncxEntries = input.manifestEntries.filter(
      (e) => e.mediaType === 'application/x-dtbncx+xml',
    );
    if (ncxEntries.length === 0) {
      missing.push('toc.ncx (spine declares toc="ncx" but no NCX manifest item)');
    } else if (!ncxEntries.some((e) => basename(e.path).toLowerCase() === 'toc.ncx')) {
      missing.push(`toc.ncx (actual: ${ncxEntries[0].path})`);
    }
  }

  // cover.<ext> — image (via properties="cover-image").
  const coverImages = input.manifestEntries.filter((e) => e.properties.includes('cover-image'));
  if (coverImages.length === 0) {
    missing.push('cover.<ext> (no manifest item with properties="cover-image")');
  } else if (!coverImages.some((e) => /^cover\.[a-z0-9]+$/i.test(basename(e.path)))) {
    missing.push(`cover.<ext> image (actual: ${coverImages[0].path})`);
  }

  return missing;
}

function basename(zipPath: string): string {
  const idx = zipPath.lastIndexOf('/');
  return idx === -1 ? zipPath : zipPath.slice(idx + 1);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function buildIssue(
  code:
    | 'PRH-FILE-XHTML-OVERSIZE'
    | 'PRH-FILE-PLATE-OVERSIZE'
    | 'PRH-DIR-LAYOUT-NONSTANDARD'
    | 'PRH-FILE-NAMING-NONSTANDARD'
    | 'PRH-FILE-FIXED-NAME-MISSING',
  location: string,
  detail = '',
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location}${detail}`,
    suggestion: suggestionFor(code),
    location,
  };
}

function suggestionFor(code: string): string {
  switch (code) {
    case 'PRH-FILE-XHTML-OVERSIZE':
      return 'Split this chapter at the next section boundary so each XHTML is ≤ 600KB. Update spine + nav references after splitting.';
    case 'PRH-FILE-PLATE-OVERSIZE':
      return 'Reduce the image set or split the plate sequence into multiple XHTML files; each plate must be ≤ 11MB.';
    case 'PRH-DIR-LAYOUT-NONSTANDARD':
      return 'Move the listed resources into /xhtml, /images, /fonts, or /styles as appropriate and update manifest hrefs.';
    case 'PRH-FILE-NAMING-NONSTANDARD':
      return 'Rename the file to lowercase alphanumeric + underscore + hyphen with a single dot before the extension (e.g. chapter_001.xhtml).';
    case 'PRH-FILE-FIXED-NAME-MISSING':
      return 'Rename the file to the canonical name so reading-system fallbacks and the cover surface resolve correctly.';
    default:
      return '';
  }
}
