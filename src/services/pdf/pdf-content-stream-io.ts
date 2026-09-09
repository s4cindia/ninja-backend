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
      if (bytes) out += Buffer.from(bytes).toString('latin1');
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
const BDC_PROPS_RE = /<<((?:(?!>>).)*)>>\s*BDC/g;
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
