/**
 * PRH UK navigation-document validator.
 *
 * Per the Technical Guide (`nav.xhtml` example), every PRH EPUB must have a
 * nav document containing three <nav> blocks:
 *
 *   1. <nav epub:type="toc" role="doc-toc">           — visible TOC
 *   2. <nav epub:type="landmarks" class="at_only">    — landmark whitelist
 *   3. <nav epub:type="page-list" hidden="hidden"
 *           class="hidden_content">                   — print page-number map
 *
 * The page-list MUST be hidden via `hidden="hidden"` AND `class="hidden_content"`
 * (NOT inline style — reading systems treat the two attributes as canonical).
 *
 * The landmarks block must include entries for at least:
 *   - epub:type="cover"
 *   - epub:type="frontmatter"
 *   - epub:type="toc"
 *   - epub:type="bodymatter"
 *
 * (Other landmark entries — `loi`, `glossary`, `bibliography`, `index` — are
 * conditional on the book containing them, so we don't enforce them here.)
 *
 * All findings are detect-only. Auto-fix lands in a later PR.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhNavInput, PrhValidatorIssue } from './types';

export function validatePrhNav(input: PrhNavInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];
  const navContent = input.navContent;
  const location = input.navPath || 'nav.xhtml';

  // No nav doc at all → don't emit nav-specific issues. Detection that the
  // EPUB is missing a nav document entirely is EPUBCheck's job.
  if (!navContent) return issues;

  // ── 1. page-list nav ──────────────────────────────────────────────────
  const pageListBlock = extractNavBlock(navContent, 'page-list');
  if (!pageListBlock) {
    issues.push(
      buildIssue('PRH-NAV-MISSING-PAGELIST', location, {
        message: 'nav.xhtml is missing a <nav epub:type="page-list"> block',
        suggestion: 'Add a page-list nav with hidden="hidden" class="hidden_content"; populate from epub:type="pagebreak" anchors',
      }),
    );
  } else {
    const hasHiddenAttr = /\bhidden\s*=\s*["']hidden["']/i.test(pageListBlock.openTag);
    const hasHiddenClass = /\bclass\s*=\s*["'][^"']*\bhidden_content\b[^"']*["']/i.test(pageListBlock.openTag);
    if (!hasHiddenAttr || !hasHiddenClass) {
      const reasons: string[] = [];
      if (!hasHiddenAttr) reasons.push('hidden="hidden" attribute is missing');
      if (!hasHiddenClass) reasons.push('class="hidden_content" is missing');
      issues.push(
        buildIssue('PRH-NAV-PAGELIST-NOT-HIDDEN', location, {
          message: `page-list nav is not hidden as required: ${reasons.join('; ')}`,
          suggestion: 'Update <nav epub:type="page-list"> to include both hidden="hidden" attribute AND class="hidden_content" (do NOT use inline style="display:none")',
        }),
      );
    }
  }

  // ── 2. landmarks whitelist ────────────────────────────────────────────
  const landmarksBlock = extractNavBlock(navContent, 'landmarks');
  if (landmarksBlock) {
    // Per the Technical Guide example, landmark anchors carry epub:type
    // values like "cover", "frontmatter ibooks:reader-start-page" (multiple
    // tokens), "toc", "bodymatter". Match any anchor whose epub:type
    // attribute *contains* the required token (whitespace-separated).
    const requiredLandmarks: Array<{ token: string; code: keyof typeof PRH_ISSUE_CODES }> = [
      { token: 'cover', code: 'PRH-NAV-LANDMARKS-MISSING-COVER' },
      { token: 'frontmatter', code: 'PRH-NAV-LANDMARKS-MISSING-FRONTMATTER' },
      { token: 'toc', code: 'PRH-NAV-LANDMARKS-MISSING-TOC' },
      { token: 'bodymatter', code: 'PRH-NAV-LANDMARKS-MISSING-BODYMATTER' },
    ];
    for (const { token, code } of requiredLandmarks) {
      if (!landmarkContainsType(landmarksBlock.body, token)) {
        issues.push(
          buildIssue(code, location, {
            message: `landmarks nav is missing an entry with epub:type="${token}"`,
            suggestion: `Add: <li><a epub:type="${token}" href="...">${capitalise(token)}</a></li>`,
          }),
        );
      }
    }
  }
  // If the landmarks block itself is missing, EPUBCheck will already
  // complain — we don't double-emit here.

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface NavBlock {
  /** Opening `<nav ...>` tag including all its attributes. */
  openTag: string;
  /** Inner content between `<nav>` and `</nav>`. */
  body: string;
}

/**
 * Extract a `<nav epub:type="X">...</nav>` block from the nav doc. Returns
 * the open tag and inner body separately so callers can inspect both
 * attributes (on the tag) and content (in the body). Tolerant of whitespace,
 * either quote style, and additional epub:type tokens.
 */
function extractNavBlock(navDoc: string, epubType: string): NavBlock | null {
  // Match: <nav ... epub:type="...EPUBTYPE..." ...> body </nav>
  // We accept multi-token epub:type values like "frontmatter ibooks:..." by
  // matching epub:type as containing the requested token (separated by
  // whitespace or as the entire value).
  const escaped = epubType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<nav\\b([^>]*\\bepub:type\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*)>([\\s\\S]*?)</nav>`,
    'i',
  );
  const m = navDoc.match(re);
  if (!m) return null;
  return { openTag: m[0].slice(0, m[0].indexOf('>') + 1), body: m[2] };
}

/**
 * Check whether the landmarks block contains an anchor whose epub:type
 * attribute includes the requested token (e.g. "cover", "bodymatter").
 */
function landmarkContainsType(landmarksBody: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<a\\b[^>]*\\bepub:type\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["']`,
    'i',
  );
  return re.test(landmarksBody);
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
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
