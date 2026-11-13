/**
 * LINK-MISSING-ANNOTATION fix (Matterhorn 28-011) -- pure, testable core.
 *
 * pdf-link-completeness.validator.ts finds URL-shaped PLAIN TEXT with no
 * underlying Link annotation at all (see that file's own doc comment --
 * Curiel_187961_CSHP.pdf has zero /Annots anywhere, despite ~200 reference-
 * list citation URLs rendered as ordinary prose). Fixing this means
 * creating a real /Link annotation plus a matching /Link structure element
 * around just the URL's own text -- but that text is already part of an
 * ordinary, already-tagged paragraph (confirmed live: a whole reference
 * list is routinely ONE /P with ONE MCID covering every citation on the
 * page), so the fix has to carve the URL's own content-stream bytes out of
 * that shared MCID without disturbing the surrounding citation prose on
 * either side.
 *
 * Real risk this module exists to avoid: a naive approach would need to
 * cut a Tj/TJ string operand MID-CHARACTER, which requires font-encoding
 * awareness (simple vs CID) to get the byte offset right -- get it wrong
 * and you corrupt the REMAINING text too, not just fail to fix the link.
 *
 * CORRECTION (2026-11-06, after a full-document sweep against the real
 * Curiel_187961_CSHP.pdf's own 209 real LINK-MISSING-ANNOTATION issues --
 * superseding an earlier, overconfident version of this comment that
 * generalized from only 3 hand-picked pages): the URL arrives as its own
 * CLEAN run of text-show operators -- no other prose sharing an operator
 * with it -- in 135/209 (64.6%) of real cases. That's genuinely this
 * module's whole addressable scope; findUrlOperatorRun deliberately
 * DECLINES the other two real buckets rather than guess:
 *   - 63/209 (30.1%): the URL shares its own Tj/TJ operand with a short
 *     lead-in phrase before it (seen live: "Retrieved from ", an org name,
 *     a sentence fragment -- MAX_LEFTOVER_CHARS=8 is a hard scope boundary
 *     here, not a safety margin with room to spare) or, rarely, trailing
 *     text after it. Fixing these needs an actual mid-string cut with
 *     font-encoding awareness -- the exact risk this module exists to
 *     avoid -- and is tracked as a separate, harder follow-on, not part of
 *     this module's job.
 *   - 11/209 (5.3%): not found at all even with no leftover cap and a
 *     20-operator window -- UPDATE (2026-11-06): root-caused, not a
 *     genuinely different shape after all. Every one of these 11 URLs
 *     contains a typographic ligature (fi, fl, ff, Th) that this
 *     document's own embedded Type1 subset fonts encode as a custom
 *     single-byte glyph code (standard PDF subsetting) -- decodeTextShowOperands's
 *     own GlyphTextResolver parameter now resolves these correctly via
 *     each font's real /ToUnicode CMap. Confirmed this closes 7/11 of
 *     these cases outright; the other 4 have a SECOND, independent
 *     problem on top (the same MAX_LEFTOVER_CHARS-exceeding shape as the
 *     30.1% bucket above) -- genuinely needs the same-operand splitter
 *     follow-on too, not a gap in the ligature fix itself.
 *
 * The three shapes below are real (still live-confirmed), but are examples
 * of the 64.6% CLEAN bucket specifically, not a representative sample of
 * all 209:
 *
 *   page 85:  [32] Tj " "  [33] TJ "https://endeavors.org/.../help"  [34] Tj " "  [35] TJ "-someone"
 *   page 102: [16] TJ " Canadian "  [17] TJ "...Society. https://kidsnewtocanada.ca/..."
 *   page 4:   [6] TJ "M5S 2V6"  [7] TJ "www.canadianscholars.ca"  [8] TJ "Copyright..."
 *
 * So the real operation this module provides is OPERATOR-boundary
 * splitting (the same granularity findRealTextSegmentsInSpan already
 * works at, just with a different "is this segment real" predicate), not
 * character-level string splitting. findUrlOperatorRun below tolerates a
 * small amount of non-URL text sharing an operator with the URL itself
 * (page 102's ". " prefix) rather than ever needing a mid-string cut --
 * but only up to MAX_LEFTOVER_CHARS, past which it declines rather than
 * guess.
 */

import { tokenize } from '../zone-extractor/seam-c/content-stream';

type Token = ReturnType<typeof tokenize>[number];

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/**
 * Minimal PDF string-literal decoder: `(escaped text)` or `<hex>` to a JS
 * string of RAW BYTES (each char code 0-255 is one PDF byte, NOT yet a
 * final Unicode character) -- resolving octal escapes and hex nibbles is
 * this function's whole job; mapping a byte to real text is a SEPARATE,
 * font-dependent step (see decodeTextShowOperands's own GlyphTextResolver
 * parameter below). Deliberately local, not shared with pdf-artifact-
 * tagger.ts's own copy -- that one lives in a module about a different
 * concern (artifact spans), and duplicating ~15 lines here is cheaper than
 * coupling the two.
 *
 * CORRECTION (2026-11-06): an earlier version of this comment claimed
 * treating each raw byte as its own Latin-1 character was "correct for the
 * simple/WinAnsi-encoded body text this targets" -- wrong, confirmed live:
 * Curiel_187961_CSHP.pdf's own embedded Type1 fonts encode typographic
 * ligatures (fi, fl, ff, Th) as custom single-byte glyph codes (standard
 * PDF subsetting), which a raw-byte-as-Latin-1 assumption decodes as a
 * control character instead of the real 2-letter text -- confirmed as the
 * exact cause of 11/209 of Curiel's own real LINK-MISSING-ANNOTATION
 * issues being "not found at all" rather than correctly located (the URL
 * genuinely exists on the page; the decode of it was just wrong). See
 * decodeTextShowOperands's own GlyphTextResolver parameter for the fix.
 */
/**
 * One decoded PDF byte, plus the exact span within the literal's own RAW
 * SOURCE TEXT (the full `(...)` or `<...>` token as it appears in the
 * content stream, delimiters included -- same string `decodePdfStringLiteral`
 * itself takes) that produced it. Built for the same-operand URL splitter's
 * own real need: given a target position in the literal's DECODED text,
 * find the exact byte offset in the ORIGINAL content stream to cut at --
 * not possible from decoded text alone once a byte can expand to more than
 * one character (a ligature; see decodeTextShowOperands's own
 * GlyphTextResolver). Checkpoint-only for now: built and unit-tested in
 * isolation, not yet wired into any splitting logic.
 */
export interface DecodedByte {
  /** This byte's own raw value (0-255). */
  byte: number;
  /** Offset where this byte's own escape sequence (or lone character, or hex-digit pair) begins within the literal's raw source text. */
  sourceStart: number;
  /** Offset right after that same escape sequence/character/hex pair. */
  sourceEnd: number;
}

/**
 * Same decoding rules as decodePdfStringLiteral (this function now backs
 * it directly -- see that function's own doc comment for the full PDF-
 * syntax rationale), but keeps each output byte's own source-text span
 * instead of discarding it. A PDF string-literal escape never produces
 * more than one byte, EXCEPT a line continuation (`\` followed directly by
 * a newline or CR), which produces none at all -- correctly skipped here,
 * same as the original.
 */
export function decodePdfStringLiteralBytes(raw: string): DecodedByte[] {
  const out: DecodedByte[] = [];
  if (raw.startsWith('(')) {
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[i + 1];
        const octal = /[0-7]/;
        if (octal.test(next)) {
          let oct = next;
          let j = i + 2;
          for (let k = 0; k < 2 && octal.test(raw[j] ?? ''); k++, j++) oct += raw[j];
          out.push({ byte: parseInt(oct, 8) & 0xff, sourceStart: i, sourceEnd: j });
          i = j - 1;
        } else if (next === 'n') { out.push({ byte: 0x0a, sourceStart: i, sourceEnd: i + 2 }); i++; }
        else if (next === 'r') { out.push({ byte: 0x0d, sourceStart: i, sourceEnd: i + 2 }); i++; }
        else if (next === 't') { out.push({ byte: 0x09, sourceStart: i, sourceEnd: i + 2 }); i++; }
        else if (next === '\n' || next === '\r') { i++; } // line continuation, no byte at all
        else { out.push({ byte: next.charCodeAt(0) & 0xff, sourceStart: i, sourceEnd: i + 2 }); i++; }
      } else {
        out.push({ byte: ch.charCodeAt(0) & 0xff, sourceStart: i, sourceEnd: i + 1 });
      }
    }
    return out;
  }
  if (raw.startsWith('<')) {
    // Collect hex-digit positions individually (not a stripped copy) so a
    // pair's own sourceStart/sourceEnd stay correct in the ORIGINAL text
    // even when whitespace sits between or around digits -- legal PDF hex-
    // string syntax, confirmed by decodePdfStringLiteral's own pre-existing
    // whitespace-stripping (now reproduced here per-digit instead of via a
    // single stripped copy, which would have discarded this mapping).
    const digitPositions: number[] = [];
    for (let i = 1; i < raw.length - 1; i++) {
      if (/[0-9a-fA-F]/.test(raw[i])) digitPositions.push(i);
    }
    for (let k = 0; k + 1 < digitPositions.length; k += 2) {
      const hi = digitPositions[k];
      const lo = digitPositions[k + 1];
      const byte = parseInt(raw[hi] + raw[lo], 16);
      out.push({ byte, sourceStart: hi, sourceEnd: lo + 1 });
    }
    return out;
  }
  return out;
}

function decodePdfStringLiteral(raw: string): string {
  return decodePdfStringLiteralBytes(raw).map((b) => String.fromCharCode(b.byte)).join('');
}

/**
 * Resolves a single PDF byte code (0-255), under a given font's own
 * resource-dictionary tag name (the same name a `Tf` operator references,
 * e.g. "/T1_2"), to its real decoded text -- one or more characters, since
 * a single glyph code can represent a multi-character ligature (e.g. "fi").
 * Returns null when the font has no usable /ToUnicode CMap, or the code
 * isn't covered by it -- callers fall back to the raw byte's own Latin-1
 * interpretation in that case (today's existing behavior, unchanged for
 * any font that doesn't need this). Built by pdf-structure-writer.
 * service.ts's own buildGlyphTextResolver (which needs a real PDFDocument
 * to resolve Resources/Font/ToUnicode -- this module stays pdf-lib-free by
 * design, same as mcid-bounding-box.ts's own resolveFormXObject convention,
 * so the caller owns the actual lookup and hands in only this function).
 */
export type GlyphTextResolver = (fontTag: string, byteCode: number) => string | null;

function applyGlyphResolver(rawBytes: string, fontTag: string | null, resolveGlyphText?: GlyphTextResolver): string {
  if (!resolveGlyphText || !fontTag) return rawBytes;
  let out = '';
  for (let i = 0; i < rawBytes.length; i++) {
    const resolved = resolveGlyphText(fontTag, rawBytes.charCodeAt(i));
    out += resolved ?? rawBytes[i];
  }
  return out;
}

function decodeTextShowOperands(operands: Token[], fontTag: string | null, resolveGlyphText?: GlyphTextResolver): string {
  // tokenize() types a parenthesized literal 's' and a hex string '<...>'
  // 'h' -- both are valid PDF string operands to Tj/TJ/'/", and
  // decodePdfStringLiteral already branches on the leading delimiter to
  // decode either; the filter must accept both or hex-encoded operands
  // (common for a CID/Type0 font) silently vanish instead of decoding.
  const rawBytes = operands
    .filter((o) => o.t === 's' || o.t === 'h')
    .map((o) => decodePdfStringLiteral(o.v))
    .join('');
  return applyGlyphResolver(rawBytes, fontTag, resolveGlyphText);
}

/**
 * One character of a literal's FINAL decoded text, plus which raw byte
 * (an index into the same DecodedByte[] the literal's own
 * decodePdfStringLiteralBytes produced) is responsible for it. A single
 * byte can produce MULTIPLE consecutive ResolvedChar entries sharing the
 * same byteIndex -- exactly a multi-character ligature (e.g. a byte
 * resolving to "fi" produces two entries, both byteIndex N). That shared-
 * byteIndex run is the whole reason findSafeCutPoint below exists: a
 * target position landing strictly INSIDE one of these runs has no valid
 * byte offset to cut at.
 */
export interface ResolvedChar {
  char: string;
  byteIndex: number;
}

/**
 * Resolves a literal's own raw bytes (from decodePdfStringLiteralBytes) to
 * its final decoded characters, same per-byte resolution
 * decodeTextShowOperands/applyGlyphResolver already use (a GlyphTextResolver
 * hit can expand to more than one character; a miss, or no resolver/font at
 * all, falls back to that byte's own Latin-1 character) -- but keeping each
 * resulting character's own origin byte instead of just concatenating text.
 */
export function resolveBytesToChars(bytes: DecodedByte[], fontTag: string | null, resolveGlyphText?: GlyphTextResolver): ResolvedChar[] {
  const out: ResolvedChar[] = [];
  bytes.forEach((b, byteIndex) => {
    const resolved = fontTag && resolveGlyphText ? resolveGlyphText(fontTag, b.byte) : null;
    const text = resolved ?? String.fromCharCode(b.byte);
    for (const ch of text) out.push({ char: ch, byteIndex });
  });
  return out;
}

/**
 * The same-operand URL splitter's own real core need: given a literal's
 * own raw bytes and resolved characters (both for the SAME literal, same
 * order), find the exact offset within that literal's RAW SOURCE TEXT
 * (decodePdfStringLiteralBytes's own sourceStart/sourceEnd convention --
 * still relative to the literal's own token text, NOT yet an absolute
 * content-stream offset; the caller adds the token's own start) where a
 * cut immediately BEFORE decoded-character position `decodedIndex` would
 * land -- i.e. slicing the literal's raw source at this offset reproduces
 * exactly the first `decodedIndex` decoded characters on one side and
 * exactly the rest on the other, with no byte left ambiguously split
 * between them.
 *
 * Returns null when `decodedIndex` falls strictly inside one byte's own
 * multi-character resolution (a ligature) -- there is no source offset
 * that could split "fi" into "f" and "i" at the byte level; callers must
 * decline rather than guess which half of the ligature glyph to keep, same
 * "decline rather than guess" convention as findUrlOperatorRun's own
 * MAX_LEFTOVER_CHARS cap.
 *
 * `decodedIndex` may equal 0 (cut before everything) or
 * `resolvedChars.length` (cut after everything) -- both always safe,
 * landing on the literal's own outer source bounds.
 */
export function findSafeCutPoint(bytes: DecodedByte[], resolvedChars: ResolvedChar[], decodedIndex: number): number | null {
  if (decodedIndex <= 0) return bytes[0]?.sourceStart ?? null;
  if (decodedIndex >= resolvedChars.length) return bytes[bytes.length - 1]?.sourceEnd ?? null;
  const before = resolvedChars[decodedIndex - 1];
  const at = resolvedChars[decodedIndex];
  if (before.byteIndex === at.byteIndex) return null; // mid-ligature -- unsafe, decline
  return bytes[at.byteIndex].sourceStart;
}

export interface UrlOperatorRun {
  /** Byte offset where the matched run's first operator begins. */
  start: number;
  /** Byte offset right after the matched run's last operator. */
  end: number;
  /** Concatenated decoded text of every operator in the matched run. */
  matchedText: string;
}

/**
 * At most this many non-URL characters, combined across the run's own
 * leading and trailing edge, may share an operator with the URL itself
 * (real, live cases: page 102's ". " prefix, a stray trailing space) --
 * past this, including the whole operator would sweep in real, unrelated
 * prose alongside the URL, which is exactly the "decline rather than
 * guess" line every other fixer in this codebase already draws.
 */
const MAX_LEFTOVER_CHARS = 8;

/** At most this many consecutive text-show operators are considered one
 *  candidate run -- real URLs here span at most 2-3 (a kerning gap, a
 *  hyphen-continuation); anything longer is far more likely a coincidental
 *  textual match than a genuine multi-operator URL. */
const MAX_RUN_OPERATORS = 5;

/**
 * Finds the shortest run of consecutive Tj/TJ/'/" operators within
 * [rangeStart, rangeEnd) whose concatenated decoded text contains
 * targetUrl, tolerating at most MAX_LEFTOVER_CHARS of non-URL text shared
 * with the run's own edge operators. Returns null when no run matches
 * this closely -- callers should treat that as "decline, don't guess,"
 * not retry with a looser threshold.
 */
// Any of these between two text-show operators means they are NOT the same
// visual run -- Tm is an absolute matrix (always a real jump), Td/TD/T* move
// the text position (T* always means "next line"; Td/TD could in principle
// be a same-line kern, but telling that apart from a real newline would mean
// parsing its own Y operand and trusting it, which is more precision than
// this needs). Real, live-confirmed bug this guards against: without it,
// "M5S 2V6" (an address's postal code, its own line) and "www.canadianscholars.ca"
// (the URL, the very next line) are adjacent TEXT-SHOW operators with nothing
// else text-show-shaped between them, so a naive scan merges them into one
// run and reports "M5S 2V6www.canadianscholars.ca" as the match -- sweeping
// an entire unrelated line into the new Link's own extent. Treating any of
// these as a hard stop is the same "decline rather than guess" direction the
// validator's own doc comment already commits to for line-wrapped URLs.
const LINE_BREAK_OPS = new Set(['Td', 'TD', 'T*', 'Tm', 'BT', 'ET']);

// Tracks the most recently seen `Tf` operand (the font's own resource-
// dictionary tag name, e.g. "/T1_2") so each text-show operator's own
// decode can be resolved under the RIGHT font -- a document routinely
// switches fonts mid-paragraph (e.g. Regular vs Italic for an inline
// citation), and the two can use entirely different byte-code assignments
// for the same ligature (confirmed live: Curiel_187961_CSHP.pdf's own
// ACaslonPro-Regular and ACaslonPro-Italic subsets assign DIFFERENT byte
// codes to the same "ff" ligature -- each subsetted font gets its own
// independent encoding, so there is no fixed, reusable code->text table;
// resolution must always go through the SPECIFIC font active at that
// exact position). Deliberately NOT reset on a line break (BT/ET
// included) -- a font selection persists until the next real `Tf`, same
// as real PDF semantics; only known, accepted gap: if `rangeStart` is not
// 0, a `Tf` that appeared BEFORE rangeStart is invisible to this scan, so
// `currentFontTag` starts null even if a font really is active -- harmless
// today since this function's only real caller always passes the whole
// page (rangeStart=0), so there's nothing before rangeStart to miss.
const FONT_SELECT_OP = 'Tf';

export function findUrlOperatorRun(
  content: string,
  rangeStart: number,
  rangeEnd: number,
  targetUrl: string,
  resolveGlyphText?: GlyphTextResolver
): UrlOperatorRun | null {
  if (!targetUrl) return null;
  const tokens = tokenize(content.slice(rangeStart, rangeEnd));

  interface Op { start: number; end: number; text: string; precededByLineBreak: boolean }
  const ops: Op[] = [];
  const operands: Token[] = [];
  let sawLineBreakSinceLastShow = false;
  let currentFontTag: string | null = null;
  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    if (TEXT_SHOW_OPS.has(tk.v)) {
      const text = decodeTextShowOperands(operands, currentFontTag, resolveGlyphText);
      const opStart = operands.length ? operands[0].start : tk.start;
      ops.push({ start: rangeStart + opStart, end: rangeStart + tk.end, text, precededByLineBreak: sawLineBreakSinceLastShow });
      sawLineBreakSinceLastShow = false;
    } else if (LINE_BREAK_OPS.has(tk.v)) {
      sawLineBreakSinceLastShow = true;
    } else if (tk.v === FONT_SELECT_OP) {
      currentFontTag = operands[0]?.t === 'name' ? operands[0].v : currentFontTag;
    }
    operands.length = 0;
  }

  for (let i = 0; i < ops.length; i++) {
    let concatenated = '';
    for (let j = i; j < Math.min(ops.length, i + MAX_RUN_OPERATORS); j++) {
      if (j > i && ops[j].precededByLineBreak) break; // hard stop -- don't merge across a line boundary
      concatenated += ops[j].text;
      const idx = concatenated.indexOf(targetUrl);
      if (idx === -1) continue;
      const leading = idx;
      const trailing = concatenated.length - idx - targetUrl.length;
      if (leading + trailing > MAX_LEFTOVER_CHARS) break; // this run already too loose; shorter j won't help, longer j only adds more leftover
      return { start: ops[i].start, end: ops[j].end, matchedText: concatenated };
    }
  }
  return null;
}

export interface EnclosingTagSpan {
  /** Structure tag name without the leading slash, e.g. "P", "Span", "Artifact". */
  tag: string;
  /**
   * This span's own existing MCID, captured the same way
   * mcid-bounding-box.ts's own lastClosedDict technique does (an inline
   * `<</MCID n>>` properties dict immediately preceding the BDC that
   * consumes it, paired positionally by token index). null for a /Artifact
   * span (which never needs one, since Artifact content is outside the
   * structure tree) or any other tag opened with a bare BMC.
   */
  mcid: number | null;
  /** Offset right after this span's own opening BDC/BMC operator. */
  contentStart: number;
  /** Offset of this span's own matching EMC operator. */
  closeOpStart: number;
  /** Offset right after that EMC. */
  closeOpEnd: number;
}

/**
 * The INNERMOST marked-content tag whose BDC/BMC...EMC span encloses
 * `position` -- the same span a findUrlOperatorRun match sits inside,
 * used to find exactly what has to be split to carve the URL's own run out
 * of it. Mirrors pdf-structure-writer.service.ts's own
 * findOutermostRealTagBounds (same token-walking shape: detect the target
 * frame the instant a token reaches `position`, return when that exact
 * frame's own EMC closes), but targets the DEEPEST open frame instead of
 * the outermost non-Artifact one, and captures the frame's own MCID too --
 * neither of which that function's own callers need.
 */
export function findEnclosingTagSpan(content: string, position: number): EnclosingTagSpan | null {
  const tokens = tokenize(content);
  interface Frame { tag: string; mcid: number | null; contentStart: number }
  const stack: Frame[] = [];
  const operands: string[] = [];
  let dictDepth = 0;
  let dictTokens: Token[] = [];
  let lastClosedDict: { closeTokenIndex: number; mcid: number | null } | null = null;
  let target: (Frame & { stackIndex: number }) | null = null;

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (dictDepth > 0) {
      if (tk.t === '<<') dictDepth++;
      else if (tk.t === '>>') {
        dictDepth--;
        if (dictDepth === 0) {
          let mcid: number | null = null;
          for (let i = 0; i < dictTokens.length - 1; i++) {
            if (dictTokens[i].t === 'name' && dictTokens[i].v === '/MCID' && dictTokens[i + 1].t === 'n') {
              mcid = parseInt(dictTokens[i + 1].v, 10);
              break;
            }
          }
          lastClosedDict = { closeTokenIndex: k, mcid };
          dictTokens = [];
        }
      } else {
        dictTokens.push(tk);
      }
      continue;
    }
    if (tk.t === '<<') { dictDepth = 1; dictTokens = []; continue; }

    if (target === null && tk.start >= position) {
      // Nothing open at `position` at all -- decline immediately rather than
      // let a LATER, unrelated BDC (one that opens only after `position`,
      // and so cannot possibly enclose it) get mistaken for the target on
      // the next iteration. Real bug this guards against, caught against
      // Curiel_187961_CSHP.pdf's own content stream: a naive version left
      // target unset and kept scanning when stack was momentarily empty,
      // then latched onto the next real tag it saw opening further down the
      // page -- reporting an "enclosing" span whose own contentStart sat
      // AFTER the match it was supposed to enclose.
      if (stack.length === 0) return null;
      const idx = stack.length - 1;
      target = { ...stack[idx], stackIndex: idx };
    }

    if (tk.t !== 'op') { operands.push(tk.v); continue; }

    if (tk.v === 'BDC' || tk.v === 'BMC') {
      const mcid = tk.v === 'BDC' && lastClosedDict && lastClosedDict.closeTokenIndex === k - 1 ? lastClosedDict.mcid : null;
      const tag = (operands[0] ?? '').replace(/^\//, '');
      stack.push({ tag, mcid, contentStart: tk.end });
    } else if (tk.v === 'EMC') {
      stack.pop();
      if (target !== null && stack.length === target.stackIndex) {
        return { tag: target.tag, mcid: target.mcid, contentStart: target.contentStart, closeOpStart: tk.start, closeOpEnd: tk.end };
      }
    }
    operands.length = 0;
  }
  return null;
}

/**
 * True when [start, end) contains at least one text-show operator with
 * real (non-whitespace) decoded text -- NOT just "any bytes at all." Real
 * shape this distinguishes: when a URL is the last citation's own last
 * piece of text inside a /P span, the only thing between the match's own
 * end and the enclosing EMC is the text object's own closing `ET` (every
 * real page in Curiel_187961_CSHP.pdf wraps its entire /P span's content in
 * one BT...ET) -- real, necessary PDF syntax, but not content needing its
 * own struct-tree reattachment. A byte-presence check alone (mirroring
 * buildArtifactSplitEdits's own `seg.end < nextBoundary`) would reopen a
 * pointless, empty remainder span for this case; this codebase's own bar
 * for "real" text (findRealTextSegmentsInSpan: `text.trim().length > 0`)
 * is reused here for consistency.
 */
function hasRealContentBetween(content: string, start: number, end: number): boolean {
  const tokens = tokenize(content.slice(start, end));
  const operands: Token[] = [];
  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    // No font/resolver needed here -- a mis-decoded ligature byte still
    // decodes to a non-whitespace character either way (a control code,
    // not a space), so this function's TRUE/FALSE outcome never actually
    // depends on getting the exact right text, only on "is there SOME
    // real text here at all."
    if (TEXT_SHOW_OPS.has(tk.v) && decodeTextShowOperands(operands, null).trim().length > 0) return true;
    operands.length = 0;
  }
  return false;
}

export interface LinkCompletenessSplice {
  /** Content-stream edits, each an {offset, text} insertion -- apply with a right-to-left splice pass, same convention as every other multi-edit content-stream rewrite in this codebase (buildArtifactSplitEdits et al). */
  edits: Array<{ offset: number; text: string }>;
  /** Fresh MCID assigned to the URL's own new /Link-tagged span -- what the new Link structure element's /K will reference. */
  linkMcid: number;
  /**
   * Fresh MCID assigned to the remainder content reopened AFTER the URL
   * run, only when BOTH the enclosing span had an MCID of its own (real
   * tagged content, not a bare /Artifact) AND there was remaining content
   * before the enclosing span's own close. null otherwise -- nothing to
   * re-wire into the structure tree. Splicing this into the enclosing
   * element's own /K array (right after its original MCID entry) is Slice
   * 3's job, not this function's -- it has no access to the structure tree
   * at all, by design.
   */
  remainderMcid: number | null;
  /** The enclosing span's own tag name (without leading slash), e.g. "P" -- needed by Slice 3 to find the matching structure element via /ParentTree. */
  enclosingTag: string;
  /** The enclosing span's own original MCID, or null if it was an untagged /Artifact span -- needed by Slice 3 to resolve the existing structure element to extend (or to skip that step entirely for an Artifact). */
  enclosingMcid: number | null;
}

/**
 * Builds the content-stream edits that carve a findUrlOperatorRun match out
 * of whatever real content tag already encloses it, WITHOUT touching the
 * structure tree at all -- that part (the real /Link annotation + structure
 * element, and re-wiring the remainder's fresh MCID into the enclosing
 * element's /K array) is Slice 3's job. Same "close the existing span right
 * before, open a fresh one around the match, reopen the original tag after
 * only if there's more content before its own close" technique
 * buildArtifactSplitEdits already uses for the analogous Artifact-split
 * case -- the one real difference is the reopened "after" span is NOT bare
 * /Artifact BMC here, since the remainder is real, already-tagged prose
 * that still needs to belong to the SAME structure element the original
 * span did (handled by giving it its own fresh MCID when the enclosing span
 * had one, so Slice 3 has something concrete to append to that element's
 * /K; a bare /Artifact reopens with no MCID at all, same as today, since
 * Artifact content was never struct-tree-bound to begin with).
 *
 * `mcidStart` follows the same convention as buildArtifactSplitEdits's own
 * parameter of the same name (and every other nextMcid allocator in
 * pdf-structure-writer.service.ts): the caller's next free MCID on the
 * page. linkMcid consumes it; remainderMcid (when needed) consumes
 * mcidStart + 1.
 *
 * Declines (returns null) when `position` has no enclosing tag at all
 * (top-level page content -- genuinely ambiguous what to reattach the
 * remainder to, if any), or when the matched run somehow extends past the
 * enclosing span's own close -- a tag boundary is a different kind of break
 * than the line-break boundaries findUrlOperatorRun already guards, so this
 * is a defensive cross-check, not an assumption that the two never
 * disagree.
 */
export function buildLinkCompletenessSplice(
  content: string,
  run: UrlOperatorRun,
  mcidStart: number
): LinkCompletenessSplice | null {
  const enclosing = findEnclosingTagSpan(content, run.start);
  if (!enclosing || !enclosing.tag) return null;
  if (run.end > enclosing.closeOpStart) return null;

  const linkMcid = mcidStart;
  const edits: Array<{ offset: number; text: string }> = [
    { offset: run.start, text: ` EMC /Link <</MCID ${linkMcid}>> BDC ` },
  ];

  let remainderMcid: number | null = null;
  if (hasRealContentBetween(content, run.end, enclosing.closeOpStart)) {
    if (enclosing.mcid !== null) {
      remainderMcid = mcidStart + 1;
      edits.push({ offset: run.end, text: ` EMC /${enclosing.tag} <</MCID ${remainderMcid}>> BDC ` });
    } else {
      edits.push({ offset: run.end, text: ` EMC /${enclosing.tag} BMC ` });
    }
  }

  return { edits, linkMcid, remainderMcid, enclosingTag: enclosing.tag, enclosingMcid: enclosing.mcid };
}

// ─── Same-operand URL splitter (the 30.1%+5.3% "shares an operand with ───
// ─── other prose" bucket findUrlOperatorRun declines) ────────────────────
//
// findUrlOperatorRun/buildLinkCompletenessSplice above only ever INSERT new
// text between already-complete operators/array-elements -- never touching
// an existing literal's own bytes. The real population this section
// targets needs more: the URL's own text routinely shares a single Tj/TJ
// string operand with real surrounding prose (a short lead-in phrase like
// "Retrieved from ", or a trailing fragment), so freeing it means cutting
// INSIDE that literal's own raw bytes at an exact point. findSafeCutPoint
// (above) is the checkpoint primitive this builds on: it resolves a target
// DECODED-text position back to the exact RAW byte offset to cut at, or
// null when that position falls inside one byte's own multi-character
// ligature expansion (no valid offset exists there -- decline, don't
// guess).
//
// Real, load-bearing finding this design depends on: every cut this
// section ever builds is still a PURE INSERTION, never a byte removal --
// splitting `(xyz)` between 'x' and 'y' is done by inserting `) ... (`
// (closing the first half's own delimiter, the tag-boundary text, then a
// fresh opening delimiter for the second half) AT that exact offset; the
// ORIGINAL single pair of delimiters simply ends up serving the first and
// last pieces once the inserted text sits between them. For a TJ array,
// the SAME insertion also has to close the array and its own operator
// (`)] TJ ... [(`) -- a tag boundary (BDC/EMC) can only ever appear BETWEEN
// complete top-level operators, never nested inside another operator's own
// array argument.

/**
 * One edge of a UrlSubstringRun: where to insert the new tag-boundary text,
 * and the exact wrapper fragments needed around it. `closeSuffix` goes
 * immediately BEFORE the tag-boundary text (closing whatever needs closing
 * at this exact point); `openPrefix` goes immediately after (reopening
 * whatever needs reopening). Both are '' for a true operator-level
 * boundary (nothing to close/reopen at all -- the SAME simple case
 * findUrlOperatorRun's own matches always use).
 */
export interface SubstringCutPoint {
  offset: number;
  closeSuffix: string;
  openPrefix: string;
}

export interface UrlSubstringRun {
  /** Absolute offset of the URL's own first decoded character -- NOT necessarily an existing token boundary; see leadingCut for what to insert there. */
  urlStart: number;
  /** Absolute offset right after the URL's own last decoded character. */
  urlEnd: number;
  matchedText: string;
  leadingCut: SubstringCutPoint;
  trailingCut: SubstringCutPoint;
  /** True when there's real (non-whitespace) decoded text remaining in the SAME operator right after the URL's own end -- trailingCut lands mid-operator (not at that operator's own clean end), and what's left there isn't just whitespace. */
  hasTrailingContentInSameOp: boolean;
  /** The nearest safe, complete-token boundary at or after urlEnd -- always a valid position to resume a fresh content-stream tokenize from (unlike urlEnd itself, which may sit mid-array). Used to check for real content AFTER the operator containing the URL's own end, without re-tokenizing from a dangling mid-array position. */
  afterOpBoundary: number;
}

/**
 * Same real-URL-shape scan as findUrlOperatorRun (same MAX_RUN_OPERATORS
 * multi-op merge, same LINE_BREAK_OPS hard stop), but with NO leftover
 * cap -- findUrlSubstringRun is only ever meant to be tried as a fallback
 * AFTER findUrlOperatorRun has already declined, so by construction any
 * leftover found here genuinely lives inside the edge operator's own
 * operand structure (if the leftover could have been resolved by simply
 * starting the match window at a LATER operator, findUrlOperatorRun's own
 * "try every starting index" loop would already have found that clean
 * match). Declines (returns null) when either edge's own cut point would
 * require splitting inside a ligature's own multi-character expansion, or
 * when `isSimpleFont` reports the active font at an edge needing an actual
 * byte-level split is not a simple (single-byte) font -- both real,
 * necessary safety gates, not retried with a different window (shifting
 * the window doesn't change where this SAME real occurrence's own
 * start/end are, so retrying can never avoid the same unsafe cut).
 */
export function findUrlSubstringRun(
  content: string,
  rangeStart: number,
  rangeEnd: number,
  targetUrl: string,
  resolveGlyphText?: GlyphTextResolver,
  isSimpleFont?: (fontTag: string) => boolean
): UrlSubstringRun | null {
  if (!targetUrl) return null;
  const tokens = tokenize(content.slice(rangeStart, rangeEnd));

  interface SubPiece { raw: string; rawStart: number; text: string }
  interface SubOp {
    start: number;
    end: number;
    opKeyword: string;
    pieces: SubPiece[];
    text: string;
    precededByLineBreak: boolean;
    fontTag: string | null;
  }
  const ops: SubOp[] = [];
  const operands: Token[] = [];
  let sawLineBreakSinceLastShow = false;
  let currentFontTag: string | null = null;
  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    if (TEXT_SHOW_OPS.has(tk.v)) {
      const pieces: SubPiece[] = operands
        .filter((o) => o.t === 's' || o.t === 'h')
        .map((o) => ({ raw: o.v, rawStart: rangeStart + o.start, text: applyGlyphResolver(decodePdfStringLiteral(o.v), currentFontTag, resolveGlyphText) }));
      const text = pieces.map((p) => p.text).join('');
      const opStart = operands.length ? operands[0].start : tk.start;
      ops.push({ start: rangeStart + opStart, end: rangeStart + tk.end, opKeyword: tk.v, pieces, text, precededByLineBreak: sawLineBreakSinceLastShow, fontTag: currentFontTag });
      sawLineBreakSinceLastShow = false;
    } else if (LINE_BREAK_OPS.has(tk.v)) {
      sawLineBreakSinceLastShow = true;
    } else if (tk.v === FONT_SELECT_OP) {
      currentFontTag = operands[0]?.t === 'name' ? operands[0].v : currentFontTag;
    }
    operands.length = 0;
  }

  const locate = (globalOffset: number, i: number, j: number): { op: SubOp; localOffset: number } | null => {
    let consumed = 0;
    for (let k = i; k <= j; k++) {
      if (globalOffset <= consumed + ops[k].text.length) return { op: ops[k], localOffset: globalOffset - consumed };
      consumed += ops[k].text.length;
    }
    return null;
  };

  const buildCut = (located: { op: SubOp; localOffset: number }): SubstringCutPoint | null => {
    const { op, localOffset } = located;
    const isArray = op.opKeyword === 'TJ';
    if (localOffset <= 0) return { offset: op.start, closeSuffix: '', openPrefix: '' };
    if (localOffset >= op.text.length) return { offset: op.end, closeSuffix: '', openPrefix: '' };

    let consumed = 0;
    for (const piece of op.pieces) {
      const pieceLen = piece.text.length;
      if (localOffset <= consumed + pieceLen) {
        const withinPiece = localOffset - consumed;
        if (withinPiece === 0) {
          return { offset: piece.rawStart, closeSuffix: isArray ? '] TJ' : '', openPrefix: isArray ? '[' : '' };
        }
        if (withinPiece === pieceLen) {
          return { offset: piece.rawStart + piece.raw.length, closeSuffix: isArray ? '] TJ' : '', openPrefix: isArray ? '[' : '' };
        }
        // Mid-literal: genuinely need to cut inside this piece's own raw bytes.
        if (op.fontTag === null) return null; // unknown font -- decline rather than guess
        if (isSimpleFont && !isSimpleFont(op.fontTag)) return null; // CID/Type0 -- out of this module's scope
        const bytes = decodePdfStringLiteralBytes(piece.raw);
        const chars = resolveBytesToChars(bytes, op.fontTag, resolveGlyphText);
        const localSourceOffset = findSafeCutPoint(bytes, chars, withinPiece);
        if (localSourceOffset === null) return null; // mid-ligature -- decline
        const isHex = piece.raw.startsWith('<');
        const closeDelim = isHex ? '>' : ')';
        const openDelim = isHex ? '<' : '(';
        return {
          offset: piece.rawStart + localSourceOffset,
          closeSuffix: closeDelim + (isArray ? '] TJ' : ' Tj'),
          openPrefix: (isArray ? '[' : '') + openDelim,
        };
      }
      consumed += pieceLen;
    }
    return null;
  };

  for (let i = 0; i < ops.length; i++) {
    let concatenated = '';
    for (let j = i; j < Math.min(ops.length, i + MAX_RUN_OPERATORS); j++) {
      if (j > i && ops[j].precededByLineBreak) break;
      concatenated += ops[j].text;
      const idx = concatenated.indexOf(targetUrl);
      if (idx === -1) continue;

      const startLocated = locate(idx, i, j);
      const endLocated = locate(idx + targetUrl.length, i, j);
      if (!startLocated || !endLocated) break; // shouldn't happen -- defensive

      const leadingCut = buildCut(startLocated);
      if (!leadingCut) return null;
      const trailingCut = buildCut(endLocated);
      if (!trailingCut) return null;

      const hasTrailingContentInSameOp = endLocated.op.text.slice(endLocated.localOffset).trim().length > 0;

      return {
        urlStart: leadingCut.offset,
        urlEnd: trailingCut.offset,
        matchedText: targetUrl,
        leadingCut,
        trailingCut,
        hasTrailingContentInSameOp,
        afterOpBoundary: endLocated.op.end,
      };
    }
  }
  return null;
}

export interface UrlSubstringSplice {
  /** Same {offset, text} PURE-INSERTION convention as LinkCompletenessSplice's own edits -- apply right-to-left, same as every other multi-edit splice in this codebase. */
  edits: Array<{ offset: number; text: string }>;
  linkMcid: number;
  remainderMcid: number | null;
  enclosingTag: string;
  enclosingMcid: number | null;
}

/**
 * Builds the content-stream edits that carve a findUrlSubstringRun match
 * out of whatever real content tag already encloses it -- the SAME
 * enclosing-tag resolution and remainder-MCID handling buildLinkCompleteness
 * Splice already uses (reused directly, not duplicated: findEnclosingTagSpan,
 * hasRealContentBetween), just driven by run.leadingCut/trailingCut's own
 * wrapper fragments instead of the simple "always an operator boundary"
 * text those functions' OWN clean-path caller never needed.
 *
 * Reuses afterOpBoundary (not urlEnd itself) as the starting point for the
 * "is there real content after this" check -- urlEnd can sit mid-array,
 * where a fresh tokenize would see a dangling, unmatched array with no
 * opening `[` in view; afterOpBoundary is always a complete-token-safe
 * position to resume scanning from (the containing operator's own clean
 * end).
 *
 * Declines (returns null) under the exact same conditions as
 * buildLinkCompletenessSplice: no enclosing tag at all, or the match
 * somehow extends past the enclosing span's own close.
 */
export function buildUrlSubstringSplice(
  content: string,
  run: UrlSubstringRun,
  mcidStart: number
): UrlSubstringSplice | null {
  const enclosing = findEnclosingTagSpan(content, run.urlStart);
  if (!enclosing || !enclosing.tag) return null;
  if (run.urlEnd > enclosing.closeOpStart) return null;

  const linkMcid = mcidStart;
  const edits: Array<{ offset: number; text: string }> = [
    {
      offset: run.leadingCut.offset,
      text: `${run.leadingCut.closeSuffix} EMC /Link <</MCID ${linkMcid}>> BDC ${run.leadingCut.openPrefix}`,
    },
  ];

  let remainderMcid: number | null = null;
  const hasTrailingContent = run.hasTrailingContentInSameOp || hasRealContentBetween(content, run.afterOpBoundary, enclosing.closeOpStart);
  if (hasTrailingContent) {
    if (enclosing.mcid !== null) {
      remainderMcid = mcidStart + 1;
      edits.push({
        offset: run.trailingCut.offset,
        text: `${run.trailingCut.closeSuffix} EMC /${enclosing.tag} <</MCID ${remainderMcid}>> BDC ${run.trailingCut.openPrefix}`,
      });
    } else {
      edits.push({
        offset: run.trailingCut.offset,
        text: `${run.trailingCut.closeSuffix} EMC /${enclosing.tag} BMC ${run.trailingCut.openPrefix}`,
      });
    }
  }

  return { edits, linkMcid, remainderMcid, enclosingTag: enclosing.tag, enclosingMcid: enclosing.mcid };
}

// ─── Glyph-aware range text decoder (CITATION-MISSING-LINK's own real ───
// ─── need: recovering a /REF bibliography entry's own text correctly) ───
//
// pdf-artifact-tagger.ts's own extractArtifactTextRuns already decodes every
// text-show operator in a byte range, but ONLY via decodePdfStringLiteral --
// no font/ligature resolution at all, and it skips hex-string ('h') operands
// entirely (built for a different original job: finding Y-position boundary
// CANDIDATES for artifact-span splitting, where a raw, occasionally-wrong
// ligature byte never changed the answer). Matching a citation's own author
// surname against this document's real /REF entries needs the OPPOSITE
// trade-off -- confirmed live on Karsaklian_189165_9781606497623.pdf's own
// real bibliography: "Hoffman, D., and T. Novak 2018" decodes as
// "Ho\u001bman" (the "ff" ligature collapsed to a single raw byte) without a
// resolver, which would silently break matching citation text "Hoffman" --
// so this reuses the SAME decodeTextShowOperands/applyGlyphResolver/
// GlyphTextResolver primitives findUrlOperatorRun already proved correct for
// exactly this ligature-byte problem, rather than a fresh decode path.

/**
 * Concatenates the decoded text of every text-show operator (`Tj`/`TJ`/`'`/
 * `"`) whose own operator offset falls within `[rangeStart, rangeEnd)`,
 * resolving each operand through `resolveGlyphText` under whichever font
 * (`Tf`) was active at that operator -- same per-operator font tracking as
 * findUrlOperatorRun/findUrlSubstringRun above. Always tokenizes the WHOLE
 * `content` string (not just the range) so a `Tf` selected before
 * `rangeStart` is still correctly known by the time the range begins --
 * same reasoning as extractArtifactTextRuns' own whole-stream CTM tracking,
 * just for font state instead of the text matrix. Read-only; never used to
 * locate a splice point, only to recover what a span of marked content
 * actually says.
 */
export function extractDecodedTextInRange(
  content: string,
  rangeStart: number,
  rangeEnd: number,
  resolveGlyphText?: GlyphTextResolver
): string {
  const tokens = tokenize(content);
  const operands: Token[] = [];
  let currentFontTag: string | null = null;
  let out = '';

  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    if (TEXT_SHOW_OPS.has(tk.v)) {
      if (tk.start >= rangeStart && tk.start < rangeEnd) {
        out += decodeTextShowOperands(operands, currentFontTag, resolveGlyphText);
      }
    } else if (tk.v === FONT_SELECT_OP) {
      currentFontTag = operands[0]?.t === 'name' ? operands[0].v : currentFontTag;
    }
    operands.length = 0;
  }

  return out;
}
