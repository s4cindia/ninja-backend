/**
 * Citation Utilities
 * Shared helpers for citation management controllers
 */

/**
 * Build a deterministic formatted reference string from field values and style code.
 * Used by both the export controller (DOCX track-change diffing) and the reference
 * controller (fallback when AI formatting fails). Having a single implementation
 * ensures both paths produce identical output, preventing DOCX match failures.
 */
export function buildFormattedReference(vals: Record<string, unknown>, style: string): string {
  const authArr = Array.isArray(vals.authors) ? (vals.authors as string[]) : [];
  const yr = vals.year ? String(vals.year) : '';
  const ttl = vals.title ? String(vals.title) : '';
  const jnl = vals.journalName ? String(vals.journalName) : '';
  const vol = vals.volume ? String(vals.volume) : '';
  const iss = vals.issue ? String(vals.issue) : '';
  const pg = vals.pages ? String(vals.pages) : '';
  const doiStr = vals.doi ? String(vals.doi) : '';
  const urlStr = vals.url ? String(vals.url) : '';
  const pub = vals.publisher ? String(vals.publisher) : '';

  if (style === 'vancouver' || style === 'ama') {
    const authorStr = authArr.length > 0
      ? authArr.map(a => String(a).trim()).join(', ')
      : 'Unknown Author';
    const source = jnl ? `${jnl}. ${yr}` : yr;
    const volIssPg = vol
      ? `;${vol}${iss ? `(${iss})` : ''}${pg ? `:${pg}` : ''}`
      : (pg ? `:${pg}` : '');
    const doiPart = doiStr ? ` doi: ${doiStr}` : (urlStr ? ` Available from: ${urlStr}` : '');
    const pubPart = pub ? ` ${pub}.` : '';
    return `${authorStr}. ${ttl}. ${source}${volIssPg}.${pubPart}${doiPart}`.trim();
  } else if (style === 'apa7') {
    const authorStr = authArr.length > 0
      ? authArr.map((a: string) => {
          const trimmed = String(a).trim();
          if (trimmed.includes(',')) return trimmed;
          const parts = trimmed.split(/\s+/);
          if (parts.length === 1) return parts[0];
          const lastName = parts[0];
          const initials = parts.slice(1).map(p => `${p.charAt(0)}.`).join(' ');
          return `${lastName}, ${initials}`;
        }).join(', ')
      : 'Unknown Author';
    const source = jnl ? `${jnl}` : '';
    const volPart = vol ? `, ${vol}` : '';
    const issPart = iss ? `(${iss})` : '';
    const pgPart = pg ? `, ${pg}` : '';
    const doiPart = doiStr ? ` https://doi.org/${doiStr}` : (urlStr ? ` ${urlStr}` : '');
    const pubPart = pub ? ` ${pub}.` : '';
    return `${authorStr} (${yr}). ${ttl}. ${source}${volPart}${issPart}${pgPart}.${pubPart}${doiPart}`.trim();
  } else if (style === 'chicago17' || style.startsWith('chicago')) {
    const authorStr = authArr.length > 0
      ? authArr.map(a => String(a).trim()).join(', ')
      : 'Unknown Author';
    const volPart = vol ? ` ${vol}` : '';
    const issPart = iss ? `, no. ${iss}` : '';
    const yrPart = yr ? ` (${yr})` : '';
    const pgPart = pg ? `: ${pg}` : '';
    const doiPart = doiStr ? ` https://doi.org/${doiStr}.` : (urlStr ? ` ${urlStr}.` : '');
    const pubPart = pub ? ` ${pub}.` : '';
    return `${authorStr}. "${ttl}." ${jnl}${volPart}${issPart}${yrPart}${pgPart}.${pubPart}${doiPart}`.trim();
  } else if (style === 'ieee') {
    const authorStr = authArr.length > 0
      ? authArr.map((a: string) => {
          const trimmed = String(a).trim();
          const parts = trimmed.split(/\s+/);
          if (parts.length === 1) return parts[0];
          const lastName = parts[0];
          const initials = parts.slice(1).map(p => `${p.charAt(0)}.`).join(' ');
          return `${initials} ${lastName}`;
        }).join(', ')
      : 'Unknown Author';
    const volPart = vol ? `vol. ${vol}` : '';
    const issPart = iss ? `no. ${iss}` : '';
    const pgPart = pg ? `pp. ${pg}` : '';
    const fmtParts = [volPart, issPart, pgPart, yr].filter(Boolean).join(', ');
    const doiPart = doiStr ? ` doi: ${doiStr}` : (urlStr ? ` [Online]. Available: ${urlStr}` : '');
    const pubPart = pub ? ` ${pub}.` : '';
    return `${authorStr}, "${ttl}," ${jnl}, ${fmtParts}.${pubPart}${doiPart}`.trim();
  } else {
    // Generic / APA-like fallback
    const authorStr = authArr.length > 0
      ? authArr.map(a => String(a).trim()).join(', ')
      : 'Unknown Author';
    const source = jnl ? ` ${jnl}` : '';
    const volPart = vol ? `, ${vol}` : '';
    const issPart = iss ? `(${iss})` : '';
    const pgPart = pg ? `, ${pg}` : '';
    const doiPart = doiStr ? ` https://doi.org/${doiStr}` : (urlStr ? ` ${urlStr}` : '');
    const pubPart = pub ? ` ${pub}.` : '';
    return `${authorStr} (${yr}). ${ttl}.${source}${volPart}${issPart}${pgPart}.${pubPart}${doiPart}`.trim();
  }
}

/**
 * Extract sorted number array from citation text like "(1, 2)", "[3-5]", "(2–4)".
 * Handles brackets, parentheses, comma-separated lists, and hyphen/en-dash ranges.
 */
export function extractCitationNumbers(text: string): number[] {
  const inner = text.replace(/^[[(]|[)\]]$/g, '').trim();
  const nums: number[] = [];
  for (const part of inner.split(',')) {
    const trimmed = part.trim();
    // Only accept whole-token numbers or ranges (reject parts with extra letters)
    const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      // Guard against pathological ranges (e.g. "[1-10000000]")
      if (end - start > 200) continue;
      for (let i = start; i <= end; i++) nums.push(i);
    } else if (/^\d+$/.test(trimmed)) {
      nums.push(parseInt(trimmed, 10));
    }
  }
  return nums.sort((a, b) => a - b);
}

/**
 * Check if two citation texts represent the same numbers
 */
// Intentionally returns false for empty-vs-empty (numsA.length > 0 guard)
// so that two non-citation strings are not considered a match
export function citationNumbersMatch(a: string, b: string): boolean {
  const numsA = extractCitationNumbers(a);
  const numsB = extractCitationNumbers(b);
  return numsA.length > 0 && numsA.length === numsB.length && numsA.every((n, i) => n === numsB[i]);
}

/**
 * Build a map of reference ID to 1-indexed reference number
 * @param references - Array of references with id property
 * @returns Map of reference ID to reference number (1-indexed)
 */
export function buildRefIdToNumberMap(
  references: Array<{ id: string }>
): Map<string, number> {
  const refIdToNumber = new Map<string, number>();
  for (let i = 0; i < references.length; i++) {
    refIdToNumber.set(references[i].id, i + 1);
  }
  return refIdToNumber;
}

/**
 * Get reference number from map, returning null if not found
 * @param refIdToNumber - Map of reference ID to number
 * @param refId - Reference ID to lookup
 * @returns Reference number or null if not found
 */
export function getRefNumber(
  refIdToNumber: Map<string, number>,
  refId: string
): number | null {
  return refIdToNumber.get(refId) ?? null;
}

/**
 * Format citation for API response
 * Shared structure used by both export and upload controllers
 */
export interface FormattedCitation {
  id: string;
  changeId?: string;  // CitationChange ID for dismiss operations
  rawText: string;
  citationType: string;
  paragraphIndex: number | null;
  referenceNumber: number | null;
  linkedReferenceIds: string[];
  linkedReferenceNumbers: number[];
  originalText: string;
  newText: string;
  changeType: string;
  isOrphaned: boolean;
}

/**
 * Check if a citation is orphaned (has no valid reference links)
 * Applies to citation types that are expected to link to references
 */
export function isCitationOrphaned(
  linkedRefNumbers: number[],
  citationType: string
): boolean {
  // Citation types that should have reference links
  const linkableCitationTypes = ['NUMERIC', 'PARENTHETICAL', 'NARRATIVE', 'FOOTNOTE', 'ENDNOTE'];

  if (!linkableCitationTypes.includes(citationType)) {
    return false;
  }

  return linkedRefNumbers.length === 0;
}

/**
 * Format a citation with change information for API response
 */
export function formatCitationWithChanges(
  citation: {
    id: string;
    rawText: string;
    citationType: string;
    paragraphIndex: number | null;
    referenceListEntries?: Array<{ referenceListEntryId: string }>;
  },
  refIdToNumber: Map<string, number>,
  change?: {
    id?: string;
    changeType: string;
    beforeText: string | null;
    afterText: string | null;
  }
): FormattedCitation {
  const linkedRefIds = citation.referenceListEntries?.map(link => link.referenceListEntryId) || [];
  const linkedRefNumbers = linkedRefIds
    .map(refId => getRefNumber(refIdToNumber, refId))
    .filter((num): num is number => num !== null);

  // Determine change type
  let changeType = 'unchanged';
  if (change) {
    if (change.changeType === 'RENUMBER') changeType = 'renumber';
    else if (change.changeType === 'REFERENCE_STYLE_CONVERSION') changeType = 'style';
    else if (change.changeType === 'DELETE') changeType = 'deleted';
    else changeType = change.changeType.toLowerCase();

    // Override to unchanged if before and after text are identical (no actual change)
    // Use nullish checks so empty-string → empty-string is correctly handled
    if (change.beforeText != null && change.afterText != null && change.beforeText === change.afterText) {
      changeType = 'unchanged';
    }
  }

  // A citation is NOT orphaned if:
  // 1. It has valid reference links, OR
  // 2. It has a REFERENCE_EDIT change (the link may be temporarily broken but we have the change record)
  const hasValidChange = change && change.changeType === 'REFERENCE_EDIT';
  const orphaned = hasValidChange ? false : isCitationOrphaned(linkedRefNumbers, citation.citationType);

  return {
    id: citation.id,
    changeId: change?.id,
    rawText: citation.rawText,
    citationType: citation.citationType,
    paragraphIndex: citation.paragraphIndex,
    referenceNumber: linkedRefNumbers[0] ?? null,
    linkedReferenceIds: linkedRefIds,
    linkedReferenceNumbers: linkedRefNumbers,
    originalText: change?.beforeText || citation.rawText,
    newText: change?.afterText || citation.rawText,
    changeType,
    isOrphaned: orphaned
  };
}
