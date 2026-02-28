/**
 * Abbreviation consistency checker.
 * Validates that abbreviations are defined on first use (e.g. "World Health Organization (WHO)")
 * and used consistently throughout the document.
 */
import { ABBREVIATION_DEFINITION, ABBREVIATION_USE } from '../rules/regex-patterns';

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

interface AbbreviationDef {
  abbreviation: string;
  fullForm: string;
  offset: number;
  match: string;
}

/** Common acronyms that don't need definition (widely known). */
const COMMON_ACRONYMS = new Set([
  'USA', 'UK', 'EU', 'UN', 'NATO', 'NASA', 'FBI', 'CIA', 'DNA', 'RNA',
  'HIV', 'AIDS', 'PDF', 'HTML', 'CSS', 'URL', 'API', 'USB', 'RAM', 'ROM',
  'CEO', 'CFO', 'CTO', 'PhD', 'MD', 'ID', 'OK', 'AM', 'PM', 'BC', 'AD',
  'IT', 'AI', 'ML', 'IoT', 'GDP', 'GNP', 'IMF', 'WHO', 'WTO',
]);

function extractContext(text: string, offset: number, length: number = 60): string {
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + length + 20);
  return text.slice(start, end).replace(/\n/g, ' ').trim();
}

export function checkAbbreviationConsistency(text: string, _html: string): CheckResult {
  const issues: CheckIssue[] = [];

  // 1. Find all abbreviation definitions: "Full Form (ABBR)"
  const definitions: AbbreviationDef[] = [];
  const defRegex = new RegExp(ABBREVIATION_DEFINITION.source, ABBREVIATION_DEFINITION.flags);
  let m: RegExpExecArray | null;
  while ((m = defRegex.exec(text)) !== null) {
    definitions.push({
      fullForm: m[1].trim(),
      abbreviation: m[2],
      offset: m.index,
      match: m[0],
    });
  }

  const definedAbbrs = new Map<string, AbbreviationDef>();
  for (const def of definitions) {
    if (!definedAbbrs.has(def.abbreviation)) {
      definedAbbrs.set(def.abbreviation, def);
    }
  }

  // 2. Check for multiple definitions of the same abbreviation
  const defCounts = new Map<string, AbbreviationDef[]>();
  for (const def of definitions) {
    const existing = defCounts.get(def.abbreviation) || [];
    existing.push(def);
    defCounts.set(def.abbreviation, existing);
  }

  for (const [abbr, defs] of defCounts) {
    if (defs.length > 1) {
      for (let i = 1; i < defs.length; i++) {
        issues.push({
          checkType: 'ABBREVIATION',
          severity: 'WARNING',
          title: 'Abbreviation defined multiple times',
          description: `"${abbr}" is defined ${defs.length} times. Define abbreviations only on first use.`,
          startOffset: defs[i].offset,
          endOffset: defs[i].offset + defs[i].match.length,
          originalText: defs[i].match,
          actualValue: abbr,
          suggestedFix: `Remove the redundant definition and use just "${abbr}" after its first definition.`,
          context: extractContext(text, defs[i].offset),
        });
      }
    }
  }

  // 3. Find all abbreviation usages (standalone uppercase 2-8 char words)
  const useRegex = new RegExp(ABBREVIATION_USE.source, ABBREVIATION_USE.flags);
  const usages: { abbr: string; offset: number; match: string }[] = [];
  while ((m = useRegex.exec(text)) !== null) {
    const abbr = m[1];
    // Skip single-letter, common words, and numbers
    if (abbr.length >= 2 && !COMMON_ACRONYMS.has(abbr)) {
      usages.push({ abbr, offset: m.index, match: m[0] });
    }
  }

  // 4. Check for abbreviations used before being defined
  for (const usage of usages) {
    const def = definedAbbrs.get(usage.abbr);
    if (def && usage.offset < def.offset) {
      issues.push({
        checkType: 'ABBREVIATION',
        severity: 'ERROR',
        title: 'Abbreviation used before definition',
        description: `"${usage.abbr}" is used before it is defined. First use at offset ${usage.offset}, definition at offset ${def.offset}.`,
        startOffset: usage.offset,
        endOffset: usage.offset + usage.match.length,
        originalText: usage.match,
        expectedValue: def.fullForm,
        actualValue: usage.abbr,
        suggestedFix: `Move the definition "${def.fullForm} (${usage.abbr})" before its first use, or spell out the full form here.`,
        context: extractContext(text, usage.offset),
      });
    }
  }

  // 5. Check for abbreviations used but never defined (excluding common ones)
  const usedAbbrs = new Set(usages.map((u) => u.abbr));
  for (const abbr of usedAbbrs) {
    if (!definedAbbrs.has(abbr)) {
      // Count occurrences — only flag if used more than once (single uses may be false positives)
      const abbrUsages = usages.filter((u) => u.abbr === abbr);
      if (abbrUsages.length >= 2) {
        issues.push({
          checkType: 'ABBREVIATION',
          severity: 'SUGGESTION',
          title: 'Abbreviation used without definition',
          description: `"${abbr}" is used ${abbrUsages.length} times but never defined. Consider defining it on first use.`,
          startOffset: abbrUsages[0].offset,
          endOffset: abbrUsages[0].offset + abbrUsages[0].match.length,
          originalText: abbr,
          actualValue: abbr,
          suggestedFix: `Define "${abbr}" on first use, e.g., "Full Form (${abbr})".`,
          context: extractContext(text, abbrUsages[0].offset),
        });
      }
    }
  }

  return {
    checkType: 'ABBREVIATION',
    issues,
    metadata: {
      definedAbbreviations: definitions.map((d) => ({
        abbreviation: d.abbreviation,
        fullForm: d.fullForm,
      })),
      totalDefinitions: definitions.length,
      uniqueAbbreviationsUsed: usedAbbrs.size,
      undefinedAbbreviations: [...usedAbbrs].filter((a) => !definedAbbrs.has(a)),
    },
  };
}
