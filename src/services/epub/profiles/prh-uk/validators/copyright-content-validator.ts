/**
 * PRH UK copyright-content validator (P2/PR1).
 *
 * Locates the copyright XHTML inside the EPUB, normalises its visible
 * text (strip tags + collapse whitespace + lowercase), then runs the
 * `copyrightContentChecks` from the imprint's rule registry. Each
 * missing needle emits the matching `PRH-COPY-*` code at the severity
 * defined in the imprint's rules.
 *
 * Imprint-specific note: every imprint has a different set of checks:
 *   - Adult template (Penguin, Pelican, #Merky, Cornerstone Saga +
 *     unknown-imprint fallback) → TDM, EEA, CIP, group, address, URL,
 *     ISBN.
 *   - Children's (Puffin, Ladybird) → same as adult + three imprint
 *     URLs.
 *   - Vintage → NO TDM, NO EEA, bespoke address, vintage URL.
 *
 * Also probes for the PRH UK logo via a separate alt-text check, since
 * its presence can't be detected via string-needle alone (the logo is
 * an <img>, not text).
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { CopyrightContentCheck, ImprintRules } from '../imprints/_types';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

interface CopyrightInput extends PrhPerXhtmlInput {
  imprintRules: ImprintRules;
}

export function validatePrhCopyrightContent(input: CopyrightInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // 1. Find the copyright XHTML.
  const copyrightFile = findCopyrightXhtml(input.xhtmlFiles);
  if (!copyrightFile) {
    // No copyright page at all — out of scope for this validator. PR4
    // (content-order) will catch missing-copyright at a higher level.
    return issues;
  }

  // 2. Normalise the visible text for substring matching.
  const normalised = normaliseCopyrightText(copyrightFile.content);

  // 3. De-duplicate checks by code: when an imprint registers multiple
  //    PRH-COPY-IMPRINT-URL-MISSING checks (children's: 3 URLs), we
  //    emit at most one issue per code per copyright file. The first
  //    needle that's missing wins (so the operator sees one
  //    representative suggestion).
  const emittedCodes = new Set<string>();

  for (const check of input.imprintRules.copyrightContentChecks) {
    if (emittedCodes.has(check.code)) continue;
    const present = normalised.includes(check.needle.toLowerCase());
    if (present) {
      // For codes that have multiple needles (URL check on children's
      // imprints), one match doesn't mean all three URLs are present.
      // We need to check ALL needles for that code before declaring it
      // satisfied. Track satisfied codes separately.
      continue;
    }
    issues.push(buildIssue(check, copyrightFile.path));
    emittedCodes.add(check.code);
  }

  // 4. Check for the PRH UK logo image alt text. This is a separate
  //    concern from the string-needle checks because the logo is an
  //    <img>, not body text.
  if (!hasPrhUkLogo(copyrightFile.content)) {
    issues.push(
      buildLogoIssue(copyrightFile.path),
    );
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface XhtmlFile {
  path: string;
  content: string;
}

/**
 * Locate the copyright XHTML file in the EPUB. Preference order:
 *   1. body epub:type="copyright-page" (canonical marker).
 *   2. <section epub:type="copyright-page">.
 *   3. Filename heuristic — copyright.xhtml / copyright-*.xhtml.
 */
function findCopyrightXhtml(files: PrhPerXhtmlInput['xhtmlFiles']): XhtmlFile | null {
  // 1. body epub:type="copyright-page".
  for (const f of files) {
    if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b[^"']*["']/i.test(f.content)) {
      return f;
    }
  }
  // 2. <section epub:type="copyright-page">.
  for (const f of files) {
    if (/<section\b[^>]*\bepub:type\s*=\s*["'][^"']*\bcopyright-page\b[^"']*["']/i.test(f.content)) {
      return f;
    }
  }
  // 3. Filename heuristic.
  for (const f of files) {
    if (/(?:^|\/)copyright[^/]*\.x?html?$/i.test(f.path)) {
      return f;
    }
  }
  return null;
}

/**
 * Normalise copyright XHTML to a single lowercase whitespace-collapsed
 * string for substring matching. Strips:
 *   - HTML tags (<...>),
 *   - HTML entities (&amp; etc. — collapsed to their general meaning
 *     so "&amp;" becomes " ", which still matches because we collapse
 *     whitespace),
 *   - whitespace runs (multiple spaces / newlines / tabs → single space),
 *   - script/style blocks (defensive — copyright pages shouldn't have
 *     either, but malformed input is real).
 */
function normaliseCopyrightText(html: string): string {
  return html
    // Strip script/style blocks first (their contents are not visible text).
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    // Strip all tags.
    .replace(/<[^>]+>/g, ' ')
    // Decode the few common entities that affect matching.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')  // numeric entities → space
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Detect the PRH UK logo via image src or alt-text reference. */
function hasPrhUkLogo(html: string): boolean {
  // Pattern 1: img src references prh_uk_logo file.
  if (/<img\b[^>]*\bsrc\s*=\s*["'][^"']*prh_uk_logo[^"']*["']/i.test(html)) {
    return true;
  }
  // Pattern 2: img alt text contains "Penguin Random House UK".
  if (/<img\b[^>]*\balt\s*=\s*["'][^"']*penguin random house uk[^"']*["']/i.test(html)) {
    return true;
  }
  return false;
}

function buildIssue(check: CopyrightContentCheck, location: string): PrhValidatorIssue {
  return {
    code: check.code,
    severity: check.severity,
    wcag: PRH_ISSUE_CODES[check.code as keyof typeof PRH_ISSUE_CODES]?.wcag ?? [],
    message: `${PRH_ISSUE_CODES[check.code as keyof typeof PRH_ISSUE_CODES]?.summary ?? check.code}: needle "${check.needle.slice(0, 60)}" not found in copyright page`,
    suggestion: check.suggestion,
    location,
  };
}

function buildLogoIssue(location: string): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-COPY-PRH-LOGO-MISSING'];
  return {
    code: 'PRH-COPY-PRH-LOGO-MISSING',
    severity: def.severity,
    wcag: def.wcag,
    message: def.summary,
    suggestion:
      'Add <figure class="copyright_logo"><img src="prh_core_assets/images/prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure> to the copyright page.',
    location,
  };
}
