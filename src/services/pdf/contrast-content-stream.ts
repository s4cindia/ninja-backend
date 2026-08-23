// Locates the content-stream byte range of a specific text object (BT…ET),
// given the device-space anchor point of the text a color-contrast issue was
// flagged against. Read-only — this only finds a byte range; Phase B2 does
// the actual rewrite.
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
  /** Byte offset of the unit's `BT`. */
  start: number;
  /** Byte offset immediately after the unit's `ET`. */
  end: number;
  /** 0-1. Reflects match distance and, when true, is reduced for ambiguity — never a claim about fix correctness beyond "this is the right span". */
  confidence: number;
  /** True when a near-equally-close runner-up unit exists, or the unit's fill color changes mid-object. */
  ambiguous: boolean;
  /**
   * Byte range of the single internal fill-color operator (operands through
   * the operator keyword) within [start,end), when exactly one exists.
   *
   * pdf-lib (and most authoring tools) emit a fill-color op *inside* BT…ET,
   * immediately after BT — e.g. `BT\n0.6 0.6 0.6 rg\n...\nTj\n...\nET`. An
   * outer q/<color>/Q wrap around the whole unit is silently overridden by
   * this internal op before Tj ever executes, making the wrap a no-op on
   * real text. When present, the writer must replace this span directly
   * instead of (or as well as) wrapping. Undefined when zero internal fill
   * ops exist (nothing to conflict with — wrapping is safe and sufficient).
   * Always undefined when `ambiguous` is true from a mixed-color unit.
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

/** Walks the tokenized content stream, collecting every BT…ET unit's byte range and first-shown-text device-space anchor. */
function findTextUnits(tokens: Token[]): TextUnit[] {
  const units: TextUnit[] = [];

  type Ctm = { a: number; d: number; e: number; f: number };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];
  let inText = false;
  let btStart = -1;
  let tld = 0;
  let tmE = 0;
  let tmF = 0;
  let firstX: number | null = null;
  let firstY: number | null = null;
  const operands: Array<{ t: string; v: string; start: number; end: number }> = [];

  const deviceX = (tE: number): number => ctm.a * tE + ctm.e;
  const deviceY = (tF: number): number => ctm.d * tF + ctm.f;

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
      case 'BT': inText = true; btStart = tk.start; tmE = 0; tmF = 0; firstX = null; firstY = null; break;
      case 'TL': tld = num(operands[operands.length - 1]); break;
      case 'Td': case 'TD': {
        const tx = num(operands[operands.length - 2]);
        const ty = num(operands[operands.length - 1]);
        if (op === 'TD') tld = -ty;
        tmE += tx;
        tmF += ty;
        break;
      }
      case 'Tm':
        tmE = num(operands[operands.length - 2]);
        tmF = num(operands[operands.length - 1]);
        break;
      case 'T*': tmF -= tld; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        if (op === "'" || op === '"') tmF -= tld;
        if (firstY === null) { firstX = deviceX(tmE); firstY = deviceY(tmF); }
        break;
      }
      case 'ET': {
        if (inText) units.push({ start: btStart, end: tk.end, anchorX: firstX, anchorY: firstY });
        inText = false; btStart = -1;
        break;
      }
      default: break;
    }
    operands.length = 0;
  }

  return units;
}

/**
 * Finds the BT…ET unit whose first-shown text anchor is closest to `target`,
 * within `tolerancePt`. Returns null if nothing is close enough. Flags
 * `ambiguous` (and reduces confidence) when a near-equally-close runner-up
 * exists, or the matched unit sets its fill color more than once internally.
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
