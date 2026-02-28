/**
 * Numbering sequence checker.
 * Validates sequential numbering of sections, figures, tables, and equations.
 * Flags gaps (e.g. 1, 2, 4 — missing 3) and duplicates (e.g. two Figure 2 captions).
 */
import {
  SECTION_HEADING,
  FIGURE_CAPTION,
  TABLE_CAPTION,
  EQUATION_REF,
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

interface NumberedItem {
  id: string;
  numericValue: number;
  offset: number;
  match: string;
}

function collectNumbered(
  text: string,
  pattern: RegExp,
): NumberedItem[] {
  const items: NumberedItem[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    // For top-level numbering, use integer part only (e.g. "3.2" -> 3 for section, but keep full for sub-numbering)
    const numericValue = parseFloat(id);
    if (!isNaN(numericValue)) {
      items.push({ id, numericValue, offset: m.index, match: m[0] });
    }
  }
  return items;
}

/**
 * Check a list of numbered items for gaps and duplicates.
 * Only checks top-level numbering (integer part).
 */
function checkSequence(
  items: NumberedItem[],
  label: string,
  checkType: string,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  if (items.length === 0) return issues;

  // Group by top-level number to detect duplicates
  const topLevelMap = new Map<number, NumberedItem[]>();
  for (const item of items) {
    const topLevel = Math.floor(item.numericValue);
    const existing = topLevelMap.get(topLevel) || [];
    existing.push(item);
    topLevelMap.set(topLevel, existing);
  }

  // Detect duplicates at top level (ignoring sub-numbering like 3.1, 3.2)
  // Only flag exact ID duplicates
  const idCounts = new Map<string, NumberedItem[]>();
  for (const item of items) {
    const existing = idCounts.get(item.id) || [];
    existing.push(item);
    idCounts.set(item.id, existing);
  }

  for (const [id, dupes] of idCounts) {
    if (dupes.length > 1) {
      for (let i = 1; i < dupes.length; i++) {
        issues.push({
          checkType,
          severity: 'ERROR',
          title: `Duplicate ${label} numbering`,
          description: `${label} ${id} appears ${dupes.length} times. Each ${label.toLowerCase()} should have a unique number.`,
          startOffset: dupes[i].offset,
          endOffset: dupes[i].offset + dupes[i].match.length,
          originalText: dupes[i].match,
          actualValue: id,
          suggestedFix: `Renumber duplicate ${label} ${id} to maintain a unique sequence.`,
        });
      }
    }
  }

  // Check for gaps in top-level sequence
  const topLevelNumbers = [...topLevelMap.keys()].sort((a, b) => a - b);
  if (topLevelNumbers.length > 1) {
    for (let i = 1; i < topLevelNumbers.length; i++) {
      const prev = topLevelNumbers[i - 1];
      const curr = topLevelNumbers[i];
      if (curr - prev > 1) {
        const missing: number[] = [];
        for (let n = prev + 1; n < curr; n++) {
          missing.push(n);
        }
        // Attach issue to the item that follows the gap
        const nextItems = topLevelMap.get(curr)!;
        issues.push({
          checkType,
          severity: 'ERROR',
          title: `Gap in ${label} numbering`,
          description: `${label} numbering jumps from ${prev} to ${curr}. Missing: ${missing.join(', ')}.`,
          startOffset: nextItems[0].offset,
          endOffset: nextItems[0].offset + nextItems[0].match.length,
          originalText: nextItems[0].match,
          expectedValue: String(prev + 1),
          actualValue: String(curr),
          suggestedFix: `Add the missing ${label.toLowerCase()}(s) ${missing.map((n) => `${label} ${n}`).join(', ')}, or renumber starting from ${prev + 1}.`,
        });
      }
    }

    // Check if sequence starts at 1
    if (topLevelNumbers[0] > 1) {
      const firstItems = topLevelMap.get(topLevelNumbers[0])!;
      issues.push({
        checkType,
        severity: 'WARNING',
        title: `${label} numbering does not start at 1`,
        description: `${label} numbering starts at ${topLevelNumbers[0]} instead of 1.`,
        startOffset: firstItems[0].offset,
        endOffset: firstItems[0].offset + firstItems[0].match.length,
        originalText: firstItems[0].match,
        expectedValue: '1',
        actualValue: String(topLevelNumbers[0]),
        suggestedFix: `Renumber ${label.toLowerCase()}s to start from 1.`,
      });
    }
  }

  return issues;
}

export function checkNumberingSequence(text: string, _html: string): CheckResult {
  const sectionItems = collectNumbered(text, SECTION_HEADING);
  const figureItems = collectNumbered(text, FIGURE_CAPTION);
  const tableItems = collectNumbered(text, TABLE_CAPTION);
  const equationItems = collectNumbered(text, EQUATION_REF);

  const sectionIssues = checkSequence(sectionItems, 'Section', 'SECTION_NUMBERING');
  const figureIssues = checkSequence(figureItems, 'Figure', 'FIGURE_NUMBERING');
  const tableIssues = checkSequence(tableItems, 'Table', 'TABLE_NUMBERING');
  const equationIssues = checkSequence(equationItems, 'Equation', 'EQUATION_NUMBERING');

  return {
    checkType: 'NUMBERING_SEQUENCE',
    issues: [...sectionIssues, ...figureIssues, ...tableIssues, ...equationIssues],
    metadata: {
      sectionsFound: sectionItems.length,
      figuresFound: figureItems.length,
      tablesFound: tableItems.length,
      equationsFound: equationItems.length,
      sectionNumbers: sectionItems.map((s) => s.id),
      figureNumbers: figureItems.map((f) => f.id),
      tableNumbers: tableItems.map((t) => t.id),
      equationNumbers: equationItems.map((e) => e.id),
    },
  };
}
