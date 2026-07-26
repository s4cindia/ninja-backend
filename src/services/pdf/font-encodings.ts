/**
 * Minimal font-encoding data for ToUnicode synthesis (font-tounicode.service).
 *
 * - WINANSI_CODE_TO_UNICODE: WinAnsiEncoding (≈ CP1252) code → Unicode. Undefined
 *   entries (control / unassigned) fall through to the PUA fallback.
 * - glyphNameToUnicode: Adobe-Glyph-List resolution for /Differences names —
 *   algorithmic uniXXXX / uXXXXXX first, then a compact AGL subset.
 *
 * Deliberately dependency-free (no fontkit): standard text resolves correctly;
 * anything unknown returns undefined so the caller applies a PUA fallback.
 */

// ── WinAnsiEncoding (CP1252) code → Unicode ────────────────────────────────
const winAnsi: number[] = new Array(256).fill(0);
// 0x20–0x7E: ASCII identity
for (let c = 0x20; c <= 0x7e; c++) winAnsi[c] = c;
// 0xA0–0xFF: Latin-1 identity
for (let c = 0xa0; c <= 0xff; c++) winAnsi[c] = c;
// 0x80–0x9F: CP1252 specials (0 = unassigned → PUA fallback)
Object.assign(winAnsi, {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
});

/** WinAnsiEncoding code (0–255) → Unicode, or 0 where unassigned. */
export const WINANSI_CODE_TO_UNICODE: readonly number[] = winAnsi;

// ── Compact Adobe Glyph List (names used by standard encodings/Differences) ──
const AGL: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28, parenright: 0x29,
  asterisk: 0x2a, plus: 0x2b, comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f,
  zero: 0x30, one: 0x31, two: 0x32, three: 0x33, four: 0x34, five: 0x35, six: 0x36,
  seven: 0x37, eight: 0x38, nine: 0x39, colon: 0x3a, semicolon: 0x3b, less: 0x3c,
  equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40, bracketleft: 0x5b,
  backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f, grave: 0x60,
  braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  // typography / punctuation
  quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c, quotedblright: 0x201d,
  quotesinglbase: 0x201a, quotedblbase: 0x201e, bullet: 0x2022, endash: 0x2013,
  emdash: 0x2014, dagger: 0x2020, daggerdbl: 0x2021, ellipsis: 0x2026, perthousand: 0x2030,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, guillemotleft: 0xab, guillemotright: 0xbb,
  florin: 0x0192, trademark: 0x2122, degree: 0xb0, minus: 0x2212, periodcentered: 0xb7,
  fraction: 0x2044, currency: 0xa4, section: 0xa7, paragraph: 0xb6, copyright: 0xa9,
  registered: 0xae, cent: 0xa2, sterling: 0xa3, yen: 0xa5, euro: 0x20ac,
  // ligatures
  fi: 0xfb01, fl: 0xfb00 + 2, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04,
  // common accents (spacing)
  circumflex: 0x02c6, tilde: 0x02dc, macron: 0xaf, breve: 0x02d8, dotaccent: 0x02d9,
  dieresis: 0xa8, ring: 0x02da, cedilla: 0xb8, hungarumlaut: 0x02dd, ogonek: 0x02db,
  caron: 0x02c7, acute: 0xb4,
};

/**
 * Resolve a glyph name to a Unicode codepoint, or undefined if unknown.
 * Order: algorithmic uniXXXX / uXXXXXX → single-char ASCII name → AGL subset.
 */
export function glyphNameToUnicode(name: string): number | undefined {
  if (!name) return undefined;
  // strip a common suffix like "A.sc" / "one.oldstyle"
  const base = name.split('.')[0];

  const uni = base.match(/^uni([0-9A-Fa-f]{4})$/);
  if (uni) return parseInt(uni[1], 16);
  const u = base.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (u) return parseInt(u[1], 16);

  // single printable-ASCII character name (e.g. "A", "z")
  if (base.length === 1) {
    const cc = base.charCodeAt(0);
    if (cc >= 0x21 && cc <= 0x7e) return cc;
  }

  return AGL[base];
}
