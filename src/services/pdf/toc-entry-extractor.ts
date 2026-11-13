/**
 * TOC Entry Extractor
 *
 * Pure, testable core for TOC-LINK-MISSING (S4 Carlisle manual QC, Round 2,
 * item #4 -- "the required two-way navigation links between the TOC and
 * the corresponding content sections were missing").
 *
 * Confirmed real via direct inspection of Karsaklian_189165_9781606497623.pdf's
 * own InDesign-exported content stream (pages 7 "Contents" and 9 "List of
 * Figures and Tables"): a Table of Contents row is NOT one shared /P
 * paragraph -- it's several flat, sibling /P-role-mapped structure
 * elements, each with its own bare MCID, emitted back-to-back in the
 * content stream in reading order:
 *
 *   1. the entry's own title text (one or more spans, if the title wraps
 *      across a physical line, e.g. "Chapter 3 Why Are Marketers Losing
 *      Their Jobs to AI" / "and How to Avoid It? .....25")
 *   2. a dot-leader span (a long run of literal "." characters, often with
 *      a kerned single-period `/Span<</ActualText<FEFF002E>>>` trick for
 *      just the first dot -- both are purely decorative)
 *   3. the entry's own trailing page-label text (e.g. "25", "ix") -- this
 *      span is ALREADY completely isolated: nothing else shares its MCID.
 *      This is the span pdf-structure-writer.service.ts's fixTocEntryLink
 *      turns into a real /Link, without needing any content-stream
 *      splitting (unlike pdf-link-completeness-writer.ts's own
 *      findUrlOperatorRun/findUrlSubstringRun, which exist specifically
 *      because a URL usually does NOT get this kind of isolation).
 *
 * This module only reads; it never writes, and has no pdf-lib dependency
 * (content-stream string in, structured data out) -- matching this
 * codebase's established preference for pure/testable content-stream cores
 * (pdf-link-completeness-writer.ts, mcid-bounding-box.ts).
 */

import { tokenize } from '../zone-extractor/seam-c/content-stream';
import { decodePdfStringLiteralBytes } from './pdf-link-completeness-writer';

type Token = ReturnType<typeof tokenize>[number];

const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

/** Simple Latin-1 byte decode (no ligature/font-encoding resolution -- see
 *  decodePdfStringLiteralBytes's own callers elsewhere for that harder
 *  problem). Good enough here: a TOC entry's own trailing LABEL text --
 *  the only text this module's correctness actually depends on -- is
 *  always plain ASCII digits or lowercase roman-numeral letters in every
 *  real sample seen, never a ligature. A rare mis-decoded byte in the
 *  TITLE text (display-only, used in the issue message, never in
 *  resolution logic) is an accepted cosmetic residual, not a correctness
 *  risk. */
function decodeLiteral(raw: string): string {
  return decodePdfStringLiteralBytes(raw).map((b) => String.fromCharCode(b.byte)).join('');
}

/**
 * A bare roman numeral or a bare 1-4 digit arabic number -- the shape a
 * TOC entry's own trailing page-label always takes. Deliberately loose
 * (e.g. "mix" also matches, read as roman numeral 1009) -- tightening this
 * further would need real roman-numeral-grammar validation for no real
 * benefit: extractTocRowCandidates's own caller (PdfTocValidator) always
 * additionally requires the matched text to resolve to EXACTLY ONE real
 * page via this document's own /PageLabels before ever trusting it as a
 * link target (same "optimistic classification, real gate at resolution"
 * split already established for CROSS-REFERENCE-MISSING-LINK's own
 * crossReferenceData) -- a stray word that happens to parse as a roman
 * numeral essentially never also collides with a real page's own printed
 * label.
 */
const LABEL_RE = /^(?:[ivxlcdm]{1,8}|\d{1,4})$/i;

/** A span whose own text is entirely dot-leader filler (periods, middle
 *  dots, bullets, ellipsis, or whitespace) -- never a real title or label. */
const DOT_LEADER_ONLY_RE = /^[.\s·•…]*$/;

export interface TocSpan {
  mcid: number;
  text: string;
  /**
   * The text matrix's own translation (e, f) in effect at the span's FIRST
   * text-show operator, in native PDF device space (bottom-left origin,
   * y grows upward) -- i.e. the glyph run's own baseline origin, same
   * convention structure-analyzer.service.ts's analyzeLinks already reads
   * raw PDF annotation /Rect coordinates in. `fontSize` is the matrix's own
   * `a` component (every real sample uses a uniform, unrotated scale --
   * `a === d`, `b === c === 0` -- same assumption mcid-bounding-box.ts's
   * own simpler callers make elsewhere). All default to 0/0/12 when no Tm
   * ever appeared before this span (defensive; not observed in any real
   * sample).
   */
  originX: number;
  originY: number;
  fontSize: number;
}

export interface TocRowCandidate {
  /** Display-only concatenation of every non-dot-leader span seen since
   *  the previous label (or page start) -- see this module's own header
   *  comment for the known, accepted "page heading/section-divider text
   *  gets swept into the FIRST row's title" cosmetic imperfection. */
  titleText: string;
  /** The trailing page-label text exactly as rendered, e.g. "25", "ix". */
  label: string;
  /** The bare MCID already isolated to just this label's own span. */
  labelMcid: number;
  /** The label span's own baseline origin/font size -- see TocSpan's own
   *  doc comment. Used by PdfTocValidator to build a real, non-degenerate
   *  Rect for the new Link annotation (a bare Tj/TJ anchor alone, with no
   *  accompanying path/clip geometry, has no true glyph-width extent to
   *  read back out of the content stream -- same documented limitation
   *  mcid-bounding-box.ts's own header comment already accepts for text
   *  anchors generally; approximated here via charCount * fontSize *
   *  AVG_CHAR_WIDTH_FACTOR, close enough for a clickable region over a
   *  1-4 character page number). */
  labelOriginX: number;
  labelOriginY: number;
  labelFontSize: number;
}

/** Average glyph width as a fraction of font size, for a proportional Latin
 *  text font -- a rough approximation (see labelOriginX's own doc comment
 *  for why no better data is available here), but good enough to size a
 *  clickable Rect around a short (1-4 character) page number. */
export const AVG_CHAR_WIDTH_FACTOR = 0.55;

/**
 * One pass over every bare-MCID marked-content span on the page, decoding
 * each span's own visible text (Tj/TJ string operands only -- kerning
 * numbers inside a TJ array are ignored, same as every other text-show
 * decoder in this codebase). Uses the same depth-tracked
 * "innermost-targeted-MCID-wins, nested untagged spans don't end it early"
 * technique mcid-bounding-box.ts's own locateMcidBoundingBoxes already
 * uses for geometry -- needed here because a title span routinely nests an
 * untagged `/Span<</ActualText<FEFF0009>>>` tab-gap trick (confirmed real:
 * every "Figure N.N" / description pair on page 9 uses one) inside its own
 * BDC...EMC without that nested span ending the outer one early.
 *
 * Returns spans in content-stream (reading) order.
 */
export function extractTocSpans(content: string): TocSpan[] {
  const tokens = tokenize(content);
  const spans: TocSpan[] = [];

  let mcDepth = 0;
  let activeMcid: number | null = null;
  let activeDepth = -1;
  let activeText = '';
  let activeOrigin: { x: number; y: number; fontSize: number } | null = null;
  let lastClosedDict: { closeTokenIndex: number; mcid: number | null } | null = null;
  let dictDepth = 0;
  let dictTokens: Token[] = [];
  const operands: Token[] = [];

  // Current text matrix's own scale/translation -- every real sample seen
  // uses an unrotated, uniform-scale `Tm` (a === d, b === c === 0)
  // immediately at the start of each span's own BT...ET block, so only the
  // most recently seen Tm needs tracking (no Td/TD running-offset support
  // needed; none of this module's real target spans use one).
  let lastTm = { a: 12, e: 0, f: 0 };

  const finalize = (): void => {
    if (activeMcid !== null) {
      spans.push({
        mcid: activeMcid,
        text: activeText,
        originX: activeOrigin?.x ?? 0,
        originY: activeOrigin?.y ?? 0,
        fontSize: activeOrigin?.fontSize ?? 12,
      });
    }
    activeMcid = null;
    activeDepth = -1;
    activeText = '';
    activeOrigin = null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (dictDepth > 0) {
      if (tk.t === '<<') {
        dictDepth++;
      } else if (tk.t === '>>') {
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

    if (tk.t !== 'op') { operands.push(tk); continue; }

    if (tk.v === 'Tm') {
      const nums = operands.filter(o => o.t === 'n').map(o => parseFloat(o.v));
      if (nums.length === 6) lastTm = { a: nums[0], e: nums[4], f: nums[5] };
    } else if (tk.v === 'BDC' || tk.v === 'BMC') {
      const mcid = tk.v === 'BDC' && lastClosedDict && lastClosedDict.closeTokenIndex === k - 1 ? lastClosedDict.mcid : null;
      mcDepth++;
      if (activeMcid === null && mcid !== null) {
        activeMcid = mcid;
        activeDepth = mcDepth;
      }
    } else if (tk.v === 'EMC') {
      if (activeMcid !== null && mcDepth === activeDepth) finalize();
      mcDepth = Math.max(0, mcDepth - 1);
    } else if (activeMcid !== null && TEXT_SHOW_OPS.has(tk.v)) {
      let added = '';
      for (const o of operands) {
        if (o.t === 's' || o.t === 'h') added += decodeLiteral(o.v);
      }
      if (activeOrigin === null && added.length > 0) {
        activeOrigin = { x: lastTm.e, y: lastTm.f, fontSize: Math.abs(lastTm.a) || 12 };
      }
      activeText += added;
    }
    operands.length = 0;
  }

  return spans;
}

/**
 * Groups a page's bare-MCID spans (in reading order) into TOC row
 * candidates: every span whose own text is a bare page-number/roman-
 * numeral label (LABEL_RE) closes one row; everything collected since the
 * previous label (skipping pure dot-leader filler and empty spans) becomes
 * that row's own display-only title text. A label with no real title text
 * before it (e.g. a stray page number right after a page heading) is still
 * returned -- title emptiness is cosmetic, not a reason to decline the
 * link.
 */
export function extractTocRowCandidates(content: string): TocRowCandidate[] {
  const spans = extractTocSpans(content);
  const rows: TocRowCandidate[] = [];
  let titleParts: string[] = [];

  for (const span of spans) {
    const text = span.text.trim();
    if (text.length === 0 || DOT_LEADER_ONLY_RE.test(text)) continue;

    if (LABEL_RE.test(text)) {
      rows.push({
        titleText: titleParts.join(' ').trim(),
        label: text,
        labelMcid: span.mcid,
        labelOriginX: span.originX,
        labelOriginY: span.originY,
        labelFontSize: span.fontSize,
      });
      titleParts = [];
    } else {
      titleParts.push(text);
    }
  }

  return rows;
}
