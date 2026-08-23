/**
 * PDF Contrast Writer Service
 *
 * Phase B2 of the color-contrast automation plan (B0: color-correction math,
 * B1: content-stream text-run correlation — both already shipped). This is
 * the actual write: wraps the located text run in a corrected fill color.
 *
 * Only construct that's both spec-legal and leak-proof: `q`/`Q` are not
 * permitted inside `BT…ET` (PDF32000-1:2008 Annex A), so the whole unit gets
 * wrapped — `q\n<r> <g> <b> rg\nBT…ET\nQ\n`. `Q` restores whatever color
 * state existed before `q` unconditionally, so nothing outside the wrapped
 * span is ever affected, regardless of what originally set the color.
 *
 * Always emits plain `rg` (DeviceRGB) regardless of the original color
 * operator's colorspace — the correction target itself comes from sampled
 * *rendered* pixels (PdfContrastValidator), not the literal original
 * operator value, so preserving `k`/`scn`/Separation/ICC would overstate a
 * precision that was never there.
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
import type { FixResult } from './pdf-structure-writer.service';

// Independent safety gate — enforced here regardless of what a caller (the
// AI-analysis pipeline, Phase B3) checks before even offering this as a
// suggestion. Matches the confidence bar Phase B3 is planned to require for
// apply-to-pdf eligibility, but this module doesn't trust callers to have
// applied it correctly.
const MIN_APPLY_CONFIDENCE = 0.80;

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

export class PdfContrastWriterService {
  /**
   * Rewrites the flagged text's fill color in the PDF content stream so it
   * clears the required WCAG contrast ratio. Recomputes correlation fresh
   * against `doc` (doesn't trust byte offsets computed at analysis time
   * against a possibly-different buffer) — cheap, and safer to reason about.
   */
  fixColorContrast(doc: PDFDocument, issue: AuditIssue): FixResult {
    const cd = issue.contrastData;
    if (!cd) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue has no contrastData (deterministic measurement missing)' };
    }
    if (!issue.pageNumber || !issue.boundingBox) {
      return { issueId: issue.id, success: false, before: 'unknown', after: 'unknown', error: 'Issue is missing pageNumber or boundingBox' };
    }

    const before = `${cd.foreground} on ${cd.background} (${cd.ratio}:1)`;

    let rotation = 0;
    try {
      rotation = doc.getPage(issue.pageNumber - 1).getRotation().angle;
    } catch {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: `Page ${issue.pageNumber} not found` };
    }
    if (rotation !== 0) {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: 'Cannot correlate on a rotated page (axis-aligned assumption)' };
    }

    const content = decodePageContent(doc, issue.pageNumber);
    if (content === null) {
      return { issueId: issue.id, success: false, before, after: 'unknown', error: 'Could not decode page content stream' };
    }

    const target = {
      x: issue.boundingBox.x,
      baselineY: issue.boundingBox.pageHeight - issue.boundingBox.y,
    };
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

    const corrected = computeCompliantColor(cd.foreground, cd.background, cd.requiredRatio);
    const rewritten = spliceColorWrap(content, match.start, match.end, hexToUnitRgb(corrected.color));

    writePageContent(doc, issue.pageNumber, rewritten);

    logger.info(
      `[ContrastWriter] fixColorContrast: ${cd.foreground} -> ${corrected.color} on page ${issue.pageNumber} ` +
      `(${cd.ratio}:1 -> ${corrected.appliedRatio}:1)`
    );

    return {
      issueId: issue.id,
      success: true,
      before,
      after: `${corrected.color} on ${cd.background} (${corrected.appliedRatio}:1)`,
    };
  }
}

export const pdfContrastWriterService = new PdfContrastWriterService();
