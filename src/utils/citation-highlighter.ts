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
</style>`;

  const result = citationStyles + highlightedBody + refHtml;

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

    processed.push(replaced);
  }

  return processed.join('');
}
