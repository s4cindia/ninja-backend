import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  computeBackplateRect,
  spliceBackplate,
  findPrecedingBackplate,
  isSameBackplatePosition,
  dedupeStackedBackplates,
  cleanupStackedBackplates,
} from '../../../../src/services/pdf/pdf-contrast-backplate';
import { RENDER_SCALE } from '../../../../src/services/pdf/color-contrast-verification';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

describe('computeBackplateRect', () => {
  it('converts a baseline-anchored, top-left-origin boundingBox to a bottom-left-origin re rect, padded for tier-0 probe coverage and descenders', () => {
    // Matches PdfContrastValidator.computeTextBoundingBox's convention:
    // y is the baseline (top-left terms), height is the font size the
    // glyph ascends by *above* that baseline.
    const rect = computeBackplateRect({ x: 100, y: 250, width: 80, height: 14, pageHeight: 700 });
    expect(rect.x).toBe(100);
    // Bottom-left y of the baseline = pageHeight - boundingBox.y, minus a
    // descender pad (30% of height) so the rect's bottom edge extends
    // below the baseline rather than sitting exactly on it.
    expect(rect.y).toBeCloseTo(700 - 250 - 14 * 0.3);
    // Width grows by the tier-0 right-probe's own gap+width (4+6 canvas px)
    // plus a 2px anti-aliasing safety margin (real bug, confirmed live on
    // Math_Weir_PDF.pdf -- see PROBE_ANTIALIAS_MARGIN_CANVAS_PX's own doc
    // comment: sizing to the exact probe distance still let the rendered
    // rect's own anti-aliased edge leak into the probe's sampled strip).
    expect(rect.width).toBeCloseTo(80 + 12 / RENDER_SCALE);
    // Height grows by the tier-0 above-probe (5 canvas px) plus the same
    // 2px margin, plus the descender pad.
    expect(rect.height).toBeCloseTo(14 + 7 / RENDER_SCALE + 14 * 0.3);
  });

  it("pads width/height up to the verification step's own canvas-space minimums plus tier-0 probe coverage, never down", () => {
    // A tiny glyph box (e.g. a single punctuation mark) would otherwise be
    // narrower/shorter than what color-contrast-verification.ts actually
    // samples (10x6 canvas px at RENDER_SCALE) -- undersizing the backplate
    // would leave contaminated edge pixels visible to the re-verify step.
    const rect = computeBackplateRect({ x: 0, y: 100, width: 1, height: 1, pageHeight: 200 });
    const flooredHeight = 6 / RENDER_SCALE;
    expect(rect.width).toBeCloseTo((10 + 12) / RENDER_SCALE);
    expect(rect.height).toBeCloseTo(flooredHeight + 7 / RENDER_SCALE + flooredHeight * 0.3);
  });

  it('still adds tier-0 probe coverage and descender padding when width/height already exceed the minimums', () => {
    const rect = computeBackplateRect({ x: 0, y: 100, width: 200, height: 20, pageHeight: 200 });
    expect(rect.width).toBeCloseTo(200 + 12 / RENDER_SCALE);
    expect(rect.height).toBeCloseTo(20 + 7 / RENDER_SCALE + 20 * 0.3);
  });

  // Real, live-confirmed regression (not a synthetic worry): a rect padded
  // to EXACTLY the tier-0 probe distance (the pre-existing PR #545
  // behavior) still left a fresh, independent re-audit reporting the fix as
  // failing, because sampleBackgroundRobust's "above" probe sits flush
  // against the rect's own top edge with zero clearance, and a rendered
  // rectangle's edge is anti-aliased regardless of how precisely its
  // coordinate is computed -- the probe's own strip samples that blend
  // instead of the backplate's true flat color. This test pins the padding
  // to strictly exceed the exact probe distance, so a future edit can't
  // silently regress back to the exact (insufficient) match.
  it('pads strictly beyond the exact tier-0 probe distance, not just up to it, to absorb rendered-edge anti-aliasing', () => {
    const rect = computeBackplateRect({ x: 100, y: 250, width: 80, height: 14, pageHeight: 700 });
    const exactAboveProbePad = 5 / RENDER_SCALE;
    const exactRightProbePad = 10 / RENDER_SCALE;
    expect(rect.height - 14 - 14 * 0.3).toBeGreaterThan(exactAboveProbePad);
    expect(rect.width - 80).toBeGreaterThan(exactRightProbePad);
  });
});

describe('spliceBackplate', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it('inserts an rg/re/f/rg sequence immediately before the enclosing BT, with NO q/Q', () => {
    // Regression test for a real, live-confirmed bug on Math_Weir_PDF.pdf:
    // a q/Q-bracketed rectangle insertion here reliably made the text run
    // immediately after the inserted Q render completely invisible in
    // pdfjs-dist's canvas backend (bisected to the q/Q pair itself, not
    // the color, CTM math, or path-construction operator choice). See this
    // function's own doc comment.
    const content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1]);

    expect(result).toBeTruthy();
    expect(result!.startsWith('BEFORE\n')).toBe(true);
    expect(result!.endsWith('BT\n<41> Tj\nET\nAFTER')).toBe(true);
    const inserted = result!.slice('BEFORE\n'.length, result!.indexOf('BT\n<41>'));

    // No graphics-state save/restore at all.
    expect(/(^|\s)q(\s|$)/.test(inserted)).toBe(false);
    expect(/(^|\s)Q(\s|$)/.test(inserted)).toBe(false);
    // Identity CTM -> no cm op needed at all (not even a no-op one).
    expect(inserted).not.toContain('cm');

    expect(inserted).toContain('1 1 1 rg');
    expect(inserted).toContain('10 20 30 40 re');
    expect(inserted).toContain('f');
    // Explicit restore back to the genuinely ambient color (nothing
    // precedes the insertion point here, so findPrecedingColor's own
    // "unset" fallback is pure black).
    expect(inserted).toContain('0 0 0 rg');

    // rg/re/f must appear in that relative order, with the restore rg
    // strictly after the fill.
    const fillRgIdx = inserted.indexOf('1 1 1 rg');
    const reIdx = inserted.indexOf('10 20 30 40 re');
    const fIdx = inserted.indexOf('f', reIdx);
    const restoreRgIdx = inserted.indexOf('0 0 0 rg');
    expect(reIdx).toBeGreaterThan(fillRgIdx);
    expect(fIdx).toBeGreaterThan(reIdx);
    expect(restoreRgIdx).toBeGreaterThan(fIdx);
  });

  it('brackets a non-identity CTM with cm/inverse-cm (no q/Q) so the rect draws in absolute device-space coordinates and the ambient transform is restored afterward', () => {
    const content = 'BT\n<41> Tj\nET';
    // A 2x-scaled, translated CTM ambient at the insertion point.
    const result = spliceBackplate(content, { btStart: 0, ctm: { a: 2, d: 4, e: 10, f: 20 } }, rect, [0, 0, 0]);
    expect(result).toBeTruthy();
    const cancelIdx = result!.indexOf(`${1 / 2} 0 0 ${1 / 4} ${-10 / 2} ${-20 / 4} cm`);
    const restoreIdx = result!.indexOf('2 0 0 4 10 20 cm');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(cancelIdx);
    expect(/(^|\s)q(\s|$)/.test(result!)).toBe(false);
    expect(/(^|\s)Q(\s|$)/.test(result!)).toBe(false);
  });

  it('returns null for a collapsed (non-invertible) CTM rather than drawing something wrong', () => {
    const content = 'BT\n<41> Tj\nET';
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 0, d: 1, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
    expect(spliceBackplate(content, { btStart: 0, ctm: { a: 1, d: 0, e: 0, f: 0 } }, rect, [0, 0, 0])).toBeNull();
  });

  it('returns null rather than guessing when the ambient restore color is set via an untracked sc/scn colorspace op', () => {
    // Matches findPrecedingColor's own documented "bail rather than guess"
    // contract for its null case.
    const content = '/CS0 cs\n0.5 0.2 0.1 0.9 scn\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    expect(spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1])).toBeNull();
  });

  it('restores whatever fill color was genuinely ambient at the insertion point, not pure black unconditionally', () => {
    const content = '0.4 0.4 0.5 rg\nBEFORE\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 1, 1]);
    expect(result).toBeTruthy();
    const inserted = result!.slice(0, result!.indexOf('BT\n<41>'));
    expect(inserted).toContain('0.4 0.4 0.5 rg');
  });

  it('does not modify content before the insertion point', () => {
    const content = 'PAGE_HEADER_CONTENT\nBT\n<41> Tj\nET';
    const btStart = content.indexOf('BT');
    const result = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [1, 0, 0]);
    expect(result!.startsWith('PAGE_HEADER_CONTENT\n')).toBe(true);
  });
});

// Real, live-confirmed incident, 2026-11-04 (Farrar_2E_Comp_188910.pdf,
// page 118): a COLOR-CONTRAST issue oscillated resolved/regressed every
// single Auto Mode round instead of ever converging. Root cause: every
// round that re-flagged the run inserted ANOTHER backplate rect on top of
// the one already there from an earlier round, each a slightly different
// size (fresh glyph-measurement drift round to round), leaving unclobbered
// slivers of earlier-painted colors exposed at the edges. findPrecedingBackplate
// + isSameBackplatePosition exist so pdf-contrast-writer.service.ts can
// detect this before stacking another one.
describe('findPrecedingBackplate', () => {
  const rect = { x: 72, y: 605, width: 161, height: 19 };

  it('detects a backplate spliceBackplate itself just inserted, immediately before the (now-shifted) BT', () => {
    const content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    const btStart = content.indexOf('BT');
    const spliced = spliceBackplate(content, { btStart, ctm: { a: 1, d: 1, e: 0, f: 0 } }, rect, [0, 0, 0]);
    expect(spliced).toBeTruthy();

    // A fresh round re-parses the content from scratch, so btStart must be
    // recomputed against the NEW (shifted-forward) content -- exactly what
    // locateEnclosingTextObject would do on the next real call.
    const newBtStart = spliced!.indexOf('BT');
    const existing = findPrecedingBackplate(spliced!, newBtStart, rect);

    expect(existing).not.toBeNull();
    expect(existing!.color).toEqual([0, 0, 0]);
    expect(existing!.rect.x).toBeCloseTo(72);
    expect(existing!.rect.y).toBeCloseTo(605);
    expect(existing!.rect.width).toBeCloseTo(161);
    expect(existing!.rect.height).toBeCloseTo(19);
  });

  it('returns null when nothing precedes the BT at all', () => {
    const content = 'BT\n<41> Tj\nET';
    expect(findPrecedingBackplate(content, content.indexOf('BT'), rect)).toBeNull();
  });

  it('returns null for ordinary page content that is not a backplate snippet (e.g. a table border fill)', () => {
    // A real, unrelated rect-fill (a table cell border) sitting right
    // before a BT must not be mistaken for a backplate -- it lacks the
    // second (restore) rg the real snippet always has.
    const content = '0 0 0 rg\n10 20 100 50 re\nf\nBT\n<41> Tj\nET';
    expect(findPrecedingBackplate(content, content.indexOf('BT'), rect)).toBeNull();
  });

  it('detects a non-identity-CTM backplate (cm-wrapped) immediately before the shifted BT', () => {
    const content = 'BT\n<41> Tj\nET';
    const spliced = spliceBackplate(content, { btStart: 0, ctm: { a: 2, d: 4, e: 10, f: 20 } }, rect, [1, 1, 1]);
    expect(spliced).toBeTruthy();
    const newBtStart = spliced!.indexOf('BT');
    const existing = findPrecedingBackplate(spliced!, newBtStart, rect);
    expect(existing).not.toBeNull();
    expect(existing!.color).toEqual([1, 1, 1]);
  });

  // Real, live-confirmed incident, 2026-11-05 (same document, same page
  // 118): a caption with 3 short lines -- 3 sibling COLOR-CONTRAST issues
  // all sharing ONE enclosing BT -- never converged across ~45 Auto Mode
  // rounds. Each sibling's own backplate is correctly inserted at the SAME
  // shared btStart, so a round-robin of 3 builds a STACK immediately in
  // front of it; checking only the single most-recently-inserted entry
  // (this function's original behavior) found a SIBLING's backplate every
  // time, never this run's own, so all 3 kept re-stacking forever -- 165
  // backplates accumulated on that one page, one position 77 times.
  it('walks back through a stack of sibling backplates sharing one BT to find THIS run\'s own, even when other siblings were spliced more recently', () => {
    const rectA = { x: 72, y: 605, width: 161, height: 19 };
    const rectB = { x: 72, y: 618, width: 162, height: 19 };
    const rectC = { x: 72, y: 657, width: 161, height: 19 };
    const ctm = { a: 1, d: 1, e: 0, f: 0 };

    let content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    let btStart = content.indexOf('BT');

    // Round 1: siblings A, B, C each splice their own backplate at the one
    // shared btStart, in that order (A ends up buried deepest, C nearest).
    for (const [rect_, color] of [[rectA, [0, 0, 0]], [rectB, [1, 1, 1]], [rectC, [1, 1, 1]]] as const) {
      content = spliceBackplate(content, { btStart, ctm }, rect_, color)!;
      btStart = content.indexOf('BT');
    }
    // Round 2: same round-robin again, burying round 1's entries deeper.
    for (const [rect_, color] of [[rectA, [0, 0, 0]], [rectB, [1, 1, 1]], [rectC, [1, 1, 1]]] as const) {
      content = spliceBackplate(content, { btStart, ctm }, rect_, color)!;
      btStart = content.indexOf('BT');
    }

    // Sibling A's own entry is now the OLDEST, most-deeply-buried thing in
    // the stack (5 other entries -- B, C, A, B, C from round 1 plus round
    // 2's B and C -- were spliced after it) -- yet it must still be found.
    const existingA = findPrecedingBackplate(content, btStart, rectA);
    expect(existingA).not.toBeNull();
    expect(existingA!.color).toEqual([0, 0, 0]);
    expect(existingA!.rect.x).toBeCloseTo(72);
    expect(existingA!.rect.y).toBeCloseTo(605);

    // B and C are each found too (nearer the top, but still correctly
    // disambiguated from one another and from A).
    expect(findPrecedingBackplate(content, btStart, rectB)!.rect.y).toBeCloseTo(618);
    expect(findPrecedingBackplate(content, btStart, rectC)!.rect.y).toBeCloseTo(657);

    // A genuinely different, unrelated position (no sibling here at all)
    // still correctly finds nothing, even with a deep stack to search through.
    expect(findPrecedingBackplate(content, btStart, { x: 72, y: 900, width: 161, height: 19 })).toBeNull();
  });
});

// Real, live-confirmed incident, 2026-11-05 (Farrar_2E_Comp_188910.pdf,
// page 118): PR #765 stopped NEW stacking but a document that hit the bug
// before that fix shipped still carries the pile it already accumulated --
// 165 backplates on that one page, one position stacked 77 times. A
// one-time cleanup pass is needed to collapse the existing pile, since the
// normal fix-application path never revisits already-painted pages.
describe('dedupeStackedBackplates', () => {
  const rectA = { x: 72, y: 605, width: 161, height: 19 };
  const rectB = { x: 72, y: 618, width: 162, height: 19 };
  const rectC = { x: 72, y: 657, width: 161, height: 19 };
  const ctm = { a: 1, d: 1, e: 0, f: 0 };

  function buildStackedContent(): string {
    let content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    let btStart = content.indexOf('BT');
    // Round 1: A, B, C each splice at the one shared btStart.
    for (const [rect, color] of [[rectA, [0.5, 0.5, 0.5]], [rectB, [1, 1, 1]], [rectC, [1, 1, 1]]] as const) {
      content = spliceBackplate(content, { btStart, ctm }, rect, color)!;
      btStart = content.indexOf('BT');
    }
    // Round 2: same round-robin, A's color now escalated to pure black --
    // this is the one that should survive cleanup for position A.
    for (const [rect, color] of [[rectA, [0, 0, 0]], [rectB, [1, 1, 1]], [rectC, [1, 1, 1]]] as const) {
      content = spliceBackplate(content, { btStart, ctm }, rect, color)!;
      btStart = content.indexOf('BT');
    }
    return content;
  }

  it('collapses a 3-sibling, 2-round stack (6 entries) down to one entry per position, keeping the most recent color', () => {
    const content = buildStackedContent();
    const result = dedupeStackedBackplates(content);

    expect(result.removedCount).toBe(3);
    expect(result.keptCount).toBe(3);

    const btStart = result.content.indexOf('BT');
    const survivorA = findPrecedingBackplate(result.content, btStart, rectA);
    const survivorB = findPrecedingBackplate(result.content, btStart, rectB);
    const survivorC = findPrecedingBackplate(result.content, btStart, rectC);

    // A's surviving entry is round 2's (pure black), not round 1's (grey).
    expect(survivorA!.color).toEqual([0, 0, 0]);
    expect(survivorB!.color).toEqual([1, 1, 1]);
    expect(survivorC!.color).toEqual([1, 1, 1]);

    // Nothing else in the stack is left to find behind the survivors.
    expect(dedupeStackedBackplates(result.content).removedCount).toBe(0);
  });

  it('preserves the surrounding page content exactly, only touching the stacked region', () => {
    const content = buildStackedContent();
    const result = dedupeStackedBackplates(content);
    expect(result.content.startsWith('BEFORE\n')).toBe(true);
    expect(result.content.endsWith('BT\n<41> Tj\nET\nAFTER')).toBe(true);
  });

  it('is a no-op on content with no stacking at all (single backplate, or none)', () => {
    const content = 'BEFORE\nBT\n<41> Tj\nET\nAFTER';
    const spliced = spliceBackplate(content, { btStart: content.indexOf('BT'), ctm }, rectA, [0, 0, 0])!;

    const singleResult = dedupeStackedBackplates(spliced);
    expect(singleResult.removedCount).toBe(0);
    expect(singleResult.keptCount).toBe(1);
    expect(singleResult.content).toBe(spliced);

    const emptyResult = dedupeStackedBackplates(content);
    expect(emptyResult.removedCount).toBe(0);
    expect(emptyResult.keptCount).toBe(0);
    expect(emptyResult.content).toBe(content);
  });

  it('does not mistake an ordinary, unrelated rect fill (e.g. a table border) for a backplate', () => {
    const content = '0 0 0 rg\n10 20 100 50 re\nf\nBT\n<41> Tj\nET';
    const result = dedupeStackedBackplates(content);
    expect(result.removedCount).toBe(0);
    expect(result.keptCount).toBe(0);
    expect(result.content).toBe(content);
  });
});

describe('cleanupStackedBackplates', () => {
  it('rewrites only the pages that had stacked duplicates, leaving clean pages untouched', async () => {
    const src = await PDFDocument.create();
    src.addPage([500, 700]); // page 1: will get a stacked mess
    src.addPage([500, 700]); // page 2: a single, already-clean backplate
    src.addPage([500, 700]); // page 3: no backplate at all
    const doc = await PDFDocument.load(await src.save());

    const ctm = { a: 1, d: 1, e: 0, f: 0 };
    const rect = { x: 72, y: 605, width: 161, height: 19 };
    let page1Content = 'BT\n<41> Tj\nET';
    let btStart = page1Content.indexOf('BT');
    for (const color of [[0.5, 0.5, 0.5], [0, 0, 0]] as const) {
      page1Content = spliceBackplate(page1Content, { btStart, ctm }, rect, color)!;
      btStart = page1Content.indexOf('BT');
    }
    writePageContent(doc, 1, page1Content);

    const page2Content = spliceBackplate('BT\n<41> Tj\nET', { btStart: 0, ctm }, rect, [0, 0, 0])!;
    writePageContent(doc, 2, page2Content);

    writePageContent(doc, 3, 'BT\n<41> Tj\nET');

    const changed = cleanupStackedBackplates(doc);

    expect(changed).toEqual([{ page: 1, removedCount: 1 }]);

    const cleanedPage1 = decodePageContent(doc, 1)!;
    expect(dedupeStackedBackplates(cleanedPage1).removedCount).toBe(0);
    expect(findPrecedingBackplate(cleanedPage1, cleanedPage1.indexOf('BT'), rect)!.color).toEqual([0, 0, 0]);

    // Page 2 (already clean) and page 3 (no backplate) are byte-identical
    // to what was written.
    expect(decodePageContent(doc, 2)).toBe(page2Content);
    expect(decodePageContent(doc, 3)).toBe('BT\n<41> Tj\nET');
  });
});

describe('isSameBackplatePosition', () => {
  it('treats the same run redrawn with a point or two of glyph-measurement drift as the same position', () => {
    const a = { x: 72, y: 605, width: 161, height: 19 };
    const b = { x: 71.2, y: 605.9, width: 162.1, height: 18.8 }; // real drift observed live
    expect(isSameBackplatePosition(a, b)).toBe(true);
  });

  it('does not conflate two different, nearby lines sharing one enclosing BT', () => {
    // Real corpus line-height is ~13pt apart -- a different run's own
    // backplate must never be treated as "this run, already fixed."
    const a = { x: 72, y: 605, width: 161, height: 19 };
    const b = { x: 72, y: 618, width: 162, height: 19 };
    expect(isSameBackplatePosition(a, b)).toBe(false);
  });
});
