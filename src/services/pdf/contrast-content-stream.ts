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
}

interface TextUnit {
  start: number;
  end: number;
  anchorX: number | null;
  anchorY: number | null;
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

  const deviceX = (tE: number): number => ctm.a * tE + ctm.e;
  const deviceY = (tF: number): number => ctm.d * tF + ctm.f;

  const flushRun = (endPos: number): void => {
    if (runHasShow) units.push({ start: runStart, end: endPos, anchorX: runAnchorX, anchorY: runAnchorY });
    runHasShow = false;
    runAnchorX = null;
    runAnchorY = null;
  };

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
      case 'BT': tmE = 0; tmF = 0; tlmA = 1; tlmD = 1; runStart = tk.end; runHasShow = false; runAnchorX = null; runAnchorY = null; break;
      case 'TL': tld = num(operands[operands.length - 1]); break;
      // A positioning op only ends the current run if a show op has already
      // fired since it began — otherwise this is still the run's lead-in
      // (e.g. a color op followed by a Tm, both before the first Tj) and
      // must stay part of the same run's span, not get cut off from it.
      case 'Td': case 'TD': {
        if (runHasShow) { flushRun(tk.start); runStart = tk.start; }
        const tx = num(operands[operands.length - 2]);
        const ty = num(operands[operands.length - 1]);
        if (op === 'TD') tld = -ty;
        tmE += tlmA * tx;
        tmF += tlmD * ty;
        break;
      }
      case 'Tm':
        if (runHasShow) { flushRun(tk.start); runStart = tk.start; }
        tlmA = num(operands[operands.length - 6]);
        tlmD = num(operands[operands.length - 3]);
        tmE = num(operands[operands.length - 2]);
        tmF = num(operands[operands.length - 1]);
        break;
      case 'T*':
        if (runHasShow) { flushRun(tk.start); runStart = tk.start; }
        tmF -= tlmD * tld;
        break;
      case 'Tj': case 'TJ': case "'": case '"': {
        if (op === "'" || op === '"') tmF -= tlmD * tld;
        if (!runHasShow) { runAnchorX = deviceX(tmE); runAnchorY = deviceY(tmF); runHasShow = true; }
        break;
      }
      case 'ET': flushRun(tk.start); break;
      default: break;
    }
    operands.length = 0;
  }

  return units;
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

  const candidates = units
    .filter((u): u is TextUnit & { anchorX: number; anchorY: number } => u.anchorX !== null && u.anchorY !== null)
    .map(u => ({ ...u, dist: Math.hypot(u.anchorX - target.x, u.anchorY - target.baselineY) }))
    .filter(u => u.dist <= tolerancePt)
    .sort((a, b) => a.dist - b.dist);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const runnerUp = candidates[1];
  const proximityAmbiguous = !!runnerUp && (runnerUp.dist - best.dist) <= AMBIGUITY_MARGIN;

  const fillOps = findFillColorOps(tokens, best.start, best.end);
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
  };
}
