/**
 * Footnote/Endnote Cross-Reference Check
 *
 * Validates that footnote markers in text match footnote entries:
 * - HTML path: <sup> markers matched to footnote sections (class/id with "footnote"/"endnote")
 * - Text fallback: [N] or ^N markers matched to Notes/Footnotes section entries
 * - Marker with no entry → ERROR
 * - Entry with no marker → WARNING
 * - Duplicate footnote numbers → ERROR
 * - Gap in footnote sequence → WARNING
 */

import { loadHtml } from '../rules/html-parser';
import type { AnyNode } from 'domhandler';
import { FOOTNOTE_MARKER_TEXT, FOOTNOTE_SECTION_HEADER } from '../rules/regex-patterns';
import type { CheckResult } from './figure-table-ref.check';

/** Extract surrounding text snippet for a marker element. */
function getMarkerContext($: NonNullable<ReturnType<typeof loadHtml>>, el: AnyNode): string {
  // Get the parent block's text and extract ~50 chars around the marker
  const parent = $(el).closest('p, li, div, td, blockquote');
  const parentText = (parent.length ? parent.text() : $(el).parent().text()).replace(/\s+/g, ' ').trim();
  const markerText = $(el).text().trim();
  const idx = parentText.indexOf(markerText);
  if (idx === -1) return parentText.substring(0, 100);
  const start = Math.max(0, idx - 30);
  const end = Math.min(parentText.length, idx + markerText.length + 50);
  return parentText.substring(start, end).trim();
}

/** Keywords indicating an affiliation context (author affiliations in journal articles). */
const AFFILIATION_KEYWORDS = /\b(university|institute|department|hospital|faculty|school|college|laboratory|correspondence|email|center|centre|division|medicine|sciences?|engineering|research)\b|@/i;

function extractHtmlFootnotes($: ReturnType<typeof loadHtml>, contentType?: string): {
  markers: Set<number>;
  markerContexts: Map<number, string>;
  entries: Set<number>;
} | null {
  if (!$) return null;

  const markers = new Set<number>();
  const markerContexts = new Map<number, string>();
  const entries = new Set<number>();

  const fullHtml = $.html() || '';
  const isJournal = contentType === 'JOURNAL_ARTICLE';

  // Find footnote markers: <sup> containing numbers, or <a> with href="#fn..."
  $('sup').each((_i, el) => {
    const text = $(el).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > 0) {
      // For journal articles, skip superscripts in the early part of the doc
      // that appear near affiliation-related text (university, department, etc.)
      if (isJournal) {
        const elHtml = $.html(el) || '';
        const pos = fullHtml.indexOf(elHtml);
        if (pos >= 0 && pos < 2000) {
          // Check surrounding text for affiliation keywords
          const surroundStart = Math.max(0, pos - 300);
          const surroundEnd = Math.min(fullHtml.length, pos + 300);
          const surroundingText = fullHtml.slice(surroundStart, surroundEnd).replace(/<[^>]*>/g, ' ');
          if (AFFILIATION_KEYWORDS.test(surroundingText)) {
            return; // Skip — this is an affiliation, not a footnote
          }
        }
      }

      markers.add(num);
      if (!markerContexts.has(num)) {
        markerContexts.set(num, getMarkerContext($, el));
      }
    }
  });

  // Also check <a> links pointing to footnotes
  $('a[href^="#fn"], a[href^="#footnote"], a[href^="#endnote"], a[href^="#note"]').each((_i, el) => {
    const text = $(el).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > 0) {
      markers.add(num);
      if (!markerContexts.has(num)) {
        markerContexts.set(num, getMarkerContext($, el));
      }
    }
  });

  // Find footnote entries: elements with class/id containing "footnote" or "endnote"
  const footnoteSelector = [
    '[class*="footnote"]', '[id*="footnote"]',
    '[class*="endnote"]', '[id*="endnote"]',
    '[role="doc-footnote"]', '[role="doc-endnote"]',
  ].join(', ');

  $(footnoteSelector).each((_i, el) => {
    const text = $(el).text().trim();
    // Try to extract leading number
    const match = text.match(/^(\d+)[.)\s]/);
    if (match) {
      entries.add(parseInt(match[1], 10));
    }
    // Also check for id like "fn1", "footnote-2"
    const id = $(el).attr('id') || '';
    const idMatch = id.match(/(\d+)$/);
    if (idMatch) {
      entries.add(parseInt(idMatch[1], 10));
    }
  });

  if (markers.size === 0 && entries.size === 0) return null;
  return { markers, markerContexts, entries };
}

function extractTextFootnotes(text: string): {
  markers: Set<number>;
  markerContexts: Map<number, string>;
  entries: Set<number>;
} {
  const markers = new Set<number>();
  const markerContexts = new Map<number, string>();
  const entries = new Set<number>();

  // Find markers: [N] or ^N in the body text
  const re = new RegExp(FOOTNOTE_MARKER_TEXT.source, FOOTNOTE_MARKER_TEXT.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1] || m[2], 10);
    if (!isNaN(num) && num > 0) {
      markers.add(num);
      if (!markerContexts.has(num)) {
        const start = Math.max(0, m.index - 30);
        const end = Math.min(text.length, m.index + m[0].length + 50);
        markerContexts.set(num, text.substring(start, end).replace(/[\r\n]+/g, ' ').trim());
      }
    }
  }

  // Find footnote section and extract entries
  const sectionMatch = FOOTNOTE_SECTION_HEADER.exec(text);
  if (sectionMatch) {
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const sectionText = text.slice(sectionStart);
    // Look for numbered entries: "1. ...", "2. ..." etc.
    const entryPattern = /(?:^|\n)\s*(\d+)[.)]\s+\S/gm;
    let em: RegExpExecArray | null;
    while ((em = entryPattern.exec(sectionText)) !== null) {
      entries.add(parseInt(em[1], 10));
    }
  }

  return { markers, markerContexts, entries };
}

export function checkFootnoteEndnoteRefs(text: string, html: string, contentType?: string): CheckResult {
  const issues: CheckResult['issues'] = [];

  // Try HTML first, fall back to text
  const $ = loadHtml(html);
  const htmlResult = extractHtmlFootnotes($, contentType);

  // For journal articles, [N] patterns in plain text are citation references,
  // not footnote markers. Only use the HTML path which checks <sup> elements.
  // Skip the text fallback entirely to avoid false positives.
  if (!htmlResult && contentType === 'JOURNAL_ARTICLE') {
    return {
      checkType: 'FOOTNOTE_REF',
      issues: [],
      metadata: { markersFound: 0, entriesFound: 0, matched: 0, skippedReason: 'journal-article-citations' },
    };
  }

  const data = htmlResult || extractTextFootnotes(text);

  const { markers, markerContexts, entries } = data;

  if (markers.size === 0 && entries.size === 0) {
    return {
      checkType: 'FOOTNOTE_REF',
      issues: [],
      metadata: { markersFound: 0, entriesFound: 0, matched: 0 },
    };
  }

  // Marker with no entry
  for (const num of markers) {
    if (!entries.has(num)) {
      issues.push({
        checkType: 'FOOTNOTE_REF',
        severity: 'ERROR',
        title: 'Footnote marker without entry',
        description: `Footnote marker ${num} appears in the text but has no corresponding footnote entry.`,
        originalText: `[${num}]`,
        context: markerContexts.get(num),
        actualValue: String(num),
        suggestedFix: `Add footnote entry ${num} in the footnotes/endnotes section.`,
      });
    }
  }

  // Entry with no marker
  for (const num of entries) {
    if (!markers.has(num)) {
      issues.push({
        checkType: 'FOOTNOTE_REF',
        severity: 'WARNING',
        title: 'Footnote entry without marker',
        description: `Footnote entry ${num} exists but is never referenced in the text.`,
        originalText: `${num}`,
        actualValue: String(num),
        suggestedFix: `Add a reference to footnote ${num} in the text, or remove the unused entry.`,
      });
    }
  }

  // Check for gaps in sequence
  const allNumbers = [...new Set([...markers, ...entries])].sort((a, b) => a - b);
  if (allNumbers.length > 1) {
    for (let i = 1; i < allNumbers.length; i++) {
      const expected = allNumbers[i - 1] + 1;
      if (allNumbers[i] !== expected && allNumbers[i] > expected) {
        issues.push({
          checkType: 'FOOTNOTE_REF',
          severity: 'WARNING',
          title: 'Gap in footnote numbering',
          description: `Footnote numbering jumps from ${allNumbers[i - 1]} to ${allNumbers[i]}.`,
          expectedValue: String(expected),
          actualValue: String(allNumbers[i]),
          suggestedFix: 'Renumber footnotes to maintain a continuous sequence.',
        });
      }
    }
  }

  // Check for duplicates (in markers specifically)
  // Reuse the same extraction logic to stay consistent with the affiliation filter
  const markerCounts = new Map<number, number>();
  if ($) {
    const fullHtml = $.html() || '';
    const isJournal = contentType === 'JOURNAL_ARTICLE';

    // Count <sup> markers (applying journal affiliation filter)
    $('sup').each((_i, el) => {
      const supText = $(el).text().trim();
      const num = parseInt(supText, 10);
      if (!isNaN(num) && num > 0) {
        if (isJournal) {
          const elHtml = $.html(el) || '';
          const pos = fullHtml.indexOf(elHtml);
          if (pos >= 0 && pos < 2000) {
            const surroundStart = Math.max(0, pos - 300);
            const surroundEnd = Math.min(fullHtml.length, pos + 300);
            const surroundingText = fullHtml.slice(surroundStart, surroundEnd).replace(/<[^>]*>/g, ' ');
            if (AFFILIATION_KEYWORDS.test(surroundingText)) {
              return; // Skip affiliation superscript
            }
          }
        }
        markerCounts.set(num, (markerCounts.get(num) || 0) + 1);
      }
    });

    // Also count <a> anchor-based markers
    $('a[href^="#fn"], a[href^="#footnote"], a[href^="#endnote"], a[href^="#note"]').each((_i, el) => {
      const anchorText = $(el).text().trim();
      const num = parseInt(anchorText, 10);
      if (!isNaN(num) && num > 0) {
        markerCounts.set(num, (markerCounts.get(num) || 0) + 1);
      }
    });
  } else {
    const re2 = new RegExp(FOOTNOTE_MARKER_TEXT.source, FOOTNOTE_MARKER_TEXT.flags);
    let m2: RegExpExecArray | null;
    while ((m2 = re2.exec(text)) !== null) {
      const num = parseInt(m2[1] || m2[2], 10);
      if (!isNaN(num) && num > 0) {
        markerCounts.set(num, (markerCounts.get(num) || 0) + 1);
      }
    }
  }

  for (const [num, count] of markerCounts) {
    if (count > 1) {
      issues.push({
        checkType: 'FOOTNOTE_REF',
        severity: 'ERROR',
        title: 'Duplicate footnote marker',
        description: `Footnote marker ${num} appears ${count} times in the text.`,
        originalText: `[${num}]`,
        context: markerContexts.get(num),
        actualValue: `${count} occurrences`,
        expectedValue: '1 occurrence',
        suggestedFix: `Ensure footnote ${num} is only referenced once, or use distinct numbers.`,
      });
    }
  }

  const matched = [...markers].filter((n) => entries.has(n)).length;

  return {
    checkType: 'FOOTNOTE_REF',
    issues,
    metadata: {
      markersFound: markers.size,
      entriesFound: entries.size,
      matched,
    },
  };
}
