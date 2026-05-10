/**
 * PRH UK image validator.
 *
 * Two checks per EPUB:
 *
 *   PRH-COVER-ALT-EMPTY                       — the cover image's alt must
 *                                                be non-empty. Per Style
 *                                                Guide Appendix 7: "Cover:
 *                                                The cover image's alt
 *                                                attribute must be populated
 *                                                to avoid validation flags
 *                                                due to the cover's ARIA
 *                                                role; it cannot be empty.
 *                                                You may use a simple
 *                                                format, for example:
 *                                                alt='Cover for [Book
 *                                                Title]'."
 *
 *   PRH-DECORATIVE-MISSING-PRESENTATION-ROLE  — decorative images (alt="")
 *                                                must also declare
 *                                                role="presentation" so
 *                                                assistive technologies
 *                                                consistently skip them.
 *                                                Style Guide Appendix 7:
 *                                                "<img src='decorative_
 *                                                image.jpg' alt=''
 *                                                role='presentation' />".
 *
 * Implementation is pure functions over parsed inputs — no I/O.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhPerXhtmlInput, PrhValidatorIssue } from './types';

export function validatePrhImages(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // ── 1. Cover alt must be non-empty ──────────────────────────────────────
  const coverFile = findCoverXhtml(input);
  if (coverFile) {
    const coverAlt = readCoverImageAlt(coverFile.content);
    // Distinguish three cases:
    //   { kind: 'no-img' }       — cover uses background image / SVG /
    //                              something other than <img>; that's a
    //                              different concern, not PRH-COVER-ALT-EMPTY.
    //   { kind: 'missing-alt' }  — <img> present but alt attribute absent.
    //   { kind: 'value', value }  — alt attribute present (may be empty).
    if (coverAlt.kind === 'missing-alt') {
      issues.push(
        buildIssue('PRH-COVER-ALT-EMPTY', coverFile.path, {
          message: 'Cover <img> has no alt attribute at all',
          suggestion: input.bookTitle
            ? `Add alt="Cover for ${input.bookTitle}" to the cover <img>`
            : 'Add a descriptive alt attribute to the cover <img> (e.g. alt="Cover for [Book Title]")',
        }),
      );
    } else if (coverAlt.kind === 'value' && coverAlt.value.length === 0) {
      issues.push(
        buildIssue('PRH-COVER-ALT-EMPTY', coverFile.path, {
          message: 'Cover <img> alt is empty; PRH requires a non-empty alt (e.g. "Cover for [Book Title]")',
          suggestion: input.bookTitle
            ? `Set the cover image alt to "Cover for ${input.bookTitle}" (or another descriptive non-empty value)`
            : 'Set the cover image alt to "Cover for [Book Title]" using the book title from dc:title',
        }),
      );
    }
    // kind === 'no-img' or non-empty value → no PRH-COVER-ALT-EMPTY.
  }

  // ── 2. Decorative images must declare role="presentation" ──────────────
  // We deliberately scan every XHTML/HTML file (not just spine entries) so
  // long-description appendices, footnote files, etc. are covered too.
  // Skip cover XHTMLs — their <img alt=""> is a separate concern flagged
  // by PRH-COVER-ALT-EMPTY (the cover must have a non-empty alt, not
  // role="presentation"). Auto-fixing it would actively work against the
  // operator's intent.
  for (const file of input.xhtmlFiles) {
    if (isCoverXhtml(file.content)) continue;
    const decoratives = findDecorativeImagesMissingRole(file.content);
    for (const img of decoratives) {
      issues.push(
        buildIssue('PRH-DECORATIVE-MISSING-PRESENTATION-ROLE', file.path, {
          message: `Decorative <img${img.srcSuffix}> has alt="" but is missing role="presentation"`,
          suggestion: 'Add role="presentation" to the <img> element so assistive technologies consistently skip it',
        }),
      );
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface CoverFile {
  path: string;
  content: string;
}

/**
 * Locate the cover XHTML inside the EPUB. Preference order:
 *   1. spine entry with epub:type="cover" on its <body>.
 *   2. manifest item whose id is exactly "cover" and href ends .xhtml/.html.
 *   3. manifest item whose href basename matches `^cover\.x?html?$`.
 * Returns the file content from the xhtmlFiles input. Defensive: returns
 * null if anything goes sideways.
 */
function findCoverXhtml(input: PrhPerXhtmlInput): CoverFile | null {
  // First try: any XHTML file containing <body epub:type="cover">. This is
  // the most reliable signal — it's an explicit declaration from the
  // publisher.
  for (const file of input.xhtmlFiles) {
    if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcover\b[^"']*["']/i.test(file.content)) {
      return file;
    }
  }

  // Fall back to manifest hints. Parse manifest items from the OPF.
  const manifestMatch = input.opfContent.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return null;
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(manifestMatch[1])) !== null) {
    const attrs = m[1];
    const id = readAttr(attrs, 'id');
    const href = readAttr(attrs, 'href');
    const mediaType = readAttr(attrs, 'media-type');
    if (!href) continue;
    if (mediaType && !/xhtml/i.test(mediaType) && !/html/i.test(mediaType)) continue;
    if (!/\.(x?html?)$/i.test(href)) continue;

    const isCover =
      (id != null && id.toLowerCase() === 'cover')
      || /(?:^|\/)cover\.x?html?$/i.test(href);
    if (!isCover) continue;

    // Resolve manifest href to a zip path and look up content.
    const target = resolveCoverPath(href, input.xhtmlFiles);
    if (target) return target;
  }
  return null;
}

/**
 * Match the manifest href against the input file list. We don't have the
 * OPF path in scope, so we use a "ends-with on path-segment boundary"
 * heuristic — sufficient for the cover (a single canonical file at a
 * well-known location). The `/` boundary stops `front-cover.xhtml` from
 * masquerading as `cover.xhtml`.
 */
function resolveCoverPath(href: string, xhtmlFiles: PrhPerXhtmlInput['xhtmlFiles']): CoverFile | null {
  // Strip leading `./` and normalise.
  const normalisedHref = href.replace(/^\.\//, '');
  // Try exact match first.
  const exact = xhtmlFiles.find((f) => f.path === normalisedHref);
  if (exact) return exact;
  // Suffix match must respect path-segment boundaries — require a leading
  // `/` (so 'xhtml/cover.xhtml' matches, but 'front-cover.xhtml' doesn't
  // match a manifest href of 'cover.xhtml').
  const suffix = xhtmlFiles.find((f) => f.path.endsWith(`/${normalisedHref}`));
  return suffix ?? null;
}

/**
 * Quick test for whether an XHTML file is the cover document. Used to
 * exclude cover XHTML from the decorative-image scan — the cover's
 * <img alt=""> belongs to PRH-COVER-ALT-EMPTY, not the decorative
 * concern.
 */
function isCoverXhtml(content: string): boolean {
  return /<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcover\b[^"']*["']/i.test(content);
}

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return (m[1] ?? m[2]) ?? null;
}

type CoverAltResult =
  | { kind: 'no-img' }
  | { kind: 'missing-alt' }
  | { kind: 'value'; value: string };

/**
 * Read the alt attribute of the cover image. Distinguishes:
 *   - 'no-img'      — cover XHTML has no <img> at all (e.g. SVG cover
 *                      or background-image style); a separate concern,
 *                      NOT PRH-COVER-ALT-EMPTY.
 *   - 'missing-alt' — <img> present but with no alt attribute. This is
 *                      a hard failure of the PRH rule.
 *   - 'value'       — alt attribute present; value (trimmed) supplied.
 *                      Empty string here is the canonical "decorative"
 *                      marker which PRH forbids on the cover.
 */
function readCoverImageAlt(coverXhtml: string): CoverAltResult {
  // Find the FIRST <img> inside <body>. The cover XHTML pattern PRH
  // documents is `<body epub:type="cover"><figure><img .../></figure>`.
  const bodyMatch = coverXhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const haystack = bodyMatch ? bodyMatch[1] : coverXhtml;
  const imgMatch = haystack.match(/<img\b([^>]*)\/?>/i);
  if (!imgMatch) return { kind: 'no-img' };
  const altMatch = imgMatch[1].match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!altMatch) return { kind: 'missing-alt' };
  const value = (altMatch[1] ?? altMatch[2] ?? '').trim();
  return { kind: 'value', value };
}

interface DecorativeImageHit {
  srcSuffix: string;
}

/**
 * Find every `<img>` whose alt is empty AND that has NO `role` attribute
 * at all. Returns one hit per offending image, with a short `src=`
 * snippet for the issue message.
 *
 * Note: we don't flag images that have a non-presentation role like
 * `role="button"` either — they're outside this rule's scope, and the
 * remediator can't safely add another role attribute alongside an
 * existing one (would produce duplicate attribute = invalid XML).
 */
function findDecorativeImagesMissingRole(content: string): DecorativeImageHit[] {
  const hits: DecorativeImageHit[] = [];
  const imgRe = /<img\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(content)) !== null) {
    const attrs = m[1];
    // Must have alt="" (empty) — img with no alt at all is a separate
    // class (covered by EPUB-IMG-001) and not a "decorative" image yet.
    const altMatch = attrs.match(/\balt\s*=\s*(["'])([^"']*)\1/i);
    if (!altMatch) continue;
    if (altMatch[2].length > 0) continue;
    // Any role attribute present? — skip. This includes the canonical
    // presentation/none roles AND any other role (e.g. role="button")
    // that we shouldn't touch.
    if (/\brole\s*=\s*["'][^"']*["']/i.test(attrs)) continue;
    // Capture src for the issue message.
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const src = srcMatch?.[1] ?? srcMatch?.[2] ?? '';
    hits.push({ srcSuffix: src ? ` src="${src}"` : '' });
  }
  return hits;
}

function buildIssue(
  code: keyof typeof PRH_ISSUE_CODES,
  location: string,
  parts: { message: string; suggestion: string },
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: parts.message,
    suggestion: parts.suggestion,
    location,
  };
}
