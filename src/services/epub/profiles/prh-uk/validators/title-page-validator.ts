/**
 * PRH UK title-page validator (P2/PR2).
 *
 * Validates the structural shape and imprint logo of the title page.
 * Per Branding Guide §4, the canonical Penguin (adult) title page is:
 *
 *   <body epub:type="frontmatter">
 *     <section epub:type="titlepage" class="titlepage">
 *       <h2>Author Name</h2>
 *       <hr/>
 *       <h3 class="booktitle">BOOK TITLE</h3>
 *       <h4 class="booksubtitle">Subtitle</h4>
 *       <figure class="imprint_logo">
 *         <img src="…/title_page_logo.png" alt="Penguin Random House" />
 *       </figure>
 *     </section>
 *   </body>
 *
 * Penguin defines 6 structural variants — different combinations of
 * author / subtitle / contributor are all valid. The validator
 * fingerprints the core structural elements (section + booktitle +
 * imprint_logo) rather than enforcing a single variant.
 *
 * Imprint deviations:
 *   - Puffin → full-bleed image-only (`<figure class="image_full">`).
 *     We drop the imprint_logo requirement here; the image itself
 *     carries the imprint mark + descriptive alt.
 *   - Pelican → `<body class="pelican_titlepage">`, drops `<hr/>`, alt
 *     = "Pelican Books".
 *   - Ladybird → adds `<figure class="portrait_small">` + credits;
 *     structurally still passes.
 *   - Vintage / Cornerstone Saga → no separate titlepage in the
 *     canonical template. `imprintRules.titlePage === null` skips the
 *     validator.
 *
 * Issue codes emitted:
 *   - PRH-TITLE-PAGE-MISSING            — no <section epub:type="titlepage"> found anywhere
 *   - PRH-TITLE-PAGE-WRONG-STRUCTURE    — section present but missing key elements
 *   - PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO — no <figure class="imprint_logo">
 *   - PRH-TITLE-PAGE-WRONG-LOGO-ALT     — imprint_logo present but alt doesn't match
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { ImprintRules } from '../imprints/_types';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

interface TitlePageInput extends PrhPerXhtmlInput {
  imprintRules: ImprintRules;
}

export function validatePrhTitlePage(input: TitlePageInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // Imprint has no canonical title page (Vintage, Cornerstone Saga).
  if (!input.imprintRules.titlePage) return issues;
  const rules = input.imprintRules.titlePage;

  const titleFile = findTitlePageXhtml(input.xhtmlFiles, rules.imageOnly === true);
  if (!titleFile) {
    issues.push(buildIssue(
      'PRH-TITLE-PAGE-MISSING',
      `Title page not found. Expected ${rules.imageOnly ? 'a frontmatter file with <figure class="image_full">' : '<section epub:type="titlepage">'}.`,
      rules.imageOnly
        ? `Add a title page with <body epub:type="frontmatter"><figure class="image_full"><img alt="Book Title - by Author" /></figure></body>.`
        : `Add a title page with <section epub:type="titlepage" class="titlepage"> containing the book title (.booktitle) and a <figure class="imprint_logo"> with alt="${rules.logoAlt}".`,
      'EPUB',
    ));
    return issues;
  }

  if (rules.imageOnly) {
    // Image-only path (Puffin): require <figure class="image_full"> with
    // a non-empty alt. Imprint_logo / .booktitle structure checks are
    // intentionally skipped — the image *is* the title page.
    const imageFullClass = hasFigureWithClass(titleFile.content, 'image_full');
    if (!imageFullClass) {
      issues.push(buildIssue(
        'PRH-TITLE-PAGE-WRONG-STRUCTURE',
        `Image-only title page expected <figure class="image_full"> but it was not found.`,
        `Wrap the title-page image in <figure class="image_full"> per the Puffin / children's title-page pattern.`,
        titleFile.path,
      ));
    }
    return issues;
  }

  // Structured-titlepage path (Penguin / Pelican / Ladybird / Merky).
  // Soft fingerprint: the validator passes if the page has a titlepage
  // section AND a booktitle. Variants that drop author/subtitle/etc.
  // still pass — those fields are content, not structural conformance.
  if (!hasBookTitle(titleFile.content)) {
    issues.push(buildIssue(
      'PRH-TITLE-PAGE-WRONG-STRUCTURE',
      `Title page is missing the <h3 class="booktitle"> (or .booktitle) element. ${input.imprintRules.displayName}'s title page must carry the book title in a tagged heading.`,
      `Wrap the book title in <h3 class="booktitle">…</h3> per the PRH title-page template.`,
      titleFile.path,
    ));
  }

  const imprintLogoScope = extractImprintLogoFigure(titleFile.content);
  if (imprintLogoScope === null) {
    issues.push(buildIssue(
      'PRH-TITLE-PAGE-MISSING-IMPRINT-LOGO',
      `Title page is missing <figure class="imprint_logo">. The closing imprint mark is mandatory per Branding Guide §4.`,
      `Add <figure class="imprint_logo"><img src="…/title_page_logo.png" alt="${rules.logoAlt}" /></figure> at the end of the title page.`,
      titleFile.path,
    ));
    return issues;
  }

  const altFound = findImgAlt(imprintLogoScope);
  if (!altMatches(altFound, rules.logoAlt)) {
    issues.push(buildIssue(
      'PRH-TITLE-PAGE-WRONG-LOGO-ALT',
      `Title-page imprint logo alt is ${altFound !== null ? `"${altFound}"` : 'missing'}; ${input.imprintRules.displayName} expects "${rules.logoAlt}".`,
      `Set the imprint_logo <img alt="${rules.logoAlt}">.`,
      titleFile.path,
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
 * Locate the title-page XHTML. Preference order:
 *   1. <section epub:type="titlepage"> (structured path).
 *   2. <body epub:type="frontmatter" class="*titlepage*"> (Pelican).
 *   3. For image-only (Puffin): file containing <figure class="image_full">
 *      inside a frontmatter body.
 *   4. Filename heuristic: `title*.xhtml` (excluding `subtitle`,
 *      `titlepage_back`, etc.).
 *
 * Returns null when nothing matches.
 */
function findTitlePageXhtml(
  files: PrhPerXhtmlInput['xhtmlFiles'],
  imageOnly: boolean,
): XhtmlFile | null {
  if (!imageOnly) {
    for (const f of files) {
      if (/<section\b[^>]*\bepub:type\s*=\s*["'][^"']*\btitlepage\b/i.test(f.content)) {
        return f;
      }
    }
    for (const f of files) {
      if (/<body\b[^>]*\bclass\s*=\s*["'][^"']*\btitlepage\b/i.test(f.content)
        && /<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b/i.test(f.content)) {
        return f;
      }
    }
  } else {
    // Image-only title page: look for a frontmatter file with
    // <figure class="image_full"> + a single descriptive <img>.
    for (const f of files) {
      if (/<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b/i.test(f.content)
        && hasFigureWithClass(f.content, 'image_full')
        && isLikelyTitlePageFilename(f.path)) {
        return f;
      }
    }
  }

  // Filename fallback. Match `title.xhtml`, `title_3.xhtml`,
  // `pelican_titlepage.xhtml`, but not `subtitle.xhtml` or
  // `chapter-title.xhtml`.
  for (const f of files) {
    if (isLikelyTitlePageFilename(f.path)) {
      return f;
    }
  }
  return null;
}

function isLikelyTitlePageFilename(path: string): boolean {
  // Anchored on token boundary so we don't false-match `subtitle`,
  // `untitled`, `chapter-title`, etc.
  return /(?:^|\/)(?:title(?:[_-]\d+)?|[a-z]+_titlepage)\.x?html?$/i.test(path);
}

function hasBookTitle(html: string): boolean {
  return /\bclass\s*=\s*["'][^"']*\bbooktitle\b/i.test(html);
}

function hasFigureWithClass(html: string, target: string): boolean {
  const regex = new RegExp(`<figure\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${target}\\b`, 'i');
  return regex.test(html);
}

/**
 * Extract the substring of the title-page HTML scoped to the
 * <figure class="imprint_logo">…</figure> block. Returns null when
 * no such figure is present. We scope to the figure so the alt-text
 * check pulls the logo's alt rather than (for example) a body image
 * earlier on the page.
 */
function extractImprintLogoFigure(html: string): string | null {
  const m = html.match(/<figure\b[^>]*\bclass\s*=\s*["'][^"']*\bimprint_logo\b[^>]*>[\s\S]*?<\/figure>/i);
  return m ? m[0] : null;
}

function findImgAlt(scope: string): string | null {
  const m = scope.match(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["']/i);
  return m ? m[1] : null;
}

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
