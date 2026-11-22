/**
 * Varying Running-Head/Footer-Tagged-As-Content Finder
 *
 * Real incident (Karsaklian_189165_9781606497623.pdf): InDesign's own export
 * nests the page's running head (the chapter title, e.g. "BECOME A
 * MARKETING NEGOTIATOR") as a real, tagged struct element -- in this
 * document's case, letter-by-letter, each glyph individually
 * `/Span <</MCID n /ActualText (letter)>> BDC ... EMC`-wrapped (InDesign's
 * own letter-kerned export convention) -- rather than as a bare /Artifact.
 * This pollutes reading order and screen-reader output with page furniture,
 * same Matterhorn 01-001 defect pdf-header-footer-content.validator.ts
 * already detects for a FIXED (unchanging) running head/footer text, but
 * that validator's own detection input -- PdfParseResult's pdfjs-extracted
 * PdfTextContent items -- cannot see this one: pdfjs fragments this
 * document's letter-kerned rendering into dozens of tiny single-letter/
 * kern-run items (confirmed real: "n", "eg", "arketing" as SEPARATE items at
 * slightly different x positions), so a per-chapter-varying running head
 * never appears as one coherent, matchable phrase at the pdfjs-item level,
 * at any threshold -- confirmed empirically: the existing exact-match check
 * finds 0 issues on this real document despite the defect being real and
 * confirmed via direct inspection.
 *
 * This module is struct-tree-native instead: it walks each CANDIDATE struct
 * element's own bare /K MCIDs directly and reconstructs the full text by
 * concatenating their content-stream Tj/TJ operands in order -- the same
 * technique that correctly reassembled "BECOME A MARKETING NEGOTIATOR" as
 * one string during this investigation, when pdfjs-item text could not.
 *
 * findVaryingHeaderFooterCandidates is the single source of truth for this
 * check -- shared by pdf-header-footer-content.validator.ts (groups
 * candidates into slots/variants, applies recurrence thresholds, maps
 * qualifying ones to AuditIssues) and
 * PdfStructureWriterService.fixHeaderFooterVaryingTaggedAsContent (re-runs
 * this same function fresh at apply time rather than trusting a stale
 * analysis-time result), matching reading-order-float.ts's own established
 * convention for this codebase.
 *
 * Deliberately conservative: a struct element only ever becomes a candidate
 * when its own /K resolves ENTIRELY to bare MCID integers or MCR dicts (no
 * nested struct-element child) -- any entry that resolves to a dict with its
 * own /S disqualifies the element outright, rather than guessing which part
 * of something more structurally complex than this document's confirmed
 * shape might be page furniture.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { decodePageContent, findBdcTagSpanForMcid } from './pdf-content-stream-io';
import { locateMcidBoundingBoxes } from './mcid-bounding-box';
import { HEADER_HEIGHT_RATIO, FOOTER_HEIGHT_RATIO } from './smart-triage/artifact-marker';

export interface VaryingHeaderFooterCandidate {
  ref: PDFRef;
  page: number;
  /** This element's own /K, in array order, bare-MCID/MCR only (see this file's own header comment). */
  mcids: number[];
  /** Raw concatenated text across all mcids, in order. */
  text: string;
  region: 'header' | 'footer';
  /** First MCID's own device-space anchor (bottom-left origin). */
  x: number;
  y: number;
}

/** Minimal PDF literal-string (`(...)`) escape decoder -- same scope as pdf-header-footer-content.validator.ts's own (unexported) decodeLiteralString, duplicated per this codebase's established preference for isolated per-feature helpers. */
function decodeLiteralString(raw: string): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { out += c; continue; }
    const next = inner[i + 1];
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b') { out += '\b'; i++; }
    else if (next === 'f') { out += '\f'; i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next === '\n' || next === '\r') { i++; }
    else { out += next; i++; }
  }
  return out;
}

/** Minimal PDF hex-string (`<...>`) decoder, single byte per char -- same scope as the validator's own (unexported) decodeHexString. */
function decodeHexString(raw: string): string {
  const hex = raw.slice(1, -1).replace(/\s+/g, '');
  const padded = hex.length % 2 === 0 ? hex : hex + '0';
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Reads every literal/hex text-show operand between an MCID's own BDC and
 * its matching EMC (depth-tracked, so a nested unrelated BDC/EMC pair inside
 * the same span doesn't end it early). Returns '' if the MCID's own BDC
 * can't be found at all.
 */
function extractTextForMcid(content: string, mcid: number): string {
  const span = findBdcTagSpanForMcid(content, mcid);
  if (!span) return '';
  const rest = content.slice(span.end);
  let depth = 1;
  const tagRe = /\b(BDC|BMC|EMC)\b/g;
  let m: RegExpExecArray | null;
  let emcOffset = rest.length;
  while ((m = tagRe.exec(rest)) !== null) {
    if (m[1] === 'EMC') { depth--; if (depth === 0) { emcOffset = m.index; break; } }
    else depth++;
  }
  const body = rest.slice(0, emcOffset);
  const strings: string[] = [];
  const opRe = /(\((?:\\.|[^()\\])*\))|(<[0-9A-Fa-f\s]*>)/g;
  let sm: RegExpExecArray | null;
  while ((sm = opRe.exec(body)) !== null) {
    strings.push(sm[1] ? decodeLiteralString(sm[1]) : decodeHexString(sm[2]));
  }
  return strings.join('');
}

/**
 * Classifies dict's own /K: returns the bare MCID list when every entry is
 * a bare integer or an MCR dict (/MCID, no /S), or null when /K is missing,
 * empty, or contains anything else -- most importantly, a nested
 * struct-element child (a dict WITH its own /S), which disqualifies this
 * element outright rather than guessing. Mirrors reading-order-float.ts's
 * own collectDirectMcids classification, reused here as a shape guard
 * rather than a range aggregator.
 */
function collectBareMcidsOnly(doc: PDFDocument, dict: PDFDict): number[] | null {
  const kRaw = dict.get(PDFName.of('K'));
  const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
  const items: unknown[] = kResolved instanceof PDFArray ? kResolved.asArray() : kRaw !== undefined ? [kRaw] : [];
  if (items.length === 0) return null;

  const out: number[] = [];
  for (const item of items) {
    if (item instanceof PDFNumber) { out.push(item.asNumber()); continue; }
    const resolved = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (resolved instanceof PDFDict) {
      if (resolved.get(PDFName.of('S')) !== undefined) return null; // nested struct child -- disqualify
      const mcidVal = resolved.get(PDFName.of('MCID'));
      const resolvedMcid = mcidVal instanceof PDFRef ? doc.context.lookup(mcidVal) : mcidVal;
      if (resolvedMcid instanceof PDFNumber) { out.push(resolvedMcid.asNumber()); continue; }
    }
    return null; // unrecognized shape -- disqualify rather than guess
  }
  return out.length > 0 ? out : null;
}

function getStructTreeRoot(doc: PDFDocument): PDFDict | undefined {
  const root = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const resolved = root instanceof PDFRef ? doc.context.lookup(root) : root;
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function findVaryingHeaderFooterCandidates(doc: PDFDocument): VaryingHeaderFooterCandidate[] {
  const structRoot = getStructTreeRoot(doc);
  if (!structRoot) return [];

  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageByRef.set(p.ref.toString(), i + 1));

  const pageContentCache = new Map<number, string | null>();
  function getPageContent(pageNumber: number): string | null {
    if (pageContentCache.has(pageNumber)) return pageContentCache.get(pageNumber) ?? null;
    const content = decodePageContent(doc, pageNumber);
    pageContentCache.set(pageNumber, content);
    return content;
  }

  const candidates: VaryingHeaderFooterCandidate[] = [];
  const visited = new Set<string>();

  function structChildren(dict: PDFDict): Array<{ ref: PDFRef; dict: PDFDict }> {
    const kRaw = dict.get(PDFName.of('K'));
    const kResolved = kRaw instanceof PDFRef ? doc.context.lookup(kRaw) : kRaw;
    const out: Array<{ ref: PDFRef; dict: PDFDict }> = [];
    const consider = (item: unknown): void => {
      if (!(item instanceof PDFRef)) return;
      const childDict = doc.context.lookup(item);
      if (childDict instanceof PDFDict && childDict.get(PDFName.of('S')) !== undefined) {
        out.push({ ref: item, dict: childDict });
      }
    };
    if (kResolved instanceof PDFArray) {
      for (const item of kResolved.asArray()) consider(item);
    } else {
      consider(kRaw);
    }
    return out;
  }

  function visit(ref: PDFRef, dict: PDFDict): void {
    const key = ref.toString();
    if (visited.has(key)) return;
    visited.add(key);

    const bareMcids = collectBareMcidsOnly(doc, dict);
    if (bareMcids) {
      const pgRaw = dict.get(PDFName.of('Pg'));
      const page = pgRaw instanceof PDFRef ? pageByRef.get(pgRaw.toString()) ?? null : null;
      if (page !== null) {
        const content = getPageContent(page);
        if (content) {
          const text = bareMcids.map((mc) => extractTextForMcid(content, mc)).join('').trim();
          if (text) {
            const box = locateMcidBoundingBoxes(content, new Set([bareMcids[0]]), { allowSinglePointBoxes: true }).get(bareMcids[0]);
            if (box) {
              const pageHeight = doc.getPage(page - 1).getSize().height;
              const headerBandStart = pageHeight - pageHeight * HEADER_HEIGHT_RATIO;
              const footerBandEnd = pageHeight * FOOTER_HEIGHT_RATIO;
              const y = box.maxY; // device space is already bottom-left origin
              const region: 'header' | 'footer' | null = y >= headerBandStart ? 'header' : y <= footerBandEnd ? 'footer' : null;
              if (region) {
                candidates.push({ ref, page, mcids: bareMcids, text, region, x: box.minX, y: box.maxY });
              }
            }
          }
        }
      }
      // A bare-MCID-only element has no struct-element children to recurse into.
      return;
    }

    for (const child of structChildren(dict)) visit(child.ref, child.dict);
  }

  for (const child of structChildren(structRoot)) {
    visit(child.ref, child.dict);
  }

  return candidates;
}
