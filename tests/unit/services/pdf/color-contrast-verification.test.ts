import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { verifyContrastInRegion } from '../../../../src/services/pdf/color-contrast-verification';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

async function buildPdf(color: number): Promise<Buffer> {
  const src = await PDFDocument.create();
  const page = src.addPage([400, 600]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText('Low contrast text', { x: 100, y: 450, size: 14, font, color: rgb(color, color, color) });
  return Buffer.from(await src.save());
}

// Top-left-origin, unscaled PDF points — the same convention
// PdfContrastValidator.computeTextBoundingBox produces.
const BOUNDING_BOX = { x: 100, y: 150, width: 106, height: 14 };

describe('verifyContrastInRegion', () => {
  it('reproduces the same measurement PdfContrastValidator itself would make', async () => {
    const buffer = await buildPdf(0.6); // deliberately low contrast
    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(false);
    expect(result!.background).toBe('#ffffff');
  });

  it('reports passes:true for genuinely high-contrast text', async () => {
    const buffer = await buildPdf(0); // true black
    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(true);
    expect(result!.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('returns null for an out-of-range page rather than throwing', async () => {
    const buffer = await buildPdf(0);
    const result = await verifyContrastInRegion(buffer, 99, BOUNDING_BOX, 4.5);
    expect(result).toBeNull();
  });

  it('respects the requiredRatio threshold passed in', async () => {
    const buffer = await buildPdf(0.6);
    // Same measured ratio, different thresholds — large-text (3:1) may pass
    // where normal-text (4.5:1) does not, for a genuinely borderline case.
    const strict = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5);
    const lenient = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 1.0);
    expect(strict!.passes).toBe(false);
    expect(lenient!.passes).toBe(true);
    expect(strict!.ratio).toBe(lenient!.ratio); // same measurement, different bar
  });

  it('given an accurate background hint, correctly verifies true-black text with a table-style fill just above it', async () => {
    // Isolates the tie-break algorithm itself: reproduces the exact
    // failing magnitude seen live (ratio ~1.2:1, comfortably failing
    // 4.5:1) from a dark fill positioned where a table cell's shading or
    // border commonly sits, directly above (and, in this geometry,
    // slightly overlapping) a row of cell text — then shows that GIVEN an
    // accurate hint for what the true background actually is, the
    // algorithm correctly prefers it over the flatter-but-wrong fill.
    //
    // The hint used here ('#ffffff') is deliberately accurate — this test
    // is NOT a claim that pdf-contrast-writer.service.ts's real hint
    // (`cd.background`, the issue's own originally-detected background)
    // would be this accurate for this exact fixture. See the next test:
    // for a *static* fill like this one, detection uses the same narrow
    // strip and gets fooled identically, so the real hint would actually
    // be the fill's own color, not the true white. This test exists to
    // prove the tie-break logic itself works correctly when it does have
    // a trustworthy hint (the case the real production bug matches: see
    // the third test below).
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 95, y: 460, width: 200, height: 10, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0, 0, 0) }); // true black
    const buffer = Buffer.from(await src.save());

    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5, '#ffffff');

    expect(result).toBeTruthy();
    expect(result!.uncertain).toBe(false);
    expect(result!.passes).toBe(true);
    expect(result!.ratio).toBeGreaterThan(15); // true black on true white, not contaminated by the fill above
  });

  it('given an accurate hint reaching beyond tier 1, escapes a band wide/tall enough to swallow tiers 0 AND 1', async () => {
    // Re-running the earlier (tier-0/1-only) fix against a real document
    // showed the actual failures didn't go away: ~40-50 apply-to-pdf
    // color-contrast fixes still failed per round, at the same ~1.1-1.9:1
    // magnitude as before that fix shipped. This band is sized to cover
    // the text's own row (contaminating the "right of run" candidates at
    // every tier -- a wide element is never escaped by moving sideways)
    // and the space above it through tier 1, leaving tier 2 clear -- the
    // class of contamination the wider search exists to reach past.
    //
    // The hint here ('#ffffff') is, like the first test in this file,
    // deliberately accurate -- proving the algorithm correctly uses tier 2+
    // when it has a trustworthy hint to check candidates against. See the
    // KNOWN LIMITATION test directly below for why this fixture's *real*
    // hint (from actually running detection against it) is not, in fact,
    // trustworthy -- the honest, load-bearing finding of this round.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 90, y: 450, width: 310, height: 35, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0, 0, 0) }); // true black
    const buffer = Buffer.from(await src.save());

    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5, '#ffffff');

    expect(result).toBeTruthy();
    expect(result!.uncertain).toBe(false);
    expect(result!.passes).toBe(true);
    expect(result!.ratio).toBeGreaterThan(15); // found true white at tier 2+, not the band
  });

  it('KNOWN LIMITATION: the same wide band also fools detection, so its real hint cannot rescue it either -- widening the search alone does not fix this class of failure', async () => {
    // The load-bearing finding from this round: a band wide/tall enough
    // to swallow tiers 0-1 is, for the same reason as the narrower static
    // fill documented above, ALSO wide enough to swallow detection's own
    // tier-0-only strip -- confirmed here by running the real pipeline and
    // getting contrastData.background === the band's own color, not white.
    // Widening fix-time's search doesn't help when the hint it's handed is
    // itself already wrong: the hint-based tie-break correctly prefers
    // whichever flat candidate matches the (wrong) hint, which is the band
    // itself, at any tier.
    //
    // This matters beyond just this fixture: it means the "recurring wide
    // page-template element" hypothesis -- offered as the likely
    // explanation for the live document's continued failures after the
    // narrower hint fix shipped -- does NOT actually predict those
    // failures resolving here either, once checked rigorously (both this
    // fixture and the earlier static-fill one collapse into the same
    // detection-is-equally-fooled limitation the moment a *static* element
    // is involved). The real mechanism behind those live failures remains
    // unconfirmed; this widened search is left in as a genuine, tested
    // improvement for cases where the hint IS trustworthy and reaches
    // beyond tier 1 (see the test above), not as a claimed fix for the
    // specific live document.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 90, y: 450, width: 310, height: 35, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0.6, 0.6, 0.6) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'known-limitation-wide-band', 'test.pdf', 'custom', ['contrast']);
    const issue = report.issues.find(i => i.code === 'COLOR-CONTRAST')!;
    expect(issue.contrastData!.background).not.toBe('#ffffff'); // detection itself was fooled by the band

    const result = await verifyContrastInRegion(buffer, 1, issue.boundingBox!, 4.5, issue.contrastData!.background);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(false); // the fix (if attempted) would still fail here -- a known, accepted gap
  });

  it('without a background hint, a same-band flat-but-wrong surface (the fill itself) can still win', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 95, y: 460, width: 200, height: 10, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());

    const result = await verifyContrastInRegion(buffer, 1, BOUNDING_BOX, 4.5); // no hint

    expect(result).toBeTruthy();
    expect(result!.uncertain).toBe(false); // the fill itself is flat, so this isn't flagged uncertain
    expect(result!.passes).toBe(false); // but it's the wrong surface, so the ratio is wrong too
  });

  it('KNOWN LIMITATION: a static fill that also fools detection defeats the hint too, since the hint comes from that same fooled detection', async () => {
    // Found via an independent `codex exec review` pass on this PR: the
    // hint is only as good as `cd.background`, which for a *static* page
    // element (unlike text, which fixes recolor over the course of a
    // batch) is measured by the SAME unchanged narrow strip at detection
    // time as at fix time. If a fill/rule sits where that strip samples,
    // detection reads the fill's color too -- confirmed here by running
    // the real detection pipeline against this exact fixture and getting
    // back contrastData.background === the fill's own color, not white.
    // Passing that (equally-wrong) hint to verification just reinforces
    // the same wrong surface instead of correcting it.
    //
    // This is deliberately left unresolved by this PR rather than
    // papered over: fixing it would need distinguishing "a small isolated
    // fill" from "the actual page background" using more than a few fixed
    // sample points (e.g. the fill's spatial extent), which is a real
    // detection-side feature, not a verification-side patch, and this PR
    // is deliberately scoped to verification only (see file header).
    //
    // It does NOT appear to be the mechanism behind the real production
    // failures this PR was written to fix, though: every one of those
    // logged `computeCompliantColor` choosing BLACK, which only happens
    // when the analysis-time background reads as light -- a static dark
    // fill fooling detection here would instead have made it choose
    // WHITE. The real mechanism is more likely dynamic (an adjacent
    // line's fix, applied earlier in the same batch, darkening what a
    // later issue's fix-time verification sees relative to what analysis
    // saw before that batch started) -- text contamination is inherently
    // sparse/high-variance rather than flat, so it's already handled by
    // variance-based candidate selection without needing the hint to be
    // perfectly accurate.
    const src = await PDFDocument.create();
    const page = src.addPage([400, 600]);
    page.drawRectangle({ x: 95, y: 460, width: 200, height: 10, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Low contrast text', { x: 100, y: 450, size: 14, color: rgb(0.6, 0.6, 0.6) });
    const buffer = Buffer.from(await src.save());

    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'known-limitation-static-fill', 'test.pdf', 'custom', ['contrast']);
    const issue = report.issues.find(i => i.code === 'COLOR-CONTRAST')!;
    expect(issue.contrastData!.background).not.toBe('#ffffff'); // detection itself was fooled by the fill

    const result = await verifyContrastInRegion(buffer, 1, issue.boundingBox!, 4.5, issue.contrastData!.background);

    expect(result).toBeTruthy();
    expect(result!.passes).toBe(false); // the fix (if attempted) would still fail here -- a known, accepted gap
  });
});
