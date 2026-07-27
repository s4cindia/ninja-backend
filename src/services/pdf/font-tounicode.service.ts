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

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { baseEncodingTable, glyphNameToUnicode, isValidScalar } from './font-encodings';

export interface ToUnicodeSynthesisResult {
  fontsProcessed: number;
  fontsSkipped: number;
  codesMapped: number;
  puaFallback: number;
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
