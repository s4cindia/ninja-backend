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

  // ── 2. Footnotes file must be last in spine and linear="no" ────────────
  const footnotesItems = findFootnotesManifestItems(manifest);
  if (footnotesItems.length > 0) {
    const lastSpine = spine[spine.length - 1];
    const lastItem = manifest.find((m) => m.id === lastSpine.idref);

    const isFootnotes = lastItem && hrefLooksLikeFootnotes(lastItem.href);

    if (!isFootnotes) {
      issues.push(
        buildIssue('PRH-SPINE-FOOTNOTES-LAST', location, {
          message: `A footnotes file is present (${footnotesItems.map((f) => f.href).join(', ')}) but is not the last entry in the spine; PRH requires footnotes to come last`,
          suggestion: 'Reorder the spine so the footnotes itemref is the final entry, and add linear="no" to it',
        }),
      );
    } else if (lastSpine.linear !== 'no') {
      issues.push(
        buildIssue('PRH-SPINE-FOOTNOTES-LAST', location, {
          message: `Footnotes spine entry is last but ${lastSpine.linear == null ? 'is missing linear="no"' : `has linear="${lastSpine.linear}"`}`,
          suggestion: `Add linear="no" to <itemref idref="${lastSpine.idref}">`,
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
  // its href. We want the cover XHTML (the spine entry), not the image.
  // Heuristic: prefer XHTML/HTML entries where id or href matches /cover/i.
  const candidates = manifest.filter(
    (m) => /\.(x?html?)$/i.test(m.href) && /cover/i.test(m.id + ' ' + m.href),
  );
  if (candidates.length === 0) return null;
  // Prefer id=cover exact, then anything with "cover" in href.
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
