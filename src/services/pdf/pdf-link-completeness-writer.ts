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
 *     20-operator window -- a genuinely different, not yet understood
 *     shape (not investigated further here).
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
    if (TEXT_SHOW_OPS.has(tk.v) && decodeTextShowOperands(operands).trim().length > 0) return true;
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
