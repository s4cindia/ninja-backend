/**
 * PDF Contrast Writer Service
 *
 * Phase B2 of the color-contrast automation plan (B0: color-correction math,
 * B1: content-stream text-run correlation — both already shipped). This is
 * the actual write: recolors the located text run's fill color.
 *
 * Two distinct write strategies, chosen by what Phase B1's correlation found:
 *
 * 1. **Internal fill-color operator present (the common case)** — pdf-lib,
 *    and most authoring tools, emit the fill color *inside* BT…ET, right
 *    after BT (e.g. `BT\n0.6 0.6 0.6 rg\n...\nTj\n...\nET`). An outer
 *    q/<color>/Q wrap around the whole unit is silently overridden by this
 *    internal op before Tj ever executes — confirmed the hard way via a real
 *    audit→apply→re-audit round trip that showed zero effect on the
 *    rendered color despite the write "succeeding". So when Phase B1 finds
 *    exactly one internal fill op, this replaces that operator's span
 *    directly (its operands through the operator keyword) with the
 *    corrected color — no wrap needed, and no risk of it being overridden.
 *
 * 2. **No internal fill-color operator** — color is inherited from outside
 *    the unit. Here the q/Q wrap (spliceColorWrap) is correct and
 *    sufficient: `q`/`Q` are not legal *inside* BT…ET (PDF32000-1:2008
 *    Annex A), so wrapping the whole unit is the only spec-legal, leak-proof
 *    construct — `Q` restores prior color state unconditionally, so nothing
 *    outside the wrapped span is ever affected.
 *
 * (Two or more internal fill ops is genuinely ambiguous — Phase B1 already
 * refuses to match in that case.)
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
 * Pure string splice — wraps content[start,end) in `q\n<r> <g> <b> rg\n` /
 * `\nQ\n`. Exported separately from fixColorContrast so the splice-offset
 * logic is testable without a pdf-lib document.
 */
export function spliceColorWrap(
  content: string,
  start: number,
  end: number,
  rgb: [number, number, number]
): string {
  const [r, g, b] = rgb;
  return (
    content.slice(0, start) +
    `q\n${r} ${g} ${b} rg\n` +
    content.slice(start, end) +
    `\nQ\n` +
    content.slice(end)
  );
}

/**
 * Pure string splice — replaces content[start,end) (an existing fill-color
 * operator's full span) with a new `<r> <g> <b> rg` operator. Used instead
 * of spliceColorWrap when the text run sets its own fill color internally
 * (see class doc comment) — directly replacing it is what actually changes
 * the rendered color; wrapping around it would not.
 */
export function spliceColorReplace(
  content: string,
  start: number,
  end: number,
  rgb: [number, number, number]
): string {
  const [r, g, b] = rgb;
  return content.slice(0, start) + `${r} ${g} ${b} rg` + content.slice(end);
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

    const applyColor = (hex: string): void => {
      const rgb = hexToUnitRgb(hex);
      const rewritten = match.internalFillColorOp
        ? spliceColorReplace(content, match.internalFillColorOp.start, match.internalFillColorOp.end, rgb)
        : spliceColorWrap(content, match.start, match.end, rgb);
      writePageContent(doc, pageNumber, rewritten);
    };
    const verify = async (): Promise<{ ratio: number; passes: boolean } | null> => {
      const buffer = Buffer.from(await doc.save());
      return verifyContrastInRegion(buffer, pageNumber, boundingBox, cd.requiredRatio);
    };

    let appliedColor = computeCompliantColor(cd.foreground, cd.background, cd.requiredRatio).color;
    applyColor(appliedColor);
    let verification = await verify();

    if (!verification || !verification.passes) {
      logger.info(
        `[ContrastWriter] Moderate correction (${appliedColor}) did not verify` +
        `${verification ? ` (measured ${verification.ratio}:1)` : ''} — escalating to an extreme color for page ${pageNumber}`
      );
      appliedColor = computeCompliantColor(cd.foreground, cd.background, EXTREME_TARGET_RATIO).color;
      applyColor(appliedColor);
      verification = await verify();
    }

    if (!verification || !verification.passes) {
      return {
        issueId: issue.id,
        success: false,
        before,
        after: 'unknown',
        error: `Fix did not verify even after escalating to ${appliedColor} ` +
          `(measured ${verification?.ratio ?? 'unknown'}:1, required ${cd.requiredRatio}:1)`,
      };
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
