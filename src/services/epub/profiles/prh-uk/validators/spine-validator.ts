/**
 * PRH UK spine validator.
 *
 * Two checks (both publisher-specific, no direct WCAG mapping):
 *
 *   PRH-SPINE-COVER-LINEAR   — the cover spine entry must have linear="no"
 *                              so reading systems don't render it twice.
 *   PRH-SPINE-FOOTNOTES-LAST — when a footnotes file is present it must be
 *                              the last entry in the spine AND be marked
 *                              linear="no" (it's reached only via in-text
 *                              footnote anchors, never linearly).
 *
 * Both are detect-only in PR2 — spine reordering is risky enough that we
 * want operator review before mutating spine entries.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorInput, PrhValidatorIssue } from './types';

interface ManifestItem {
  id: string;
  href: string;
  properties: string;
}

interface SpineItemRef {
  idref: string;
  linear: string | null;
}

export function validatePrhSpine(input: PrhValidatorInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];
  const opf = input.opfContent;
  const location = input.opfPath || 'package.opf';

  if (!opf) return issues;

  const manifest = parseManifest(opf);
  const spine = parseSpine(opf);

  if (spine.length === 0) return issues;

  // ── 1. Cover spine entry must have linear="no" ─────────────────────────
  const coverItem = findCoverManifestItem(manifest);
  if (coverItem) {
    const coverSpine = spine.find((s) => s.idref === coverItem.id);
    if (coverSpine && coverSpine.linear !== 'no') {
      issues.push(
        buildIssue('PRH-SPINE-COVER-LINEAR', location, {
          message: coverSpine.linear == null
            ? `Cover spine entry (idref="${coverItem.id}") is missing linear="no"`
            : `Cover spine entry (idref="${coverItem.id}") has linear="${coverSpine.linear}"; PRH requires linear="no"`,
          suggestion: `Update <itemref idref="${coverItem.id}"> to include linear="no"`,
        }),
      );
    }
  }

  // ── 2. Every footnotes file must be in the trailing block of the spine
  //      AND marked linear="no". A spine like
  //      [..., footnotes1.xhtml, appendix.xhtml, footnotes2.xhtml] is
  //      non-conforming because footnotes1 is interrupted by a non-footnotes
  //      item (appendix), even if footnotes2 is correctly at the end.
  const footnotesItems = findFootnotesManifestItems(manifest);
  if (footnotesItems.length > 0) {
    const footnoteIds = new Set(footnotesItems.map((m) => m.id));

    // Trailing block: walk back from the end, collecting consecutive
    // footnote-only itemrefs.
    let trailingStart = spine.length;
    while (trailingStart > 0 && footnoteIds.has(spine[trailingStart - 1].idref)) {
      trailingStart--;
    }

    const misplaced: string[] = [];
    const missingLinear: string[] = [];

    for (let i = 0; i < spine.length; i++) {
      const ref = spine[i];
      if (!footnoteIds.has(ref.idref)) continue;
      // Position must be inside the trailing footnote-only block.
      if (i < trailingStart) {
        misplaced.push(ref.idref);
      }
      // Each footnote itemref must be linear="no".
      if (ref.linear !== 'no') {
        missingLinear.push(ref.idref);
      }
    }

    if (misplaced.length > 0) {
      issues.push(
        buildIssue('PRH-SPINE-FOOTNOTES-LAST', location, {
          message: `Footnotes itemref(s) [${misplaced.join(', ')}] are not in the trailing block of the spine; PRH requires every footnotes file to come at the end`,
          suggestion: `Reorder the spine so all footnotes itemrefs (${footnotesItems.map((m) => m.id).join(', ')}) form the final contiguous block, each with linear="no"`,
        }),
      );
    }
    if (missingLinear.length > 0) {
      issues.push(
        buildIssue('PRH-SPINE-FOOTNOTES-LAST', location, {
          message: `Footnotes itemref(s) [${missingLinear.join(', ')}] are missing linear="no"`,
          suggestion: `Add linear="no" to each: ${missingLinear.map((id) => `<itemref idref="${id}">`).join(', ')}`,
        }),
      );
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseManifest(opf: string): ManifestItem[] {
  const manifestMatch = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) return [];
  const block = manifestMatch[1];
  const items: ManifestItem[] = [];
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(block)) !== null) {
    const attrs = m[1];
    const id = readAttr(attrs, 'id');
    const href = readAttr(attrs, 'href');
    const properties = readAttr(attrs, 'properties');
    if (id && href != null) {
      items.push({ id, href, properties: properties ?? '' });
    }
  }
  return items;
}

function parseSpine(opf: string): SpineItemRef[] {
  const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) return [];
  const block = spineMatch[1];
  const refs: SpineItemRef[] = [];
  const refRe = /<itemref\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(block)) !== null) {
    const attrs = m[1];
    const idref = readAttr(attrs, 'idref');
    const linear = readAttr(attrs, 'linear');
    if (idref) refs.push({ idref, linear });
  }
  return refs;
}

function readAttr(attrs: string, name: string): string | null {
  // `name="value"` or `name='value'`, with optional whitespace around `=`.
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return (m[1] ?? m[2]) ?? null;
}

function findCoverManifestItem(manifest: ManifestItem[]): ManifestItem | null {
  // Most reliable: an item explicitly carrying properties="cover-image" is
  // the cover IMAGE; the cover XHTML is usually id="cover" or has cover in
  // its href basename. Use a token-aware regex so unrelated names like
  // `discover.xhtml` or `covers.xhtml` are not mistaken for the cover.
  // The pattern requires "cover" to be flanked by a separator on both sides
  // (start-of-string, `/`, `_`, `-`, `.` or end-of-string).
  const COVER_TOKEN = /(?:^|[/_-])cover(?:[/._-]|$)/i;
  const candidates = manifest.filter(
    (m) => /\.(x?html?)$/i.test(m.href) && (COVER_TOKEN.test(m.id) || COVER_TOKEN.test(m.href)),
  );
  if (candidates.length === 0) return null;
  // Prefer id=cover exact, then anything with "cover" token in href.
  const exactId = candidates.find((c) => c.id.toLowerCase() === 'cover');
  if (exactId) return exactId;
  return candidates[0];
}

function findFootnotesManifestItems(manifest: ManifestItem[]): ManifestItem[] {
  return manifest.filter((m) => hrefLooksLikeFootnotes(m.href));
}

function hrefLooksLikeFootnotes(href: string): boolean {
  // PRH convention: footnotes externalised into a file named `footnotes.xhtml`
  // (sometimes split as footnotes1/2 in the Technical Guide example).
  return /(?:^|\/)footnotes?\d*\.x?html?$/i.test(href);
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
