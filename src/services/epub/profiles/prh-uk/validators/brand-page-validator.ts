/**
 * PRH UK brand-page validator (P2/PR2).
 *
 * Validates the structural markup and logo alt text of an imprint's
 * brand page — the frontmatter section that displays the imprint's
 * large logo. Per Branding Guide §6, the canonical shape is:
 *
 *   <body epub:type="frontmatter" id="brand_page">
 *     <figure class="brand_logo_solo">
 *       <img src="…/logo_large.png" alt="<Imprint Name>" />
 *     </figure>
 *   </body>
 *
 * Vintage deviates: it uses `<figure class="image_full">` instead of
 * `.brand_logo_solo`. #Merky and Cornerstone Saga have no canonical
 * brand page at all — the orchestrator skips them via `imprintRules.brandPage === null`.
 *
 * Issue codes emitted:
 *   - PRH-BRAND-PAGE-MISSING       — no brand page found in any spine entry
 *   - PRH-BRAND-PAGE-WRONG-CLASS   — figure class doesn't match imprint expectation
 *   - PRH-BRAND-PAGE-WRONG-LOGO-ALT — figure exists but alt text doesn't match
 *
 * "Missing" is one-shot at the EPUB level (no path); structural issues
 * are emitted against the brand-page XHTML's path.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { ImprintRules } from '../imprints/_types';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

interface BrandPageInput extends PrhPerXhtmlInput {
  imprintRules: ImprintRules;
}

export function validatePrhBrandPage(input: BrandPageInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // Imprint has no canonical brand page (#Merky, Cornerstone Saga).
  if (!input.imprintRules.brandPage) return issues;
  const rules = input.imprintRules.brandPage;

  const brandFile = findBrandPageXhtml(input.xhtmlFiles);
  if (!brandFile) {
    issues.push(buildIssue(
      'PRH-BRAND-PAGE-MISSING',
      `Brand page not found. Expected a frontmatter section with id="brand_page" containing the ${input.imprintRules.displayName} logo.`,
      `Add a brand page: <body epub:type="frontmatter" id="brand_page"><figure class="${rules.figureClass}"><img src="…/logo_large.png" alt="${rules.logoAlt}" /></figure></body>.`,
      // No path — the issue is "this file doesn't exist in the EPUB".
      'EPUB',
    ));
    return issues;
  }

  // Figure class — Vintage uses .image_full, others use .brand_logo_solo.
  const figureClassFound = findFigureClass(brandFile.content);
  if (figureClassFound !== rules.figureClass) {
    issues.push(buildIssue(
      'PRH-BRAND-PAGE-WRONG-CLASS',
      `Brand-page <figure> class is ${figureClassFound ? `"${figureClassFound}"` : 'missing'}; ${input.imprintRules.displayName} expects "${rules.figureClass}".`,
      `Change the brand-page <figure> to class="${rules.figureClass}".`,
      brandFile.path,
    ));
  }

  // Logo alt text — case-insensitive, whitespace-collapsed match against
  // the imprint's expected alt.
  const altFound = findBrandPageImgAlt(brandFile.content);
  if (!altMatches(altFound, rules.logoAlt)) {
    issues.push(buildIssue(
      'PRH-BRAND-PAGE-WRONG-LOGO-ALT',
      `Brand-page logo alt is ${altFound !== null ? `"${altFound}"` : 'missing'}; ${input.imprintRules.displayName} expects "${rules.logoAlt}".`,
      `Set the brand-page <img alt="${rules.logoAlt}">.`,
      brandFile.path,
    ));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface XhtmlFile {
  path: string;
  content: string;
}

/**
 * Locate the brand-page XHTML. Preference order:
 *   1. <body epub:type="frontmatter" id="brand_page"> (canonical marker).
 *   2. <body id="brand_page"> (relaxed — some EPUBs drop the epub:type).
 *   3. Filename heuristic: `brand*.xhtml` / `*brand_page*.xhtml`.
 *
 * Returns null when nothing matches.
 */
function findBrandPageXhtml(files: PrhPerXhtmlInput['xhtmlFiles']): XhtmlFile | null {
  for (const f of files) {
    if (/<body\b[^>]*\bid\s*=\s*["']brand_page["'][^>]*\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b/i.test(f.content)
      || /<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b[^>]*\bid\s*=\s*["']brand_page["']/i.test(f.content)) {
      return f;
    }
  }
  for (const f of files) {
    if (/<body\b[^>]*\bid\s*=\s*["']brand_page["']/i.test(f.content)) {
      return f;
    }
  }
  for (const f of files) {
    // Filename heuristic — match `brand_page.xhtml`, `penguin_brand.xhtml`,
    // etc., but not unrelated files like `brand_marketing.xhtml`. We
    // anchor on token boundary to limit false positives.
    if (/(?:^|\/)(?:brand[-_ ]?page|[\w-]+[-_]brand|brand)\.x?html?$/i.test(f.path)) {
      return f;
    }
  }
  return null;
}

/**
 * Extract the first <figure class="…"> class value from the brand-page
 * content. Returns the class name (`brand_logo_solo` / `image_full` /
 * other) or null when no figure-with-class is present.
 *
 * Class attributes can hold multiple values (e.g. `class="brand_logo_solo
 * with_caption"`); we check membership rather than equality so cosmetic
 * variants pass.
 */
function findFigureClass(html: string): string | null {
  const m = html.match(/<figure\b[^>]*\bclass\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  const classes = m[1].split(/\s+/).map((c) => c.trim()).filter(Boolean);
  // Prefer the canonical brand classes when present; otherwise return
  // the first class so the wrong-class issue surfaces meaningfully.
  for (const c of classes) {
    if (c === 'brand_logo_solo' || c === 'image_full') return c;
  }
  return classes[0] ?? null;
}

/**
 * Extract the alt text of the first <img> inside the brand-page's
 * <figure>. Returns null when no <img alt="…"> is found.
 */
function findBrandPageImgAlt(html: string): string | null {
  const figMatch = html.match(/<figure\b[\s\S]*?<\/figure>/i);
  const scope = figMatch ? figMatch[0] : html;
  const imgMatch = scope.match(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

/**
 * Compare an observed alt-text value to the imprint's expected alt.
 * Whitespace-collapsed, case-insensitive equality. Null observed values
 * (no alt attribute at all) never match.
 */
function altMatches(observed: string | null, expected: string): boolean {
  if (observed === null) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(observed) === norm(expected);
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
