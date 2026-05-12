/**
 * PRH UK footnote ref↔dest id parity validator (P3/PR3).
 *
 * Per Technical Guide §6.3, footnote references must round-trip
 * cleanly between the in-text ref and the destination element:
 *
 *   <p>… see footnote.<a epub:type="noteref" href="#fn12">12</a></p>
 *
 *   <aside epub:type="footnote" id="fn12" role="doc-footnote">…</aside>
 *   OR
 *   <section epub:type="endnotes">
 *     <ol>
 *       <li id="fn12">…</li>
 *     </ol>
 *   </section>
 *
 * Kindle popup behaviour relies on the ref's `href="#X"` matching an
 * `id="X"` on a `<aside epub:type="footnote">` OR a `<li>` inside
 * `<section epub:type="endnotes">`. A broken ref degrades silently on
 * web (the anchor jumps to nowhere) but produces a confusing "no
 * popup" experience in Kindle — operators rarely notice without an
 * explicit check.
 *
 * Strategy:
 *   1. Walk every XHTML to build a global id-set: every id on an
 *      `<aside epub:type="footnote">` plus every id on `<li>` inside
 *      `<section epub:type="endnotes">`.
 *   2. Walk every XHTML to find `<a epub:type="noteref">` elements.
 *      For each, extract the href fragment (`#fn12`) and check
 *      membership in the id-set.
 *
 * One issue per orphan ref. Detect-only.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput, PrhXhtmlFile } from './types';

export function validatePrhFootnoteIdParity(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // 1. Build the destination id-set across the entire EPUB.
  const destIds = collectDestinationIds(input.xhtmlFiles);

  // 2. Walk every XHTML for `<a epub:type="noteref">` refs.
  for (const file of input.xhtmlFiles) {
    const refRe = /<a\b([^>]*\bepub:type\s*=\s*["'][^"']*\bnoteref\b[^"']*["'][^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(file.content)) !== null) {
      const attrs = m[1];
      const hrefMatch = attrs.match(/(?:^|\s)href\s*=\s*["']([^"']*)["']/i);
      if (!hrefMatch) {
        // noteref without an href — broken in a different way. Flag
        // it as a mismatch so the operator notices.
        issues.push(buildIssue(
          file.path,
          '(no href)',
          'Add an href="#…" to the <a epub:type="noteref"> pointing at the matching footnote/endnote id.',
        ));
        continue;
      }
      const href = hrefMatch[1];
      const idTarget = parseFragmentId(href);
      if (!idTarget) {
        // href present but no `#` fragment — also broken (web link?).
        issues.push(buildIssue(
          file.path,
          href,
          'Noteref href must reference an in-EPUB fragment (e.g. href="#fn12"), not an external URL.',
        ));
        continue;
      }
      if (!destIds.has(idTarget)) {
        issues.push(buildIssue(
          file.path,
          href,
          `Add id="${idTarget}" to the matching <aside epub:type="footnote"> or <li> inside <section epub:type="endnotes">, OR correct the ref's href to point at an existing footnote id.`,
        ));
      }
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Build a global id-set covering every legal noteref destination.
 *
 * Sources:
 *   - <aside epub:type="footnote" id="…"> — inline-style PRH footnotes.
 *   - <li id="…"> inside <section epub:type="endnotes"> — endnotes
 *     pattern (Kindle popups still match these via the ol/li id).
 *
 * Returns a Set of bare ids (no `#` prefix). Operates on the WHOLE
 * EPUB so cross-file references work (a chapter's ref → the
 * standalone footnotes file).
 */
function collectDestinationIds(files: PrhXhtmlFile[]): Set<string> {
  const ids = new Set<string>();

  for (const file of files) {
    // Footnote asides — match <aside …> opening tags that carry the
    // canonical epub:type="footnote" marker, then extract id.
    const asideRe = /<aside\b([^>]*\bepub:type\s*=\s*["'][^"']*\bfootnote\b[^"']*["'][^>]*)>/gi;
    let am: RegExpExecArray | null;
    while ((am = asideRe.exec(file.content)) !== null) {
      const idMatch = am[1].match(/(?:^|\s)id\s*=\s*["']([^"']+)["']/i);
      if (idMatch) ids.add(idMatch[1]);
    }

    // Endnotes sections — collect every <li id="…"> within each
    // <section epub:type="endnotes">…</section> block. Using a
    // section-scoped scan avoids picking up <li id="…"> from
    // unrelated lists (e.g. a chapter's bullet list).
    const sectionRe = /<section\b[^>]*\bepub:type\s*=\s*["'][^"']*\bendnotes\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sectionRe.exec(file.content)) !== null) {
      const sectionBody = sm[1];
      const liRe = /<li\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi;
      let lm: RegExpExecArray | null;
      while ((lm = liRe.exec(sectionBody)) !== null) {
        ids.add(lm[1]);
      }
    }
  }

  return ids;
}

/**
 * Pull the fragment identifier from an href. Returns null if the
 * href has no fragment (external URL, plain path). For `#fn12` we
 * return `fn12`; for `chapter1.xhtml#fn12` we also return `fn12`
 * (cross-file refs are common when footnotes are externalised).
 */
function parseFragmentId(href: string): string | null {
  const hashIdx = href.indexOf('#');
  if (hashIdx < 0) return null;
  const frag = href.slice(hashIdx + 1).trim();
  return frag.length > 0 ? frag : null;
}

function buildIssue(location: string, hrefValue: string, fixHint: string): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES['PRH-FOOTNOTE-ID-MISMATCH'];
  return {
    code: 'PRH-FOOTNOTE-ID-MISMATCH',
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location} contains a <a epub:type="noteref" href="${hrefValue}"> whose destination id is missing across the EPUB.`,
    suggestion: fixHint,
    location,
  };
}
