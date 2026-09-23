// Locates the content-stream byte range of a specific text *run* — the
// sequence of consecutive text-showing operators (Tj/TJ/'/") between one
// positioning op (Td/TD/Tm/T*) and the next — given the device-space anchor
// point of the text a color-contrast issue was flagged against. A `BT…ET`
// text object commonly holds many such runs (one per line of a paragraph);
// anchoring to the whole object rather than the individual run would only
// ever find the first line. Read-only — this only finds a byte range; the
// writer does the actual rewrite.
//
// Reuses `tokenize()` from the Seam C content-stream tagger (proven, tested,
// exported for this purpose) but implements its own CTM/text-matrix walker
// rather than calling into `tagContentStream()` directly — that function is
// live production code for the untagged-PDF autotag pipeline, and this
// feature has a different matching problem (nearest-point-to-one-target,
// not zone-band assignment). Duplicating ~40 lines of state tracking here
// keeps this feature fully isolated from that path. A shared
// `walkTextObjects()` primitive is a reasonable future refactor once this
// path is proven, not before.
//
// Same axis-aligned assumption as content-stream.ts: CTM/text matrices track
// only scale+translate (a, d, e, f), not full rotation/skew. Callers must
// refuse to correlate on rotated pages (page.rotation !== 0) — that guard
// lives at the call site (Phase B3), not here, since this module has no
// notion of page metadata.

import { tokenize } from '../zone-extractor/seam-c/content-stream';

type Token = ReturnType<typeof tokenize>[number];

export interface TextRunMatch {
  /** Byte offset where this run begins (right after the positioning op that placed it, or right after `BT` for the object's first run). */
  start: number;
  /** Byte offset where this run ends (right before the next positioning op, or right before `ET`). */
  end: number;
  /** 0-1. Reflects match distance and, when true, is reduced for ambiguity — never a claim about fix correctness beyond "this is the right span". */
  confidence: number;
  /** True when a near-equally-close runner-up run exists, or the run's fill color changes mid-run. */
  ambiguous: boolean;
  /**
   * Byte range of the single internal fill-color operator (operands through
   * the operator keyword) within [start,end), when exactly one exists.
   *
   * A run commonly carries its own dedicated color op right before its show
   * op (e.g. pdf-lib emits `BT\n0.6 0.6 0.6 rg\n...\nTj\n...\nET` for a
   * single-line text object — the whole object is one run, and this is that
   * run's op). Undefined when zero internal fill ops exist, meaning the
   * run's color is inherited from outside its own span (an earlier sibling
   * run in the same text object, or state from before `BT`). Always
   * undefined when `ambiguous` is true from a mixed-color run.
   */
  internalFillColorOp?: { start: number; end: number };
  /**
   * Byte offset right after the run's own LAST show op -- NOT the same as
   * `end`, which can extend further to include trailing graphics-state
   * setup for whatever the NEXT run shows (a run only closes on a
   * positioning op, not on "no more shows follow"). A caller restoring this
   * run's original color after writing a fix (pdf-contrast-writer.service.ts
   * always does) must insert that restore here, not at `end` -- inserting
   * after a trailing color op belonging to the next run would fire AFTER
   * that op and silently override its color instead of restoring this run's.
   */
  lastShowEnd: number;
  /**
   * The run's TRUE final rendered color (parsed from its LAST internal fill
   * op), present whenever the run has one or more internal fill ops at all
   * -- set by locateTextRunsForPage's multi-segment matching, always
   * undefined from plain locateTextRun. Overrides the caller-supplied
   * `cd.foreground` for the restore-after-run splice: fixing a NON-last
   * colored segment of a multi-color run (e.g. segment 1 of "black RED
   * black") must restore to the run's real trailing color (black, from the
   * last internal op) after the run ends, not to the FIXED segment's own
   * original color (red) -- using the wrong value here would silently
   * leave the graphics state on the wrong color for whatever renders next,
   * a new contrast defect this module must never introduce. See
   * locateTextRunsForPage's own doc comment for the full reasoning.
   *
   * No longer read by pdf-contrast-writer.service.ts's fixColorContrast:
   * even the run's own TRUE final color isn't always what unrelated LATER
   * content in the stream actually needs restored (confirmed live on
   * Math_Weir_PDF.pdf -- see findPrecedingColor's own doc comment for the
   * real incident and the fix, which derives the restore value directly
   * from the stream instead). Left in place, still computed and still
   * asserted by its own tests, since it's a real, separately-useful piece
   * of run analysis (the run's true trailing color) a future caller could
   * still want -- not removed here since that's a larger, separate cleanup
   * than this fix's own scope.
   */
  restoreColorOverride?: [number, number, number];
  /**
   * Device-space anchor position (this run's own first show op), present
   * only when the run was found via `findSiblingRuns` -- a position-matched
   * run (plain `locateTextRun`/`locateTextRunsForPage`) already has the
   * caller's own target x/baselineY for this purpose, so leaving these
   * undefined there is deliberate, not an oversight. A caller building a
   * boundingBox to fix/verify a sibling run (which has no audit-supplied
   * bbox of its own) anchors it here.
   */
  anchorX?: number;
  anchorY?: number;
}

interface TextUnit {
  start: number;
  end: number;
  anchorX: number | null;
  anchorY: number | null;
  /**
   * Byte offset right after the run's LAST show op (Tj/TJ/'/"), or null if
   * the run never shows anything (shouldn't happen for a pushed unit, since
   * flushRun only pushes when runHasShow is true, but kept nullable rather
   * than asserted). A color-setting op after this point paints nothing
   * within this run -- the run ends via a positioning op, not a show op, so
   * content between the last show and the run's own `end` is graphics-state
   * setup for whatever the NEXT run shows, not this one's own color.
   */
  lastShowEnd: number | null;
  /**
   * The text line matrix's own Y-scale (|tlmD|) in effect when this run's
   * first show op fired -- a reliable proxy for the run's rendered font
   * size (Tm's a/d directly encode effective size for a unit-size font
   * resource, the near-universal case; confirmed real: `10 0 0 10 Tm`
   * ordinary text vs. `5.83 0 0 5.83 Tm` a subscript). Used only to gate
   * locateTextRunFromUnits' proximity-ambiguity check against a nearby
   * subscript/superscript glyph -- see SUBSCRIPT_SCALE_RATIO_THRESHOLD.
   */
  scaleY: number;
}

const num = (t: { t: string; v: string } | undefined): number => (t && t.t === 'n' ? parseFloat(t.v) : 0);

// Distance (PDF points) → confidence, matching content-stream.ts's own
// nearest-within-12pt convention for the outer tolerance.
const CONFIDENCE_TIERS: Array<{ maxDist: number; confidence: number }> = [
  { maxDist: 2, confidence: 0.95 },
  { maxDist: 6, confidence: 0.80 },
  { maxDist: 12, confidence: 0.60 },
];

// A runner-up this close to the best match makes the correlation unreliable
// (e.g. two lines at nearly the same position — adjacent columns/rows).
const AMBIGUITY_MARGIN = 4;

// A CONFIDENCE step subtracted when a match is otherwise usable but ambiguous.
const AMBIGUITY_PENALTY = 0.2;

// Below this ratio (smaller run's own scaleY / larger run's), a nearby
// runner-up is treated as a subscript/superscript glyph attached to the
// SAME semantic unit as the best match, not a genuinely separate competing
// candidate -- exempted from the proximity-ambiguity penalty above.
//
// Real incident, confirmed live on Math_Weir_PDF.pdf: statistical notation
// like "H₀ true"/"B₁ (1 time/wk)" renders each subscript ("0"/"1") as its
// own tiny run positioned just before the following word, close enough to
// trigger AMBIGUITY_MARGIN even though there's no genuine ambiguity about
// which run a contrast issue targets -- the subscript is never itself a
// plausible alternate target. Measured scale ratio in BOTH real cases:
// 5.83/10 = 0.583 and 5.247/9 = 0.583 exactly -- a standard subscript-scale
// convention, not a coincidence. 0.75 sits with real margin above that
// (comfortably exempts genuine subscripts) and below 1.0 (a genuine
// same-size collision, e.g. two ordinary adjacent table-column values,
// keeps the existing ambiguity behavior completely unchanged).
const SUBSCRIPT_SCALE_RATIO_THRESHOLD = 0.75;

// Fill-color operators only (lowercase — sets the color Tj actually renders
// with under the default, near-universal fill text-rendering mode). Stroke
// operators (RG/G/K/SC/SCN, uppercase) are deliberately excluded: they don't
// affect Tj's rendered fill color and are noise for this purpose.
const FILL_COLOR_OPS = new Set(['rg', 'g', 'k', 'sc', 'scn']);

function confidenceForDistance(dist: number): number {
  for (const tier of CONFIDENCE_TIERS) {
    if (dist <= tier.maxDist) return tier.confidence;
  }
  return 0;
}

/**
 * Finds every fill-color operator within [rangeStart, rangeEnd), returning
 * each one's full span (its operand tokens through the operator keyword).
 * Mirrors tagContentStream's operand-accumulation pattern: non-operator
 * tokens accumulate as pending operands; every operator (color or not)
 * resets the accumulator, so only the operands immediately preceding a
 * given color op are attributed to it.
 */
function findFillColorOps(
  tokens: Token[],
  rangeStart: number,
  rangeEnd: number
): Array<{ start: number; end: number }> {
  const ops: Array<{ start: number; end: number }> = [];
  let pendingStart: number | null = null;

  for (const tk of tokens) {
    if (tk.start < rangeStart) continue;
    if (tk.start >= rangeEnd) break;

    if (tk.t !== 'op') {
      if (pendingStart === null) pendingStart = tk.start;
      continue;
    }
    if (FILL_COLOR_OPS.has(tk.v)) {
      ops.push({ start: pendingStart ?? tk.start, end: tk.end });
    }
    pendingStart = null;
  }

  return ops;
}

/**
 * Walks the tokenized content stream, collecting one unit per text *run* —
 * the span of consecutive show ops (Tj/TJ/'/") between one positioning op
 * (Td/TD/Tm/T*, or `BT` for the object's first run) and the next. A run's
 * anchor is the device-space position in effect when its first show op
 * fires. Ends a run (and starts the next) on every positioning op and on
 * `ET`; a bare color-setting op does not end a run — it's expected to sit
 * inside a run's own span (see `internalFillColorOp` on TextRunMatch).
 *
 * Live-confirmed bug (real 805-page document): `Td`/`TD`'s tx/ty — and
 * `T*`/`'`/`"`'s TL-derived offset — are expressed in *text space*, not
 * device space (PDF32000-1:2008 §9.4.2). Per spec they must be transformed
 * through the *current* text line matrix's own scale before being folded
 * into the running device-space position; this previously accumulated them
 * as raw, unscaled numbers. A line positioned via a fresh `Tm` (which sets
 * an absolute device-space position via its own e/f directly) always
 * anchored correctly; every subsequent `Td`-positioned continuation line
 * within the same scaled text object was wrong, and the error compounded
 * with each further `Td` — confirmed on a real TOC page where 116 of 120
 * text units are `Td`-positioned: distance to the correct anchor grew
 * roughly linearly down the page (115pt -> 535pt over 11 lines), so every
 * one of them missed the 12pt tolerance and locateTextRun returned null.
 * 42% of contrast issues document-wide failed to locate for this reason.
 * Tracks only the line matrix's scale (tlmA, tlmD), matching this file's
 * existing axis-aligned-only convention for the graphics-state CTM above —
 * b/c (rotation/skew) are assumed zero throughout, same assumption content-
 * stream.ts's caller-side rotation guard already depends on.
 */
function findTextUnits(tokens: Token[]): TextUnit[] {
  const units: TextUnit[] = [];

  type Ctm = { a: number; d: number; e: number; f: number };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];
  let tld = 0;
  let tmE = 0;
  let tmF = 0;
  // Current text line matrix's own scale — set by Tm, reset by BT. Td/TD/T*
  // offsets are in text space and must be scaled by these before they can
  // be folded into tmE/tmF, which deviceX/deviceY treat as already in the
  // same space Tm's own e/f are in (device space, since Tm replaces the
  // whole matrix at once rather than accumulating relative to it).
  //
  // A literal 0 parsed from Tm is kept as-is, not defaulted to 1: a Tm with
  // a genuinely zero a or d component means Td/TD/T* contribute nothing
  // along that axis, and forcing it to 1 would silently invent a scale the
  // matrix doesn't have. This only matters for a Tm this module can't
  // represent anyway (b/c rotation/skew, always ignored here) leaking a
  // collapsed diagonal through — in that case, multiple runs freezing onto
  // the same anchor is caught by locateTextRun's own proximity-ambiguity
  // check below, same safety net that already covers any other same-point
  // collision.
  let tlmA = 1;
  let tlmD = 1;
  const operands: Array<{ t: string; v: string; start: number; end: number }> = [];

  let runStart = -1;
  let runHasShow = false;
  let runAnchorX: number | null = null;
  let runAnchorY: number | null = null;
  let runLastShowEnd: number | null = null;
  let runScaleY = 1;

  const deviceX = (tE: number): number => ctm.a * tE + ctm.e;
  const deviceY = (tF: number): number => ctm.d * tF + ctm.f;

  const flushRun = (endPos: number): void => {
    if (runHasShow) units.push({ start: runStart, end: endPos, anchorX: runAnchorX, anchorY: runAnchorY, lastShowEnd: runLastShowEnd, scaleY: runScaleY });
    runHasShow = false;
    runAnchorX = null;
    runAnchorY = null;
    runLastShowEnd = null;
  };

  // A run's `end` must land BEFORE the next positioning op's own operands
  // (matching this file's documented contract: "right before the next
  // positioning op"), not merely before the operator keyword itself --
  // Td/TD/Tm take numeric operands of their own, written before the
  // keyword in PDF's postfix syntax, so `tk.start` (the keyword's own
  // start) still sits BETWEEN those operands and the keyword. A caller
  // inserting a restore-color op at run.end (spliceColorFix always does,
  // right after every fix) would splice it into that exact same gap,
  // corrupting the FOLLOWING run's positioning call the same way an
  // unfixed run.start once corrupted THIS run's own. `operands` holds
  // only tokens accumulated since the last operator fired (cleared after
  // every one), so its first entry -- when non-empty -- is exactly this
  // upcoming operator's own first operand. T*/ET take no operands, so
  // `operands` is empty at that point and this correctly falls back to
  // the keyword's own start.
  const runEndBeforePendingOperands = (nextOpToken: { start: number }): number =>
    operands.length > 0 ? operands[0].start : nextOpToken.start;

  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;
    switch (op) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = { ...p }; break; }
      case 'cm': {
        const a = num(operands[operands.length - 6]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        ctm = { a: ctm.a * a, d: ctm.d * d, e: ctm.a * e + ctm.e, f: ctm.d * f + ctm.f };
        break;
      }
      case 'BT': tmE = 0; tmF = 0; tlmA = 1; tlmD = 1; runStart = tk.end; runHasShow = false; runAnchorX = null; runAnchorY = null; runLastShowEnd = null; break;
      case 'TL': tld = num(operands[operands.length - 1]); break;
      // A positioning op only ends the current run if a show op has already
      // fired since it began — otherwise this is still the run's lead-in
      // (e.g. a color op followed by a Tm, both before the first Tj) and
      // must stay part of the same run's span, not get cut off from it.
      //
      // runStart = tk.end (not tk.start) on every branch below: the new
      // run must begin strictly AFTER the positioning operator, matching
      // this file's own documented contract on TextRunMatch.start ("right
      // after the positioning op that placed it"). Td/TD/Tm take their own
      // preceding numeric operands (unlike BT, which takes none) -- using
      // tk.start instead put those operands INSIDE the new run's reported
      // span, meaning a caller inserting new content at that boundary (the
      // common case: color inherited from outside the run, so
      // spliceColorFix inserts right at run.start) spliced its insertion
      // BETWEEN the operands and their own operator, corrupting the
      // positioning call. Confirmed live: a real Math_Kim page's second
      // line, positioned via a relative Td (not T*), silently failed to
      // move after a color-fix write -- pdf.js's error recovery meant a
      // completely different content stream elsewhere on the page (or
      // background) is what the writer's fix-and-verify loop kept
      // measuring, driving the recurring documentwide symptom "recoloring
      // has no measurable effect, same ratio before and after every
      // escalation attempt." T* takes no operands of its own, so this
      // never corrupted anything there -- purely why the existing
      // multi-line fixture (which uses T* for its continuation lines)
      // never caught it.
      case 'Td': case 'TD': {
        if (runHasShow) { flushRun(runEndBeforePendingOperands(tk)); runStart = tk.end; }
        const tx = num(operands[operands.length - 2]);
        const ty = num(operands[operands.length - 1]);
        if (op === 'TD') tld = -ty;
        tmE += tlmA * tx;
        tmF += tlmD * ty;
        break;
      }
      case 'Tm':
        if (runHasShow) { flushRun(runEndBeforePendingOperands(tk)); runStart = tk.end; }
        tlmA = num(operands[operands.length - 6]);
        tlmD = num(operands[operands.length - 3]);
        tmE = num(operands[operands.length - 2]);
        tmF = num(operands[operands.length - 1]);
        break;
      case 'T*':
        if (runHasShow) { flushRun(runEndBeforePendingOperands(tk)); runStart = tk.end; }
        tmF -= tlmD * tld;
        break;
      case 'Tj': case 'TJ': {
        if (!runHasShow) { runAnchorX = deviceX(tmE); runAnchorY = deviceY(tmF); runScaleY = Math.abs(tlmD); runHasShow = true; }
        runLastShowEnd = tk.end;
        break;
      }
      // `'`/`"` are a positioning move (T*'s tmF shift) FUSED with a show
      // op in one operator -- unlike Tj/TJ above, they can legitimately
      // start a NEW run (CodeRabbit finding on PR #544): treating them as
      // "just another show in the current run" (the original code) kept a
      // PRIOR line's anchor for the new, differently-positioned line the
      // quote actually shows, so a target near the quoted line either
      // matched the wrong (first) line's span or missed entirely. Mirrors
      // the Td/TD/Tm/T* pattern above: flush before the quote's own
      // operand(s) (runEndBeforePendingOperands -- '`'` takes one string
      // operand, `"` takes two numbers plus a string; either way `operands`
      // holds only tokens accumulated since the last operator fired), then
      // start the new run there and compute ITS OWN anchor after the move,
      // rather than reusing whatever anchor an earlier Tj already set.
      case "'": case '"': {
        if (runHasShow) {
          const nextRunStart = runEndBeforePendingOperands(tk);
          flushRun(nextRunStart);
          runStart = nextRunStart;
        }
        tmF -= tlmD * tld;
        runAnchorX = deviceX(tmE);
        runAnchorY = deviceY(tmF);
        runScaleY = Math.abs(tlmD);
        runHasShow = true;
        runLastShowEnd = tk.end;
        break;
      }
      case 'ET': flushRun(tk.start); break;
      default: break;
    }
    operands.length = 0;
  }

  return units;
}

export interface EnclosingTextObject {
  /** Byte offset of the `BT` operator that opens the text object containing `runStart`. */
  btStart: number;
  /** The CTM (scale+translate only, matching this file's axis-aligned-only convention) in effect at `btStart`. */
  ctm: { a: number; d: number; e: number; f: number };
}

/**
 * Finds the `BT` that opens the text object containing byte offset
 * `runStart` (typically a `TextRunMatch.start`/`end`), plus the CTM in
 * effect at that point. `q`/`Q` — and therefore path-painting operators like
 * `re`/`f` — are illegal inside `BT…ET` (PDF32000-1:2008 Annex A), so a
 * caller wanting to draw something (e.g. a backplate rectangle) "behind" a
 * located text run must insert it before the run's *enclosing* `BT`, not at
 * the run's own start/end — this locates that insertion point. The CTM is
 * returned so the caller can counteract it (e.g. via its own `q [inverse]
 * cm ... Q` wrapper) and draw in plain device-space coordinates regardless
 * of whatever transform is already ambient at the insertion point.
 *
 * Returns null if `runStart` isn't actually inside a `BT…ET` block (should
 * not happen for a genuine `TextRunMatch`, but this module makes no
 * assumption about caller correctness).
 */
// b/c non-zero beyond this is treated as a genuine shear/rotation, not
// floating-point noise from the content stream's own decimal formatting.
const SHEAR_EPSILON = 1e-6;

export function locateEnclosingTextObject(content: string, runStart: number): EnclosingTextObject | null {
  const tokens = tokenize(content);

  // CodeRabbit finding on PR #545: this module's a/d/e/f-only Ctm tracks
  // scale+translate and silently drops a `cm`'s b/c (rotation/skew)
  // operands -- fine for locateTextRun's anchor matching (a wrong anchor
  // there just costs a match, not a wrong paint), but spliceBackplate
  // inverts the returned ctm and draws a real rectangle through it: a local
  // shear (possible even on a page with zero page-level rotation, e.g.
  // `1 0.1 0 1 0 0 cm` before BT) silently becomes an identity inverse,
  // painting a skewed or misplaced backplate. `sheared` is tracked as part
  // of the CTM state itself (saved/restored by q/Q exactly like a/d/e/f) --
  // a shear applied and then properly reverted via q/cm[shear]/Q before
  // reaching btStart must NOT taint the result. Reject rather than guess
  // when a shear IS still in effect at btStart, matching this whole
  // subsystem's governing "bail to failure, don't guess" principle --
  // support for genuinely sheared content is a real, separate undertaking
  // (tracking and inverting the full 6-component affine matrix), not a
  // quick fix.
  type Ctm = { a: number; d: number; e: number; f: number; sheared: boolean };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0, sheared: false };
  const ctmStack: Ctm[] = [];
  const operands: Array<{ t: string; v: string; start: number; end: number }> = [];

  let btStart: number | null = null;
  let btCtm: Ctm | null = null;

  for (const tk of tokens) {
    if (tk.start >= runStart) break;
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;
    switch (op) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = { ...p }; break; }
      case 'cm': {
        const a = num(operands[operands.length - 6]);
        const b = num(operands[operands.length - 5]);
        const c = num(operands[operands.length - 4]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        const thisOpSheared = Math.abs(b) > SHEAR_EPSILON || Math.abs(c) > SHEAR_EPSILON;
        ctm = {
          a: ctm.a * a, d: ctm.d * d, e: ctm.a * e + ctm.e, f: ctm.d * f + ctm.f,
          sheared: ctm.sheared || thisOpSheared,
        };
        break;
      }
      case 'BT': btStart = tk.start; btCtm = { ...ctm }; break;
      case 'ET': btStart = null; btCtm = null; break;
      default: break;
    }
    operands.length = 0;
  }

  if (btStart === null || btCtm === null || btCtm.sheared) return null;
  return { btStart, ctm: btCtm };
}

/**
 * The CTM (scale+translate only, same axis-aligned-only convention as
 * EnclosingTextObject) in effect immediately before byte offset `position`
 * -- unlike locateEnclosingTextObject, `position` need not be inside a
 * `BT…ET` block at all. Used by pdf-structure-writer.service.ts's
 * fixInvisibleTextArtifact to confirm a text run being relocated out of a
 * real tagged region has the SAME ambient transform at both its original
 * position and the destination it's being moved to -- if they differ, the
 * run's own absolute Tm coordinates would render at a different page
 * position after the move, a real (if usually small) visual regression
 * this fix must never silently risk. Returns null when a shear/rotation is
 * in effect at `position` (see SHEAR_EPSILON's call site above for why
 * that case is refused rather than compensated for).
 */
export function computeCtmAt(content: string, position: number): { a: number; d: number; e: number; f: number } | null {
  const tokens = tokenize(content);
  type Ctm = { a: number; d: number; e: number; f: number; sheared: boolean };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0, sheared: false };
  const ctmStack: Ctm[] = [];
  const operands: Array<{ t: string; v: string; start: number; end: number }> = [];

  for (const tk of tokens) {
    if (tk.start >= position) break;
    if (tk.t !== 'op') { operands.push(tk); continue; }
    switch (tk.v) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = { ...p }; break; }
      case 'cm': {
        const a = num(operands[operands.length - 6]);
        const b = num(operands[operands.length - 5]);
        const c = num(operands[operands.length - 4]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        const thisOpSheared = Math.abs(b) > SHEAR_EPSILON || Math.abs(c) > SHEAR_EPSILON;
        ctm = {
          a: ctm.a * a, d: ctm.d * d, e: ctm.a * e + ctm.e, f: ctm.d * f + ctm.f,
          sheared: ctm.sheared || thisOpSheared,
        };
        break;
      }
      default: break;
    }
    operands.length = 0;
  }

  if (ctm.sheared) return null;
  return { a: ctm.a, d: ctm.d, e: ctm.e, f: ctm.f };
}

/**
 * Core of locateTextRun, operating on already-tokenized/already-walked
 * state so locateTextRunsForPage can reuse one tokenize()+findTextUnits()
 * pass across every target on a page instead of repeating both per issue.
 */
function locateTextRunFromUnits(
  tokens: Token[],
  units: TextUnit[],
  target: { x: number; baselineY: number },
  tolerancePt: number
): TextRunMatch | null {
  const candidates = units
    .filter((u): u is TextUnit & { anchorX: number; anchorY: number } => u.anchorX !== null && u.anchorY !== null)
    .map(u => ({ ...u, dist: Math.hypot(u.anchorX - target.x, u.anchorY - target.baselineY) }))
    .filter(u => u.dist <= tolerancePt)
    .sort((a, b) => a.dist - b.dist);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const runnerUp = candidates[1];
  const scaleRatio = runnerUp ? Math.min(best.scaleY, runnerUp.scaleY) / Math.max(best.scaleY, runnerUp.scaleY) : 1;
  const runnerUpIsSubscriptLike = scaleRatio <= SUBSCRIPT_SCALE_RATIO_THRESHOLD;
  const proximityAmbiguous =
    !!runnerUp && (runnerUp.dist - best.dist) <= AMBIGUITY_MARGIN && !runnerUpIsSubscriptLike;

  // Search only up to the run's own LAST show op, not its full [start,end) --
  // content between the last show and the run's end boundary is graphics-
  // state setup for whatever the NEXT run shows (the run only ends on a
  // positioning op, not on "no more shows follow"), so a color op there
  // paints nothing within THIS run. Confirmed live: a caption run ("Table
  // 4.1.2.") immediately followed -- with no intervening positioning op --
  // by a color change setting up the NEXT run's (unrelated) text color. The
  // full-span search found that trailing op as this run's sole "internal"
  // one and told spliceColorFix to overwrite it in place -- silently
  // recoloring nothing the caption actually shows, while also corrupting
  // the next run's intended color, every time. lastShowEnd is never null
  // here: flushRun only ever pushes a unit when runHasShow is true, and
  // runLastShowEnd is set in the same branch that sets runHasShow.
  const fillOps = findFillColorOps(tokens, best.start, best.lastShowEnd!);
  const mixedColor = fillOps.length > 1;

  const ambiguous = proximityAmbiguous || mixedColor;
  let confidence = confidenceForDistance(best.dist);
  if (proximityAmbiguous) confidence = Math.max(0, confidence - AMBIGUITY_PENALTY);
  if (mixedColor) confidence = 0;

  return {
    start: best.start,
    end: best.end,
    confidence,
    ambiguous,
    internalFillColorOp: fillOps.length === 1 ? fillOps[0] : undefined,
    lastShowEnd: best.lastShowEnd!,
  };
}

/**
 * Finds the text run whose anchor is closest to `target`, within
 * `tolerancePt`. Returns null if nothing is close enough. Flags `ambiguous`
 * (and reduces confidence) when a near-equally-close runner-up run exists,
 * or the matched run sets its fill color more than once internally.
 */
export function locateTextRun(
  content: string,
  target: { x: number; baselineY: number },
  tolerancePt = 12
): TextRunMatch | null {
  const tokens = tokenize(content);
  const units = findTextUnits(tokens);
  return locateTextRunFromUnits(tokens, units, target, tolerancePt);
}

/**
 * Finds up to `maxSiblings` text runs immediately AFTER `afterRun`, in
 * document order, within the SAME enclosing `BT...ET` text object. Used
 * when a run located by POSITION isn't actually the one with a real
 * contrast defect (see pdf-contrast-writer.service.ts's own caller for the
 * real incident this addresses): pdfjs's own `getTextContent()` coalesces
 * adjacent same-line `Tj`/`TJ` calls into ONE logical text item for
 * detection purposes, regardless of internal content-stream color-operator
 * boundaries between them (confirmed live: a "8 749 47" table cell is one
 * pdfjs item combining a near-white "8" and pure-black "749"/"47", and the
 * validator's own pixel sampling across that whole item's bbox produces one
 * meaningless BLENDED color, e.g. #262626 -- neither segment's real color).
 * The audit issue's own target position always anchors to the FIRST
 * segment ("8"), which `locateTextRun` then correctly, unambiguously finds
 * as its OWN narrow run (a `Td` between "8" and "749" already ends the run
 * right there, by this module's own run-boundary rules) -- but that segment
 * usually isn't the one that's actually low-contrast. This function finds
 * the SIBLING runs the audit's own item-level blending hid, so a caller can
 * check each one's own true color and fix whichever genuinely fails.
 *
 * Each returned TextRunMatch carries `anchorX`/`anchorY` (always present
 * here, unlike a position-matched run) so a caller can build a bounding box
 * for a run the original audit issue never described. `confidence` is
 * always 1 and `ambiguous` reflects only whether the sibling itself has a
 * mixed-color internal structure (its own `internalFillColorOp` is set only
 * when exactly one exists, same convention as `locateTextRun`) -- these
 * runs are found by structural adjacency, not position-distance, so the
 * distance-based confidence/ambiguity model doesn't apply.
 */
export function findSiblingRuns(
  content: string,
  afterRun: TextRunMatch,
  maxSiblings = 8
): TextRunMatch[] {
  const enclosing = locateEnclosingTextObject(content, afterRun.start);
  if (!enclosing) return [];

  const tokens = tokenize(content);
  const units = findTextUnits(tokens);
  const result: TextRunMatch[] = [];

  for (const u of units) {
    if (u.start < afterRun.end) continue;
    const unitEnclosing = locateEnclosingTextObject(content, u.start);
    // Units are in document order (findTextUnits appends as it scans), so
    // the first one outside the original text object means every
    // subsequent unit is too -- safe to stop rather than skip.
    if (!unitEnclosing || unitEnclosing.btStart !== enclosing.btStart) break;
    if (u.anchorX === null || u.anchorY === null) continue;

    const ops = findFillColorOps(tokens, u.start, u.lastShowEnd!);
    let restoreColorOverride: [number, number, number] | undefined;
    if (ops.length > 0) {
      const finalColor = parseFillColorOpToRgb(content, ops[ops.length - 1]);
      if (finalColor !== null) restoreColorOverride = finalColor;
    }

    result.push({
      start: u.start,
      end: u.end,
      confidence: 1,
      ambiguous: ops.length > 1,
      internalFillColorOp: ops.length === 1 ? ops[0] : undefined,
      lastShowEnd: u.lastShowEnd!,
      restoreColorOverride,
      anchorX: u.anchorX,
      anchorY: u.anchorY,
    });
    if (result.length >= maxSiblings) break;
  }

  return result;
}

/**
 * Parses a single fill-color op's raw operand text (as located by
 * findFillColorOps -- operands through the operator keyword) into unit
 * (0-1) RGB. Returns null for `sc`/`scn`, whose operand count and meaning
 * depend on the current (untracked-by-this-module) /ColorSpace -- declining
 * rather than guessing a wrong color, same "bail rather than guess"
 * discipline as everywhere else in this file.
 */
function parseFillColorOpToRgb(content: string, op: { start: number; end: number }): [number, number, number] | null {
  const parts = content.slice(op.start, op.end).trim().split(/\s+/);
  const opName = parts[parts.length - 1];
  const nums = parts.slice(0, -1).map(Number);
  if (nums.some(n => Number.isNaN(n))) return null;
  switch (opName) {
    case 'g': return nums.length === 1 ? [nums[0], nums[0], nums[0]] : null;
    case 'rg': return nums.length === 3 ? [nums[0], nums[1], nums[2]] : null;
    case 'k': {
      if (nums.length !== 4) return null;
      const [c, m, y, k] = nums;
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    default: return null;
  }
}

/**
 * Finds the RGB value that was ACTUALLY in effect immediately before
 * `beforePos` in the whole content stream -- walks every token from the
 * start of the stream up to that position, simulating the real graphics-
 * state color stack (`q` pushes the current color, `Q` pops it back), not
 * scoped to any one run or text object.
 *
 * This is what pdf-contrast-writer.service.ts's spliceColorFix restores
 * after a fix, and it matters which color that is: a fixed run's OWN
 * reported/measured color (issue.contrastData.foreground, or
 * TextRunMatch.restoreColorOverride's "run's own true final color") is NOT
 * necessarily what unrelated LATER content in the stream needs restored.
 * Confirmed live on Math_Weir_PDF.pdf: a tiny "error" superscript
 * annotation's own original color was gray, uniquely, as a one-off local
 * style -- restoring to that gray after fixing it to black left gray as
 * the active fill color for several unrelated, ordinary body-text words
 * that followed, which had never been gray and were never meant to be,
 * registering as brand-new contrast failures the original document never
 * had. The color that actually needs restoring is whatever was active
 * immediately BEFORE this run started (in that case, black, inherited from
 * further upstream) -- which this function derives directly from the
 * stream itself instead of from anything specific to the run being fixed.
 *
 * MUST track `q`/`Q` scope, not just take the textually-nearest preceding
 * op: a naive linear scan (this function's original implementation) picks
 * up a color set *inside* an already-closed `q...Q` block as if it were
 * still ambient. Confirmed live on Math_Weir_PDF.pdf, round 2 of a real
 * Auto Mode run: pdf-contrast-backplate.ts's spliceBackplate deliberately
 * wraps its rectangle's `1 1 1 rg` (white) in its own `q...Q` so it can't
 * leak into surrounding text -- but a LATER cell's own recolor-fix restore,
 * computed by the old linear scan, found that scoped white as the
 * "nearest preceding rg" and restored white as if it were genuinely
 * ambient. Real PDF graphics-state semantics say `Q` already popped that
 * color back to whatever was active before the backplate's own `q` by the
 * time execution reaches any later content -- this walk simulates exactly
 * that instead of trusting raw textual proximity. Confirmed as the actual
 * mechanism behind a 19-cell cluster of new near-white-on-white contrast
 * regressions across three rows of one dense table: the leaked white
 * became the ambient color for every subsequent ambient-only text run
 * (the overwhelming majority of this document's text objects carry no
 * color op of their own) until the next explicit color reset.
 *
 * Declines (returns null) rather than guessing when the color in effect at
 * `beforePos` was last set by `sc`/`scn` (colorspace-dependent, unparseable
 * without tracking /ColorSpace -- same "bail rather than guess" discipline
 * as parseFillColorOpToRgb itself): that op genuinely IS the ambient color
 * right before `beforePos`, so falling back to an earlier op would return a
 * color that's no longer actually in effect there, an active wrong guess
 * rather than a declined unknown. Falls back to pure black ([0,0,0], the
 * PDF default initial fill color per PDF32000-1:2008 §8.6.3) only when NO
 * fill-color op is in effect at all (never set, or every `q` this position
 * is nested in was pushed before any color op ever ran).
 */
export function findPrecedingColor(content: string, beforePos: number): [number, number, number] | null {
  const tokens = tokenize(content);

  // 'unset' = the PDF default black, never overridden by any op seen so far
  // at this stack depth. 'unknown' = last set by an unparseable sc/scn.
  type ColorState = { kind: 'rgb'; rgb: [number, number, number] } | { kind: 'unknown' } | { kind: 'unset' };

  let current: ColorState = { kind: 'unset' };
  const stack: ColorState[] = [];
  let pendingStart: number | null = null;

  for (const tk of tokens) {
    if (tk.start >= beforePos) break;
    if (tk.t !== 'op') {
      if (pendingStart === null) pendingStart = tk.start;
      continue;
    }
    if (tk.v === 'q') {
      stack.push(current);
    } else if (tk.v === 'Q') {
      current = stack.pop() ?? current; // unbalanced Q: nothing sensible to revert to
    } else if (FILL_COLOR_OPS.has(tk.v)) {
      const rgb = parseFillColorOpToRgb(content, { start: pendingStart ?? tk.start, end: tk.end });
      current = rgb ? { kind: 'rgb', rgb } : { kind: 'unknown' };
    }
    pendingStart = null;
  }

  if (current.kind === 'rgb') return current.rgb;
  if (current.kind === 'unset') return [0, 0, 0];
  return null;
}

export interface PageContrastTarget {
  id: string;
  x: number;
  baselineY: number;
}

// Structurally-confirmed ordinal pairing (reading-order correspondence
// within a tight same-line Y-band, gated on an exact count match -- see
// locateTextRunsForPage) is a real fact, not a distance estimate, but it's
// a newer, less-proven mechanism than the direct single-target anchor
// match -- kept at the existing MIN_APPLY_CONFIDENCE/MIN_CONTRAST_FIX_
// CONFIDENCE floor (0.80) with a small margin rather than the 0.95 tier
// reserved for a near-exact single-anchor match.
const ORDINAL_PAIRING_CONFIDENCE = 0.85;

// Two device-space anchors within this many points are treated as "the
// same line" for clustering purposes -- much tighter than locateTextRun's
// own 12pt anchor-match tolerance (which exists to absorb pdfjs-vs-content-
// stream position discrepancies for a SINGLE target/run pair) since here
// the question is "are these genuinely the same baseline", and real
// distinct lines are normally separated by a full line-height (10pt+).
const SAME_LINE_Y_TOLERANCE = 2;

/**
 * Locates every target's text run for ALL of a page's color-contrast issues
 * at once, extending plain locateTextRun to handle two real patterns it
 * can't: (a) a single text run that changes its own fill color more than
 * once internally (e.g. plain black text with one colored word embedded --
 * "The answer is <red>one</red>."), which locateTextRun correctly refuses
 * (mixedColor -> confidence 0) since it has no way to tell which of the
 * run's several colors corresponds to the target; (b) several separate,
 * single-color runs sitting close enough together that locateTextRun's own
 * proximity-ambiguity check correctly refuses to pick one.
 *
 * Confirmed live against Math_Kim's real remaining COLOR-CONTRAST issues:
 * both patterns are common (colored math answers/blanks embedded in
 * otherwise-black instructional text; small custom-font marker glyphs
 * clustered together) and account for the large majority of the issues
 * plain locateTextRun can't confidently resolve on its own.
 *
 * The fix does NOT estimate an exact device-space position for a run's
 * later internal segments (that needs real font-metrics-based advance-width
 * tracking, a substantial undertaking this module doesn't have) --
 * instead, it relies on a structural fact that needs no font metrics at
 * all: PDF text within one run renders in byte order (= reading order), and
 * separate runs on the same visual line are ordered left-to-right by their
 * own anchors. So: within a tight same-line Y-band, if the number of
 * "colorable positions" available (one per run with no internal color
 * changes, or one per internally-color-delimited segment for a run that
 * has some) EXACTLY equals the number of unresolved target issues in that
 * band, sort both by X and pair them ordinally. This only ever proceeds on
 * a genuine structural count-match -- never a distance estimate -- and
 * falls back to "no match" (exactly locateTextRun's own existing failure
 * mode) whenever the counts disagree, rather than guessing.
 *
 * Every target that plain locateTextRun already resolves confidently
 * (matched, not ambiguous, confidence >= the existing 0.80 floor) is left
 * completely untouched by this extension -- zero behavior change for the
 * cases that already worked.
 */
export function locateTextRunsForPage(
  content: string,
  targets: PageContrastTarget[],
  tolerancePt = 12
): Map<string, TextRunMatch | null> {
  const tokens = tokenize(content);
  const units = findTextUnits(tokens);
  const anchoredUnits = units.filter((u): u is TextUnit & { anchorX: number; anchorY: number } => u.anchorX !== null && u.anchorY !== null);

  const result = new Map<string, TextRunMatch | null>();
  const unresolved: PageContrastTarget[] = [];

  for (const target of targets) {
    const m = locateTextRunFromUnits(tokens, units, target, tolerancePt);
    if (m && !m.ambiguous && m.confidence >= 0.80) {
      result.set(target.id, m);
    } else {
      unresolved.push(target);
    }
  }

  if (unresolved.length === 0) return result;

  // One "slot" per colorable position on the page: a run with zero internal
  // fill-color changes contributes exactly one slot (its own full span);
  // a run with K internal changes contributes K+1 slots, one per color-
  // delimited segment, ordered by byte position (= reading order within
  // that run). segmentOrder breaks ties between same-run slots, which
  // necessarily share the run's own single tracked anchor (findTextUnits
  // has no notion of a segment's own position -- see this function's doc
  // comment for why that's fine here).
  interface Slot {
    run: TextUnit & { anchorX: number; anchorY: number };
    internalOp?: { start: number; end: number };
    segmentOrder: number;
    restoreColorOverride?: [number, number, number];
  }
  const slots: Slot[] = [];
  for (const run of anchoredUnits) {
    const ops = findFillColorOps(tokens, run.start, run.lastShowEnd!);
    if (ops.length === 0) {
      slots.push({ run, internalOp: undefined, segmentOrder: 0 });
      continue;
    }
    // The run's TRUE final color -- needed to correctly restore state after
    // fixing ANY of this run's segments, not just its last one (see
    // TextRunMatch.restoreColorOverride's own doc comment). Declining the
    // whole run (not just the affected segment) when this can't be parsed
    // matches this module's "bail rather than guess" discipline: fixing a
    // segment without a trustworthy restore value risks leaving the
    // graphics state on the wrong color for whatever renders after this
    // run, a new defect this module must never introduce.
    const finalColor = parseFillColorOpToRgb(content, ops[ops.length - 1]);
    if (finalColor === null) continue;
    for (let i = 0; i <= ops.length; i++) {
      slots.push({
        run,
        internalOp: i === 0 ? undefined : ops[i - 1],
        segmentOrder: i,
        restoreColorOverride: finalColor,
      });
    }
  }

  // Greedy same-line clustering: sort unresolved targets by Y, then group
  // consecutive ones within SAME_LINE_Y_TOLERANCE of the cluster's first
  // member. Real distinct lines are separated by a full line-height
  // (comfortably over this tolerance), so this doesn't merge genuinely
  // different lines even on a densely-set page.
  const sortedTargets = [...unresolved].sort((a, b) => a.baselineY - b.baselineY);
  const clusters: PageContrastTarget[][] = [];
  for (const t of sortedTargets) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(t.baselineY - last[0].baselineY) <= SAME_LINE_Y_TOLERANCE) {
      last.push(t);
    } else {
      clusters.push([t]);
    }
  }

  for (const cluster of clusters) {
    const clusterY = cluster[0].baselineY;
    const candidateSlots = slots.filter(s => Math.abs(s.run.anchorY - clusterY) <= SAME_LINE_Y_TOLERANCE);
    if (candidateSlots.length !== cluster.length) continue; // not a confident structural match -- leave unresolved (null)

    const sortedClusterTargets = [...cluster].sort((a, b) => a.x - b.x);
    const sortedSlots = [...candidateSlots].sort((a, b) => a.run.anchorX - b.run.anchorX || a.segmentOrder - b.segmentOrder);

    for (let i = 0; i < sortedClusterTargets.length; i++) {
      const slot = sortedSlots[i];
      result.set(sortedClusterTargets[i].id, {
        start: slot.run.start,
        end: slot.run.end,
        lastShowEnd: slot.run.lastShowEnd!,
        confidence: ORDINAL_PAIRING_CONFIDENCE,
        ambiguous: false,
        internalFillColorOp: slot.internalOp,
        restoreColorOverride: slot.restoreColorOverride,
      });
    }
  }

  for (const target of unresolved) {
    if (!result.has(target.id)) result.set(target.id, null);
  }

  return result;
}
