/**
 * PDF Contrast Writer Service
 *
 * Phase B2 of the color-contrast automation plan (B0: color-correction math,
 * B1: content-stream text-run correlation — both already shipped). This is
 * the actual write: recolors the located text run's fill color.
 *
 * A `BT…ET` text object commonly holds many runs (one per line of a
 * paragraph, each preceded by its own `Td`/`T*`/`Tm`). Phase B1 correlates
 * against the individual run, not the whole object — so a run's span often
 * sits *inside* a text object rather than spanning it. That rules out
 * wrapping the run in `q/<color>/Q`: `q`/`Q` are not legal inside `BT…ET`
 * (PDF32000-1:2008 Annex A) at all, whole-object or not. Instead this always
 * does the same two things, regardless of whether the run carries its own
 * color op:
 *
 * 1. **Apply** — if Phase B1 found exactly one internal fill-color op within
 *    the run's own span (the common case — a dedicated op right before the
 *    run's show op), replace that operator's value directly. Otherwise
 *    (color inherited from outside the run) insert a new fill-color op right
 *    before the run's start.
 * 2. **Restore** — insert a fill-color op for the run's *original* measured
 *    color (`contrastData.foreground` — already known, since that's what the
 *    validator sampled) right after the run's end. Fill-color state persists
 *    across positioning ops, so without this, any sibling run later in the
 *    same text object that inherits color from before ours would pick up
 *    our correction too. This restore undoes that leak regardless of where
 *    the color state actually originated.
 *
 * (Two or more internal fill ops within the run's own span is genuinely
 * ambiguous — Phase B1 already refuses to match in that case.)
 *
 * Always emits plain `rg` (DeviceRGB) regardless of the original color
 * operator's colorspace — the correction target itself comes from sampled
 * *rendered* pixels (PdfContrastValidator), not the literal original
 * operator value, so preserving `k`/`scn`/Separation/ICC would overstate a
 * precision that was never there.
 *
 * Verifies its own work rather than trusting the theoretical WCAG math: a
 * real audit→apply→re-audit round trip showed that for small/thin text,
 * PdfContrastValidator's pixel sampling reads noticeably lighter than the
 * true fill color (anti-aliased edge pixels dominate the sample), enough
 * that a mathematically-correct moderate correction can still measure as
 * failing. So after writing, this re-renders the region (color-contrast-
 * verification.ts, using the exact same sampling the validator uses to
 * detect issues) and checks the real measured ratio. If it doesn't verify,
 * escalates once to the extreme (pure black or white — confirmed to measure
 * correctly regardless of font size) and re-verifies; only reports success
 * once independently confirmed, fails cleanly if even the extreme doesn't
 * verify.
 *
 * Every failure mode bails to `success: false` rather than guessing — this
 * is the first content-stream *write* in the codebase (everything else
 * writes structure-tree tags or metadata), so this stays conservative.
 */

import { PDFDocument } from 'pdf-lib';
import { AuditIssue } from '../audit/base-audit.service';
import { logger } from '../../lib/logger';
import { decodePageContent, writePageContent } from './pdf-content-stream-io';
import { locateTextRun, locateTextRunsForPage, locateEnclosingTextObject, type TextRunMatch, type PageContrastTarget } from './contrast-content-stream';
import { computeCompliantColor } from './color-contrast-correction';
import { verifyContrastInRegion } from './color-contrast-verification';
import { computeBackplateRect, spliceBackplate } from './pdf-contrast-backplate';
import { BUSY_VARIANCE_THRESHOLD } from './validators/pdf-contrast.validator';
import type { FixResult } from './pdf-structure-writer.service';

// Independent safety gate — enforced here regardless of what a caller (the
// AI-analysis pipeline, Phase B3) checks before even offering this as a
// suggestion. Matches the confidence bar Phase B3 is planned to require for
// apply-to-pdf eligibility, but this module doesn't trust callers to have
// applied it correctly.
const MIN_APPLY_CONFIDENCE = 0.80;

// 21:1 is the theoretical maximum WCAG contrast ratio (pure black vs pure
// white) — no fg/bg pair can reach it via a moderate lightness adjustment,
// so passing it as the target forces computeCompliantColor's own black/white
// fallback path. Reused here rather than re-deriving "which extreme is
// better against this background" independently.
// Exported so pdf-contrast-backplate.ts can request the same theoretical-
// maximum ratio when computing a backplate color against the original text
// foreground — same rationale as this constant's own use below (forces
// computeCompliantColor's black/white fallback path).
export const EXTREME_TARGET_RATIO = 21;

// Exported for pdf-contrast-backplate.ts — single source of truth for the
// hex -> unit-RGB conversion the `rg` operator needs.
export function hexToUnitRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  return [
    round4(parseInt(clean.substring(0, 2), 16) / 255),
    round4(parseInt(clean.substring(2, 4), 16) / 255),
    round4(parseInt(clean.substring(4, 6), 16) / 255),
  ];
}

/**
 * Pure string splice implementing the class doc comment's apply+restore
 * strategy for one run. `run` is the run's own [start,end) span;
 * `internalOp`, when present, is Phase B1's located fill-color op within
 * that span (undefined when the run has none of its own). Splices are
 * applied right-to-left (restore first, then apply) so the apply-side
 * offsets stay valid regardless of the restore insertion's length.
 *
 * Brackets the fix in `q`/`Q` (PDF's own graphics-state save/restore)
 * instead of inserting an explicit restore-color `rg` op, which this
 * function used to do. Confirmed live on Math_Weir_PDF.pdf: `rg` isn't
 * scoped to BT/ET, so an explicit restore value only correctly protects
 * whatever comes after the run when that later content was relying on
 * THIS run's own original color -- which fails for a run whose original
 * color was a local one-off (e.g. a small annotation that was already
 * flagged as gray-on-white), not the shared ambient color the page's
 * OTHER, unrelated text actually needs. The fixed run's own gray "restore"
 * value then leaked forward and repainted several unrelated words in that
 * same gray, registering as brand-new contrast failures never reported for
 * the original document -- confirmed via a real 348→400+ issue count
 * increase in production before this fix. `Q` sidesteps the problem
 * entirely: it restores the graphics state to whatever was ACTUALLY active
 * before the matching `q`, correct by construction, with nothing to
 * compute or guess.
 *
 * The restore lands at `run.lastShowEnd` (falling back to `run.end` when
 * absent, e.g. a hand-built `run` in a unit test with no trailing content
 * to distinguish) rather than `run.end` itself: `end` can extend past the
 * run's own last show op to include trailing graphics-state setup for
 * whatever the NEXT run shows (a run only closes on a positioning op, not
 * on "no more shows follow"). Restoring at `end` would fire AFTER that
 * setup and silently override the next run's own intended color instead of
 * restoring this run's — CodeRabbit finding on PR #544, confirmed live: a
 * caption immediately followed by a color change for the next (unrelated)
 * line hit exactly this.
 */
export function spliceColorFix(
  content: string,
  run: { start: number; end: number; lastShowEnd?: number },
  internalOp: { start: number; end: number } | undefined,
  newColor: [number, number, number]
): string {
  const [nr, ng, nb] = newColor;
  const restoreAt = run.lastShowEnd ?? run.end;

  // Leading/trailing \n on every inserted snippet — unlike an operator-span
  // replacement (which reuses whitespace already surrounding the original
  // token), an insertion lands between two tokens that may not have any
  // separator of their own (e.g. right after `BT`), so it must bring both.
  let out = content.slice(0, restoreAt) + `\nQ\n` + content.slice(restoreAt);

  out = internalOp
    ? out.slice(0, internalOp.start) + `q\n${nr} ${ng} ${nb} rg` + out.slice(internalOp.end)
    : out.slice(0, run.start) + `\nq\n${nr} ${ng} ${nb} rg\n` + out.slice(run.start);

  return out;
}

/**
 * Resolves color-contrast-fix correlation for a WHOLE batch of issues at
 * once, grouped by page, using locateTextRunsForPage instead of one
 * independent locateTextRun call per issue. This is what actually unlocks
 * the two harder real patterns locateTextRunsForPage handles (a single run
 * with a colored word embedded in otherwise plain text; several separate
 * single-color runs sitting close together) -- both require seeing every
 * issue on a page TOGETHER to structurally confirm an ordinal pairing, so
 * calling fixColorContrast one issue at a time (as applyApprovedSuggestions
 * used to) can never engage that mechanism at all.
 *
 * Skips (leaves absent from the returned map, matching fixColorContrast's
 * own existing per-issue gates so its fallback path re-derives the exact
 * same "unknown"/rotated-page/no-content error) any issue missing
 * pageNumber/boundingBox/contrastData, or on a page whose content stream
 * can't be decoded or that's rotated (locateTextRunsForPage's axis-aligned
 * assumption).
 */
export function resolveColorContrastTargets(doc: PDFDocument, issues: AuditIssue[]): Map<string, TextRunMatch | null> {
  const result = new Map<string, TextRunMatch | null>();
  const byPage = new Map<number, AuditIssue[]>();
  for (const issue of issues) {
    if (!issue.contrastData || !issue.pageNumber || !issue.boundingBox) continue;
    const list = byPage.get(issue.pageNumber) ?? [];
    list.push(issue);
    byPage.set(issue.pageNumber, list);
  }

  for (const [pageNumber, pageIssues] of byPage) {
    let rotation = 0;
    try {
      rotation = doc.getPage(pageNumber - 1).getRotation().angle;
    } catch {
      continue;
    }
    if (rotation !== 0) continue;

    const content = decodePageContent(doc, pageNumber);
    if (content === null) continue;

    const targets: PageContrastTarget[] = pageIssues.map(issue => ({
      id: issue.id,
      x: issue.boundingBox!.x,
      baselineY: issue.boundingBox!.pageHeight - issue.boundingBox!.y,
    }));
    const pageResult = locateTextRunsForPage(content, targets);
    for (const [id, match] of pageResult) result.set(id, match);
  }

  return result;
}

export class PdfContrastWriterService {
  /**
   * Rewrites the flagged text's fill color in the PDF content stream so it
   * clears the required WCAG contrast ratio, then verifies the real
   * rendered result and escalates to an extreme color if the first attempt
   * doesn't actually verify (see class doc comment). Recomputes correlation
   * fresh against `doc` (doesn't trust byte offsets computed at analysis
   * time against a possibly-different buffer) — cheap, and safer to reason
   * about.
   *
   * @param preResolvedMatches - see resolveColorContrastTargets's own doc
   *   comment: when a caller batches this across multiple color-contrast
   *   issues (applyApprovedSuggestions always does), the page-level
   *   ordinal-pairing mechanism can only engage when every issue on a page
   *   is resolved TOGETHER, not one at a time. Falls back to the original
   *   single-issue locateTextRun call when omitted (single-suggestion
   *   apply endpoint, no batch to precompute from).
   */
  async fixColorContrast(
    doc: PDFDocument,
    issue: AuditIssue,
    preResolvedMatches?: Map<string, TextRunMatch | null>,
  ): Promise<FixResult> {
    const cd = issue.contrastData;
    if (!cd) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no contrastData (deterministic measurement missing)' };
    }
    if (!issue.pageNumber || !issue.boundingBox) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue is missing pageNumber or boundingBox' };
    }
    const pageNumber = issue.pageNumber;
    const boundingBox = issue.boundingBox;

    const before = `${cd.foreground} on ${cd.background} (${cd.ratio}:1)`;

    let rotation = 0;
    try {
      rotation = doc.getPage(pageNumber - 1).getRotation().angle;
    } catch {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: `Page ${pageNumber} not found` };
    }
    if (rotation !== 0) {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: 'Cannot correlate on a rotated page (axis-aligned assumption)' };
    }

    const content = decodePageContent(doc, pageNumber);
    if (content === null) {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: 'Could not decode page content stream' };
    }

    const target = { x: boundingBox.x, baselineY: boundingBox.pageHeight - boundingBox.y };
    const match = preResolvedMatches
      ? (preResolvedMatches.get(issue.id) ?? null)
      : locateTextRun(content, target);

    if (!match || match.ambiguous || match.confidence < MIN_APPLY_CONFIDENCE) {
      const reason = match
        ? `confidence ${match.confidence}${match.ambiguous ? ', ambiguous' : ''}`
        : 'no candidate within tolerance';
      return {
        issueId: issue.id,
        success: false,
        before,
        after: 'unknown',
        error: `Could not confidently locate the flagged text in the content stream (${reason})`,
      };
    }

    const applyColor = (hex: string): void => {
      const rewritten = spliceColorFix(content, match, match.internalFillColorOp, hexToUnitRgb(hex));
      writePageContent(doc, pageNumber, rewritten);
    };
    const verify = async (): Promise<{ ratio: number; passes: boolean; uncertain: boolean; variance: number } | null> => {
      const buffer = Buffer.from(await doc.save());
      return verifyContrastInRegion(buffer, pageNumber, boundingBox, cd.requiredRatio, cd.background);
    };

    let appliedColor = computeCompliantColor(cd.foreground, cd.background, cd.requiredRatio).color;
    applyColor(appliedColor);
    let verification = await verify();

    // `uncertain` gates success here exactly like `!passes` does — an
    // uncertain measurement whose averaged color happens to produce a
    // passing ratio is still not a confirmed fix; it must not short-circuit
    // past escalation (and, below, must not be reported as success).
    //
    // Deliberate tradeoff (found in review): text sitting on a genuinely
    // non-uniform background (a photo, a gradient) will *always* measure
    // uncertain — every nearby patch legitimately varies, not just the
    // ones affected by adjacent-content contamination — so this makes
    // such cases permanently unable to auto-apply, where the old plain-
    // average approach could nominally "succeed" on one. That's accepted
    // deliberately, not overlooked: this file's own header already states
    // its governing principle ("every failure mode bails to success:
    // false rather than guessing... stays conservative"), and a WCAG
    // contrast ratio isn't well-defined against a genuinely busy image in
    // the first place (real guidance calls for a solid backplate behind
    // such text, not just a color tweak) — reporting "could not
    // confidently verify, needs manual review" is more honest here than
    // claiming a fix that isn't reliably measurable actually worked.
    if (!verification || !verification.passes || verification.uncertain) {
      logger.info(
        `[ContrastWriter] Moderate correction (${appliedColor}) did not verify` +
        `${verification ? ` (measured ${verification.ratio}:1${verification.uncertain ? ', uncertain background' : ''})` : ''} — escalating to an extreme color for page ${pageNumber}`
      );
      appliedColor = computeCompliantColor(cd.foreground, cd.background, EXTREME_TARGET_RATIO).color;
      applyColor(appliedColor);
      verification = await verify();
    }

    // Third tier: recoloring text can never fix contrast against a
    // background that can't be measured at all (moderate and extreme text
    // colors above have both now failed for the same reason). A solid
    // backplate rectangle behind the text turns that unmeasurable
    // background into a known, flat one instead. Gated on how FAR into
    // "uncertain" territory this specific region falls, not just the
    // boolean: BUSY_VARIANCE_THRESHOLD separates a mildly non-uniform
    // background (a subtle gradient, JPEG noise, a neighboring element's
    // edge bleeding into the sample -- safe to auto-cover) from a
    // genuinely busy one (a real photo/illustration, where stamping an
    // opaque box is a visible, potentially jarring change that should stay
    // a human decision). See BUSY_VARIANCE_THRESHOLD's own doc comment.
    if (verification && verification.uncertain && verification.variance <= BUSY_VARIANCE_THRESHOLD) {
      const enclosing = locateEnclosingTextObject(content, match.start);
      const backplateColorHex = computeCompliantColor(cd.background, cd.foreground, EXTREME_TARGET_RATIO).color;
      const rect = computeBackplateRect(boundingBox);
      const spliced = enclosing ? spliceBackplate(content, enclosing, rect, hexToUnitRgb(backplateColorHex)) : null;

      if (spliced) {
        writePageContent(doc, pageNumber, spliced);
        const backplateVerification = await verify();
        if (backplateVerification && backplateVerification.passes && !backplateVerification.uncertain) {
          logger.info(
            `[ContrastWriter] Backplate ${backplateColorHex} behind original text verified ` +
            `(${backplateVerification.ratio}:1) on page ${pageNumber}`
          );
          return {
            issueId: issue.id,
            success: true,
            before,
            after: `backplate ${backplateColorHex} behind original text (verified ${backplateVerification.ratio}:1)`,
          };
        }
        // Backplate didn't verify either -- revert before falling through
        // to the unchanged failure path below (which itself reverts again,
        // harmlessly, from the same pristine `content`).
        writePageContent(doc, pageNumber, content);
      }
    }

    if (!verification || !verification.passes || verification.uncertain) {
      // applyColor() above already mutated the shared `doc` (possibly
      // twice, including the extreme escalation) -- since this is being
      // reported as a failure, `doc` must not retain that unverified
      // change. `content` is the pristine pre-fix page content decoded at
      // the top of this method (applyColor always splices from it fresh,
      // never from a prior write), so writing it back is a full revert.
      // Without this, AiAnalysisService.applyApprovedSuggestions() saving
      // this same `doc` -- which it does whenever any OTHER fix in the
      // same batch succeeds -- would silently persist this "failed" color
      // change into the final output anyway.
      writePageContent(doc, pageNumber, content);
      const error = verification?.uncertain
        ? 'Could not confidently measure the background near this text (every nearby sampled region showed ' +
          'meaningful color variation -- either adjacent contamination, or a genuinely non-uniform background ' +
          'like a photo or gradient) — skipping rather than risking a false pass/fail; likely needs manual review'
        : `Fix did not verify even after escalating to ${appliedColor} ` +
          `(measured ${verification?.ratio ?? 'unknown'}:1, required ${cd.requiredRatio}:1)`;
      return { issueId: issue.id, success: false, before, after: 'unknown', error };
    }

    logger.info(
      `[ContrastWriter] fixColorContrast: ${cd.foreground} -> ${appliedColor} on page ${pageNumber} ` +
      `(${cd.ratio}:1 measured -> ${verification.ratio}:1 verified)`
    );

    return {
      issueId: issue.id,
      success: true,
      before,
      after: `${appliedColor} on ${cd.background} (verified ${verification.ratio}:1)`,
    };
  }
}

export const pdfContrastWriterService = new PdfContrastWriterService();
