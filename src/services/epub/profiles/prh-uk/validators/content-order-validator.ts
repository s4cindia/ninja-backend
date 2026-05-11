/**
 * PRH UK content-order validator (P2/PR4).
 *
 * Walks the spine and classifies each entry (cover / title / copyright /
 * brand / bodymatter / backmatter / footnotes / about-author) using a
 * combination of epub:type on the XHTML body, the manifest properties,
 * and filename heuristics. Then asserts PRH's mandated reading order:
 *
 *   1. Cover is at spine index 0.
 *   2. If the imprint rules require a brand page, it must appear in
 *      the spine. (PR2's brand-page-validator catches the structural
 *      shape; this validator catches "missing entirely". The two
 *      messages co-fire harmlessly when the brand page is absent.)
 *   3. Footnotes (when present) must be at the last spine index — same
 *      finding as PR2's PRH-SPINE-FOOTNOTES-LAST but with ORDER framing
 *      rather than the linear="no" framing. Both can co-fire.
 *   4. Copyright page must sit in the frontmatter portion of the spine
 *      (PRH treats copyright as frontmatter; placing it in the
 *      back-half is unusual). The rule fires when copyright appears
 *      after the spine's midpoint AND there's an explicit bodymatter
 *      entry, since "after the midpoint" alone is meaningless on tiny
 *      EPUBs.
 *   5. About-the-Author must be present somewhere in the spine — per
 *      Style Guide §6.6 it's required on every PRH reflow EPUB.
 *
 * All findings are detect-only — spine surgery is risky enough to
 * require operator review. Gated like the rest of P2 by imprint
 * recognition + ≥medium confidence.
 *
 * Implementation notes:
 *   - Classification leans on epub:type FIRST (most reliable), then
 *     `<section epub:type="…">`, then filename + content fingerprints.
 *   - "About-the-Author" detection is forgiving (PRH-author-bio,
 *     about_author, contributor pages all count) because real EPUBs
 *     vary in how the section is named.
 *   - The validator is imprint-gated at the orchestrator level — when
 *     `imprintRules.brandPage` is null (#Merky, Cornerstone Saga), the
 *     brand-page check is skipped.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { ImprintRules } from '../imprints/_types';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

interface ContentOrderInput extends PrhPerXhtmlInput {
  imprintRules: ImprintRules;
}

interface ManifestItem {
  id: string;
  href: string;
  properties: string;
}

interface SpineRef {
  idref: string;
  linear: string | null;
  /** Resolved zip-relative path of the manifest item this idref points at. */
  path: string | null;
  /** Manifest properties for this item (e.g. "cover-image", "nav"). */
  properties: string;
}

type SpineEntryRole =
  | 'cover'
  | 'title'
  | 'copyright'
  | 'brand'
  | 'about-author'
  | 'footnotes'
  | 'frontmatter'
  | 'bodymatter'
  | 'backmatter'
  | 'unknown';

interface ClassifiedSpine extends SpineRef {
  role: SpineEntryRole;
  /** XHTML content of the manifest item (or null when unavailable). */
  content: string | null;
}

export function validatePrhContentOrder(input: ContentOrderInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];
  const opf = input.opfContent;
  const location = input.opfPath || 'package.opf';

  if (!opf) return issues;

  const manifest = parseManifest(opf);
  const rawSpine = parseSpine(opf, manifest);
  if (rawSpine.length === 0) return issues;

  const opfDir = opf.includes('/') ? input.opfPath.slice(0, input.opfPath.lastIndexOf('/')) : '';
  const filesByPath = new Map(input.xhtmlFiles.map((f) => [f.path, f.content]));

  const spine: ClassifiedSpine[] = rawSpine.map((ref) => {
    const fullPath = ref.path ? resolveOpfRelative(opfDir, ref.path) : null;
    const content = fullPath ? (filesByPath.get(fullPath) ?? null) : null;
    return {
      ...ref,
      content,
      role: classifySpineEntry(ref, content),
    };
  });

  // ── 1. Cover must be at index 0 ────────────────────────────────────────
  const coverIndex = spine.findIndex((s) => s.role === 'cover');
  if (coverIndex > 0) {
    issues.push(buildIssue(
      'PRH-ORDER-COVER-NOT-FIRST',
      `Cover spine entry (idref="${spine[coverIndex].idref}") is at index ${coverIndex}; PRH requires it at spine index 0.`,
      `Move the cover itemref to the start of <spine>.`,
      location,
    ));
  }

  // ── 2. Brand page must exist in the spine (when imprint expects one) ──
  if (input.imprintRules.brandPage) {
    const hasBrand = spine.some((s) => s.role === 'brand');
    if (!hasBrand) {
      issues.push(buildIssue(
        'PRH-ORDER-MISSING-BRAND-PAGE',
        `No brand page found in the spine. ${input.imprintRules.displayName} requires a brand page (Branding Guide §7).`,
        `Add the brand-page itemref to <spine> after the cover.`,
        location,
      ));
    }
  }

  // ── 3. Footnotes (if present) must be the last spine entry ────────────
  const footnoteIndices = spine
    .map((s, i) => (s.role === 'footnotes' ? i : -1))
    .filter((i) => i >= 0);
  if (footnoteIndices.length > 0) {
    const lastIndex = spine.length - 1;
    const trailingFootnotes = footnoteIndices.every((i) => i === lastIndex || isFootnoteRunToEnd(spine, i));
    if (!trailingFootnotes) {
      const misplaced = footnoteIndices.filter((i) => !isFootnoteRunToEnd(spine, i));
      issues.push(buildIssue(
        'PRH-ORDER-FOOTNOTES-NOT-LAST',
        `Footnotes spine entries [${misplaced.map((i) => spine[i].idref).join(', ')}] are not in the trailing block of the spine.`,
        `Reorder <spine> so footnotes itemrefs form the final contiguous block.`,
        location,
      ));
    }
  }

  // ── 4. Copyright must be in frontmatter (not backmatter) ──────────────
  const copyrightIndex = spine.findIndex((s) => s.role === 'copyright');
  if (copyrightIndex >= 0) {
    const bodyStart = spine.findIndex((s) => s.role === 'bodymatter');
    // Two-step rule: only fire when there IS an explicit bodymatter
    // marker AND copyright sits at or after it. Without a bodymatter
    // marker the spine has no notion of where frontmatter ends, so
    // we can't reliably distinguish "copyright at the end of front-
    // matter" (correct) from "copyright in backmatter" (wrong).
    if (bodyStart >= 0 && copyrightIndex >= bodyStart) {
      issues.push(buildIssue(
        'PRH-ORDER-COPYRIGHT-WRONG-POSITION',
        `Copyright spine entry (idref="${spine[copyrightIndex].idref}") is at index ${copyrightIndex}, at or after the first bodymatter entry (index ${bodyStart}). PRH treats copyright as frontmatter.`,
        `Move the copyright itemref to the frontmatter section of <spine>, before the first bodymatter entry.`,
        location,
      ));
    }
  }

  // ── 5. About-the-Author must be present somewhere ─────────────────────
  const hasAboutAuthor = spine.some((s) => s.role === 'about-author');
  if (!hasAboutAuthor) {
    issues.push(buildIssue(
      'PRH-ORDER-MISSING-ABOUT-AUTHOR',
      `No About-the-Author section found in the spine. Style Guide §6.6 requires every PRH reflow EPUB to include one.`,
      `Add an About-the-Author backmatter file (e.g. <section epub:type="biography"> or filename "about_the_author.xhtml") and include it in the spine.`,
      location,
    ));
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Classify a spine entry by content (epub:type, section markers) +
 * filename heuristics. Returns the most specific role we can identify.
 * Falls back to 'unknown' when no clear signal is present — the
 * validator treats unknowns as non-load-bearing (won't trigger checks).
 */
function classifySpineEntry(ref: SpineRef, content: string | null): SpineEntryRole {
  // Cover gets the most reliable signal: the cover-image manifest
  // property OR an `epub:type="cover"` body / section.
  if (/\bcover-image\b/i.test(ref.properties)) return 'cover';
  if (content && bodyEpubType(content) === 'cover') return 'cover';
  if (content && sectionHasEpubType(content, 'cover')) return 'cover';
  if (ref.path && pathLooksLikeCover(ref.path)) return 'cover';

  // The order of subsequent checks matters: copyright + title + brand
  // are all frontmatter sections, but only one role applies per entry.
  if (content) {
    if (sectionHasEpubType(content, 'copyright-page') || bodyEpubType(content) === 'copyright-page') {
      return 'copyright';
    }
    if (sectionHasEpubType(content, 'titlepage') || bodyEpubType(content) === 'titlepage') {
      return 'title';
    }
    // Brand pages are identified by id="brand_page" rather than epub:type
    // (the Branding Guide doesn't define an epub:type for them).
    if (/<body\b[^>]*\bid\s*=\s*["']brand_page["']/i.test(content)
        || /<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bfrontmatter\b[^"']*["'][^>]*\bid\s*=\s*["']brand_page["']/i.test(content)) {
      return 'brand';
    }
    if (sectionHasEpubType(content, 'biography') || bodyEpubType(content) === 'biography') {
      return 'about-author';
    }
    if (sectionHasEpubType(content, 'footnotes')) return 'footnotes';
  }

  // Filename heuristics — used when epub:type didn't decide. We anchor
  // on token boundary so unrelated names (`discover.xhtml`,
  // `chapter-title.xhtml`) don't false-match.
  if (ref.path) {
    if (pathLooksLikeCopyright(ref.path)) return 'copyright';
    if (pathLooksLikeTitle(ref.path)) return 'title';
    if (pathLooksLikeBrand(ref.path)) return 'brand';
    if (pathLooksLikeFootnotes(ref.path)) return 'footnotes';
    if (pathLooksLikeAboutAuthor(ref.path)) return 'about-author';
  }

  if (content) {
    const bodyType = bodyEpubType(content);
    if (bodyType === 'bodymatter') return 'bodymatter';
    if (bodyType === 'backmatter') return 'backmatter';
    if (bodyType === 'frontmatter') return 'frontmatter';
  }

  return 'unknown';
}

/**
 * True when all spine entries from `startIdx` to the end are footnotes
 * — i.e. the run from this position runs cleanly to the spine's tail.
 * Used so that footnotes1 + footnotes2 BOTH being at the back of the
 * spine doesn't fire a misplaced warning.
 */
function isFootnoteRunToEnd(spine: ClassifiedSpine[], startIdx: number): boolean {
  for (let i = startIdx; i < spine.length; i += 1) {
    if (spine[i].role !== 'footnotes') return false;
  }
  return true;
}

function bodyEpubType(html: string): string | null {
  const m = html.match(/<body\b[^>]*\bepub:type\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  // epub:type can carry multiple space-separated values. Return the
  // first PRH-relevant one.
  const tokens = m[1].split(/\s+/);
  for (const t of tokens) {
    const norm = t.toLowerCase();
    if (['cover', 'frontmatter', 'bodymatter', 'backmatter', 'copyright-page', 'titlepage', 'biography'].includes(norm)) {
      return norm;
    }
  }
  return tokens[0]?.toLowerCase() ?? null;
}

function sectionHasEpubType(html: string, target: string): boolean {
  const re = new RegExp(`<section\\b[^>]*\\bepub:type\\s*=\\s*["'][^"']*\\b${target}\\b`, 'i');
  return re.test(html);
}

function pathLooksLikeCover(path: string): boolean {
  return /(?:^|[/_-])cover(?:[/._-]|$)/i.test(path);
}

function pathLooksLikeCopyright(path: string): boolean {
  return /(?:^|\/)copyright[^/]*\.x?html?$/i.test(path);
}

function pathLooksLikeTitle(path: string): boolean {
  return /(?:^|\/)(?:title(?:[_-]\d+)?|[a-z]+_titlepage)\.x?html?$/i.test(path);
}

function pathLooksLikeBrand(path: string): boolean {
  return /(?:^|\/)(?:brand[-_ ]?page|[\w-]+[-_]brand|brand)\.x?html?$/i.test(path);
}

function pathLooksLikeFootnotes(path: string): boolean {
  return /(?:^|\/)footnotes?\d*\.x?html?$/i.test(path);
}

/**
 * About-the-Author file detection. PRH naming varies:
 *   - `about_the_author.xhtml`
 *   - `about-the-author.xhtml`
 *   - `author_bio.xhtml`
 *   - `author-biography.xhtml`
 *   - `contributor.xhtml` (occasionally — for anthologies)
 */
function pathLooksLikeAboutAuthor(path: string): boolean {
  return /(?:^|\/)(?:about[-_]?the[-_]?author|author[-_]bio(?:graphy)?|contributor)\.x?html?$/i.test(path);
}

function parseManifest(opf: string): ManifestItem[] {
  const manifestMatch = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return [];
  const items: ManifestItem[] = [];
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(manifestMatch[1])) !== null) {
    const attrs = m[1];
    const id = readAttr(attrs, 'id');
    const href = readAttr(attrs, 'href');
    const properties = readAttr(attrs, 'properties');
    if (id && href != null) items.push({ id, href, properties: properties ?? '' });
  }
  return items;
}

function parseSpine(opf: string, manifest: ManifestItem[]): SpineRef[] {
  const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) return [];
  const refs: SpineRef[] = [];
  const refRe = /<itemref\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  const manifestById = new Map(manifest.map((i) => [i.id, i]));
  while ((m = refRe.exec(spineMatch[1])) !== null) {
    const attrs = m[1];
    const idref = readAttr(attrs, 'idref');
    if (!idref) continue;
    const item = manifestById.get(idref);
    refs.push({
      idref,
      linear: readAttr(attrs, 'linear'),
      path: item?.href ?? null,
      properties: item?.properties ?? '',
    });
  }
  return refs;
}

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return (m[1] ?? m[2]) ?? null;
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
