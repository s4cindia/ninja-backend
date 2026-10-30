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
// PDF32000-1:2008 §9.4.3 text-showing operators.
const TEXT_SHOW_OPS = new Set(["Tj", 'TJ', "'", '"']);

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

export interface ArtifactNestingViolation {
  /**
   * Byte offset of the nested real tag's own FIRST operand (its tag name,
   * e.g. `/Span` -- NOT the BDC/BMC operator's own offset, which sits AFTER
   * the tag name in PDF's postfix syntax; splicing at the operator's offset
   * would leave the tag name itself stranded outside both spans, corrupting
   * the content stream -- same hazard pdf-structure-writer.service.ts's own
   * findEnclosingBdcTarget already documents and guards against). Insert
   * `EMC ` here to close the enclosing Artifact early, right before this tag
   * opens.
   */
  closeArtifactBefore: number;
  /** Byte offset right after this real tag's own matching EMC. Insert `/Artifact BMC ` here to reopen the Artifact for whatever comes next. */
  reopenArtifactAfter: number;
}

/**
 * Matterhorn 01-004 ("Tagged content is present inside content marked as
 * Artifact", UA1:7.1-1, machine-testable) — confirmed live via a real
 * PAC/axesPAC report on Farrar_2E_Comp_188910.pdf: 76 real structure
 * elements (Span/Figure/PlacedPDF/H6) nested inside an /Artifact span,
 * inherited untouched from the document's original (InDesign) producer.
 * Unlike findUntaggedPathRuns above, this never has to decide whether
 * something is decorative — the nested content already carries its own
 * real structure tag, so the only question is a pure structural fact: does
 * the enclosing Artifact's own marked-content boundary wrongly include it.
 *
 * Only the OUTERMOST real tag in a nested chain is reported (and later
 * fixed) — a real tag nested inside another real tag that's already being
 * excised from the Artifact doesn't need (or get) its own separate
 * violation, since splitting the Artifact around the outer tag already
 * carries the inner one out along with it.
 */
export function findTaggedContentInsideArtifact(content: string): ArtifactNestingViolation[] {
  const tokens = tokenize(content);
  const violations: ArtifactNestingViolation[] = [];

  const stack: Array<{ isArtifact: boolean; ownsViolation: boolean }> = [];
  const openViolationStarts: Array<number | null> = [];
  const operands: Token[] = [];

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    if (op === 'BDC' || op === 'BMC') {
      const tagName = operands.length ? operands[0].v : '';
      const tagStart = operands.length ? operands[0].start : tk.start;
      const isArtifact = tagName === '/Artifact';
      const isOC = tagName === '/OC';
      const isReal = op === 'BDC' && !isArtifact && !isOC;

      const hasArtifactAncestor = stack.some((s) => s.isArtifact);
      const hasViolationAncestor = stack.some((s) => s.ownsViolation);
      const isNewViolation = isReal && hasArtifactAncestor && !hasViolationAncestor;

      stack.push({ isArtifact, ownsViolation: isNewViolation });
      openViolationStarts.push(isNewViolation ? tagStart : null);
      operands.length = 0;
      continue;
    }
    if (op === 'EMC') {
      stack.pop();
      const openStart = openViolationStarts.pop() ?? null;
      if (openStart !== null) {
        violations.push({ closeArtifactBefore: openStart, reopenArtifactAfter: tk.end });
      }
      operands.length = 0;
      continue;
    }

    if (op === 'BI') {
      // Inline image: BI <dict> ID <binary> EI -- same corruption hazard
      // (and same fix) as findUntaggedPathRuns's own BI handling above:
      // locate EI directly in the source and skip every token inside that
      // span, never letting the tokenizer interpret raw image bytes.
      const idm = /\bID\b/.exec(content.slice(tk.end));
      const from = idm ? tk.end + idm.index + 2 : tk.end;
      const eim = /\sEI\b/.exec(content.slice(from));
      const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
      while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
      operands.length = 0;
      continue;
    }

    operands.length = 0;
  }

  return violations;
}

/**
 * Applies findTaggedContentInsideArtifact's violations: for each one,
 * closes the enclosing Artifact right before the nested real tag opens and
 * reopens a fresh Artifact right after it closes -- splitting one
 * `/Artifact BMC … EMC` span into two around the real content, never
 * touching the real tag's own bytes or any path/text/image operator.
 * Applied right-to-left so earlier insertions don't invalidate later
 * offsets (same convention as tagUntaggedPaintedPaths above). When two
 * violations are adjacent -- one's reopen point and the next one's close
 * point have nothing but whitespace between them, the overwhelmingly
 * common real shape for a run of back-to-back real tags all sharing one
 * outer Artifact (e.g. 38 consecutive Spans confirmed real on one page of
 * Farrar_2E_Comp_188910.pdf) -- the pair is skipped rather than inserting
 * an empty open/close Artifact span with nothing meaningful between them.
 *
 * Both insertions carry a LEADING space -- confirmed real and necessary
 * live: `closeArtifactBefore` can land immediately after a bare keyword
 * operator (e.g. `BT`, confirmed on Farrar_2E_Comp_188910.pdf's page 68),
 * and unlike `/` (a real PDF delimiter, safe with no leading space before
 * the reopened `/Artifact`), plain letters are NOT self-delimiting --
 * `BT` immediately followed by an unspaced `EMC` tokenizes as the single
 * garbage operator `BTEMC`, silently swallowing the fix and leaving the
 * Artifact open. A leading space is always harmless and guarantees a real
 * token boundary regardless of what precedes the insertion point.
 */
export function splitArtifactAroundTaggedContent(content: string): { content: string; count: number } {
  const violations = findTaggedContentInsideArtifact(content);
  if (violations.length === 0) return { content, count: 0 };

  const isOnlyWhitespaceBetween = (start: number, end: number): boolean =>
    end >= start && content.slice(start, end).trim() === '';

  const sorted = [...violations].sort((a, b) => a.closeArtifactBefore - b.closeArtifactBefore);
  type Edit = { offset: number; text: string };
  const edits: Edit[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    if (!(prev && isOnlyWhitespaceBetween(prev.reopenArtifactAfter, v.closeArtifactBefore))) {
      edits.push({ offset: v.closeArtifactBefore, text: ' EMC ' });
    }
    const next = i + 1 < sorted.length ? sorted[i + 1] : null;
    if (!(next && isOnlyWhitespaceBetween(v.reopenArtifactAfter, next.closeArtifactBefore))) {
      edits.push({ offset: v.reopenArtifactAfter, text: ' /Artifact BMC ' });
    }
  }

  edits.sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const edit of edits) {
    out = out.slice(0, edit.offset) + edit.text + out.slice(edit.offset);
  }

  return { content: out, count: violations.length };
}

export interface OversizedArtifactSpan {
  /** Offset of the top-level Artifact's own opening BDC/BMC operator. */
  openOpStart: number;
  /** Offset right after that opening operator -- where the span's own content begins. */
  contentStart: number;
  /** Offset of the matching EMC operator that closes this span. */
  closeOpStart: number;
  /** Offset right after that matching EMC. */
  closeOpEnd: number;
  /** Count of text-show/path-paint operators found directly inside this span (depth 1, not inside any further nested tag). */
  opCount: number;
  /** True if any PATH-painting operator (not just text) was found inside -- see findOversizedArtifactSpans's own doc comment for why this gates auto-fix eligibility. */
  hasPathOps: boolean;
}

// Real legitimate decorative spans (page numbers, running heads) confirmed
// on Farrar_2E_Comp_188910.pdf top out around 2 ops; every confirmed real
// swallowing case on that same document (23 of 124 pages, scanned via
// scripts/scan-artifact-swallowing-wide.ts) was 59-317 ops. 15 sits safely
// between the two clusters.
const DEFAULT_SWALLOWED_CONTENT_OP_THRESHOLD = 15;

/**
 * Finds every TOP-LEVEL `/Artifact BMC … EMC` span (one not already nested
 * inside something else -- a nested one is a different, already-covered
 * shape, see findTaggedContentInsideArtifact above) whose own directly-
 * contained text-show/path-paint operator count exceeds a legitimate
 * header/footer/page-number's real size.
 *
 * Distinct from BOTH existing Artifact-related defects in this file:
 * unlike findTaggedContentInsideArtifact (01-004), the content in here
 * carries NO real tag at all, nested or otherwise; unlike
 * findUntaggedPathRuns (01-005), the content isn't bare -- it already has
 * an Artifact wrapper, just one whose own boundary is wrong. Confirmed live
 * on Farrar_2E_Comp_188910.pdf's page 12: a single `/Artifact BMC` opens
 * covering a legitimate page-number + running-head, but never closes where
 * it should -- it continues straight through two full real body paragraphs
 * and a heading, all genuinely never tagged, finally closing 1870+
 * characters later. A real validator (PAC/axesPAC) flags this as untagged
 * content because Artifact-wrapped content is invisible to the structure
 * tree exactly as if it had no tag at all; Ninja's own existing 01-005
 * detection (findUntaggedPathRuns) can't see it either, by design --
 * findUntaggedPathRuns deliberately treats ANY existing BDC/BMC (Artifact
 * included) as "already handled," since a bona fide decorative Artifact is
 * legitimate and correct.
 */
export function findOversizedArtifactSpans(
  content: string,
  opThreshold = DEFAULT_SWALLOWED_CONTENT_OP_THRESHOLD
): OversizedArtifactSpan[] {
  const tokens = tokenize(content);
  const spans: OversizedArtifactSpan[] = [];

  let depth = 0;
  let current: { openOpStart: number; contentStart: number; opCount: number; hasPathOps: boolean } | null = null;
  const operands: Token[] = [];

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    if (op === 'BDC' || op === 'BMC') {
      const tagName = operands.length ? operands[0].v : '';
      if (depth === 0 && tagName === '/Artifact') {
        current = { openOpStart: tk.start, contentStart: tk.end, opCount: 0, hasPathOps: false };
      }
      depth++;
      operands.length = 0;
      continue;
    }
    if (op === 'EMC') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && current) {
        if (current.opCount > opThreshold) {
          spans.push({
            openOpStart: current.openOpStart,
            contentStart: current.contentStart,
            closeOpStart: tk.start,
            closeOpEnd: tk.end,
            opCount: current.opCount,
            hasPathOps: current.hasPathOps,
          });
        }
        current = null;
      }
      operands.length = 0;
      continue;
    }
    if (op === 'BI') {
      // Inline image: skip the binary payload, same hazard/fix as every
      // other function in this file.
      const idm = /\bID\b/.exec(content.slice(tk.end));
      const from = idm ? tk.end + idm.index + 2 : tk.end;
      const eim = /\sEI\b/.exec(content.slice(from));
      const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
      while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
      operands.length = 0;
      continue;
    }

    if (depth === 1 && current && (TEXT_SHOW_OPS.has(op) || PATH_PAINT_OPS.has(op))) {
      current.opCount++;
      if (PATH_PAINT_OPS.has(op)) current.hasPathOps = true;
    }
    operands.length = 0;
  }

  return spans;
}

export interface ArtifactTextRun {
  /** Decoded (PDF-string-escape-resolved) visible text shown by this text-show call. Whitespace-only calls are omitted. */
  text: string;
  /** Byte offset of this text-show operator's own first operand -- the correct splice anchor if this run is chosen as the real-content boundary. */
  start: number;
  /** Device-space baseline Y at the moment this text was shown (PDF Y-up convention: larger is higher on the page). */
  y: number;
}

function decodePdfStringLiteral(raw: string): string {
  const inner = raw.slice(1, -1); // strip the surrounding ( )
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { out += c; continue; }
    const next = inner[i + 1];
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b') { out += '\b'; i++; }
    else if (next === 'f') { out += '\f'; i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next === '\n' || next === '\r') { i++; } // escaped line break -- not part of the string
    else if (next >= '0' && next <= '7') {
      let oct = next;
      let consumed = 1;
      while (consumed < 3 && inner[i + 1 + consumed] >= '0' && inner[i + 1 + consumed] <= '7') {
        oct += inner[i + 1 + consumed];
        consumed++;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i += consumed;
    } else { out += next; i++; }
  }
  return out;
}

/**
 * Extracts every text-show call (`Tj`/`TJ`/`'`/`"`) whose operator offset
 * falls within `[rangeStart, rangeEnd)`, each with its decoded visible text
 * and the device-space Y it was shown at. Tracks CTM/text-matrix state
 * (`q`/`Q`/`cm`/`BT`/`Td`/`TD`/`Tm`/`T*`) across the WHOLE content stream
 * (not just the range) so a transform established before the range starts
 * is still correctly accounted for -- same state-tracking convention as
 * zone-extractor/seam-c/content-stream.ts's own tagContentStream, scoped
 * here to just the Y position of EVERY text-show call rather than only the
 * first one per BT block.
 */
export function extractArtifactTextRuns(content: string, rangeStart: number, rangeEnd: number): ArtifactTextRun[] {
  const tokens = tokenize(content);
  const runs: ArtifactTextRun[] = [];

  type Ctm = { a: number; d: number; e: number; f: number };
  let ctm: Ctm = { a: 1, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];
  // Only the Y (baseline) component matters for this function's own
  // boundary-candidate purpose -- unlike Seam-C's own tagContentStream,
  // which also tracks X for column/zone assignment.
  let tmF = 0;
  let tld = 0;
  const deviceY = (tF: number): number => ctm.d * tF + ctm.f;
  const num = (t: Token | undefined): number => (t && t.t === 'n' ? parseFloat(t.v) : 0);
  const operands: Token[] = [];

  const recordTextShow = (tk: Token): void => {
    if (tk.start < rangeStart || tk.start >= rangeEnd) return;
    const strOperands = operands.filter((o) => o.t === 's');
    if (strOperands.length === 0) return;
    const text = strOperands.map((o) => decodePdfStringLiteral(o.v)).join('');
    if (text.trim().length === 0) return;
    runs.push({ text, start: operands[0].start, y: deviceY(tmF) });
  };

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    switch (op) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = p; break; }
      case 'cm': {
        const a = num(operands[operands.length - 6]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        ctm = { a: ctm.a * a, d: ctm.d * d, e: ctm.a * e + ctm.e, f: ctm.d * f + ctm.f };
        break;
      }
      case 'BT': tmF = 0; break;
      case 'TL': tld = num(operands[operands.length - 1]); break;
      case 'Td': case 'TD': {
        const ty = num(operands[operands.length - 1]);
        if (op === 'TD') tld = -ty;
        tmF += ty;
        break;
      }
      case 'Tm':
        tmF = num(operands[operands.length - 1]);
        break;
      case 'T*': tmF -= tld; break;
      case "'": case '"':
        tmF -= tld;
        // falls through -- these also show text, same as Tj/TJ
      case 'Tj': case 'TJ':
        recordTextShow(tk);
        break;
      case 'BI': {
        const idm = /\bID\b/.exec(content.slice(tk.end));
        const from = idm ? tk.end + idm.index + 2 : tk.end;
        const eim = /\sEI\b/.exec(content.slice(from));
        const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
        while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
        break;
      }
      default: break;
    }
    operands.length = 0;
  }

  return runs;
}

/**
 * Candidate split point between an Artifact span's legitimate decorative
 * opening (page number, running head) and the real content it wrongly
 * swallows: the single largest consecutive baseline-Y drop (PDF Y-up --
 * moving down the page) among the span's own text runs. Confirmed shape on
 * Farrar_2E_Comp_188910.pdf page 12: one large drop from the running
 * head's own baseline to the first real paragraph's baseline, with every
 * OTHER drop (line-to-line within a paragraph) consistently much smaller.
 * Only a starting hint for the AI-assisted confirmation step -- never
 * trusted on its own, see analyzeArtifactSwallowsContent in
 * ai-analysis.service.ts.
 */
export function computeHeuristicBoundaryIndex(runs: ArtifactTextRun[]): number {
  if (runs.length < 2) return 0;
  let maxDrop = -Infinity;
  let maxDropIndex = 0;
  for (let i = 1; i < runs.length; i++) {
    const drop = runs[i - 1].y - runs[i].y;
    if (drop > maxDrop) { maxDrop = drop; maxDropIndex = i; }
  }
  return maxDropIndex;
}

/**
 * Splits an oversized Artifact span at `realContentStart`: closes the
 * Artifact there and immediately opens a fresh `/Span <</MCID n>>` tag for
 * whatever follows. Deliberately a SINGLE insertion, not a close+reopen
 * pair the way splitArtifactAroundTaggedContent needs -- the span's own
 * PRE-EXISTING closing EMC (never touched) now correctly closes the new
 * Span instead of the Artifact, since the Artifact was already closed by
 * this one insertion. v1 scope: treats everything from realContentStart
 * through the span's own original close as real content -- does not
 * detect or preserve a second trailing decorative footer within the same
 * span (not seen in any real case so far; see this function's own
 * call site for the real-document verification this was checked against).
 * Leading space on the insertion, same established reason as
 * splitArtifactAroundTaggedContent above: realContentStart can land
 * immediately after a bare keyword operator, and plain letters aren't
 * self-delimiting.
 */
export function applyArtifactUnwrap(content: string, realContentStart: number, mcid: number): string {
  const insertion = ` EMC /Span <</MCID ${mcid}>> BDC `;
  return content.slice(0, realContentStart) + insertion + content.slice(realContentStart);
}

export interface ArtifactTextSegment {
  /** Offset where this segment's own fresh /Span should open (closing whatever's currently open there -- the enclosing Artifact, or a re-opened one from an earlier segment in the same span). */
  start: number;
  /** Offset right after this segment's last real text-show operator. */
  end: number;
}

/**
 * Within a single "complex" oversized Artifact span (one with hasPathOps
 * true -- see findOversizedArtifactSpans), finds every maximal run of real
 * text-show operators uninterrupted by any path-paint op. Each returned
 * segment is exactly the real content that needs its own structure tag;
 * everything NOT covered by a segment (the decorative drawing in between)
 * is left exactly as-is, still Artifact-wrapped -- this function never has
 * to judge whether that graphics content is itself decorative or a real
 * chart/diagram, which is the one thing a geometry-only check can't safely
 * do (see ai-analysis.service.ts's own ARTIFACT_SWALLOWS_CONTENT_COMPLEX_CODES
 * doc comment). Confirmed live on Farrar_2E_Comp_188910.pdf's two-column
 * glossary-table pages: draw a grid-line separator, print one term +
 * definition pair, draw the next separator, repeat -- each term/definition
 * pair comes back as its own segment, 1 to a few dozen per page.
 */
export function findRealTextSegmentsInSpan(content: string, span: OversizedArtifactSpan): ArtifactTextSegment[] {
  const segments: ArtifactTextSegment[] = [];
  const tokens = tokenize(content.slice(span.contentStart, span.closeOpStart));
  const operands: Token[] = [];
  let depth = 0;
  let currentStart: number | null = null;
  let currentEnd = 0;

  const flush = (): void => {
    if (currentStart !== null) {
      segments.push({ start: span.contentStart + currentStart, end: span.contentStart + currentEnd });
      currentStart = null;
    }
  };

  for (const tk of tokens) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;
    if (op === 'BDC' || op === 'BMC') { depth++; operands.length = 0; continue; }
    if (op === 'EMC') { depth = Math.max(0, depth - 1); operands.length = 0; continue; }
    if (depth === 0 && TEXT_SHOW_OPS.has(op)) {
      const strOperands = operands.filter((o) => o.t === 's');
      const text = strOperands.map((o) => decodePdfStringLiteral(o.v)).join('');
      if (text.trim().length > 0) {
        if (currentStart === null) currentStart = operands.length ? operands[0].start : tk.start;
        currentEnd = tk.end;
      }
      operands.length = 0;
      continue;
    }
    if (depth === 0 && PATH_PAINT_OPS.has(op)) flush();
    operands.length = 0;
  }
  flush();
  return segments;
}

/**
 * Builds the content-stream edits (and the fresh MCIDs assigned to each
 * one) that free every segment findRealTextSegmentsInSpan found inside a
 * single span -- closes the Artifact right before each segment, opens a
 * fresh `/Span <</MCID n>>` there, closes that Span right after the
 * segment's own last text-show op, and re-opens `/Artifact BMC` immediately
 * after IF there's more content before the next segment (or the span's own
 * original close) -- skipped when there isn't, so the span's pre-existing
 * closing EMC keeps closing the new Span directly, same convention as
 * applyArtifactUnwrap's own single-cut case (of which this is the general
 * N-segment form). Pure/offset-only -- apply with the caller's own
 * right-to-left splice pass, same as every other multi-edit content-stream
 * rewrite in this codebase.
 */
export function buildArtifactSplitEdits(
  segments: ArtifactTextSegment[],
  spanCloseOpStart: number,
  mcidStart: number
): { edits: Array<{ offset: number; text: string }>; mcids: number[] } {
  const edits: Array<{ offset: number; text: string }> = [];
  const mcids: number[] = [];
  segments.forEach((seg, i) => {
    const mcid = mcidStart + i;
    mcids.push(mcid);
    edits.push({ offset: seg.start, text: ` EMC /Span <</MCID ${mcid}>> BDC ` });
    const nextBoundary = i + 1 < segments.length ? segments[i + 1].start : spanCloseOpStart;
    if (seg.end < nextBoundary) {
      edits.push({ offset: seg.end, text: ` EMC /Artifact BMC ` });
    }
  });
  return { edits, mcids };
}
