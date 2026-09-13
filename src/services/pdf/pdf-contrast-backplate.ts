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

/**
 * Computes the backplate rectangle for a contrast issue's `boundingBox`
 * (top-left origin, y grows downward, unscaled PDF points — the same
 * convention PdfContrastValidator.computeTextBoundingBox produces: `y` is
 * the text's BASELINE, `height` is the font size the glyph ascends by
 * *above* that baseline, not a generic top-edge/height box). Converts to
 * the bottom-left-origin, y-up rectangle `re` expects, padded to at least
 * the verification step's own canvas-space minimums.
 */
export function computeBackplateRect(boundingBox: {
  x: number;
  y: number;
  width: number;
  height: number;
  pageHeight: number;
}): BackplateRect {
  return {
    x: boundingBox.x,
    // boundingBox.y is the baseline in top-left terms; pageHeight - y is
    // that same baseline in bottom-left terms, and is also the rect's own
    // (fixed) bottom edge regardless of how much `height` gets padded below
    // — the glyph only ascends *upward* (increasing bottom-left y) from here.
    y: boundingBox.pageHeight - boundingBox.y,
    width: Math.max(boundingBox.width, MIN_CANVAS_WIDTH_PX / RENDER_SCALE),
    height: Math.max(boundingBox.height, MIN_CANVAS_HEIGHT_PX / RENDER_SCALE),
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
