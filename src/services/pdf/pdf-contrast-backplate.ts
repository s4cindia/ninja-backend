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

import type { EnclosingTextObject } from './contrast-content-stream';
import { RENDER_SCALE } from './color-contrast-verification';

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

  const topPad = TIER0_ABOVE_CANVAS_PX / RENDER_SCALE;
  const rightPad = (TIER0_RIGHT_GAP_CANVAS_PX + TIER0_RIGHT_WIDTH_CANVAS_PX) / RENDER_SCALE;
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
 * Inserts a filled-rectangle sequence before `enclosing.btStart`, wrapped in
 * its own `q [inverse-CTM] cm ... Q` so `rect`'s coordinates can be plain
 * device-space PDF points regardless of whatever transform is already
 * ambient at that point in the content stream (the same axis-aligned-only
 * assumption — scale + translate, no rotation/skew — already governing
 * every other CTM computation in this subsystem).
 *
 * Returns null (rather than guessing) when `enclosing.ctm` has a collapsed
 * axis (a or d is 0) — the matrix isn't invertible, and this subsystem's
 * whole convention is to bail rather than draw something wrong.
 */
export function spliceBackplate(
  content: string,
  enclosing: EnclosingTextObject,
  rect: BackplateRect,
  colorRgb: [number, number, number]
): string | null {
  const { a, d, e, f } = enclosing.ctm;
  if (a === 0 || d === 0) return null;

  const invA = 1 / a;
  const invD = 1 / d;
  const invE = -e / a;
  const invF = -f / d;

  const [r, g, b] = colorRgb;
  const snippet =
    `\nq\n${invA} 0 0 ${invD} ${invE} ${invF} cm\n` +
    `${r} ${g} ${b} rg\n` +
    `${rect.x} ${rect.y} ${rect.width} ${rect.height} re\n` +
    `f\nQ\n`;

  return content.slice(0, enclosing.btStart) + snippet + content.slice(enclosing.btStart);
}
