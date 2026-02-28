/**
 * Unit consistency checker.
 * Detects mixed unit forms in the same document (e.g. "mg" and "milligrams").
 * Uses unit-mappings.ts to group related forms.
 */
import { defaultUnitGroups, findUnitGroup } from '../rules/unit-mappings';

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

interface UnitOccurrence {
  form: string;
  offset: number;
  match: string;
  groupName: string;
}

/**
 * Build a regex that matches all known unit forms as whole words.
 * Longer forms are matched first to avoid partial matches.
 */
function buildUnitPattern(): RegExp {
  const allForms: string[] = [];
  for (const group of defaultUnitGroups) {
    for (const form of group.forms) {
      allForms.push(form);
    }
  }
  // Sort longest first so "milligrams" matches before "mg" in ambiguous contexts
  allForms.sort((a, b) => b.length - a.length);
  const escaped = allForms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Use word boundary for alphabetic forms; handle special chars like °C
  return new RegExp(`(?:^|\\s|\\d)(${escaped.join('|')})(?=\\s|$|[.,;:!?)])`, 'g');
}

export function checkUnitConsistency(text: string, _html: string): CheckResult {
  const issues: CheckIssue[] = [];
  const unitPattern = buildUnitPattern();
  const occurrences: UnitOccurrence[] = [];

  let m: RegExpExecArray | null;
  while ((m = unitPattern.exec(text)) !== null) {
    const form = m[1];
    const group = findUnitGroup(form);
    if (group) {
      // Adjust offset to point to the actual unit form, not leading whitespace/digit
      const formStart = m.index + m[0].indexOf(form);
      occurrences.push({
        form,
        offset: formStart,
        match: form,
        groupName: group.name,
      });
    }
  }

  // Group occurrences by unit group
  const groupedOccurrences = new Map<string, UnitOccurrence[]>();
  for (const occ of occurrences) {
    const existing = groupedOccurrences.get(occ.groupName) || [];
    existing.push(occ);
    groupedOccurrences.set(occ.groupName, existing);
  }

  // Check each group for mixed forms
  for (const [groupName, occs] of groupedOccurrences) {
    const uniqueForms = new Set(occs.map((o) => o.form));
    if (uniqueForms.size > 1) {
      const group = defaultUnitGroups.find((g) => g.name === groupName);
      if (!group) continue;

      // Determine the dominant form (most frequently used)
      const formCounts = new Map<string, number>();
      for (const occ of occs) {
        formCounts.set(occ.form, (formCounts.get(occ.form) || 0) + 1);
      }
      let dominantForm = occs[0].form;
      let maxCount = 0;
      for (const [form, count] of formCounts) {
        if (count > maxCount) {
          maxCount = count;
          dominantForm = form;
        }
      }

      // Flag each minority-form occurrence
      for (const occ of occs) {
        if (occ.form !== dominantForm) {
          issues.push({
            checkType: 'UNIT_CONSISTENCY',
            severity: 'WARNING',
            title: `Inconsistent unit form for ${groupName}`,
            description: `Mixed usage of "${occ.form}" and "${dominantForm}" for ${groupName}. Use one form consistently.`,
            startOffset: occ.offset,
            endOffset: occ.offset + occ.form.length,
            originalText: occ.form,
            expectedValue: dominantForm,
            actualValue: occ.form,
            suggestedFix: `Replace "${occ.form}" with "${dominantForm}" for consistency (or vice versa).`,
          });
        }
      }
    }
  }

  return {
    checkType: 'UNIT_CONSISTENCY',
    issues,
    metadata: {
      totalUnitOccurrences: occurrences.length,
      unitGroupsFound: groupedOccurrences.size,
      inconsistentGroups: [...groupedOccurrences.entries()]
        .filter(([, occs]) => new Set(occs.map((o) => o.form)).size > 1)
        .map(([name]) => name),
    },
  };
}
