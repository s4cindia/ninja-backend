/**
 * Citation reference checker.
 * Detects: cited in text but missing from reference list,
 * present in reference list but never cited, and duplicate references.
 */
import { CITATION_BRACKET, CITATION_AUTHOR_YEAR } from '../rules/regex-patterns';

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

/** Tokenize a string into lowercase word tokens for Jaccard comparison. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/** Jaccard similarity between two sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract reference list entries. Looks for a "References" or "Bibliography"
 * section and parses numbered entries like "[1] Author..." or "1. Author..."
 */
function extractReferenceList(text: string): { id: string; text: string; offset: number }[] {
  const entries: { id: string; text: string; offset: number }[] = [];
  const refSectionMatch = /(?:^|\n)\s*(?:References|Bibliography|Works Cited)\s*\n/i.exec(text);
  if (!refSectionMatch) return entries;

  const refSection = text.slice(refSectionMatch.index + refSectionMatch[0].length);
  const entryPattern = /(?:^|\n)\s*\[?(\d+)\]?[.)\s]+(.+?)(?=\n\s*\[?\d+\]?[.)\s]|\n\s*$|$)/gs;
  let m: RegExpExecArray | null;
  while ((m = entryPattern.exec(refSection)) !== null) {
    entries.push({
      id: m[1],
      text: m[2].trim(),
      offset: refSectionMatch.index + refSectionMatch[0].length + m.index,
    });
  }
  return entries;
}

/** Extract in-text bracket citation numbers (e.g. [1], [2-4], [1,3,5]). */
function extractCitedNumbers(text: string): { id: string; offset: number; match: string }[] {
  const results: { id: string; offset: number; match: string }[] = [];
  const re = new RegExp(CITATION_BRACKET.source, CITATION_BRACKET.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    // Parse ranges like "2-4" and lists like "1,3"
    const parts = inner.split(/\s*,\s*/);
    for (const part of parts) {
      const rangeMatch = part.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end; i++) {
          results.push({ id: String(i), offset: m.index, match: m[0] });
        }
      } else {
        const num = part.trim();
        if (/^\d+$/.test(num)) {
          results.push({ id: num, offset: m.index, match: m[0] });
        }
      }
    }
  }
  return results;
}

/** Detect whether the document uses numeric bracket or APA author-date citations. */
function detectCitationStyle(text: string): 'numeric' | 'author-date' {
  const bracketCount = (text.match(CITATION_BRACKET) || []).length;
  const authorYearRe = new RegExp(CITATION_AUTHOR_YEAR.source, CITATION_AUTHOR_YEAR.flags);
  const authorYearCount = (text.match(authorYearRe) || []).length;
  return authorYearCount > bracketCount ? 'author-date' : 'numeric';
}

/**
 * Extract APA-formatted reference list entries.
 * Entries start with "Surname, I." followed by "(Year)".
 */
function extractAPAReferenceList(text: string): { id: string; text: string; offset: number }[] {
  const refSectionMatch = /(?:^|\n)\s*(?:References|Bibliography|Works Cited)\s*\n/i.exec(text);
  if (!refSectionMatch) return [];

  const sectionStart = refSectionMatch.index + refSectionMatch[0].length;
  const refSection = text.slice(sectionStart);
  const entries: { id: string; text: string; offset: number }[] = [];

  // Split on newlines that start with an author surname pattern
  const lines = refSection.split('\n');
  let currentEntry = '';
  let currentEntryStart = 0;
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isNewEntry = /^[A-Z][a-zà-öø-ÿ]+(?:[-'][A-Z][a-zà-öø-ÿ]+)?,\s*[A-Z]\./.test(line.trim());

    if (isNewEntry && currentEntry) {
      // Flush the previous entry
      const entryText = currentEntry.trim();
      const authorMatch = entryText.match(/^([A-Z][a-zà-öø-ÿ]+(?:[-'][A-Z][a-zà-öø-ÿ]+)?)/);
      const yearMatch = entryText.match(/\((\d{4}[a-z]?)\)/);
      if (authorMatch && yearMatch) {
        const id = `${authorMatch[1].toLowerCase()}_${yearMatch[1]}`;
        entries.push({ id, text: entryText, offset: sectionStart + currentEntryStart });
      }
      currentEntry = line;
      currentEntryStart = charOffset;
    } else if (isNewEntry) {
      currentEntry = line;
      currentEntryStart = charOffset;
    } else if (currentEntry) {
      currentEntry += ' ' + line;
    }

    charOffset += line.length + 1; // +1 for newline
  }

  // Flush last entry
  if (currentEntry) {
    const entryText = currentEntry.trim();
    const authorMatch = entryText.match(/^([A-Z][a-zà-öø-ÿ]+(?:[-'][A-Z][a-zà-öø-ÿ]+)?)/);
    const yearMatch = entryText.match(/\((\d{4}[a-z]?)\)/);
    if (authorMatch && yearMatch) {
      const id = `${authorMatch[1].toLowerCase()}_${yearMatch[1]}`;
      entries.push({ id, text: entryText, offset: sectionStart + currentEntryStart });
    }
  }

  return entries;
}

/** Extract in-text APA author-date citations, normalized to "surname_year" keys. */
function extractAuthorYearCitations(text: string): { id: string; offset: number; match: string }[] {
  const results: { id: string; offset: number; match: string }[] = [];
  const re = new RegExp(CITATION_AUTHOR_YEAR.source, CITATION_AUTHOR_YEAR.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1]; // e.g. "Floridi, 2014" or "Russell & Norvig, 2021"
    const authorMatch = inner.match(/^([A-Z][a-zà-öø-ÿ]+(?:[-'][A-Z][a-zà-öø-ÿ]+)?)/);
    const yearMatch = inner.match(/(\d{4}[a-z]?)$/);
    if (authorMatch && yearMatch) {
      const id = `${authorMatch[1].toLowerCase()}_${yearMatch[1]}`;
      results.push({ id, offset: m.index, match: m[0] });
    }
  }
  return results;
}

/** Format a reference ID for display based on citation style. */
function formatRefLabel(id: string, style: 'numeric' | 'author-date', refText?: string): string {
  if (style === 'numeric') return `[${id}]`;
  // Convert "floridi_2014" to "Floridi (2014)"
  const parts = id.split('_');
  const surname = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const year = parts[1] || '';
  if (refText) {
    // Use the actual text snippet for better display
    const authorMatch = refText.match(/^([^(]+?)\s*\(/);
    if (authorMatch) return `${authorMatch[1].trim()} (${year})`;
  }
  return `${surname} (${year})`;
}

export function checkCitationRefs(text: string, _html: string): CheckResult {
  const issues: CheckIssue[] = [];
  const style = detectCitationStyle(text);

  let refEntries: { id: string; text: string; offset: number }[];
  let cited: { id: string; offset: number; match: string }[];

  if (style === 'author-date') {
    refEntries = extractAPAReferenceList(text);
    cited = extractAuthorYearCitations(text);
  } else {
    refEntries = extractReferenceList(text);
    cited = extractCitedNumbers(text);
  }

  const refIds = new Set(refEntries.map((r) => r.id));
  const citedIds = new Set(cited.map((c) => c.id));

  // Cited in text but not in reference list
  for (const cite of cited) {
    if (!refIds.has(cite.id) && refEntries.length > 0) {
      const label = formatRefLabel(cite.id, style);
      issues.push({
        checkType: 'CITATION_REF',
        severity: 'ERROR',
        title: 'Citation not found in reference list',
        description: `Reference ${label} is cited in text but does not appear in the reference list.`,
        startOffset: cite.offset,
        endOffset: cite.offset + cite.match.length,
        originalText: cite.match,
        actualValue: cite.id,
        suggestedFix: `Add reference ${label} to the reference list, or correct the citation.`,
      });
    }
  }

  // In reference list but never cited
  for (const ref of refEntries) {
    if (!citedIds.has(ref.id)) {
      const label = formatRefLabel(ref.id, style, ref.text);
      issues.push({
        checkType: 'CITATION_REF',
        severity: 'WARNING',
        title: 'Reference never cited in text',
        description: `Reference ${label} appears in the reference list but is never cited in the body text.`,
        startOffset: ref.offset,
        originalText: style === 'numeric' ? `[${ref.id}] ${ref.text.slice(0, 60)}` : ref.text.slice(0, 80),
        actualValue: ref.id,
        suggestedFix: `Add a citation for ${label} in the text, or remove the unused reference.`,
      });
    }
  }

  // Duplicate references (Jaccard similarity > 0.7)
  for (let i = 0; i < refEntries.length; i++) {
    const tokensA = tokenize(refEntries[i].text);
    for (let j = i + 1; j < refEntries.length; j++) {
      const tokensB = tokenize(refEntries[j].text);
      const sim = jaccardSimilarity(tokensA, tokensB);
      if (sim > 0.7) {
        const labelI = formatRefLabel(refEntries[i].id, style, refEntries[i].text);
        const labelJ = formatRefLabel(refEntries[j].id, style, refEntries[j].text);
        issues.push({
          checkType: 'CITATION_REF',
          severity: 'WARNING',
          title: 'Possible duplicate references',
          description: `References ${labelI} and ${labelJ} appear to be duplicates (${(sim * 100).toFixed(0)}% similarity).`,
          startOffset: refEntries[j].offset,
          originalText: refEntries[j].text.slice(0, 80),
          expectedValue: refEntries[i].id,
          actualValue: refEntries[j].id,
          suggestedFix: `Merge references ${labelI} and ${labelJ} if they refer to the same source.`,
        });
      }
    }
  }

  return {
    checkType: 'CITATION_REF',
    issues,
    metadata: {
      citationStyle: style,
      totalCitations: cited.length,
      uniqueCitedIds: citedIds.size,
      totalReferences: refEntries.length,
      uncitedReferences: refEntries.filter((r) => !citedIds.has(r.id)).length,
      missingReferences: [...citedIds].filter((id) => !refIds.has(id)).length,
    },
  };
}
