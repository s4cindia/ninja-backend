/**
 * Strip Marked Content
 *
 * Stage 2 of the structure-tree-completeness effort (see
 * structure-tree-completeness.ts). A document whose existing structure
 * tree is an empty shell still has real BDC…EMC marked-content operators
 * in its page content streams, referencing that tree's MCIDs. Seam C's
 * own tagger (content-stream.ts) has no awareness of pre-existing marked
 * content — it just inserts its own BDC…EMC wrapping around whatever it
 * finds, so re-tagging over un-stripped content would nest a fresh
 * MCID-0-based scheme inside (or around) the old one. Both schemes would
 * likely reuse the same MCID numbers per page (MCID numbering restarts at
 * 0 per page in both the old tagging and Seam C's own `startMcid = 0`),
 * which is exactly the "duplicate/conflicting MCIDs" scenario Seam C's own
 * SEAM_C_ALREADY_TAGGED guard (struct-tree-builder.ts) exists to prevent.
 *
 * This module removes that ambiguity at the source: strip the old marked
 * content cleanly first, so a "retag" pass sees a genuinely blank
 * document — never touching struct-tree-builder.ts or content-stream.ts
 * themselves, which stay exactly as they are, still refusing to run on
 * anything genuinely already tagged. Reuses the exported `tokenize()` from
 * content-stream.ts (the same, deliberate isolation pattern already used
 * by contrast-content-stream.ts) rather than calling into any of that
 * module's own tagging logic.
 *
 * Scope: strips the inline-property-dict form Seam C itself emits and this
 * document's own pre-existing tagging uses — `/Tag <</MCID n>> BDC` — plus
 * the other spec-legal form, `/Tag /PropertyName BDC`, indirecting through
 * the page's /Resources /Properties dictionary, when that dictionary lets
 * this module positively confirm the referenced property either does or
 * doesn't carry /MCID (see resolvePagePropertyMcidStates). A property that
 * can't be confirmed either way (dict missing, or this entry absent from
 * it) is treated as unrecognized and bails, same as any other genuinely
 * unsupported form — never guessed at. Handles proper BDC/EMC nesting (a
 * stack, not a flat scan) even though the one real document this was
 * originally built against never nests, since nesting is spec-legal and
 * getting pairing wrong would be a correctness bug waiting to happen.
 */

import { PDFDocument, PDFName, PDFDict, PDFRef } from 'pdf-lib';
import { tokenize } from '../zone-extractor/seam-c/content-stream';
import { decodePageContent, writePageContent } from './pdf-content-stream-io';

type Token = ReturnType<typeof tokenize>[number];

/** Whether a named /Resources /Properties entry is confirmed MCID-tagged, confirmed not, or couldn't be resolved at all. */
export type PropertyMcidState = 'mcid' | 'not-mcid' | 'unknown';

/**
 * Resolves a page's /Resources /Properties dictionary into per-name MCID
 * status, for the named-properties-resource BDC form (/Tag /PropertyName
 * BDC). Absent entries (or an absent Properties/Resources dict entirely)
 * simply don't appear in the returned map — callers must treat a missing
 * key as 'unknown' (bail), not as "assume not tagged": an unresolvable
 * property could just as easily be a genuinely MCID-tagged one this
 * couldn't confirm, and silently leaving a real MCID-tagged region
 * un-stripped risks the exact nested/conflicting-MCID-numbering bug this
 * whole module exists to prevent (see module doc comment above) once Seam
 * C wraps its own BDC/EMC around the same, still-tagged content.
 */
export function resolvePagePropertyMcidStates(doc: PDFDocument, pageNumber: number): Map<string, PropertyMcidState> {
  const map = new Map<string, PropertyMcidState>();
  try {
    const page = doc.getPage(pageNumber - 1);
    const resourcesRaw = page.node.get(PDFName.of('Resources'));
    const resources = resourcesRaw instanceof PDFRef ? doc.context.lookup(resourcesRaw) : resourcesRaw;
    if (!(resources instanceof PDFDict)) return map;

    const propsRaw = resources.get(PDFName.of('Properties'));
    const props = propsRaw instanceof PDFRef ? doc.context.lookup(propsRaw) : propsRaw;
    if (!(props instanceof PDFDict)) return map;

    for (const [key, valueRaw] of props.entries()) {
      const value = valueRaw instanceof PDFRef ? doc.context.lookup(valueRaw) : valueRaw;
      const name = key instanceof PDFName ? key.decodeText() : String(key);
      const hasMcid = value instanceof PDFDict && value.get(PDFName.of('MCID')) !== undefined;
      map.set(name, hasMcid ? 'mcid' : 'not-mcid');
    }
  } catch {
    // Non-fatal -- an empty map means every named-form BDC on this page is
    // treated as 'unknown' (bail), same as if this function didn't exist.
  }
  return map;
}

export interface StripMarkedContentResult {
  content: string;
  /** Number of BDC…EMC pairs removed. 0 with content unchanged if nothing was stripped (including the bail case below). */
  removedCount: number;
  /**
   * True if a BDC using the named-properties-resource form was found and
   * left untouched — the whole strip is abandoned in that case (content is
   * returned unchanged) rather than partially stripping a stream this
   * module can't fully account for.
   */
  bailedOnUnsupportedForm: boolean;
}

interface OpenMark {
  /** [start, end) of the BDC/BMC's own opening span — its /Tag name (+ dict, for BDC) through the operator itself. Deleted on its own; content after it is untouched. */
  start: number;
  end: number;
  /** True if this was a BDC using the inline `<<...>>` dict form with /MCID inside — only these (and their matching EMC) get stripped. */
  isMcidTagged: boolean;
}

/**
 * Strips /MCID-tagged BDC…EMC pairs from a content stream, preserving
 * everything between them byte-for-byte. See module doc comment for scope.
 *
 * `propertyMcidStates` (from resolvePagePropertyMcidStates) resolves the
 * named-properties-resource BDC form; omit it (or leave a given property
 * name out of it) to always bail on that form, matching this function's
 * original behavior.
 */
export function stripMcidMarkedContent(
  content: string,
  propertyMcidStates?: Map<string, PropertyMcidState>
): StripMarkedContentResult {
  const tokens = tokenize(content);
  const stack: OpenMark[] = [];
  // [start, end) byte ranges to delete, applied right-to-left so earlier
  // offsets stay valid.
  const deletions: Array<{ start: number; end: number }> = [];
  let removedCount = 0;
  let bailedOnUnsupportedForm = false;

  const operands: Token[] = [];

  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }

    if (tk.v === 'BMC') {
      // Bare tag, no property list (e.g. Seam C's own `/Artifact BMC`) —
      // never /MCID-tagged by definition, but still opens a mark that EMC
      // will close, so it must occupy a stack slot to keep nesting/pairing
      // correct for whatever comes after it.
      const tagOperand = operands[operands.length - 1];
      stack.push({ start: tagOperand ? tagOperand.start : tk.start, end: tk.end, isMcidTagged: false });
      operands.length = 0;
      continue;
    }

    if (tk.v === 'BDC') {
      // Expected inline-dict shape: [...][name /Tag][<<][...dict tokens...][>>]
      // — the operand immediately before BDC must be a closing >>, and an
      // opening << must exist earlier in this operand run for this to be
      // the inline form at all.
      const last = operands[operands.length - 1];
      const dictCloseIdx = last && last.t === '>>' ? operands.length - 1 : -1;
      let dictOpenIdx = -1;
      if (dictCloseIdx !== -1) {
        for (let i = dictCloseIdx - 1; i >= 0; i--) {
          if (operands[i].t === '<<') { dictOpenIdx = i; break; }
        }
      }

      if (dictOpenIdx === -1) {
        // Possibly the named-properties-resource form: [...][name /Tag][name /PropertyName].
        const propOperand = operands[operands.length - 1];
        const tagOperand = operands[operands.length - 2];
        const isNamedForm = propOperand?.t === 'name' && tagOperand?.t === 'name';
        const propState = isNamedForm ? propertyMcidStates?.get(propOperand.v.replace(/^\//, '')) : undefined;

        if (isNamedForm && propState && propState !== 'unknown') {
          stack.push({ start: tagOperand.start, end: tk.end, isMcidTagged: propState === 'mcid' });
        } else {
          // Genuinely unrecognized form, or a named-form property that
          // couldn't be confirmed either way — bail entirely rather than guess.
          bailedOnUnsupportedForm = true;
          stack.push({ start: -1, end: tk.end, isMcidTagged: false });
        }
      } else {
        const hasMcid = operands
          .slice(dictOpenIdx + 1, dictCloseIdx)
          .some((t) => t.t === 'name' && t.v === '/MCID');
        // The /Tag name (if present) is whatever operand comes right before
        // the <<; if the tag name itself is missing, fall back to the <<'s
        // own start — either way this is the leftmost byte belonging to
        // this BDC's operand run.
        const tagIdx = dictOpenIdx - 1;
        const runStart = tagIdx >= 0 ? operands[tagIdx].start : operands[dictOpenIdx].start;
        stack.push({ start: runStart, end: tk.end, isMcidTagged: hasMcid });
      }
      operands.length = 0;
      continue;
    }

    if (tk.v === 'EMC') {
      const open = stack.pop();
      if (open && open.isMcidTagged) {
        // Two separate deletions — the BDC's own opening span, and this EMC
        // token on its own. Everything in between (the actual content) is
        // left completely untouched.
        deletions.push({ start: open.start, end: open.end });
        deletions.push({ start: tk.start, end: tk.end });
        removedCount++;
      }
      operands.length = 0;
      continue;
    }

    operands.length = 0;
  }

  if (bailedOnUnsupportedForm) {
    return { content, removedCount: 0, bailedOnUnsupportedForm: true };
  }

  if (deletions.length === 0) {
    return { content, removedCount: 0, bailedOnUnsupportedForm: false };
  }

  deletions.sort((a, b) => b.start - a.start);
  let out = content;
  for (const d of deletions) out = out.slice(0, d.start) + out.slice(d.end);

  return { content: out, removedCount, bailedOnUnsupportedForm: false };
}

export interface PrepareForRetagResult {
  /** False if nothing was changed — either no pages needed stripping, or any single page's content couldn't be safely stripped (all-or-nothing: a partial strip would leave one page double-taggable while the rest are clean, worse than leaving the whole document as-is). */
  success: boolean;
  pagesStripped: number;
  totalPages: number;
  /** 1-based page number that caused an abort, when success is false because of an unsupported BDC form (not because there was simply nothing to strip). */
  bailedOnPage: number | null;
}

/**
 * Strips MCID-tagged marked content from every page and removes the
 * catalog's /StructTreeRoot pointer, so the document is genuinely
 * unmarked again — at which point Seam C's own, untouched
 * SEAM_C_ALREADY_TAGGED check naturally stops firing. All-or-nothing: does
 * a dry run across every page first, and only writes anything if every
 * page could be safely stripped (or had nothing to strip).
 */
export function prepareDocumentForRetag(doc: PDFDocument): PrepareForRetagResult {
  const pageCount = doc.getPageCount();
  const perPage: Array<{ pageNumber: number; content: string; result: StripMarkedContentResult } | null> = [];

  for (let i = 0; i < pageCount; i++) {
    const pageNumber = i + 1;
    const content = decodePageContent(doc, pageNumber);
    if (content === null) { perPage.push(null); continue; }
    const propertyMcidStates = resolvePagePropertyMcidStates(doc, pageNumber);
    const result = stripMcidMarkedContent(content, propertyMcidStates);
    if (result.bailedOnUnsupportedForm) {
      return { success: false, pagesStripped: 0, totalPages: pageCount, bailedOnPage: pageNumber };
    }
    perPage.push({ pageNumber, content, result });
  }

  let pagesStripped = 0;
  for (const entry of perPage) {
    if (!entry || entry.result.removedCount === 0) continue;
    writePageContent(doc, entry.pageNumber, entry.result.content);
    pagesStripped++;
  }

  if (pagesStripped > 0) {
    doc.catalog.delete(PDFName.of('StructTreeRoot'));
    doc.catalog.delete(PDFName.of('MarkInfo'));
  }

  return { success: pagesStripped > 0, pagesStripped, totalPages: pageCount, bailedOnPage: null };
}
