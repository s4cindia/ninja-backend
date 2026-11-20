// Content-stream + position correlation primitives for building real /Figure
// tagging around genuinely-untagged images (the "no /Figure anywhere on the
// page" half of the alt-text Figure-indexing investigation -- see the plan
// at the session's own plan file). Two distinct concerns, kept in one file
// since they're always used together but have different shapes, mirroring
// table-content-tagger.ts's own split:
//   - locateXObjectInvocation: WHERE in the content stream does a specific
//     image's `Do` invocation live? Exact-match, not fuzzy -- an XObject
//     resource name is a literal token, not an approximate position, so this
//     is deliberately simpler than locateTextRun's tolerance-based matching.
//     Modeled on pdf-modifier.service.ts's existing mcidForXObject, which
//     already does this same `/name Do` regex walk for the READ direction
//     (find the MCID that already wraps a Do) -- this is the INSERT
//     direction (find the byte range to wrap with a NEW MCID).
//   - findNearestMcidForPosition: given a target page position (the same
//     top-down {x, y} convention image-extractor.service.ts's own
//     ImageInfo.position already uses), which EXISTING MCID-bound content on
//     that page is nearest? Used to find a real, already-tagged struct
//     element to anchor a new /Figure's placement near, via
//     pdf-structure-writer.service.ts's existing insertIntoKidsAfter -- the
//     same anchor-relative-insertion primitive Slice 2d already proved safe
//     against a flat, ungrouped /Document container (confirmed the same
//     shape recurs here: 2278 direct children, live-verified this session).

import type { ParsedPDF } from './pdf-parser.service';

export interface ContentRange {
  start: number;
  end: number;
}

/**
 * Finds the byte range of `/xObjectName Do` in a page's content stream.
 * Exact string match on the operand name immediately before a `Do` operator
 * -- no position tolerance, no ambiguity scoring, unlike locateTextRun.
 *
 * Without `occurrence`, bails (returns null) rather than guessing when the
 * same XObject name is invoked zero or more-than-once on the page: zero
 * means nothing to wrap; more-than-once means there's no way to know which
 * invocation corresponds to "the" image without additional information this
 * function doesn't otherwise have (this codebase's established "bail rather
 * than guess" convention for structure-tree/content-stream mutation, same
 * reasoning insertMarkedContentSpans and extendParentTree already apply for
 * their own ambiguous cases).
 *
 * `occurrence` (0-based), when given, supplies exactly that missing
 * information and disambiguates instead of bailing: returns the
 * (occurrence)-th `/xObjectName Do` match in source order, regardless of how
 * many total matches exist, or null if there's no match at that position.
 * Exists for a reused XObject resource (the same embedded image invoked more
 * than once on one page at different positions, a normal, common authoring
 * pattern) -- image-extractor.service.ts's own ImageInfo.index now carries
 * this exact occurrence number (see its doc comment), so a caller resolving
 * a specific invocation (e.g. buildFigureFromImage, pdf-structure-writer
 * .service.ts) can target it directly instead of being stuck at "ambiguous,
 * decline".
 */
export function locateXObjectInvocation(content: string, xObjectName: string, occurrence?: number): ContentRange | null {
  const escaped = xObjectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/${escaped}\\s+Do\\b`, 'g');
  const matches: ContentRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  if (occurrence !== undefined) {
    return matches[occurrence] ?? null;
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

interface McidPositionCandidate {
  mcid: number;
  x: number;
  y: number;
}

/**
 * Walks a page's pdfjs text content (with includeMarkedContent, the same
 * API this codebase's own table-content-tagger.test.ts helper already uses
 * to correlate MCIDs to shown text) and returns every distinct MCID bound to
 * visible text on the page, sorted nearest-first to `target` -- {x, y} in the
 * SAME top-down page-coordinate convention image-extractor.service.ts's
 * ImageInfo.position already uses (viewport.height - transform[5], not the
 * raw bottom-up baseline TableCell.anchor used for a different, unrelated
 * purpose in the just-shipped Tables effort -- do not mix the two
 * conventions). Each MCID appears at most once, at its own closest text
 * occurrence's distance.
 *
 * Returns [] if the page has no MCID-bound text content at all (should be
 * rare per this session's own reconnaissance -- 15/15 sampled genuinely-
 * untagged images had SOME text on their page -- but a real page could still
 * be text-free, e.g. a full-page diagram with no surrounding content).
 *
 * Plural, not just the single nearest: a real investigation (Whiting/Zaidi
 * jobs, 2026-11-20) found cases where the SINGLE nearest MCID is itself
 * orphaned -- opened in the content stream but never linked into the
 * structure tree by whatever tagged the document, even though the SAME page
 * has other, perfectly real tagged content a little farther away. Returning
 * every candidate (not just #1) lets buildFigureFromImage's own anchor
 * resolution keep trying progressively farther MCIDs on this exact page
 * before giving up on it entirely.
 */
export async function findNearestMcidCandidatesForPosition(
  parsedPdf: ParsedPDF,
  pageNumber: number,
  target: { x: number; y: number }
): Promise<Array<{ mcid: number; distance: number }>> {
  const page = await parsedPdf.pdfjsDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({ includeMarkedContent: true });

  const candidates: McidPositionCandidate[] = [];
  const stack: number[] = [];

  for (const raw of textContent.items as unknown[]) {
    const item = raw as {
      type?: string;
      id?: string;
      str?: string;
      transform?: number[];
    };
    if (item.type) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        const idMatch = (item.id ?? '').match(/_mc(\d+)$/);
        stack.push(idMatch ? Number(idMatch[1]) : -1);
      } else if (item.type === 'endMarkedContent') {
        stack.pop();
      }
      continue;
    }
    const activeMcid = stack.length > 0 ? stack[stack.length - 1] : -1;
    if (activeMcid < 0) continue;
    if (!item.transform || typeof item.str !== 'string' || item.str.trim() === '') continue;
    const x = item.transform[4];
    const y = viewport.height - item.transform[5];
    candidates.push({ mcid: activeMcid, x, y });
  }

  const bestDistByMcid = new Map<number, number>();
  for (const c of candidates) {
    const dist = Math.hypot(c.x - target.x, c.y - target.y);
    const existing = bestDistByMcid.get(c.mcid);
    if (existing === undefined || dist < existing) {
      bestDistByMcid.set(c.mcid, dist);
    }
  }

  return [...bestDistByMcid.entries()]
    .map(([mcid, distance]) => ({ mcid, distance }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Convenience wrapper over findNearestMcidCandidatesForPosition for callers
 * that only ever want the single nearest candidate. Kept as its own function
 * (rather than inlining `candidates[0]` at every call site) since its name
 * alone documents the "just the best one" contract existing callers/tests
 * already rely on.
 */
export async function findNearestMcidForPosition(
  parsedPdf: ParsedPDF,
  pageNumber: number,
  target: { x: number; y: number }
): Promise<{ mcid: number; distance: number } | null> {
  const candidates = await findNearestMcidCandidatesForPosition(parsedPdf, pageNumber, target);
  return candidates[0] ?? null;
}
