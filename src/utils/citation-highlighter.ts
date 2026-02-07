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

export function highlightCitationsInHtml(
  html: string,
  data: CitationHighlightData
): string {
  if (!html) return html;

  const { lookupMap, orphanedNumbers } = data;

  const citPattern = /\((\d+(?:\s*,\s*\d+)*)\)/g;

  const segments = html.split(/(<[^>]*>)/);
  const processed: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('<')) {
      processed.push(seg);
      continue;
    }

    const replaced = seg.replace(citPattern, (match, numsStr: string) => {
      const numbers = numsStr.split(/\s*,\s*/).map((n: string) => n.trim());
      const hasOrphan = numbers.some((n: string) => orphanedNumbers.has(parseInt(n, 10)));
      const allHaveRef = numbers.every((n: string) => lookupMap[n]);

      let status: string;
      if (hasOrphan) {
        status = 'issue';
      } else if (allHaveRef) {
        status = 'matched';
      } else {
        status = 'unmatched';
      }

      const refTexts = numbers.map((n: string) => {
        const ref = lookupMap[n];
        return ref ? `[${n}] ${ref}` : `[${n}] No matching reference`;
      }).join('\n');

      return `<span class="cit-hl cit-${status}" data-cit-nums="${numbers.join(',')}" data-ref-text="${escapeAttr(refTexts)}" title="${escapeAttr(refTexts)}">${match}</span>`;
    });

    processed.push(replaced);
  }

  let result = processed.join('');

  const bracketPattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  const bracketSegments = result.split(/(<[^>]*>)/);
  const bracketProcessed: string[] = [];

  for (let i = 0; i < bracketSegments.length; i++) {
    const seg = bracketSegments[i];
    if (seg.startsWith('<')) {
      bracketProcessed.push(seg);
      continue;
    }

    const replaced = seg.replace(bracketPattern, (match, numsStr: string) => {
      const numbers = numsStr.split(/\s*,\s*/).map((n: string) => n.trim());
      const hasOrphan = numbers.some((n: string) => orphanedNumbers.has(parseInt(n, 10)));
      const allHaveRef = numbers.every((n: string) => lookupMap[n]);

      let status: string;
      if (hasOrphan) {
        status = 'issue';
      } else if (allHaveRef) {
        status = 'matched';
      } else {
        status = 'unmatched';
      }

      const refTexts = numbers.map((n: string) => {
        const ref = lookupMap[n];
        return ref ? `[${n}] ${ref}` : `[${n}] No matching reference`;
      }).join('\n');

      return `<span class="cit-hl cit-${status}" data-cit-nums="${numbers.join(',')}" data-ref-text="${escapeAttr(refTexts)}" title="${escapeAttr(refTexts)}">${match}</span>`;
    });

    bracketProcessed.push(replaced);
  }

  result = bracketProcessed.join('');

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

  result = citationStyles + result;

  logger.info(`[Citation Highlighter] Highlighted citations in HTML`);
  return result;
}
