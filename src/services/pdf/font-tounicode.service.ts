/**
 * Font ToUnicode synthesis (Seam C — recommendation #3)
 *
 * PDF/UA (veraPDF clause 7.21.7 — `toUnicode != null`) requires every used
 * glyph to map to Unicode. Many source PDFs — especially TeX/LaTeX output —
 * embed subset fonts with no /ToUnicode CMap, so their glyphs are unmappable.
 * This pass synthesises a /ToUnicode CMap for every simple font that lacks one.
 *
 * Mapping strategy (best-effort, never wrong for standard text):
 *   1. /Encoding /Differences glyph name → Unicode (algorithmic uniXXXX / AGL)
 *   2. base encoding (WinAnsi/CP1252) code → Unicode
 *   3. PUA fallback (U+E000 + code) — guarantees `toUnicode != null`
 *
 * Custom-encoded math fonts (CMEX/CMSY) fall to PUA; that satisfies 7.21.7,
 * while the real reading comes from the Formula /ActualText written elsewhere
 * (recommendation #2). ToUnicode carries syntax, ActualText carries semantics.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { baseEncodingTable, glyphNameToUnicode, isValidScalar } from './font-encodings';
import { tokenize } from '../zone-extractor/seam-c/content-stream';
import { decodePageContent } from './pdf-content-stream-io';

export interface ToUnicodeSynthesisResult {
  fontsProcessed: number;
  fontsSkipped: number;
  codesMapped: number;
  puaFallback: number;
}

export interface ToUnicodeExtensionResult {
  fontsExtended: number;
  codesAdded: number;
}

// Simple (single-byte) font subtypes we can synthesise for. Type0/CIDFont use
// multi-byte codes + CIDToGID and are out of scope for v1 (they usually ship a
// ToUnicode already, or need CID-aware handling).
const SIMPLE_FONT_SUBTYPES = new Set(['/Type1', '/TrueType', '/MMType1', '/Type3']);

class FontToUnicodeService {
  /**
   * Add a /ToUnicode CMap to every simple font missing one. Mutates `doc`.
   */
  synthesizeToUnicode(doc: PDFDocument): ToUnicodeSynthesisResult {
    const result: ToUnicodeSynthesisResult = { fontsProcessed: 0, fontsSkipped: 0, codesMapped: 0, puaFallback: 0 };
    const seen = new Set<string>();

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue;

      const key = ref.toString();
      if (seen.has(key)) continue;
      seen.add(key);

      const subtype = obj.get(PDFName.of('Subtype'))?.toString();
      if (!subtype || !SIMPLE_FONT_SUBTYPES.has(subtype)) { result.fontsSkipped++; continue; }
      if (obj.has(PDFName.of('ToUnicode'))) { result.fontsSkipped++; continue; }

      const codeToUnicode = this.buildCodeMap(doc, obj, result);
      if (codeToUnicode.size === 0) { result.fontsSkipped++; continue; }

      const cmap = this.buildCMapStream(codeToUnicode);
      const streamRef = doc.context.register(doc.context.stream(cmap));
      obj.set(PDFName.of('ToUnicode'), streamRef);
      result.fontsProcessed++;
    }

    if (result.fontsProcessed > 0) {
      logger.info(
        `[FontToUnicode] synthesised ToUnicode for ${result.fontsProcessed} font(s) ` +
          `(${result.codesMapped} codes mapped, ${result.puaFallback} PUA fallback)`,
      );
    }
    return result;
  }

  /**
   * Extend an EXISTING (but incomplete) /ToUnicode CMap with entries for
   * codes the font's own /FontDescriptor /CharSet claims it can render, or
   * that the document's content streams actually render through it,
   * whichever its CMap doesn't already cover -- a genuinely different gap
   * from synthesizeToUnicode above, which only ever handles fonts with NO
   * CMap at all (explicitly skips any font that already has one).
   *
   * Real incident: pdfa11y's UA-10-002 ("/ToUnicode CMap exists but
   * doesn't cover every rendered code") fires for exactly this shape --
   * confirmed live on Math_Weir_PDF.pdf, font 'BOXDSW+MathematicalPiLTStd-4'
   * (page 295) has a code (0x61) its own CMap never mapped. An initial,
   * content-stream-usage-only version of this method (checked in, then
   * revised here) did NOT fix this real case: direct content-stream
   * tracing confirmed THIS SPECIFIC font object never actually shows 0x61
   * anywhere in the document -- its own /FirstChar=/LastChar=98 (only code
   * 98, 'b', is even nominally in range) -- yet the FontDescriptor's own
   * /CharSet lists a real glyph named "a" (PDF32000-1:2008 §9.8.1: CharSet
   * "shall list the character names of all glyphs present in the font
   * program, regardless of whether a glyph is referenced or used by the
   * PDF or not" -- Matterhorn 31-012's own message, confirmed to apply the
   * identical standard elsewhere in this same document). pdfa11y evidently
   * checks ToUnicode coverage against that DECLARED capability, not
   * against this specific document's actual usage -- so a usage-only scan
   * can never satisfy it for a font whose CharSet is broader than what's
   * actually shown. charSetClaimedCodes resolves each CharSet-listed name
   * to a byte code via this font's own Unicode-based encoding inference
   * (buildCodeMap), reusing the exact values it already computes rather
   * than re-deriving them -- combined additively with
   * findRenderedCodesByFont's own actual-usage scan (never REPLACING it:
   * a font whose CharSet is somehow incomplete or missing entirely must
   * still get fixed for whatever it demonstrably does render).
   *
   * Deliberately APPEND-only, never touching the existing CMap's own
   * entries: a symbol/math-Pi font's glyph names rarely resolve correctly
   * via the same Differences/base-encoding inference synthesizeToUnicode
   * uses for ordinary text -- REPLACING a font's already-correct (if
   * incomplete) mappings with our own algorithmic guess for ALL 256 codes
   * would very likely overwrite MORE correct mappings than it fixes.
   * Mutates `doc`.
   */
  extendPartialToUnicode(doc: PDFDocument): ToUnicodeExtensionResult {
    const result: ToUnicodeExtensionResult = { fontsExtended: 0, codesAdded: 0 };
    const renderedByFont = this.findRenderedCodesByFont(doc);
    const seen = new Set<string>();

    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue;

      const key = ref.toString();
      if (seen.has(key)) continue;
      seen.add(key);

      const subtype = obj.get(PDFName.of('Subtype'))?.toString();
      if (!subtype || !SIMPLE_FONT_SUBTYPES.has(subtype)) continue;

      const toUnicodeRaw = obj.get(PDFName.of('ToUnicode'));
      const toUnicodeRef = toUnicodeRaw instanceof PDFRef ? toUnicodeRaw : null;
      if (!toUnicodeRef) continue; // no existing CMap at all -- synthesizeToUnicode's own job, not this one

      const inferred = this.buildCodeMap(doc, obj, { fontsProcessed: 0, fontsSkipped: 0, codesMapped: 0, puaFallback: 0 });

      const candidates = new Set<number>(renderedByFont.get(key) ?? []);
      for (const code of this.charSetClaimedCodes(doc, obj, inferred)) candidates.add(code);
      if (candidates.size === 0) continue; // neither declared-capable nor actually shown -- nothing to check

      const stream = doc.context.lookup(toUnicodeRef);
      if (!(stream instanceof PDFRawStream)) continue;
      let existingText: string;
      try {
        existingText = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      } catch {
        continue; // unparseable existing CMap -- decline rather than guess
      }

      const covered = this.parseExistingCMapCodes(existingText);
      const missing = [...candidates].filter(code => !covered.has(code));
      if (missing.length === 0) continue;

      const additions = new Map<number, number>();
      for (const code of missing) {
        const cp = inferred.get(code);
        if (cp !== undefined) additions.set(code, cp);
      }
      if (additions.size === 0) continue;

      const extendedText = this.appendBfCharEntries(existingText, additions);
      if (extendedText === null) continue; // couldn't find a safe insertion point -- decline

      const newStream = doc.context.flateStream(Buffer.from(extendedText, 'latin1'));
      doc.context.assign(toUnicodeRef, newStream);
      result.fontsExtended++;
      result.codesAdded += additions.size;
    }

    if (result.fontsExtended > 0) {
      logger.info(
        `[FontToUnicode] extended ${result.fontsExtended} partial /ToUnicode CMap(s) ` +
          `(${result.codesAdded} code(s) added)`,
      );
    }
    return result;
  }

  /**
   * Parses a /ToUnicode CMap's own bfchar/bfrange blocks for single-byte
   * (0x00-0xFF) source codes it already covers -- used to avoid duplicating
   * or conflicting with an existing, presumably-correct mapping. Multi-byte
   * source codes (>0xFF, a CID-keyed/Type0 CMap shape) are ignored: this
   * module's whole scope (SIMPLE_FONT_SUBTYPES) is single-byte fonts only.
   */
  private parseExistingCMapCodes(cmapText: string): Set<number> {
    const covered = new Set<number>();
    const hexToNum = (h: string): number => parseInt(h, 16);

    for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]+>/g)) {
        if (pair[1].length <= 2) covered.add(hexToNum(pair[1]));
      }
    }
    for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
        if (range[1].length > 2 || range[2].length > 2) continue;
        const lo = hexToNum(range[1]);
        const hi = hexToNum(range[2]);
        if (hi < lo || hi - lo > 0xff) continue; // malformed/unexpectedly huge range -- ignore rather than loop forever
        for (let c = lo; c <= hi; c++) covered.add(c);
      }
    }
    return covered;
  }

  /**
   * Resolves a font's own /FontDescriptor /CharSet -- a string listing
   * every glyph name the EMBEDDED FONT PROGRAM actually contains
   * (PDF32000-1:2008 §9.8.1), independent of whether this specific
   * document's /Widths /FirstChar /LastChar range or content streams ever
   * reference them -- to the byte codes each name resolves to under this
   * font's own /Encoding.
   *
   * Reuses `inferred` (this font's own already-computed code->Unicode
   * table from buildCodeMap, built from the SAME /Differences/base-
   * encoding priority used everywhere else in this file) as a Unicode-
   * based reverse lookup, rather than building a second, separate
   * name-based encoding table: for each CharSet name, resolve its Unicode
   * value via the same AGL lookup (glyphNameToUnicode) already used for
   * /Differences names, then find which code `inferred` independently
   * computed that SAME Unicode value for. A name with no resolvable
   * Unicode (a font-specific/non-AGL name) or no matching code under this
   * font's own encoding is silently skipped, not guessed at -- the same
   * "bail rather than guess" discipline as the rest of this module. On the
   * rare chance two codes share one Unicode value under this encoding,
   * only the lower one is recorded here -- harmless, since whichever code
   * IS recorded still gets its own independently-correct `inferred` value
   * inserted, never a wrong one.
   */
  private charSetClaimedCodes(doc: PDFDocument, font: PDFDict, inferred: Map<number, number>): Set<number> {
    const claimed = new Set<number>();
    const fdRaw = font.get(PDFName.of('FontDescriptor'));
    const fd = fdRaw instanceof PDFRef ? doc.context.lookup(fdRaw) : fdRaw;
    if (!(fd instanceof PDFDict)) return claimed;

    let charSetRaw: unknown = fd.get(PDFName.of('CharSet'));
    if (charSetRaw instanceof PDFRef) charSetRaw = doc.context.lookup(charSetRaw);
    if (!(charSetRaw instanceof PDFString)) return claimed;

    const names = charSetRaw.decodeText().split('/').map(s => s.trim()).filter(s => s.length > 0 && s !== '.notdef');
    if (names.length === 0) return claimed;

    const unicodeToCode = new Map<number, number>();
    for (const [code, cp] of inferred) {
      if (!unicodeToCode.has(cp)) unicodeToCode.set(cp, code);
    }

    for (const name of names) {
      const cp = glyphNameToUnicode(name);
      if (cp === undefined) continue;
      const code = unicodeToCode.get(cp);
      if (code !== undefined) claimed.add(code);
    }
    return claimed;
  }

  /**
   * Inserts a new `N beginbfchar ... endbfchar` block (containing exactly
   * `additions`) right before the CMap's own `endcmap`, leaving every
   * existing byte of `cmapText` untouched -- append-only, matching
   * extendPartialToUnicode's own "never touch existing entries" contract.
   * Returns null if `endcmap` can't be found (an unrecognized/malformed
   * CMap shape) rather than guessing an insertion point.
   */
  private appendBfCharEntries(cmapText: string, additions: Map<number, number>): string | null {
    const idx = cmapText.lastIndexOf('endcmap');
    if (idx === -1) return null;
    const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
    const utf16be = (cp: number): string => {
      if (cp <= 0xffff) return cp.toString(16).padStart(4, '0');
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      return hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
    };
    const lines = [`${additions.size} beginbfchar`];
    for (const [code, cp] of [...additions.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`<${hex2(code)}> <${utf16be(cp)}>`);
    }
    lines.push('endbfchar', '');
    return cmapText.slice(0, idx) + lines.join('\n') + cmapText.slice(idx);
  }

  /**
   * Walks every page's content stream, tracking the active font (via Tf,
   * resolved to the font object's own indirect-reference key through the
   * page's /Resources /Font dict) and collecting the single-byte codes
   * each Tj/TJ/'/" actually shows while that font is selected. Powers
   * extendPartialToUnicode's own "does this font's existing CMap cover
   * everything it's actually used for" check -- content-stream usage is
   * the only reliable source of truth for that; a font's own glyph set
   * can be far larger than what a specific document actually renders.
   */
  private findRenderedCodesByFont(doc: PDFDocument): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>();
    const pageCount = doc.getPageCount();

    for (let i = 0; i < pageCount; i++) {
      const page = doc.getPage(i);
      const resources = page.node.Resources();
      const fontDictRaw = resources?.get(PDFName.of('Font'));
      const fontDict = fontDictRaw instanceof PDFRef ? doc.context.lookup(fontDictRaw) : fontDictRaw;
      if (!(fontDict instanceof PDFDict)) continue;

      const content = decodePageContent(doc, i + 1);
      if (content === null) continue;

      const tokens = tokenize(content);
      let currentFontKey: string | null = null;
      const operands: Array<{ t: string; v: string }> = [];

      for (const tk of tokens) {
        if (tk.t !== 'op') { operands.push(tk); continue; }
        if (tk.v === 'Tf') {
          const nameTok = operands[operands.length - 2];
          if (nameTok && nameTok.t === 'name') {
            const fontEntry = fontDict.get(PDFName.of(nameTok.v.replace(/^\//, '')));
            currentFontKey = fontEntry instanceof PDFRef ? fontEntry.toString() : null;
          } else {
            currentFontKey = null;
          }
        } else if ((tk.v === 'Tj' || tk.v === "'" || tk.v === '"') && currentFontKey) {
          const strTok = operands[operands.length - 1];
          if (strTok) this.collectStringCodes(strTok, result, currentFontKey);
        } else if (tk.v === 'TJ' && currentFontKey) {
          // Every string element inside the array is shown text; numbers
          // are kerning-only adjustments. tokenize() emits '[' / ']' as
          // their own token types (not 'op'), so the array's contents
          // accumulate into `operands` just like any other operator's own
          // operands would.
          for (const el of operands) {
            if (el.t === 's' || el.t === 'h') this.collectStringCodes(el, result, currentFontKey);
          }
        }
        operands.length = 0;
      }
    }
    return result;
  }

  private collectStringCodes(tok: { t: string; v: string }, result: Map<string, Set<number>>, fontKey: string): void {
    const bytes = tok.t === 'h' ? this.decodeHexStringBytes(tok.v) : this.decodeLiteralStringBytes(tok.v);
    if (bytes.length === 0) return;
    let set = result.get(fontKey);
    if (!set) { set = new Set(); result.set(fontKey, set); }
    for (const b of bytes) set.add(b);
  }

  /** Decodes a hex string token's raw source (e.g. "<4142>") to its byte values -- an odd trailing digit is padded with an implicit 0, per PDF32000-1:2008 §7.3.4.3. */
  private decodeHexStringBytes(raw: string): number[] {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    if (hex.length % 2 === 1) bytes.push(parseInt(hex[hex.length - 1] + '0', 16));
    return bytes;
  }

  /**
   * Decodes a literal string token's raw source (e.g. "(He\\)llo)") to its
   * byte values -- each unescaped char is already exactly one byte (this
   * whole subsystem works in latin1 space, 1:1 byte<->char), and PDF's own
   * escape sequences (PDF32000-1:2008 §7.3.4.2) are resolved to their real
   * byte value rather than left as literal backslash+char pairs.
   */
  private decodeLiteralStringBytes(raw: string): number[] {
    const inner = raw.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c !== '\\') { bytes.push(inner.charCodeAt(i) & 0xff); continue; }
      const next = inner[i + 1];
      if (next === undefined) break;
      if (next === '\n') { i++; continue; }
      if (next === '\r') { i++; if (inner[i + 1] === '\n') i++; continue; }
      const simple: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c, '(': 0x28, ')': 0x29, '\\': 0x5c };
      if (next in simple) { bytes.push(simple[next]); i++; continue; }
      if (next >= '0' && next <= '7') {
        let oct = next; i++;
        for (let k = 0; k < 2 && inner[i + 1] >= '0' && inner[i + 1] <= '7'; k++) { i++; oct += inner[i]; }
        bytes.push(parseInt(oct, 8) & 0xff);
        continue;
      }
      bytes.push(next.charCodeAt(0) & 0xff);
      i++;
    }
    return bytes;
  }

  /**
   * Build code (0–255) → Unicode for one simple font, from its /Encoding.
   * Every code that could be shown gets a value (real or PUA) so no used glyph
   * is left unmapped.
   */
  private buildCodeMap(doc: PDFDocument, font: PDFDict, result: ToUnicodeSynthesisResult): Map<number, number> {
    const { baseName, differences } = this.readEncoding(doc, font);
    // Base code→Unicode table. When /Encoding is absent, a nonsymbolic simple
    // font defaults to StandardEncoding; symbolic or unknown fonts have no
    // knowable base encoding → codes without a /Differences override use PUA.
    const base =
      baseEncodingTable(baseName) ??
      (baseName === undefined && this.isNonsymbolic(doc, font) ? baseEncodingTable('/StandardEncoding') : undefined);

    const map = new Map<number, number>();
    for (let code = 0; code <= 0xff; code++) {
      let cp: number | undefined;

      if (differences.has(code)) {
        // An explicit /Differences override is authoritative — never fall back
        // to the base encoding, even when the glyph name can't be resolved.
        cp = glyphNameToUnicode(differences.get(code)!);
      } else if (base) {
        const v = base[code];
        if (v && isValidScalar(v)) cp = v;
      }

      // PUA fallback — guarantees toUnicode != null for any glyph veraPDF sees
      if (cp === undefined || !isValidScalar(cp)) {
        cp = 0xe000 + code;
        result.puaFallback++;
      } else {
        result.codesMapped++;
      }
      map.set(code, cp);
    }
    return map;
  }

  /** True when the font's descriptor marks it Nonsymbolic (and not Symbolic). */
  private isNonsymbolic(doc: PDFDocument, font: PDFDict): boolean {
    const fdRaw = font.get(PDFName.of('FontDescriptor'));
    const fd = fdRaw instanceof PDFRef ? doc.context.lookup(fdRaw) : fdRaw;
    if (!(fd instanceof PDFDict)) return false; // unknown → treat as symbolic (safe: PUA)
    const flags = fd.get(PDFName.of('Flags'));
    if (!(flags instanceof PDFNumber)) return false;
    const f = flags.asNumber();
    const SYMBOLIC = 1 << 2; // bit 3
    const NONSYMBOLIC = 1 << 5; // bit 6
    return (f & NONSYMBOLIC) !== 0 && (f & SYMBOLIC) === 0;
  }

  /** Read a font's base encoding name and /Differences (code → glyph name). */
  private readEncoding(doc: PDFDocument, font: PDFDict): { baseName?: string; differences: Map<number, string> } {
    const differences = new Map<number, string>();
    let encRaw = font.get(PDFName.of('Encoding'));
    if (encRaw instanceof PDFRef) encRaw = doc.context.lookup(encRaw);

    if (encRaw instanceof PDFName) {
      return { baseName: encRaw.toString(), differences };
    }
    if (encRaw instanceof PDFDict) {
      const base = encRaw.get(PDFName.of('BaseEncoding'));
      const diffs = encRaw.get(PDFName.of('Differences'));
      const diffArr = diffs instanceof PDFRef ? doc.context.lookup(diffs) : diffs;
      if (diffArr instanceof PDFArray) {
        let current = 0;
        for (const item of diffArr.asArray()) {
          if (item instanceof PDFNumber) current = item.asNumber();
          else if (item instanceof PDFName) differences.set(current++, item.decodeText().replace(/^\//, ''));
        }
      }
      return { baseName: base instanceof PDFName ? base.toString() : undefined, differences };
    }
    return { differences };
  }

  /** Emit a CMap program mapping single-byte codes to UTF-16BE Unicode. */
  private buildCMapStream(map: Map<number, number>): string {
    const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
    // UTF-16BE: BMP as one code unit, astral (> U+FFFF) as a surrogate pair.
    const utf16be = (cp: number): string => {
      if (cp <= 0xffff) return cp.toString(16).padStart(4, '0');
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      return hi.toString(16).padStart(4, '0') + lo.toString(16).padStart(4, '0');
    };
    const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);

    const lines: string[] = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<00> <ff>',
      'endcodespacerange',
    ];
    // bfchar blocks: max 100 entries each per the CMap spec
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const [code, cp] of chunk) lines.push(`<${hex2(code)}> <${utf16be(cp)}>`);
      lines.push('endbfchar');
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    return lines.join('\n');
  }
}

export const fontToUnicodeService = new FontToUnicodeService();
