import { logger } from '../lib/logger';

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface CitationHighlightData {
  lookupMap: Record<string, string>;
  orphanedNumbers: Set<number>;
  /** Map of reference number to citationIds (for link status highlighting) */
  referenceLinkStatus?: Map<number, string[]>;
  /** Map of author last name to citationIds (for APA-style references) */
  referenceAuthorStatus?: Map<string, { citationIds: string[]; year?: string }>;
}

function isJournalVolumeIssue(textBefore: string, textAfter: string): boolean {
  if (/\d+\s*$/.test(textBefore) && /^\s*:\s*\d+/.test(textAfter)) return true;

  if (/;\s*\d+\s*$/.test(textBefore)) return true;

  if (/\d{4};\s*\d+\s*$/.test(textBefore)) return true;

  if (/Vol\.?\s*\d+\s*$/i.test(textBefore)) return true;
  if (/Volume\s+\d+\s*$/i.test(textBefore)) return true;

  if (/Suppl\s*$/i.test(textBefore)) return true;

  if (/^\s*:\s*\w?\d+/.test(textAfter)) return true;

  return false;
}

function wrapCitation(
  match: string,
  numbers: string[],
  lookupMap: Record<string, string>,
  orphanedNumbers: Set<number>
): string {
  const hasOrphan = numbers.some(n => orphanedNumbers.has(parseInt(n, 10)));
  const allHaveRef = numbers.every(n => lookupMap[n]);

  let status: string;
  if (hasOrphan) {
    status = 'issue';
  } else if (allHaveRef) {
    status = 'matched';
  } else {
    status = 'unmatched';
  }

  const refTexts = numbers.map(n => {
    const ref = lookupMap[n];
    return ref ? `[${n}] ${ref}` : `[${n}] No matching reference`;
  }).join('\n');

  return `<span class="cit-hl cit-${status}" data-cit-nums="${numbers.join(',')}" data-ref-text="${escapeAttr(refTexts)}" title="${escapeAttr(refTexts)}">${match}</span>`;
}

export function highlightCitationsInHtml(
  html: string,
  data: CitationHighlightData
): string {
  if (!html) return html;

  const { lookupMap, orphanedNumbers } = data;

  const refSplitIdx = findReferenceSectionStart(html);

  const bodyHtml = refSplitIdx >= 0 ? html.substring(0, refSplitIdx) : html;
  const refHtml = refSplitIdx >= 0 ? html.substring(refSplitIdx) : '';

  const highlightedBody = highlightSegment(bodyHtml, lookupMap, orphanedNumbers);

  // Process reference section if link status data is provided
  const processedRefHtml = (data.referenceLinkStatus || data.referenceAuthorStatus)
    ? highlightReferenceSection(refHtml, data.referenceLinkStatus, data.referenceAuthorStatus)
    : refHtml;

  const citationStyles = `
<style>
.cit-hl {
  padding: 1px 3px;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  font-weight: 600;
}
.cit-matched {
  background: rgba(61, 214, 140, 0.18);
  color: #3dd68c;
  border-bottom: 2px solid #3dd68c;
}
.cit-issue {
  background: rgba(255, 107, 107, 0.18);
  color: #ff6b6b;
  border-bottom: 2px solid #ff6b6b;
}
.cit-unmatched {
  background: rgba(255, 212, 59, 0.18);
  color: #ffd43b;
  border-bottom: 2px solid #ffd43b;
}
/* Reference link status colors */
.ref-linked {
  background: rgba(61, 214, 140, 0.12);
  border-left: 3px solid #3dd68c;
  padding-left: 8px;
}
.ref-orphaned {
  background: rgba(255, 107, 107, 0.12);
  border-left: 3px solid #ff6b6b;
  padding-left: 8px;
}
.ref-linked::before {
  content: "✓ ";
  color: #3dd68c;
  font-weight: bold;
}
.ref-orphaned::before {
  content: "⚠ ";
  color: #ff6b6b;
  font-weight: bold;
}
</style>`;

  const result = citationStyles + highlightedBody + processedRefHtml;

  const highlightCount = (result.match(/class="cit-hl/g) || []).length;
  logger.info(`[Citation Highlighter] Highlighted ${highlightCount} citations in body HTML${refSplitIdx >= 0 ? ' (references section excluded)' : ' (no references section found)'}`);
  return result;
}

function findReferenceSectionStart(html: string): number {
  const candidates: Array<{ idx: number; matchEnd: number }> = [];

  const patterns = [
    /<(h[1-6])[^>]*>\s*references?\s*<\/\1>/gi,
    /<(p|div)[^>]*>\s*<(strong|b)[^>]*>\s*references?\s*<\/\2>\s*<\/\1>/gi,
    /<(p|div)[^>]*>\s*references?\s*<\/\1>/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      candidates.push({ idx: m.index, matchEnd: m.index + m[0].length });
    }
  }

  if (candidates.length === 0) return -1;

  candidates.sort((a, b) => a.idx - b.idx);

  for (const candidate of candidates) {
    const after = html.substring(candidate.matchEnd, candidate.matchEnd + 200).trim();

    if (/^<\s*(ol|ul)\b/i.test(after)) {
      return candidate.idx;
    }

    if (/^<\s*p\b[^>]*>\s*\d+\.\s/i.test(after)) {
      return candidate.idx;
    }

    if (/^<\s*(p|div)\b[^>]*>.*?\d{4}[;,.]/.test(after)) {
      return candidate.idx;
    }
  }

  const lastCandidate = candidates[candidates.length - 1];
  const totalLength = html.length;
  if (lastCandidate.idx > totalLength * 0.6) {
    return lastCandidate.idx;
  }

  return -1;
}

function highlightSegment(
  html: string,
  lookupMap: Record<string, string>,
  orphanedNumbers: Set<number>
): string {
  const segments = html.split(/(<[^>]*>)/);
  const processed: string[] = [];

  const citPattern = /\((\d+(?:\s*,\s*\d+)*)\)/g;
  const bracketPattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  // Author-year pattern: (Author, Year), (Author et al., Year), (Author & Author, Year)
  // Also handles multiple: (Author, Year; Author, Year)
  const authorYearPattern = /\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|(?:&|and)\s+[A-Z][a-z]+))?,?\s*\d{4}(?:;\s*[A-Z][a-z]+(?:\s+(?:et\s+al\.?|(?:&|and)\s+[A-Z][a-z]+))?,?\s*\d{4})*)\)/g;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('<')) {
      processed.push(seg);
      continue;
    }

    let replaced = seg.replace(citPattern, (match, numsStr: string, offset: number) => {
      const textBefore = seg.substring(0, offset);
      const textAfter = seg.substring(offset + match.length);
      if (isJournalVolumeIssue(textBefore, textAfter)) {
        return match;
      }

      const numbers = numsStr.split(/\s*,\s*/).map((n: string) => n.trim());
      return wrapCitation(match, numbers, lookupMap, orphanedNumbers);
    });

    replaced = replaced.replace(bracketPattern, (match, numsStr: string) => {
      if (match.includes('cit-hl')) return match;
      const numbers = numsStr.split(/\s*,\s*/).map((n: string) => n.trim());
      return wrapCitation(match, numbers, lookupMap, orphanedNumbers);
    });

    // Highlight author-year citations (APA style)
    // Handle multiple citations separately: (Brown et al., 2020; Bommasani et al., 2021)
    replaced = replaced.replace(authorYearPattern, (match) => {
      if (match.includes('cit-hl')) return match;

      // Remove outer parentheses for processing
      const inner = match.slice(1, -1);

      // Check if it contains multiple citations (semicolon-separated)
      if (inner.includes(';')) {
        const parts = inner.split(/;\s*/);
        const highlightedParts = parts.map(part => {
          // Extract author name for data attribute
          const authorMatch = part.match(/^([A-Z][a-z]+)/);
          const author = authorMatch ? authorMatch[1] : 'unknown';
          return `<span class="cit-hl cit-matched" data-cit-type="author-year" data-author="${author}" title="${escapeAttr(part)}">${part}</span>`;
        });
        return '(' + highlightedParts.join('; ') + ')';
      }

      // Single citation
      const authorMatch = inner.match(/^([A-Z][a-z]+)/);
      const author = authorMatch ? authorMatch[1] : 'unknown';
      return `<span class="cit-hl cit-matched" data-cit-type="author-year" data-author="${author}" title="${escapeAttr(match)}">${match}</span>`;
    });

    processed.push(replaced);
  }

  return processed.join('');
}

/**
 * Highlight references in the reference section with link status
 * References with citationIds are marked as linked (green)
 * References without citationIds are marked as orphaned (red)
 * Supports both numbered references (Vancouver) and author-name references (APA)
 */
function highlightReferenceSection(
  refHtml: string,
  referenceLinkStatus?: Map<number, string[]>,
  referenceAuthorStatus?: Map<string, { citationIds: string[]; year?: string }>
): string {
  if (!refHtml) return refHtml;

  // Split into segments by HTML tags
  const segments = refHtml.split(/(<[^>]*>)/);
  const processed: string[] = [];

  // Pattern to match reference numbers at start of text (e.g., "1." or "[1]" or "1 " or "(1)")
  const refNumPattern = /^(\s*)[\[(]?(\d+)[\])]?(\.|\s)/;
  // Pattern to match author name at start of text for various formats:
  // - APA: "Bender, E. M.," or "Brown, T. B.,"
  // - Chicago: "Author, First." or "Author, First Name."
  // - General: "LastName," followed by anything
  const authorPattern = /^(\s*)([A-Z][a-z]+(?:-[A-Z][a-z]+)?),/i;

  let linkedCount = 0;
  let orphanedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Skip HTML tags
    if (seg.startsWith('<')) {
      // Check if it's a list item or paragraph that might contain a reference
      if (seg.match(/<(li|p|div)\b/i)) {
        // Look at next text segment for reference number or author name
        const nextTextIdx = segments.slice(i + 1).findIndex(s => !s.startsWith('<') && s.trim());
        if (nextTextIdx >= 0) {
          const nextText = segments[i + 1 + nextTextIdx];

          // Try numbered reference first (Vancouver style)
          const numMatch = nextText.match(refNumPattern);
          if (numMatch && referenceLinkStatus) {
            const refNum = parseInt(numMatch[2], 10);
            const citationIds = referenceLinkStatus.get(refNum);
            const linkClass = citationIds && citationIds.length > 0 ? 'ref-linked' : 'ref-orphaned';
            if (citationIds && citationIds.length > 0) linkedCount++; else orphanedCount++;

            const modifiedTag = seg.replace(/<(li|p|div)(\s|>)/i, (m, tag, rest) => {
              if (rest === '>') {
                return `<${tag} class="${linkClass}" data-ref-num="${refNum}" data-link-count="${citationIds?.length || 0}">`;
              } else {
                return `<${tag} class="${linkClass}" data-ref-num="${refNum}" data-link-count="${citationIds?.length || 0}"${rest}`;
              }
            });
            processed.push(modifiedTag);
            continue;
          }

          // Try author name (APA style)
          const authorMatch = nextText.match(authorPattern);
          if (authorMatch && referenceAuthorStatus) {
            const authorLastName = authorMatch[2];
            const authorData = referenceAuthorStatus.get(authorLastName.toLowerCase());
            const linkClass = authorData && authorData.citationIds.length > 0 ? 'ref-linked' : 'ref-orphaned';
            if (authorData && authorData.citationIds.length > 0) linkedCount++; else orphanedCount++;

            const modifiedTag = seg.replace(/<(li|p|div)(\s|>)/i, (m, tag, rest) => {
              if (rest === '>') {
                return `<${tag} class="${linkClass}" data-ref-author="${authorLastName}" data-link-count="${authorData?.citationIds.length || 0}">`;
              } else {
                return `<${tag} class="${linkClass}" data-ref-author="${authorLastName}" data-link-count="${authorData?.citationIds.length || 0}"${rest}`;
              }
            });
            processed.push(modifiedTag);
            continue;
          }
        }
      }
      processed.push(seg);
      continue;
    }

    processed.push(seg);
  }

  logger.info(`[Citation Highlighter] Reference section: ${linkedCount} linked, ${orphanedCount} orphaned references`);

  return processed.join('');
}
