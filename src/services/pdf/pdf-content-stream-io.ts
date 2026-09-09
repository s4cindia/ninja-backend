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

const MCID_BDC_RE = /<<\s*\/MCID\s+(\d+)\s*>>\s*BDC/g;

/**
 * Every MCID opened via a `<< /MCID n >> BDC` marked-content sequence
 * anywhere in this page's content stream, or null if the page/stream can't
 * be read. MCIDs are page-scoped by PDF spec (each page's own numbering),
 * so membership in this set is real evidence a given MCID's content lives
 * on this specific page — usable to verify/resolve a structure element's
 * true page via its own leaf MCID references, for taggers that put no /Pg
 * anywhere in an element's structure-tree subtree (confirmed on a real
 * 805-page trial document: some /Table elements genuinely have none, even
 * searched with the subtree walk's depth unbounded — missing tag data, not
 * a search-depth issue). Callers checking several elements against the same
 * target page should call this once and reuse the result, rather than
 * re-decoding the page's content per element.
 */
export function pageContentMcids(doc: PDFDocument, pageNumber: number): Set<number> | null {
  const content = decodePageContent(doc, pageNumber);
  if (content === null) return null;
  const mcids = new Set<number>();
  MCID_BDC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MCID_BDC_RE.exec(content)) !== null) {
    mcids.add(Number(m[1]));
  }
  return mcids;
}
