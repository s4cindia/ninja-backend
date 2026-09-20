/**
 * Untagged Painted-Path Tagger
 *
 * Matterhorn 01-005 ("Content is neither marked as Artifact nor tagged as
 * real content", UA1:7.1-2, machine-testable) has never had validator
 * coverage in this codebase. Confirmed live on a real 377-page document
 * (Math_Weir_PDF via the real PAC/axesPAC desktop tool, not Ninja's own
 * audit): ~24,000 vector-graphics path-paint sequences across every page
 * carry no marked-content tag at all — neither a real structure tag nor a
 * bare `/Artifact` — because the document arrived already tagged by its
 * original producer (Ninja's own Seam-C from-scratch autotagger, the only
 * place in the codebase that currently tags painted paths, only runs for
 * genuinely untagged PDFs and was skipped here).
 *
 * Two confirmed real sources, both purely decorative:
 *   1. A near-universal ~2-per-page cluster of tiny corner tick-marks
 *      (print-production crop/registration marks), present on every page.
 *   2. Dense numeric tables' own row/header background-shading rectangles
 *      (a `0 0 0 0.7 k` header fill, alternating `0 0 0 0.08/0.12 k`
 *      zebra-striped row fills) — the actual DATA is carried by the
 *      already-correctly-tagged text in each cell; the shading rectangles
 *      behind them are pure visual styling.
 *
 * Fix: wrap every painted-path sequence that has no enclosing marked-
 * content tag in `/Artifact BMC … EMC`. Deliberately `BMC` (bare tag, no
 * property list) not `BDC <</Artifact ...>>` — mirrors
 * zone-extractor/seam-c/content-stream.ts's own established reasoning
 * (closeRun there): `/Artifact BDC` makes a strict validator look up
 * `/Artifact` in the page's `/Properties` dictionary, which most PDFs
 * don't have, and fail with "Undefined property" (a real veraPDF finding
 * on that code path).
 *
 * Deliberately scoped to painted paths only (not `Do`/`BI`/`sh` as their own
 * detected/fixed content): the same real document's untagged `Do` (image)
 * and text (`BT…ET`) content was already correctly wrapped by its original
 * producer — only paths were left bare. `Do`/`sh` remain hard boundaries
 * that close a run rather than being auto-artifacted themselves — an
 * untagged image is far more likely to be genuine content needing alt text
 * than decoration, which is a job for the alt-text pipeline, not this
 * module (see pac-report.service.ts's own comment on why 01-005 isn't
 * claimed as fully Ninja-tested here). Reuses `tokenize` from the Seam-C
 * tagger rather than calling into `tagContentStream` directly: that
 * function assumes it's tagging a wholly *untagged* document from scratch
 * (every BT/Do/path unconditionally gets a fresh tag), which would
 * double-wrap the vast majority of this document's content that is already
 * correctly tagged.
 *
 * Not every untagged path is safe to auto-artifact, either — see
 * UntaggedPathRun.hasCurves's own doc comment for the real curved-shape
 * case this module found and deliberately declines to auto-fix (a
 * decorative rounded-rectangle chapter-heading banner, confirmed by
 * inspection, not a chart — but the point of the heuristic is exactly to
 * not have to trust that inspection at fix time).
 */

import { tokenize } from '../zone-extractor/seam-c/content-stream';

type Token = ReturnType<typeof tokenize>[number];

// Mirrors content-stream.ts's own path-start / path-paint operator sets —
// PDF32000-1:2008 §8.5.2 (path construction) and §8.5.3 (path-painting).
const PATH_START_OPS = new Set(['m', 're', 'l', 'c', 'v', 'y', 'h']);
const PATH_PAINT_OPS = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);

// Curve-construction operators specifically (a subset of PATH_START_OPS) —
// see UntaggedPathRun.hasCurves's own doc comment for why this matters.
const CURVE_OPS = new Set(['c', 'v', 'y']);

export interface UntaggedPathRun {
  /** Byte offset of the first path-construction operand in this run. */
  start: number;
  /** Byte offset right after the run's last path-painting operator. */
  end: number;
  /**
   * True if any path-construction operator in this run is a Bezier curve
   * (`c`/`v`/`y`) rather than only straight lines/rectangles (`m`/`l`/`re`/
   * `h`). CodeRabbit finding, confirmed real: this module's detection alone
   * proves a path is untagged, never that it's decorative — a tagged PDF
   * could contain a genuine untagged vector chart, map, diagram, or logo,
   * and blindly artifacting one would hide real content from assistive
   * technology, which is worse than leaving it untagged. Every real
   * instance confirmed on Math_Weir_PDF.pdf (crop marks, table row/header
   * shading) uses only straight lines and rectangles; illustrative content
   * complex enough to matter overwhelmingly needs curves to render
   * anything but boxes. Callers use this to gate auto-apply eligibility —
   * see pdf-structure.validator.ts's UNTAGGED-CONTENT vs
   * UNTAGGED-CONTENT-COMPLEX split.
   */
  hasCurves: boolean;
}

/**
 * Finds every run of one-or-more consecutive untagged painted-path
 * sequences in a decoded content stream. Consecutive untagged paths
 * separated only by graphics-state/color-setting operators (`q`/`Q`/`cm`/
 * `rg`/`k`/`w`/`gs`/…) are merged into a single run — matching a real
 * page's shape (a header-row fill, then a color change, then a batch of
 * zebra-stripe row fills, all one cohesive decorative region) rather than
 * producing one tiny Artifact wrapper per fill call. A run is only ever
 * broken by something that means "this is no longer the same untagged
 * region": entering already-tagged content (`BDC`/`BMC`), leaving it
 * (`EMC`), or a text/image/shading operator (`BT`/`Do`/`BI`/`sh`) — the
 * latter three are never expected to be untagged on a document already
 * confirmed to tag them correctly, but are treated as a hard boundary
 * rather than silently absorbed if they ever are.
 *
 * A path used only for clipping (`W n`, ending in `n` rather than a paint
 * operator) draws nothing and needs no tag at all — correctly produces no
 * run, matching the Seam-C tagger's own `case 'n':` handling.
 *
 * Two real bugs found by CodeRabbit on this module's first version, both
 * fixed here:
 *
 * 1. `BDC`/`BMC` whose tag name is `/OC` marks OPTIONAL CONTENT (layer
 *    visibility, ISO 32000-1:2008 §8.11) — semantically unrelated to
 *    accessibility tagging. Content sitting in `/OC /MC0 BDC … EMC` with no
 *    REAL structure tag or `/Artifact` around it is still genuinely
 *    untagged for Matterhorn 01-005 purposes; treating any `BDC`/`BMC` as
 *    "already handled" (the original version) produced a false negative —
 *    a real untagged path silently missed. A stack of {isReal} entries
 *    (not a flat depth counter) tracks this correctly even when a real tag
 *    and an OC layer nest in either order.
 *
 * 2. `BI … ID <binary data> EI` (an inline image) was only handled as a
 *    boundary that resets path tracking — the token loop still walked
 *    through the image's own binary payload afterward, parsing arbitrary
 *    image bytes as if they were content-stream operators. A real
 *    uncompressed inline image whose sample data happens to contain a byte
 *    sequence like `m`/`l`/`S` would then be detected as a "path run", and
 *    tagUntaggedPaintedPaths would splice `/Artifact BMC` directly into the
 *    middle of the image's binary data — corrupting it. Mirrors
 *    content-stream.ts's own `case 'BI':` handling: locates `EI` directly
 *    in the raw string and skips every token whose offset falls inside
 *    that span, never letting the tokenizer's own token stream drive
 *    interpretation of the image bytes at all.
 */
export function findUntaggedPathRuns(content: string): UntaggedPathRun[] {
  const tokens = tokenize(content);
  const runs: UntaggedPathRun[] = [];

  // Tracks whether each currently-open BDC/BMC is a REAL accessibility tag
  // (Artifact or a structure type) vs. an unrelated `/OC` optional-content
  // marker — only a real tag suppresses detection of what's inside it.
  const tagStack: boolean[] = [];
  let markedContentDepth = 0;
  let pathOperandStart: number | null = null;
  let pathHasCurve = false;
  let currentRun: UntaggedPathRun | null = null;
  const operands: Token[] = [];

  const closeRun = (): void => {
    if (currentRun) { runs.push(currentRun); currentRun = null; }
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    if (op === 'BDC' || op === 'BMC') {
      const tagName = operands.length ? operands[0].v : '';
      const isReal = tagName !== '/OC';
      tagStack.push(isReal);
      if (isReal) markedContentDepth++;
      closeRun();
      operands.length = 0;
      continue;
    }
    if (op === 'EMC') {
      const wasReal = tagStack.pop() ?? true; // unbalanced EMC: assume real, matches prior depth-clamping behavior
      if (wasReal) markedContentDepth = Math.max(0, markedContentDepth - 1);
      closeRun();
      operands.length = 0;
      continue;
    }

    if (markedContentDepth > 0) {
      // Already inside a real tag or an existing Artifact — not this
      // module's concern. Reset any in-progress (tagged) path tracking so
      // it can't leak into content encountered after the next EMC.
      pathOperandStart = null;
      pathHasCurve = false;
      operands.length = 0;
      continue;
    }

    if (op === 'BI') {
      // Inline image: BI <dict> ID <binary> EI. Locate EI directly in the
      // source (the tokenizer can't parse raw image bytes as tokens) and
      // skip every token inside that span — see this function's own doc
      // comment for the real corruption this prevents.
      closeRun();
      pathOperandStart = null;
      pathHasCurve = false;
      const idm = /\bID\b/.exec(content.slice(tk.end));
      const from = idm ? tk.end + idm.index + 2 : tk.end;
      const eim = /\sEI\b/.exec(content.slice(from));
      const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
      while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
      operands.length = 0;
      continue;
    }

    if (op === 'BT' || op === 'Do' || op === 'sh') {
      // A hard boundary: some other kind of untagged content. Out of
      // scope for this module (see class doc comment) — close whatever
      // path run was open rather than merging across it.
      closeRun();
      pathOperandStart = null;
      pathHasCurve = false;
      operands.length = 0;
      continue;
    }

    if (PATH_START_OPS.has(op)) {
      if (pathOperandStart === null) {
        pathOperandStart = operands.length ? operands[0].start : tk.start;
      }
      if (CURVE_OPS.has(op)) pathHasCurve = true;
      operands.length = 0;
      continue;
    }

    if (PATH_PAINT_OPS.has(op)) {
      if (pathOperandStart !== null) {
        const unitEnd = tk.end;
        if (currentRun) {
          currentRun.end = unitEnd; // merge into the open run
          currentRun.hasCurves = currentRun.hasCurves || pathHasCurve;
        } else {
          currentRun = { start: pathOperandStart, end: unitEnd, hasCurves: pathHasCurve };
        }
        pathOperandStart = null;
        pathHasCurve = false;
      }
      operands.length = 0;
      continue;
    }

    if (op === 'n') {
      pathOperandStart = null; // clip-only path — never painted, no tag needed
      pathHasCurve = false;
      operands.length = 0;
      continue;
    }

    // Any other operator (q/Q/cm/rg/g/k/w/gs/j/J/M/d/ri/i/…) while a run is
    // open doesn't close it — it's setup for whatever paints next in the
    // same untagged region.
    operands.length = 0;
  }
  closeRun();

  return runs;
}

/**
 * Wraps every untagged painted-path run in `/Artifact BMC … EMC`. Returns
 * the original content unchanged (same string instance) when there is
 * nothing to tag, so a caller can cheaply check `count === 0` to skip a
 * page entirely.
 */
export function tagUntaggedPaintedPaths(content: string): { content: string; count: number } {
  const runs = findUntaggedPathRuns(content);
  if (runs.length === 0) return { content, count: 0 };

  // Apply right-to-left so earlier insertions don't invalidate later offsets
  // — the same convention used throughout this codebase's other content-
  // stream splicers (contrast-content-stream.ts, pdf-contrast-backplate.ts).
  const sorted = [...runs].sort((a, b) => b.start - a.start);
  let out = content;
  for (const run of sorted) {
    out = out.slice(0, run.start) + '/Artifact BMC ' + out.slice(run.start, run.end) + ' EMC ' + out.slice(run.end);
  }

  return { content: out, count: runs.length };
}
