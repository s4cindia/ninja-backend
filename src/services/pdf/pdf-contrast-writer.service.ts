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
import { locateTextRun } from './contrast-content-stream';
import { computeCompliantColor } from './color-contrast-correction';
import { verifyContrastInRegion } from './color-contrast-verification';
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
const EXTREME_TARGET_RATIO = 21;

function hexToUnitRgb(hex: string): [number, number, number] {
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
 * that span (undefined when the run has none of its own). Always inserts a
 * restore op for `originalColor` right after the run — see class doc
 * comment for why. Splices are applied right-to-left (restore first, then
 * apply) so the apply-side offsets stay valid regardless of the restore
 * insertion's length.
 */
export function spliceColorFix(
  content: string,
  run: { start: number; end: number },
  internalOp: { start: number; end: number } | undefined,
  newColor: [number, number, number],
  originalColor: [number, number, number]
): string {
  const [nr, ng, nb] = newColor;
  const [or_, og, ob] = originalColor;

  // Leading/trailing \n on every inserted snippet — unlike an operator-span
  // replacement (which reuses whitespace already surrounding the original
  // token), an insertion lands between two tokens that may not have any
  // separator of their own (e.g. right after `BT`), so it must bring both.
  let out = content.slice(0, run.end) + `\n${or_} ${og} ${ob} rg\n` + content.slice(run.end);

  out = internalOp
    ? out.slice(0, internalOp.start) + `${nr} ${ng} ${nb} rg` + out.slice(internalOp.end)
    : out.slice(0, run.start) + `\n${nr} ${ng} ${nb} rg\n` + out.slice(run.start);

  return out;
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
   */
  async fixColorContrast(doc: PDFDocument, issue: AuditIssue): Promise<FixResult> {
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
    const match = locateTextRun(content, target);

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

    const originalRgb = hexToUnitRgb(cd.foreground);
    const applyColor = (hex: string): void => {
      const rewritten = spliceColorFix(content, match, match.internalFillColorOp, hexToUnitRgb(hex), originalRgb);
      writePageContent(doc, pageNumber, rewritten);
    };
    const verify = async (): Promise<{ ratio: number; passes: boolean; uncertain: boolean } | null> => {
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
    if (!verification || !verification.passes || verification.uncertain) {
      logger.info(
        `[ContrastWriter] Moderate correction (${appliedColor}) did not verify` +
        `${verification ? ` (measured ${verification.ratio}:1${verification.uncertain ? ', uncertain background' : ''})` : ''} — escalating to an extreme color for page ${pageNumber}`
      );
      appliedColor = computeCompliantColor(cd.foreground, cd.background, EXTREME_TARGET_RATIO).color;
      applyColor(appliedColor);
      verification = await verify();
    }

    if (!verification || !verification.passes || verification.uncertain) {
      const error = verification?.uncertain
        ? 'Could not confidently measure the background near this text (no nearby sampled region looked ' +
          'like flat background rather than adjacent content) — skipping rather than risking a false pass/fail'
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
