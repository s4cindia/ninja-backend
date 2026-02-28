/**
 * Figure & Table cross-reference checker.
 * Compares in-text callouts (e.g. "Figure 3", "Table 2") against captions
 * and flags mismatches: referenced but no caption, or caption but never referenced.
 */
import {
  FIGURE_REF,
  FIGURE_CAPTION,
  TABLE_REF,
  TABLE_CAPTION,
  EQUATION_REF as EQUATION_REF_PATTERN,
  EQUATION_CAPTION,
  BOX_REF as BOX_REF_PATTERN,
  BOX_CAPTION,
} from '../rules/regex-patterns';

export interface CheckIssue {
  checkType: string;
  severity: 'ERROR' | 'WARNING' | 'SUGGESTION';
  title: string;
  description: string;
  startOffset?: number;
  endOffset?: number;
  originalText?: string;
  expectedValue?: string;
  actualValue?: string;
  suggestedFix?: string;
  context?: string;
}

export interface CheckResult {
  checkType: string;
  issues: CheckIssue[];
  metadata: Record<string, unknown>;
}

function collectMatches(
  text: string,
  pattern: RegExp,
): { id: string; offset: number; match: string }[] {
  const results: { id: string; offset: number; match: string }[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({
      id: m[1].toLowerCase(),
      offset: m.index,
      match: m[0],
    });
  }
  return results;
}

function extractContext(text: string, offset: number, length: number = 80): string {
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + length + 20);
  return text.slice(start, end).replace(/\n/g, ' ').trim();
}

function checkRefType(
  text: string,
  label: string,
  checkType: string,
  refPattern: RegExp,
  captionPattern: RegExp,
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  const refs = collectMatches(text, refPattern);
  const captions = collectMatches(text, captionPattern);

  const refIds = new Set(refs.map((r) => r.id));
  const captionIds = new Set(captions.map((c) => c.id));

  // Referenced in text but no caption found
  for (const ref of refs) {
    if (!captionIds.has(ref.id)) {
      issues.push({
        checkType,
        severity: 'ERROR',
        title: `${label} referenced but no caption found`,
        description: `"${ref.match}" is referenced in the text but no corresponding ${label.toLowerCase()} caption was found.`,
        startOffset: ref.offset,
        endOffset: ref.offset + ref.match.length,
        originalText: ref.match,
        actualValue: ref.id,
        suggestedFix: `Add a caption for ${label} ${ref.id}, or correct the reference number.`,
        context: extractContext(text, ref.offset),
      });
    }
  }

  // Caption exists but never referenced in text
  for (const cap of captions) {
    if (!refIds.has(cap.id)) {
      issues.push({
        checkType,
        severity: 'WARNING',
        title: `${label} caption exists but never referenced`,
        description: `${label} ${cap.id} has a caption but is never referenced in the body text.`,
        startOffset: cap.offset,
        endOffset: cap.offset + cap.match.length,
        originalText: cap.match,
        actualValue: cap.id,
        suggestedFix: `Add a reference to ${label} ${cap.id} in the text, or remove the unused ${label.toLowerCase()}.`,
        context: extractContext(text, cap.offset),
      });
    }
  }

  return issues;
}

export function checkFigureTableRefs(text: string, _html: string): CheckResult {
  const figureIssues = checkRefType(text, 'Figure', 'FIGURE_REF', FIGURE_REF, FIGURE_CAPTION);
  const tableIssues = checkRefType(text, 'Table', 'TABLE_REF', TABLE_REF, TABLE_CAPTION);

  const figRefs = collectMatches(text, FIGURE_REF);
  const figCaptions = collectMatches(text, FIGURE_CAPTION);
  const tblRefs = collectMatches(text, TABLE_REF);
  const tblCaptions = collectMatches(text, TABLE_CAPTION);

  return {
    checkType: 'FIGURE_TABLE_REF',
    issues: [...figureIssues, ...tableIssues],
    metadata: {
      figureRefsFound: figRefs.length,
      figureCaptionsFound: figCaptions.length,
      tableRefsFound: tblRefs.length,
      tableCaptionsFound: tblCaptions.length,
      uniqueFigureRefs: new Set(figRefs.map((r) => r.id)).size,
      uniqueFigureCaptions: new Set(figCaptions.map((c) => c.id)).size,
      uniqueTableRefs: new Set(tblRefs.map((r) => r.id)).size,
      uniqueTableCaptions: new Set(tblCaptions.map((c) => c.id)).size,
    },
  };
}

/**
 * Equation & Box cross-reference checker.
 * Same logic as figure/table but for equations and boxes.
 */
export function checkEquationBoxRefs(text: string, _html: string): CheckResult {
  const equationIssues = checkRefType(text, 'Equation', 'EQUATION_REF', EQUATION_REF_PATTERN, EQUATION_CAPTION);
  const boxIssues = checkRefType(text, 'Box', 'BOX_REF', BOX_REF_PATTERN, BOX_CAPTION);

  const eqRefs = collectMatches(text, EQUATION_REF_PATTERN);
  const eqCaptions = collectMatches(text, EQUATION_CAPTION);
  const boxRefs = collectMatches(text, BOX_REF_PATTERN);
  const boxCaptions = collectMatches(text, BOX_CAPTION);

  return {
    checkType: 'EQUATION_BOX_REF',
    issues: [...equationIssues, ...boxIssues],
    metadata: {
      equationRefsFound: eqRefs.length,
      equationCaptionsFound: eqCaptions.length,
      boxRefsFound: boxRefs.length,
      boxCaptionsFound: boxCaptions.length,
      uniqueEquationRefs: new Set(eqRefs.map((r) => r.id)).size,
      uniqueEquationCaptions: new Set(eqCaptions.map((c) => c.id)).size,
      uniqueBoxRefs: new Set(boxRefs.map((r) => r.id)).size,
      uniqueBoxCaptions: new Set(boxCaptions.map((c) => c.id)).size,
    },
  };
}
