/**
 * Cross-reference checker.
 * Validates that "see Section X.Y" references point to section headings
 * that actually exist in the document.
 */
import { SECTION_REF, SECTION_HEADING } from '../rules/regex-patterns';

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

function extractContext(text: string, offset: number, length: number = 60): string {
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + length + 20);
  return text.slice(start, end).replace(/\n/g, ' ').trim();
}

export function checkCrossReferences(text: string, _html: string): CheckResult {
  const issues: CheckIssue[] = [];

  // Collect all section headings present in the document
  const headingIds = new Set<string>();
  const headingRegex = new RegExp(SECTION_HEADING.source, SECTION_HEADING.flags);
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(text)) !== null) {
    headingIds.add(m[1]);
  }

  // Collect all section references in text ("Section 3.2", "Sec. 4")
  const refs: { id: string; offset: number; match: string }[] = [];
  const refRegex = new RegExp(SECTION_REF.source, SECTION_REF.flags);
  while ((m = refRegex.exec(text)) !== null) {
    refs.push({ id: m[1], offset: m.index, match: m[0] });
  }

  // Check each reference against known headings
  for (const ref of refs) {
    if (!headingIds.has(ref.id)) {
      // Also check if a parent section exists (e.g. ref to "3.2" when only "3" exists)
      const parts = ref.id.split('.');
      let parentExists = false;
      if (parts.length > 1) {
        const parentId = parts.slice(0, -1).join('.');
        parentExists = headingIds.has(parentId);
      }

      issues.push({
        checkType: 'CROSS_REF',
        severity: parentExists ? 'WARNING' : 'ERROR',
        title: 'Cross-reference to non-existent section',
        description: `"${ref.match}" references section ${ref.id}, but no heading with that number was found.${parentExists ? ` Parent section ${parts.slice(0, -1).join('.')} exists.` : ''}`,
        startOffset: ref.offset,
        endOffset: ref.offset + ref.match.length,
        originalText: ref.match,
        actualValue: ref.id,
        suggestedFix: headingIds.size > 0
          ? `Verify the section number. Existing sections: ${[...headingIds].sort().join(', ')}.`
          : 'No numbered section headings were found in the document.',
        context: extractContext(text, ref.offset),
      });
    }
  }

  return {
    checkType: 'CROSS_REF',
    issues,
    metadata: {
      sectionHeadingsFound: headingIds.size,
      sectionReferencesFound: refs.length,
      validReferences: refs.filter((r) => headingIds.has(r.id)).length,
      invalidReferences: refs.filter((r) => !headingIds.has(r.id)).length,
      knownSections: [...headingIds].sort(),
    },
  };
}
