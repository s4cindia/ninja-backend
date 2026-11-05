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
 * Checked this directly against real Curiel content before writing any of
 * this: on every sampled citation (3 independent pages), the URL always
 * arrives as its own whole Tj/TJ operator (occasionally 2-3 consecutive
 * ones for a kerning gap or hyphen-continuation), NEVER mid-operator
 * alongside unrelated prose:
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
 * (page 102's ". " prefix) rather than ever needing a mid-string cut.
 */

import { tokenize } from '../zone-extractor/seam-c/content-stream';

type Token = ReturnType<typeof tokenize>[number];

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/**
 * Minimal PDF string-literal decoder: `(escaped text)` or `<hex>` to a JS
 * string. Deliberately local, not shared with pdf-artifact-tagger.ts's own
 * copy -- that one lives in a module about a different concern (artifact
 * spans), and duplicating ~15 lines here is cheaper than coupling the two.
 * Does NOT apply a font's own ToUnicode mapping -- correct for the simple/
 * WinAnsi-encoded body text this targets (citation URLs are plain ASCII),
 * not a general-purpose PDF text extractor. findUrlOperatorRun's own
 * confidence gate (the matched text must actually contain the validator's
 * own reported URL) catches a wrong decode by simply failing to match,
 * never by silently producing a wrong splice.
 */
function decodePdfStringLiteral(raw: string): string {
  if (raw.startsWith('(')) {
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[i + 1];
        const octal = /[0-7]/;
        if (octal.test(next)) {
          let oct = next;
          let j = i + 2;
          for (let k = 0; k < 2 && octal.test(raw[j] ?? ''); k++, j++) oct += raw[j];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = j - 1;
        } else if (next === 'n') { out += '\n'; i++; }
        else if (next === 'r') { out += '\r'; i++; }
        else if (next === 't') { out += '\t'; i++; }
        else if (next === '\n' || next === '\r') { i++; } // line continuation, no char
        else { out += next; i++; }
      } else {
        out += ch;
      }
    }
    return out;
  }
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i < hex.length - 1; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  return raw;
}

function decodeTextShowOperands(operands: Token[]): string {
  // tokenize() types a parenthesized literal 's' and a hex string '<...>'
  // 'h' -- both are valid PDF string operands to Tj/TJ/'/", and
  // decodePdfStringLiteral already branches on the leading delimiter to
  // decode either; the filter must accept both or hex-encoded operands
  // (common for a CID/Type0 font) silently vanish instead of decoding.
  return operands
    .filter((o) => o.t === 's' || o.t === 'h')
    .map((o) => decodePdfStringLiteral(o.v))
    .join('');
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

export function findUrlOperatorRun(
  content: string,
  rangeStart: number,
  rangeEnd: number,
  targetUrl: string
): UrlOperatorRun | null {
  if (!targetUrl) return null;
  const tokens = tokenize(content.slice(rangeStart, rangeEnd));

  interface Op { start: number; end: number; text: string; precededByLineBreak: boolean }
  const ops: Op[] = [];
  const operands: Token[] = [];
  let sawLineBreakSinceLastShow = false;
  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    if (TEXT_SHOW_OPS.has(tk.v)) {
      const text = decodeTextShowOperands(operands);
      const opStart = operands.length ? operands[0].start : tk.start;
      ops.push({ start: rangeStart + opStart, end: rangeStart + tk.end, text, precededByLineBreak: sawLineBreakSinceLastShow });
      sawLineBreakSinceLastShow = false;
    } else if (LINE_BREAK_OPS.has(tk.v)) {
      sawLineBreakSinceLastShow = true;
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
