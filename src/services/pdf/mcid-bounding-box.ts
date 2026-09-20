/**
 * Locates the device-space bounding box of an arbitrary marked-content
 * span's own drawn geometry, given its MCID, by walking a page's decoded
 * content stream. Built to close a real gap found live on Math_Weir_PDF.pdf
 * (a 377-page document): pdf-figure-structtree.validator.ts's own
 * struct-tree-only /Figure detections (a Figure with no discoverable image
 * XObject -- confirmed real content: small vector-drawn math notation and
 * leader-line/label clusters, NOT raster images) never attach a
 * boundingBox, so ai-analysis.service.ts's fallbackToPageRender can only
 * render the WHOLE page for them. On any page with more than one such
 * Figure (60 of 82 real affected pages, up to 12 on one page), every one of
 * those separate issues handed the AI the IDENTICAL full-page image with no
 * way to know which specific figure was being asked about -- confirmed live
 * as the real cause of Auto Mode's round-over-round yield collapsing to
 * near zero after its first pass (433 -> 303 in round 2, then only 3-7 per
 * round for five more rounds, on a document with 283 such issues).
 *
 * Tracks the FULL affine CTM (all six a/b/c/d/e/f values, proper matrix
 * composition on `cm`) -- every real sample inspected on Math_Weir_PDF.pdf
 * (a 12-figure page, plus several single-figure pages) happens to use only
 * translation-only `cm` operands, but a rotated or skewed transform
 * elsewhere in a real document (e.g. a sideways figure caption) must not
 * silently collapse every point to the same coordinate, the way the
 * a/d-only simplification zone-extractor/seam-c/content-stream.ts's own
 * tagContentStream already accepts for its own, different purpose
 * (CodeRabbit finding on PR #583, confirmed real).
 *
 * CTM state is tracked across the ENTIRE page content stream continuously
 * -- q/Q/cm are NEVER reset at a marked-content boundary. Confirmed
 * necessary live: a real q/Q pair on Math_Weir_PDF.pdf's own page 218 is
 * NOT self-contained within a single Figure's own BDC...EMC span (one
 * Figure's span opens with a bare `Q` popping a `q` pushed by an EARLIER
 * sibling Figure's own span) -- resetting CTM at each marked-content
 * boundary would silently compute a wrong-by-hundreds-of-points box.
 *
 * Geometry sources counted toward the box, all confirmed present in real
 * samples:
 *   - Path construction points (m/l/c/v/y, and re's four corners) --
 *     covers stroked leader lines, fraction bars, and filled glyph-like
 *     shapes (e.g. a footnote-marker arrow), AND doubles as free coverage
 *     for a text run's own `re W n` clip rectangle (a clip path is built
 *     from the exact same `re` operator as a painted one; this function
 *     doesn't need to distinguish painted vs. clip-only paths for bbox
 *     purposes -- either way it's real evidence of "content lives here").
 *   - `Do`/inline-image (`BI`) invocations: the unit square's four corners
 *     transformed by the current CTM. This assumes an Image XObject; a
 *     `Do` invoking a FORM XObject instead should really use that form's
 *     own /BBox (transformed by both its own /Matrix and the current CTM),
 *     not a bare unit square (CodeRabbit finding on PR #583, confirmed
 *     real, but deliberately NOT fixed here -- resolving a Form XObject
 *     needs a page-Resources lookup this module doesn't otherwise need at
 *     all, a genuinely bigger, separate undertaking). Confirmed dormant for
 *     the real document this was built against: of Math_Weir_PDF.pdf's 283
 *     real struct-tree-only Figures, exactly one uses `Do` at all, and it
 *     invokes a real Image XObject (`/Im0`) that pdf-alttext.validator.ts's
 *     own image-based path almost certainly already covers, via
 *     computeImageCoveredFigures's exclusion above -- so this gap has zero
 *     measured impact on the document it was built and validated against.
 *   - Text run anchors (Tj/TJ/'/"): the current text matrix's own
 *     translation, transformed through the CTM -- an ANCHOR point only,
 *     not true glyph-width extent (no font metrics available from a raw
 *     content stream). A documented, accepted approximation: real samples
 *     show short (1-3 word/number) runs almost always already bracketed by
 *     a `re W n` clip rectangle covering their own real extent, so this
 *     rarely matters in practice. `T*`/`TL` leading-based line advances are
 *     NOT tracked (unobserved in every real sample, which all use explicit
 *     Td/Tm) -- a text run inside a target span that relies on `T*` alone
 *     would anchor its later lines at the wrong Y, a known, scoped-out gap.
 *
 * Returns an empty map entry (nothing) for a target MCID whose span
 * produced no geometry at all (e.g., an empty nested marker with no real
 * content), or whose BDC was never found -- callers already treat "no
 * boundingBox" as an existing, harmless fallback to a full-page render.
 */

import { tokenize } from '../zone-extractor/seam-c/content-stream';

export interface DeviceBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Token = ReturnType<typeof tokenize>[number];

const num = (t: Token | undefined): number => (t && t.t === 'n' ? parseFloat(t.v) : 0);

/**
 * Computes a device-space (PDF point space, bottom-left origin) bounding
 * box for each target MCID's own drawn content, in a single pass over the
 * page's tokenized content stream. See this file's own header comment for
 * why a single continuous CTM/marked-content walk (not a per-figure
 * restart) is required for correctness.
 */
export function locateMcidBoundingBoxes(
  content: string,
  targetMcids: ReadonlySet<number>,
): Map<number, DeviceBoundingBox> {
  const results = new Map<number, DeviceBoundingBox>();
  if (targetMcids.size === 0) return results;
  const tokens = tokenize(content);

  type Ctm = { a: number; b: number; c: number; d: number; e: number; f: number };
  let ctm: Ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const ctmStack: Ctm[] = [];

  // Marked-content nesting: which currently-open frame (if any) is one of
  // our targets, and at what stack depth it was opened -- lets a nested,
  // unrelated BDC/EMC pair (e.g. an InDesign "/PlacedGraphic" marker) open
  // and close inside a target's own span without ending it early.
  let mcDepth = 0;
  let activeMcid: number | null = null;
  let activeDepth = -1;

  // The most recently closed inline dict `<<...>>`, and its own /MCID (if
  // any) -- consumed by the very next BDC only when that BDC's own
  // properties operand IS this exact dict, checked positionally by token
  // index (not merely "a dict closed recently"), so an intervening
  // unrelated operator (e.g. a DP using its own inline dict) can never be
  // mistaken for this BDC's properties.
  let lastClosedDict: { closeTokenIndex: number; mcid: number | null } | null = null;
  let dictDepth = 0;
  let dictTokens: Token[] = [];

  let tmE = 0;
  let tmF = 0;

  let curMinX = Infinity, curMinY = Infinity, curMaxX = -Infinity, curMaxY = -Infinity;
  const include = (x: number, y: number): void => {
    if (activeMcid === null) return;
    const X = ctm.a * x + ctm.c * y + ctm.e;
    const Y = ctm.b * x + ctm.d * y + ctm.f;
    if (X < curMinX) curMinX = X;
    if (X > curMaxX) curMaxX = X;
    if (Y < curMinY) curMinY = Y;
    if (Y > curMaxY) curMaxY = Y;
  };

  const finalizeActive = (): void => {
    // Requires real extent in AT LEAST one axis, not just "some point was
    // seen" -- a Figure whose only content is a single text anchor (no
    // accompanying path/clip-rect geometry) would otherwise finalize a
    // true single-point box (minX===maxX AND minY===maxY), which a caller
    // padding it for a crop (ai-analysis.service.ts's cropBase64Region)
    // would silently turn into a tiny, useless few-pixel crop instead of
    // falling back to the full page (CodeRabbit finding on PR #583,
    // confirmed real). A genuine flat line (e.g. a horizontal leader line,
    // zero HEIGHT but real width) still correctly passes this check.
    if (
      activeMcid !== null &&
      curMinX <= curMaxX && curMinY <= curMaxY &&
      (curMaxX > curMinX || curMaxY > curMinY)
    ) {
      results.set(activeMcid, { minX: curMinX, minY: curMinY, maxX: curMaxX, maxY: curMaxY });
    }
    activeMcid = null;
    activeDepth = -1;
    curMinX = Infinity; curMinY = Infinity; curMaxX = -Infinity; curMaxY = -Infinity;
  };

  const operands: Token[] = [];

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

    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;

    switch (op) {
      case 'q': ctmStack.push({ ...ctm }); break;
      case 'Q': { const p = ctmStack.pop(); if (p) ctm = p; break; }
      case 'cm': {
        const a = num(operands[operands.length - 6]);
        const b = num(operands[operands.length - 5]);
        const c = num(operands[operands.length - 4]);
        const d = num(operands[operands.length - 3]);
        const e = num(operands[operands.length - 2]);
        const f = num(operands[operands.length - 1]);
        // Full affine composition (new_CTM = [a b c d e f] x ctm, PDF's
        // row-vector convention) -- CodeRabbit finding on PR #583, confirmed
        // real: the previous a/d/e/f-only version silently collapsed every
        // point to a single coordinate under a rotated or skewed `cm` (e.g.
        // a 90-degree `0 1 -1 0 e f cm`). Every real sample inspected on
        // Math_Weir_PDF.pdf uses translation-only `cm` operands, but this is
        // no longer assumed -- b/c are now tracked and applied for real.
        ctm = {
          a: a * ctm.a + b * ctm.c,
          b: a * ctm.b + b * ctm.d,
          c: c * ctm.a + d * ctm.c,
          d: c * ctm.b + d * ctm.d,
          e: e * ctm.a + f * ctm.c + ctm.e,
          f: e * ctm.b + f * ctm.d + ctm.f,
        };
        break;
      }
      case 'BDC': case 'BMC': {
        let mcid: number | null = null;
        if (op === 'BDC' && lastClosedDict && lastClosedDict.closeTokenIndex === k - 1) {
          mcid = lastClosedDict.mcid;
        }
        mcDepth++;
        if (activeMcid === null && mcid !== null && targetMcids.has(mcid)) {
          activeMcid = mcid;
          activeDepth = mcDepth;
        }
        break;
      }
      case 'EMC': {
        if (activeMcid !== null && mcDepth === activeDepth) finalizeActive();
        mcDepth = Math.max(0, mcDepth - 1);
        break;
      }

      case 'm': case 'l':
        include(num(operands[operands.length - 2]), num(operands[operands.length - 1]));
        break;
      case 'c':
        include(num(operands[operands.length - 6]), num(operands[operands.length - 5]));
        include(num(operands[operands.length - 4]), num(operands[operands.length - 3]));
        include(num(operands[operands.length - 2]), num(operands[operands.length - 1]));
        break;
      case 'v': case 'y':
        include(num(operands[operands.length - 4]), num(operands[operands.length - 3]));
        include(num(operands[operands.length - 2]), num(operands[operands.length - 1]));
        break;
      case 're': {
        const x = num(operands[operands.length - 4]);
        const y = num(operands[operands.length - 3]);
        const w = num(operands[operands.length - 2]);
        const h = num(operands[operands.length - 1]);
        include(x, y); include(x + w, y); include(x, y + h); include(x + w, y + h);
        break;
      }

      case 'Do':
        include(0, 0); include(1, 0); include(0, 1); include(1, 1);
        break;
      case 'BI': {
        // Inline images carry raw binary data the tokenizer can't parse --
        // approximate with the unit square like Do, and skip past EI in the
        // raw source, mirroring tagContentStream's own BI handling.
        include(0, 0); include(1, 0); include(0, 1); include(1, 1);
        const idm = /\bID\b/.exec(content.slice(tk.end));
        const from = idm ? tk.end + idm.index + 2 : tk.end;
        const eim = /\sEI\b/.exec(content.slice(from));
        const eiEnd = eim ? from + eim.index + eim[0].length : content.length;
        while (k + 1 < tokens.length && tokens[k + 1].start < eiEnd) k++;
        break;
      }

      case 'Td': case 'TD':
        tmE += num(operands[operands.length - 2]);
        tmF += num(operands[operands.length - 1]);
        break;
      case 'Tm':
        tmE = num(operands[operands.length - 2]);
        tmF = num(operands[operands.length - 1]);
        break;
      case 'BT': tmE = 0; tmF = 0; break;
      case 'Tj': case "'": case '"': case 'TJ': include(tmE, tmF); break;

      default: break;
    }
    operands.length = 0;
  }

  // A target whose EMC never arrived (malformed content, or truncated at
  // EOF) still gets its accumulated geometry recorded rather than silently
  // dropped -- matches this codebase's "best effort, bail only when truly
  // nothing was found" convention.
  finalizeActive();

  return results;
}
