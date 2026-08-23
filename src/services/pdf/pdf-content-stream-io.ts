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
