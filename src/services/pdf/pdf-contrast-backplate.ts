/**
 * Backplate rectangle geometry + content-stream splice for the color-
 * contrast writer's third escalation tier (pdf-contrast-writer.service.ts).
 *
 * When text sits on a background too visually non-uniform to confidently
 * measure or fix by recoloring alone (a photo, a gradient, or a nearby
 * element bleeding into the sample), the only reliable fix is a solid-color
 * rectangle drawn behind the text — turning an unmeasurable background into
 * a known, flat one. This module builds that rectangle's geometry and the
 * raw content-stream bytes to draw it; pdf-contrast-writer.service.ts owns
 * deciding *when* to use it (see BUSY_VARIANCE_THRESHOLD in
 * pdf-contrast.validator.ts) and re-verifying the result.
 *
 * Critical constraint: `q`/`Q` — and therefore path-painting operators like
 * `re`/`f` — are illegal inside `BT…ET` (PDF32000-1:2008 Annex A). The
 * rectangle must be inserted before the text run's *enclosing* `BT`, not at
 * the run's own byte offset — see locateEnclosingTextObject in
 * contrast-content-stream.ts, which this module's spliceBackplate consumes.
 */

import { PDFDocument } from 'pdf-lib';
import type { EnclosingTextObject } from './contrast-content-stream';
import { findPrecedingColor } from './contrast-content-stream';
import { RENDER_SCALE } from './color-contrast-verification';
import { decodePageContent, writePageContent } from './pdf-content-stream-io';

export interface BackplateRect {
  /** Bottom-left-origin PDF points — the `re` operator's own convention. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// Mirrors color-contrast-verification.ts's own itemW/itemH floor (10/6
// canvas px at RENDER_SCALE) so the backplate fully covers whatever the
// re-verify step actually samples — undersizing it would leave contaminated
// edge pixels visible to that step, defeating the whole point.
const MIN_CANVAS_WIDTH_PX = 10;
const MIN_CANVAS_HEIGHT_PX = 6;

// CodeRabbit finding on PR #545: sampleBackgroundRobust (pdf-contrast.
// validator.ts) doesn't re-sample the text box itself — its closest
// ("tier 0") background candidates are a 5px strip immediately ABOVE the
// box and a 6px strip starting 4px to its RIGHT. A backplate sized to only
// the text box (this module's original geometry) never touches either
// probe, so re-verification kept sampling the same untouched, still-
// uncertain background and reverting the fix on every real attempt — the
// backplate tier measured 0 real-world wins across this whole feature's
// live validation, which is this exact bug, not rare luck. Extend the
// rect to cover both tier-0 probes so the nearest, first-tried candidates
// read as flat and correctly win the re-sample. (Farther tiers exist for
// cases where tier 0 itself is excluded, e.g. for overlapping another
// text item — not chased here; tier 0 is what a normal case resolves to.)
const TIER0_ABOVE_CANVAS_PX = 5;
const TIER0_RIGHT_GAP_CANVAS_PX = 4;
const TIER0_RIGHT_WIDTH_CANVAS_PX = 6;

// Confirmed live on Math_Weir_PDF.pdf: sizing topPad/rightPad to EXACTLY
// the tier-0 probe distance (no margin) still leaves a real fix stuck.
// sampleBackgroundRobust checks "above" BEFORE "right" (candidates[0]
// before candidates[1]) and picks the FIRST candidate whose variance reads
// as flat -- it does not compare candidates against each other for which
// is MORE flat. The rendered rect's own top edge anti-aliases into
// whatever sits just outside it (Skia softens a hard rectangle edge over
// roughly a pixel, regardless of how precisely the edge coordinate is
// computed), so the "above" strip -- sized to sit immediately flush
// against that edge with zero clearance -- samples a blended color (e.g.
// measured live: #1a1a1a, variance 0.0073) that is NOT the backplate's own
// flat color, but still reads as "flat enough" (comfortably under
// FLAT_VARIANCE_THRESHOLD's 0.02) and wins outright over the genuinely
// perfectly-flat (variance 0) "right" candidate purely by array order. A
// caller re-auditing the fixed document from scratch then measures this
// wrong, blended color as the "background" and the run's own true ink as
// "foreground" against it -- a real contrast failure reading despite the
// backplate rendering correctly (confirmed by direct pixel sampling: the
// probed region is a clean ~91% two-color split of the backplate's exact
// color and the text's exact ink color, with the antialiased edge being a
// small minority of pixels). This margin pushes the rect's edge far enough
// past each probe's own near edge that the probe strip sits entirely
// inside the rect's solidly-covered interior, leaving any antialiasing
// blend on the OUTSIDE of the probe instead of inside it.
const PROBE_ANTIALIAS_MARGIN_CANVAS_PX = 2;

// CodeRabbit finding on PR #545: a descender (g, p, y, j, q) extends below
// the baseline, but the rect's bottom edge previously sat exactly AT the
// baseline — those pixels stayed outside the backplate, still rendered
// against the original background, while re-verification's own ink box
// (which also stops at the baseline) couldn't see the still-broken pixels
// either, letting a genuinely incomplete fix report as verified success.
// 30% of the font size is a generous, deliberately conservative estimate
// (real font descent metrics aren't available at this layer) -- better to
// slightly over-cover than leave a descender exposed.
const DESCENDER_PADDING_FRACTION = 0.3;

/**
 * Computes the backplate rectangle for a contrast issue's `boundingBox`
 * (top-left origin, y grows downward, unscaled PDF points — the same
 * convention PdfContrastValidator.computeTextBoundingBox produces: `y` is
 * the text's BASELINE, `height` is the font size the glyph ascends by
 * *above* that baseline, not a generic top-edge/height box). Converts to
 * the bottom-left-origin, y-up rectangle `re` expects, padded to at least
 * the verification step's own canvas-space minimums, extended to cover its
 * nearest background-sampling probes (above/right), and extended below the
 * baseline for descenders.
 *
 * Known, accepted limitation (CodeRabbit finding on PR #545, deliberately
 * not fixed here): `boundingBox` assumes normal (non-reflected) text —
 * PdfContrastValidator.computeTextBoundingBox always extends `width`
 * rightward from `x` and `height` upward from the baseline, regardless of
 * the source text item's own transform. If a PDF's content stream renders
 * genuinely mirrored text (a negative horizontal/vertical scale on `Tm`,
 * not `cm` — `locateEnclosingTextObject`'s shear/reflection tracking
 * doesn't see this, since `Tm` is a separate transform this file never
 * inspects), this rect would cover the wrong side of the glyphs. Fixing it
 * properly means normalizing `computeTextBoundingBox` itself from the
 * transformed corner points, which affects every contrast issue's
 * boundingBox (recolor tiers too, not just this one), not something
 * scoped to the backplate splice — a separate, larger change. Confirmed
 * absent from the real document this feature was validated against (0
 * reflected text items across all pages); left as a known gap for a
 * document that does have mirrored text, matching this module's own
 * "bail rather than guess" convention EXCEPT that there is no signal left
 * in `boundingBox` by the time it reaches this file to bail on.
 */
export function computeBackplateRect(boundingBox: {
  x: number;
  y: number;
  width: number;
  height: number;
  pageHeight: number;
}): BackplateRect {
  const width = Math.max(boundingBox.width, MIN_CANVAS_WIDTH_PX / RENDER_SCALE);
  const height = Math.max(boundingBox.height, MIN_CANVAS_HEIGHT_PX / RENDER_SCALE);

  const topPad = (TIER0_ABOVE_CANVAS_PX + PROBE_ANTIALIAS_MARGIN_CANVAS_PX) / RENDER_SCALE;
  const rightPad = (TIER0_RIGHT_GAP_CANVAS_PX + TIER0_RIGHT_WIDTH_CANVAS_PX + PROBE_ANTIALIAS_MARGIN_CANVAS_PX) / RENDER_SCALE;
  const descentPad = height * DESCENDER_PADDING_FRACTION;

  return {
    x: boundingBox.x,
    // The baseline (pageHeight - boundingBox.y in bottom-left terms) minus
    // descentPad -- the bottom edge now extends BELOW the baseline to cover
    // descenders, rather than sitting exactly on it.
    y: boundingBox.pageHeight - boundingBox.y - descentPad,
    width: width + rightPad,
    // Both pads extend upward/downward from the original top/bottom edges;
    // height must grow by both to keep each edge at its new position.
    height: height + topPad + descentPad,
  };
}

/**
 * Inserts a filled-rectangle sequence before `enclosing.btStart`. `rect`'s
 * coordinates can be plain device-space PDF points regardless of whatever
 * transform is already ambient at that point in the content stream, by
 * bracketing the draw with `cm [inverse-CTM]` then, after painting, `cm
 * [CTM]` again to put the ambient transform back — the same axis-aligned-
 * only assumption (scale + translate, no rotation/skew) already governing
 * every other CTM computation in this subsystem. Fill color is restored the
 * same way: an explicit `rg` back to whatever `findPrecedingColor` finds
 * genuinely ambient at the insertion point, not a graphics-state pop.
 *
 * Deliberately does NOT use `q`/`Q` to scope the color/CTM change, even
 * though `q [inverse-CTM] cm ... Q` is the more obvious way to write this
 * and *is* legal here (the insertion sits before `BT`, never inside it —
 * unlike the PDF32000-1:2008 Annex A violation this module's sibling,
 * spliceColorFix, hit and fixed in PR #569). Confirmed live on
 * Math_Weir_PDF.pdf: a `q`/`Q`-bracketed rectangle insertion here reliably
 * makes the text run immediately following the inserted `Q` render
 * completely invisible in pdfjs-dist's canvas backend — reproduced across 6
 * real stuck contrast issues, bisected down to the `q`/`Q` pair itself
 * (not the color, not the CTM math, not the path-construction operator
 * choice (`re` vs `m`/`l`/`h`), not an XObject-vs-inline formulation, and
 * not a leftover clip — 5 of the 6 real cases have no clip operator
 * anywhere nearby). The exact upstream pdfjs-dist/canvas mechanism wasn't
 * chased further; the explicit-restore form below was verified empirically
 * (same real cases, same render pipeline) to make the text render
 * correctly, and matches this codebase's own established precedent
 * (findPrecedingColor's doc comment) of preferring a spec-legal, verified-
 * safe explicit restore over a graphics-state stack op whenever the two
 * are otherwise equivalent.
 *
 * Returns null (rather than guessing) when `enclosing.ctm` has a collapsed
 * axis (a or d is 0) — the matrix isn't invertible — or when
 * findPrecedingColor can't determine the genuinely ambient restore color
 * (an untracked `sc`/`scn` colorspace) — this subsystem's whole convention
 * is to bail rather than draw or restore something wrong.
 */
export function spliceBackplate(
  content: string,
  enclosing: EnclosingTextObject,
  rect: BackplateRect,
  colorRgb: [number, number, number],
  resolveColorSpace?: (csName: string, nums: number[]) => [number, number, number] | null
): string | null {
  const { a, d, e, f } = enclosing.ctm;
  if (a === 0 || d === 0) return null;

  const restoreRgb = findPrecedingColor(content, enclosing.btStart, resolveColorSpace);
  if (!restoreRgb) return null;

  const invA = 1 / a;
  const invD = 1 / d;
  const invE = -e / a;
  const invF = -f / d;
  const isIdentity = a === 1 && d === 1 && e === 0 && f === 0;

  const [r, g, b] = colorRgb;
  const [rr, rgVal, rb] = restoreRgb;
  const cancelCm = isIdentity ? '' : `${invA} 0 0 ${invD} ${invE} ${invF} cm\n`;
  const restoreCm = isIdentity ? '' : `${a} 0 0 ${d} ${e} ${f} cm\n`;

  const snippet =
    `\n${cancelCm}` +
    `${r} ${g} ${b} rg\n` +
    `${rect.x} ${rect.y} ${rect.width} ${rect.height} re\n` +
    `f\n` +
    `${rr} ${rgVal} ${rb} rg\n` +
    `${restoreCm}`;

  return content.slice(0, enclosing.btStart) + snippet + content.slice(enclosing.btStart);
}

// Matches spliceBackplate's own snippet shape, anchored to end exactly at
// the search window's end (i.e. immediately touching whatever position is
// sliced up to -- btStart, before this call's own insertion). Captures the
// fill color (the backplate's own rg, not the restore rg after it) and the
// rect's own x/y/width/height.
const PRECEDING_BACKPLATE_RE =
  /(?:[-\d.]+\s+0\s+0\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+cm\s*\n)?([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\s*\n([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re\s*\nf\s*\n[\d.]+\s+[\d.]+\s+[\d.]+\s+rg\s*\n(?:[-\d.]+\s+0\s+0\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+cm\s*\n)?$/;

// Same block shape as PRECEDING_BACKPLATE_RE (built from its own source, to
// stay in sync), minus the trailing `$` anchor -- finds every backplate
// block anywhere in a page's content rather than only one ending at a
// specific cursor. Used by dedupeStackedBackplates to walk a whole page.
const BACKPLATE_BLOCK_SOURCE = PRECEDING_BACKPLATE_RE.source.slice(0, -1);

// Only search the last ~400 chars before btStart -- comfortably more than
// one snippet ever needs (its longest numbers are a handful of digits
// each), so a false match pulled from unrelated, much-earlier content is
// not a realistic risk.
const PRECEDING_BACKPLATE_SEARCH_WINDOW = 400;

export interface PrecedingBackplate {
  color: [number, number, number];
  rect: BackplateRect;
}

// How close two rects' x/y must be (in PDF points) to count as "the same
// run's backplate, redrawn" rather than "a different, nearby run's own
// backplate that happens to share this BT." Generous enough to absorb the
// point-or-so glyph-measurement drift real rounds show (see
// findPrecedingBackplate's own doc comment), tight enough that two
// genuinely different lines (normally a full line-height, ~13pt, apart on
// this corpus) are never conflated.
const SAME_RUN_POSITION_TOLERANCE_PT = 4;

/** True if `a` and `b` are close enough to be the same run's own backplate, redrawn. */
export function isSameBackplatePosition(a: BackplateRect, b: BackplateRect): boolean {
  return Math.abs(a.x - b.x) <= SAME_RUN_POSITION_TOLERANCE_PT && Math.abs(a.y - b.y) <= SAME_RUN_POSITION_TOLERANCE_PT;
}

// How many stacked blocks to walk backward through looking for THIS run's
// own entry before giving up -- see findPrecedingBackplate's own doc
// comment for why a stack, not just the outermost entry, must be searched.
// Confirmed real on Farrar_2E_Comp_188910.pdf (2026-11-05): a page with 3
// sibling runs sharing one BT accumulated 165 backplates total, one single
// position stacked 77 times, after ~45 unconverged Auto Mode rounds. A
// small, fixed sibling-group size (3 here) only ever needs to look back a
// few entries to find its own most recent one; this cap is generously
// larger than any real sibling-group size observed, while still bounding
// the walk's cost against a page that has already accumulated a pathological
// stack before this fix ships (searching all 165 one at a time would be
// wasteful, not incorrect -- the cap trades a theoretical, very rare "stop
// finding mine, stack another" miss on an enormous pre-existing pile for
// guaranteed-bounded work on every call).
const MAX_BACKPLATE_STACK_DEPTH = 30;

/**
 * Detects a backplate THIS function already spliced immediately before
 * `btStart` on a PRIOR call, whose rect position matches `targetRect` --
 * i.e. the SAME run's own backplate, redrawn -- and returns its fill color
 * and rect, or null if none is found within the stack searched.
 *
 * When several DIFFERENT runs share one enclosing BT (a single BT...ET
 * block can contain multiple Tj/TJ operations with inline color changes
 * between them), each one's own backplate is inserted at the exact SAME
 * btStart -- so a round-robin of N sibling runs builds a STACK of N
 * backplates immediately before that shared BT, each round adding N more.
 * Checking only the single most-recently-inserted entry (this function's
 * original behavior) almost never finds THIS run's own: by the time its
 * next turn comes around, 1 to N-1 siblings have already pushed their own
 * fresh entries in front of it. The position check then correctly says
 * "not mine" every time -- not because the check is wrong, but because it
 * was only ever looking at the top of the stack, never searching into it.
 * This function instead walks backward through up to MAX_BACKPLATE_STACK_
 * DEPTH contiguous entries, returning the first (nearest) one whose
 * position actually matches `targetRect`.
 *
 * Real incident, 2026-11-04/05 (Farrar_2E_Comp_188910.pdf, page 118): a
 * caption with 3 short lines (3 sibling COLOR-CONTRAST issues sharing one
 * enclosing BT) never converged across ~45 Auto Mode rounds -- each run's
 * own idempotency check kept finding a SIBLING's backplate immediately in
 * front of the shared BT, never its own, so all 3 kept re-stacking forever.
 * 165 backplates accumulated on that one page alone before this was caught,
 * one position stacked 77 times. Each round's rect is also a SLIGHTLY
 * different size (computeBackplateRect depends on this round's own
 * freshly-measured glyph box, which drifts by a point or so run to run), so
 * they don't perfectly re-cover each other -- a fractionally smaller new
 * rect leaves a 1pt sliver of an EARLIER, differently-colored rect exposed
 * right at the edge, which is the likely cause of a real COLOR-CONTRAST
 * issue oscillating resolved/regressed every round for a SINGLE-sibling
 * case too (the original, narrower incident this function was first built
 * for), not just the stacking volume itself.
 */
export function findPrecedingBackplate(content: string, btStart: number, targetRect: BackplateRect): PrecedingBackplate | null {
  let cursor = btStart;
  for (let i = 0; i < MAX_BACKPLATE_STACK_DEPTH; i++) {
    const windowStart = Math.max(0, cursor - PRECEDING_BACKPLATE_SEARCH_WINDOW);
    const window = content.slice(windowStart, cursor);
    const m = PRECEDING_BACKPLATE_RE.exec(window);
    if (!m) return null;

    const rect: BackplateRect = { x: parseFloat(m[4]), y: parseFloat(m[5]), width: parseFloat(m[6]), height: parseFloat(m[7]) };
    if (isSameBackplatePosition(rect, targetRect)) {
      return { color: [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])], rect };
    }

    // Not this run's own -- step the cursor back to where this (someone
    // else's) block started and keep searching the stack for an older entry.
    cursor = windowStart + m.index;
  }
  return null;
}

export interface BackplateDedupeResult {
  content: string;
  removedCount: number;
  keptCount: number;
}

/**
 * Collapses runs of stacked, same-position backplates (see
 * findPrecedingBackplate's own doc comment for how they accumulate on a
 * document that predates that fix) down to one entry per position -- the
 * one closest to its enclosing BT. That entry is both the most recently
 * spliced AND the one actually visible: content-stream operators paint in
 * order, so a later `re f` renders on top of an earlier one at the same
 * spot.
 *
 * Safe to discard the rest outright, not just visually redundant: every
 * stacked entry's own trailing restore `rg` already resolves to the same
 * true pre-backplate ambient color, because each splice's findPrecedingColor
 * call (see spliceBackplate) finds the immediately-preceding block's own
 * restore op, not its fill -- so the chain of restores is uniform all the
 * way back to the original ambient, regardless of which entry in the stack
 * is kept. Dropping every entry but the last reproduces exactly what the
 * content stream would look like if only that one splice had ever happened.
 *
 * One-time cleanup, not part of the normal fix-application path -- PR #765
 * stops *new* stacking going forward but doesn't retroactively touch a
 * document that already accumulated a pile before that fix shipped (real,
 * live case: Farrar_2E_Comp_188910.pdf page 118, 165 backplates, one
 * position stacked 77 times). Pure function over a raw content string, so
 * it's directly testable; cleanupStackedBackplates below is the page-
 * iterating wrapper that actually applies it to a PDFDocument.
 */
export function dedupeStackedBackplates(content: string): BackplateDedupeResult {
  const re = new RegExp(BACKPLATE_BLOCK_SOURCE, 'g');
  const matches: Array<{ start: number; end: number; rect: BackplateRect }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      rect: { x: parseFloat(m[4]), y: parseFloat(m[5]), width: parseFloat(m[6]), height: parseFloat(m[7]) },
    });
  }
  if (matches.length === 0) return { content, removedCount: 0, keptCount: 0 };

  // Group matches by position, comparing each new match against the
  // group's most-recently-added member (not its first) so gradual
  // round-to-round glyph-measurement drift doesn't silently split one run's
  // long stack into several groups -- same reasoning as findPrecedingBackplate
  // walking the stack instead of only checking one fixed reference point.
  const groups: Array<{ x: number; y: number; members: typeof matches }> = [];
  for (const match of matches) {
    const group = groups.find(
      (g) => Math.abs(g.x - match.rect.x) <= SAME_RUN_POSITION_TOLERANCE_PT && Math.abs(g.y - match.rect.y) <= SAME_RUN_POSITION_TOLERANCE_PT
    );
    if (group) {
      group.members.push(match);
      group.x = match.rect.x;
      group.y = match.rect.y;
    } else {
      groups.push({ x: match.rect.x, y: match.rect.y, members: [match] });
    }
  }

  const toRemove = new Set<number>(); // keyed by each stale match's own `start` offset
  for (const group of groups) {
    for (const stale of group.members.slice(0, -1)) {
      toRemove.add(stale.start);
    }
  }
  if (toRemove.size === 0) return { content, removedCount: 0, keptCount: matches.length };

  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += content.slice(cursor, match.start);
    if (!toRemove.has(match.start)) out += content.slice(match.start, match.end);
    cursor = match.end;
  }
  out += content.slice(cursor);

  return { content: out, removedCount: toRemove.size, keptCount: matches.length - toRemove.size };
}

/**
 * Runs dedupeStackedBackplates across every page of `doc`, rewriting only
 * the pages that actually had stacked duplicates. One-time maintenance
 * operation for a document that hit the pre-#765 sibling-stacking bug
 * before it shipped -- see that function's own doc comment. Returns only
 * the pages that changed, with how many duplicate backplates each lost.
 */
export function cleanupStackedBackplates(doc: PDFDocument): Array<{ page: number; removedCount: number }> {
  const changed: Array<{ page: number; removedCount: number }> = [];
  for (let page = 1; page <= doc.getPageCount(); page++) {
    const content = decodePageContent(doc, page);
    if (!content) continue;
    const result = dedupeStackedBackplates(content);
    if (result.removedCount > 0) {
      writePageContent(doc, page, result.content);
      changed.push({ page, removedCount: result.removedCount });
    }
  }
  return changed;
}
