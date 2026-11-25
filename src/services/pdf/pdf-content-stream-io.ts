// Shared low-level read/write of a single PDF page's content stream.
//
// The decode side is a pure extraction of pdf-modifier.service.ts's private
// decodePageContent (behavior-preserving — that method now delegates here).
// The write side is the same flateStream → register → set('Contents', ref)
// triplet already proven in struct-tree-builder.ts's content-stream rewrite
// (left as-is there, not touched by this extraction, to minimize surface
// changed on a live production path).

import { PDFDocument, PDFName, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/**
 * Decode a page's content stream(s) to a single latin1 string (1:1
 * byte↔char correspondence — required for byte-offset math on the result),
 * or null if the page/stream can't be read.
 */
export function decodePageContent(doc: PDFDocument, pageNumber: number): string | null {
  try {
    const page = doc.getPage(pageNumber - 1);
    const raw = page.node.get(PDFName.of('Contents'));
    const resolve = (o: unknown): unknown => (o instanceof PDFRef ? doc.context.lookup(o) : o);
    const c = resolve(raw);
    const streams = c instanceof PDFArray
      ? Array.from({ length: c.size() }, (_, i) => resolve(c.get(i)))
      : [c];
    let out = '';
    for (const s of streams) {
      let bytes: Uint8Array | null = null;
      const anyS = s as { decode?: () => Uint8Array };
      if (anyS && typeof anyS.decode === 'function') { try { bytes = anyS.decode(); } catch { /* */ } }
      if (!bytes && s instanceof PDFRawStream) { try { bytes = decodePDFRawStream(s).decode(); } catch { /* */ } }
      if (bytes) {
        // PDF32000-1:2008 §7.8.2 only guarantees each /Contents array
        // element is internally a complete token sequence -- it says
        // nothing about what byte immediately precedes/follows the next
        // element, and real producers routinely emit a segment with no
        // trailing whitespace right before one with no leading whitespace
        // (confirmed real: a running-header /Artifact BDC whose own
        // preceding /Tf lived in the PRECEDING array element, 149 pages,
        // WPVP_180188_9798986469300_txt.pdf, 2026-11-10). Concatenating
        // with no separator silently glues the last token of one segment
        // to the first token of the next into one unrecognized token --
        // here, Tf's own font-name operand merging with the next
        // segment's leading tag name, making the font untrackable from
        // that point on. A newline is always syntactically safe to insert
        // (whitespace is never significant inside a content stream), so
        // this has no downside for a conforming producer and heals this
        // real non-conforming shape.
        if (out.length > 0) out += '\n';
        out += Buffer.from(bytes).toString('latin1');
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Replace a page's /Contents with a single new stream built from `content`
 * (latin1 — the inverse of decodePageContent), re-compressed with FlateDecode.
 */
export function writePageContent(doc: PDFDocument, pageNumber: number, content: string): void {
  const page = doc.getPage(pageNumber - 1);
  const newStream = doc.context.flateStream(Buffer.from(content, 'latin1'));
  const newRef = doc.context.register(newStream);
  page.node.set(PDFName.of('Contents'), newRef);
}

// Captures a BDC's whole inline property dict, e.g. both the plain
// `<< /MCID 7 >>` form and one with other keys alongside it (e.g.
// `<< /Lang (en-US) /MCID 7 >>`) -- /MCID is then pulled out of the
// captured group separately, rather than requiring it be the dict's only
// entry (which would silently miss any BDC with additional properties).
//
// Known, accepted residual limitations (text-based regex parsing of PDF
// content-stream syntax, not a real tokenizer -- flagged in review as a
// legitimate but separate, substantially bigger undertaking):
//   - A /MCID-shaped substring inside a PDF string literal (parenthesized
//     text, e.g. an /ActualText value that happens to contain the literal
//     text "/MCID 7") sitting inside an otherwise-real BDC dict could be
//     misread as a key. Real documents essentially never put PDF-syntax
//     lookalikes inside human-authored string content, but it's possible.
//   - A dict containing a *nested* `<<...>>` (e.g. an OCG dict as a
//     property value) stops at the first `>>`, truncating the captured
//     group at the nested dict's own close rather than the outer one.
//   - Only the inline-dict BDC form is recognized -- a named property-list
//     reference (`/P1 BDC`, resolved via the page's /Resources /Properties)
//     is not. A page using that form yields zero MCIDs here, same as
//     before this fallback existed (a missed opportunity, not a wrong
//     answer -- resolvesToPageViaMcid's caller already treats "no MCID
//     evidence" as "can't help", not as a false negative on some other
//     path).
// A correct, general fix needs an actual content-stream tokenizer (proper
// string/dict/array lexing) plus Resources-aware Properties resolution --
// real, valuable, out of scope for this fallback's purpose (recovering an
// otherwise totally unresolvable element), which this regex already
// strictly improves on for the realistic cases seen in real tagged PDFs.
//
// FIXED (2026-11-07), unlike the two limitations above: a dict ending in a
// nested `<...>` HEX STRING immediately followed by the dict's own closing
// `>>` -- e.g. `<</MCID 7 /ActualText<FEFF0041>>>` -- produces three
// consecutive `>` characters (the hex string's own close, then the dict's).
// The naive `(?!>>).` loop stops one character too early (right before the
// hex string's own closing `>`, since the lookahead sees '>>' starting
// there), then fails to match the required literal `>>` immediately after
// (what's actually there is a THIRD `>`, not whitespace/BDC) -- silently
// dropping the WHOLE BDC occurrence, MCID included. Confirmed real and
// newly load-bearing, not theoretical: Karsaklian_189165_9781606497623's
// own InDesign-authored /ActualText values use this exact hex form
// (confirmed via decodePdfStringLiteral's own UTF-16BE/FEFF-BOM handling
// elsewhere), and once pdf-structure-writer.service.ts's own
// fixActualTextMissingMcid started writing a real /MCID into these same
// dicts (PR #781), this function's own undercount of "next available
// MCID" started colliding with /ParentTree's real, already-correct entry
// count -- confirmed live: buildFigureFromImage failed with "MCID 2556
// does not append contiguously" on a page whose content stream, scanned
// directly, plainly contains a literal `/MCID 2556` this regex alone
// couldn't see. Fixed by letting a complete hex-string token (`<` + hex
// digits/whitespace + `>`) consume as ONE atomic alternative before the
// general character-by-character rule applies -- a hex string's own `>`
// can then never be mistaken for the dict's.
const BDC_PROPS_RE = /<<((?:<[0-9A-Fa-f\s]*>|(?!>>).)*)>>\s*BDC/g;
const MCID_ATTR_RE = /\/MCID\s+(\d+)/;

/**
 * Every MCID opened via a `<< ... /MCID n ... >> BDC` marked-content
 * sequence anywhere in this page's content stream, or null if the
 * page/stream can't be read. MCIDs are page-scoped by PDF spec (each
 * page's own numbering), so membership in this set is real evidence a
 * given MCID's content lives on this specific page — usable to
 * verify/resolve a structure element's true page via its own leaf MCID
 * references, for taggers that put no /Pg anywhere in an element's
 * structure-tree subtree (confirmed on a real 805-page trial document:
 * some /Table elements genuinely have none, even searched with the
 * subtree walk's depth unbounded — missing tag data, not a search-depth
 * issue). Callers checking several elements against the same target page
 * should call this once and reuse the result, rather than re-decoding the
 * page's content per element.
 */
export function pageContentMcids(doc: PDFDocument, pageNumber: number): Set<number> | null {
  const content = decodePageContent(doc, pageNumber);
  if (content === null) return null;
  const mcids = new Set<number>();
  BDC_PROPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BDC_PROPS_RE.exec(content)) !== null) {
    const mcidMatch = MCID_ATTR_RE.exec(m[1]);
    if (mcidMatch) mcids.add(Number(mcidMatch[1]));
  }
  return mcids;
}

export interface PositionedMcid {
  mcid: number;
  /** Byte offset of the `<<` that opens this MCID's own property dict (where its own BDC sequence begins). */
  start: number;
}

/**
 * Same detection as pageContentMcids, but on already-decoded content (no
 * page re-decode) and keeping each MCID's own byte offset in document
 * (content-stream) order. Needed by callers that must find the nearest
 * EXISTING tagged neighbor to a specific splice point -- e.g. deciding
 * which document-flow parent a newly-inserted struct element belongs next
 * to -- not just confirm an MCID value exists somewhere on the page.
 */
export function orderedPageContentMcids(content: string): PositionedMcid[] {
  const results: PositionedMcid[] = [];
  BDC_PROPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BDC_PROPS_RE.exec(content)) !== null) {
    const mcidMatch = MCID_ATTR_RE.exec(m[1]);
    if (mcidMatch) results.push({ mcid: Number(mcidMatch[1]), start: m.index });
  }
  return results;
}

/**
 * Locates the FULL `/TagName <<...props...>> BDC` span (from the tag
 * name's own start through the literal `BDC` keyword) that opens the given
 * MCID -- unlike orderedPageContentMcids's own `start` (the `<<` only),
 * this includes the tag name so a caller can replace the WHOLE opening
 * sequence (e.g. retagging `/Figure <</MCID n>>BDC` to `/Artifact BMC`,
 * which carries no properties dict and no MCID at all). The matching EMC
 * never needs locating separately for that kind of retag -- EMC carries no
 * tag name of its own, so it closes correctly regardless of what opened it.
 * Returns null if no BDC opens exactly this MCID (never guesses which one
 * if the content is malformed enough to have none).
 */
export function findBdcTagSpanForMcid(content: string, mcid: number): { start: number; end: number } | null {
  const re = new RegExp(BDC_PROPS_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const mcidMatch = MCID_ATTR_RE.exec(m[1]);
    if (!mcidMatch || Number(mcidMatch[1]) !== mcid) continue;
    let tagStart = m.index;
    while (tagStart > 0 && /\s/.test(content[tagStart - 1])) tagStart--;
    while (tagStart > 0 && !/\s/.test(content[tagStart - 1])) tagStart--;
    return { start: tagStart, end: m.index + m[0].length };
  }
  return null;
}

const MARKED_CONTENT_OPEN_CLOSE_RE = /\b(BDC|BMC|EMC)\b/g;

/**
 * The full content between a specific MCID's own `BDC` and its MATCHING
 * `EMC` (depth-tracked -- a nested BDC/BMC inside this span increments
 * depth, so an inner EMC doesn't prematurely close the outer one). Unlike
 * findBdcTagSpanForMcid (which only locates the opening tag itself, for
 * retagging callers that never need the body), this is for callers that
 * need to inspect what's actually DRAWN inside this MCID's own marked
 * content -- see figureHasDrawableContent below, its only caller today.
 * Returns null if the MCID has no opening BDC, or its EMC is missing
 * (malformed/truncated content stream -- never guesses a close point).
 */
export function findMcidContentSpan(content: string, mcid: number): { start: number; end: number } | null {
  const tag = findBdcTagSpanForMcid(content, mcid);
  if (!tag) return null;

  const re = new RegExp(MARKED_CONTENT_OPEN_CLOSE_RE.source, 'g');
  re.lastIndex = tag.end;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1] === 'EMC') {
      if (depth === 0) return { start: tag.end, end: match.index };
      depth--;
    } else {
      depth++;
    }
  }
  return null; // no matching EMC found -- malformed/truncated stream
}

// Same operator set measure.py's own PageScan._scan uses to classify a
// Figure's content (scripts/qc-regression/measure.py) -- kept in sync
// deliberately, so the production invariant below and the corpus's own
// figures_content_empty metric agree on what "has content" means.
const IMAGE_OR_VECTOR_OPERATOR_RE = /\b(Do|BI|f\*?|F|B\*?|b\*?|S|s)\b/;
// A single string-show operand, either form PDF32000 §7.3.4/7.3.4.3 allows:
// a literal string "(...)" or a hex string "<...>" -- pdf-lib (confirmed
// live, 2026-11-25) emits the hex form for ordinary Latin text, not just
// for genuinely binary/non-Latin1 content, so both forms are load-bearing
// here, not just a defensive extra case.
const STRING_OPERAND_RE = /\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]*)>/g;
// Tj/'/" each take exactly one string operand; TJ takes a bracketed array
// mixing string operands with plain numbers (kerning adjustments) -- only
// the strings carry text, so this only needs to find the array body, not
// parse the numbers out of it.
const TEXT_SHOW_RE = /\(((?:\\.|[^()\\])*)\)\s*(?:Tj|')|<([0-9A-Fa-f\s]*)>\s*(?:Tj|')|\[((?:\\.|[^[\]\\])*)\]\s*TJ/g;

/** Decodes a PDF literal string's own backslash escapes just enough to
 *  tell whether it's whitespace-only -- \\n/\\t/\\r/\\( etc. all collapse
 *  to a single non-informative char here, which is all isWhitespaceOnly
 *  below needs; this is NOT a general PDF string→Unicode decoder. */
function collapseEscapes(s: string): string {
  return s.replace(/\\(.)/g, ' ');
}

/** Hex string "<41 42>" -> "AB" (strips whitespace the spec allows between
 *  digit pairs, then one fromCharCode per byte -- Latin1 code-point-per-
 *  byte, matching decodePageContent's own latin1 round-trip, not a real
 *  PDFDocEncoding/UTF-16BE decoder; good enough for a whitespace/pattern
 *  check on the result, which is this module's only use for it). An odd
 *  number of hex digits (a malformed string) drops the final unpaired one
 *  rather than throwing. */
function decodeHexString(hex: string): string {
  const digits = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < digits.length; i += 2) {
    out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
  }
  return out;
}

/** Every string operand (literal or hex) inside a TJ array body, decoded
 *  and concatenated -- the array's own interleaved numbers are ignored. */
function decodeTJArrayBody(body: string): string {
  let out = '';
  let m: RegExpExecArray | null;
  STRING_OPERAND_RE.lastIndex = 0;
  while ((m = STRING_OPERAND_RE.exec(body)) !== null) {
    out += m[1] !== undefined ? collapseEscapes(m[1]) : decodeHexString(m[2] ?? '');
  }
  return out;
}

/**
 * Removes every NESTED marked-content region (any BDC or BMC, regardless
 * of tag, depth-tracked so an inner span's own nested EMC never
 * prematurely closes an outer one) from `body` -- leaving only the
 * content directly inside the OUTER mcid's own span, not anything
 * belonging to a nested child struct element or Artifact instead.
 * Matches measure.py's own _state() semantics (the INNERMOST open
 * marked-content region on the stack claims content, never an
 * ancestor's).
 *
 * Real bug this closes, 2026-11-25: without this, a Figure whose own
 * drawable content is ENTIRELY nested inside e.g. an /Artifact BMC reads
 * as "has content" to the two functions below, when nothing is actually
 * exposed as the Figure's own. Confirmed live: T4's own page-90 Figure
 * (MCID 8) opens, then immediately opens a nested `/Artifact BMC` whose
 * matching EMC doesn't appear until AFTER a real image Do and a page's
 * worth of vector-art strokes -- every bit of that drawing is Artifact
 * content, correctly excluded by measure.py's figures_content_empty
 * metric (which is how this Figure was found to still be "empty" despite
 * visibly containing an image and vector paint), but NOT excluded by
 * mcidHasImageOrVectorContent/extractMcidText before this fix -- so alt
 * text dispatch (ai-analysis.service.ts) saw "real content" and sent it
 * to vision, which duly hallucinated a description for a region with
 * nothing actually exposed to describe.
 */
function stripNestedMarkedContent(body: string): string {
  const re = new RegExp(MARKED_CONTENT_OPEN_CLOSE_RE.source, 'g');
  let out = '';
  let copyFrom = 0;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] === 'EMC') {
      if (depth > 0) {
        depth--;
        if (depth === 0) copyFrom = m.index + m[0].length;
      }
    } else {
      if (depth === 0) out += body.slice(copyFrom, m.index);
      depth++;
    }
  }
  if (depth === 0) out += body.slice(copyFrom);
  return out;
}

/** True if `mcid`'s own span -- excluding anything nested inside a child
 *  struct element or Artifact (see stripNestedMarkedContent) -- contains
 *  an image/form XObject invocation (`Do`), inline image (`BI`), or a
 *  vector path-paint operator (fill, fill-even-odd, stroke,
 *  close-and-stroke, or the B/b variants that both fill and stroke) --
 *  i.e. it actually draws something, text aside. Doesn't distinguish
 *  image-Do from form-Do (measure.py's "image" vs "form" kinds) -- a
 *  caller needing that distinction inspects the XObject's own /Subtype
 *  directly, the way pdf-modifier.service.ts and
 *  image-extractor.service.ts already do for other purposes. */
export function mcidHasImageOrVectorContent(content: string, mcid: number): boolean {
  const span = findMcidContentSpan(content, mcid);
  if (!span) return false;
  return IMAGE_OR_VECTOR_OPERATOR_RE.test(stripNestedMarkedContent(content.slice(span.start, span.end)));
}

/** Every Tj/TJ/'/" text-show operand directly under `mcid`'s own span --
 *  excluding anything nested inside a child struct element or Artifact
 *  (see stripNestedMarkedContent) -- concatenated in source order
 *  (escapes collapsed to a space, not fully decoded -- callers doing
 *  more than a whitespace/pattern check on the result should extract
 *  their own copy with a real PDF string decoder). Empty string if the
 *  MCID has no span or no direct text-show operator at all. */
export function extractMcidText(content: string, mcid: number): string {
  const span = findMcidContentSpan(content, mcid);
  if (!span) return '';
  const body = stripNestedMarkedContent(content.slice(span.start, span.end));
  let out = '';
  let m: RegExpExecArray | null;
  TEXT_SHOW_RE.lastIndex = 0;
  while ((m = TEXT_SHOW_RE.exec(body)) !== null) {
    if (m[1] !== undefined) out += collapseEscapes(m[1]);
    else if (m[2] !== undefined) out += decodeHexString(m[2]);
    else out += decodeTJArrayBody(m[3] ?? '');
  }
  return out;
}

/**
 * True if `mcid`'s own marked-content span (BDC..EMC, nested spans
 * included) draws or says ANYTHING -- image/vector/form content
 * (mcidHasImageOrVectorContent) or non-whitespace text
 * (extractMcidText) -- as opposed to being a placeholder with nothing
 * under it at all. The ONLY caller-visible "has content" question;
 * distinguishing text-only from image/vector (needed e.g. to decide
 * whether vision or grounded-text alt-drafting applies) is the
 * caller's own job via the two functions above, not this one.
 */
export function mcidHasDrawableContent(content: string, mcid: number): boolean {
  if (mcidHasImageOrVectorContent(content, mcid)) return true;
  return extractMcidText(content, mcid).trim().length > 0;
}

// A job/author/figure-code production slug -- 3+ slash-delimited tokens,
// each a short run of letters/digits/dots/hyphens with no internal space
// (a real sentence or label always has at least one space-separated
// multi-word segment; a production stamp like
// "E7808/McConnell/F09.02/678320/mh-R2" never does). Deliberately
// conservative (3+ segments, not 2+) to avoid matching a genuine two-part
// reference like "Figure/3.2" or a URL-shaped caption.
const PRODUCTION_STAMP_RE = /^[A-Za-z0-9.-]+(?:\/[A-Za-z0-9.-]+){2,}$/;

/** True if `text` (already collapsed/trimmed by the caller, e.g. via
 *  extractMcidText) looks like an InDesign-style internal production
 *  stamp (job/author/figure-code slug) rather than reader-facing content
 *  -- see PRODUCTION_STAMP_RE's own comment for the exact shape and why
 *  it's safe against real captions/references. */
export function looksLikeProductionStamp(text: string): boolean {
  return PRODUCTION_STAMP_RE.test(text.trim());
}

/**
 * Rewrites `mcid`'s own opening `/TagName [<<props>>] BDC` to a bare
 * `/Artifact BMC` -- same retag findBdcTagSpanForMcid's own doc comment
 * already anticipated (no properties dict, no MCID, so the matching EMC
 * still closes it correctly with no further change needed there). Used
 * to demote a zone struct-tree-builder.ts decides NOT to keep as a
 * struct element (no real content, or a production-stamp-only text run)
 * from tagged content to artifact, so its MCID doesn't dangle unclaimed
 * in the content stream once no struct element references it. Returns
 * the unmodified content, and false, if no BDC opens exactly this MCID.
 */
export function retagMcidToArtifact(content: string, mcid: number): { content: string; retagged: boolean } {
  const tag = findBdcTagSpanForMcid(content, mcid);
  if (!tag) return { content, retagged: false };
  return { content: content.slice(0, tag.start) + '/Artifact BMC' + content.slice(tag.end), retagged: true };
}
