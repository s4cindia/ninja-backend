/**
 * TOC Consistency Check
 *
 * Validates Table of Contents against actual document headings:
 * - TOC entry with no matching heading → ERROR
 * - Major heading (h1-h3) not in TOC → SUGGESTION
 * - Broken anchor links → ERROR
 * - Order mismatch → WARNING
 */

import { loadHtml, type CheerioRoot } from '../rules/html-parser';
import { TOC_SECTION_HEADER } from '../rules/regex-patterns';
import type { CheckResult } from './figure-table-ref.check';

interface TocEntry {
  text: string;
  href?: string;
  normalized: string;
}

interface Heading {
  level: number;
  text: string;
  id?: string;
  normalized: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim().toLowerCase();
}

function extractTocFromHtml($: CheerioRoot): TocEntry[] | null {
  const entries: TocEntry[] = [];

  // Look for <nav> with toc role/type, or elements with toc class/id
  const tocSelector = [
    'nav[role="doc-toc"]',
    'nav[epub\\:type="toc"]',
    '[id="toc"]', '[class*="toc"]',
    '[id="table-of-contents"]', '[class*="table-of-contents"]',
    '[id="contents"]',
  ].join(', ');

  const tocEl = $(tocSelector).first();
  if (tocEl.length === 0) return null;

  // Extract entries from links within the TOC
  tocEl.find('a').each((_i, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (text) {
      entries.push({ text, href, normalized: normalize(text) });
    }
  });

  // If no links found, try list items
  if (entries.length === 0) {
    tocEl.find('li').each((_i, el) => {
      const text = $(el).clone().children('ul, ol').remove().end().text().trim();
      if (text) {
        entries.push({ text, normalized: normalize(text) });
      }
    });
  }

  return entries.length > 0 ? entries : null;
}

function extractTocFromText(text: string): TocEntry[] | null {
  const match = TOC_SECTION_HEADER.exec(text);
  if (!match) return null;

  const sectionStart = match.index + match[0].length;
  // Take lines until we hit a blank line followed by content that doesn't look like TOC
  const lines = text.slice(sectionStart).split('\n');
  const entries: TocEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Stop on second blank line
      if (entries.length > 0) break;
      continue;
    }
    // TOC entries typically are chapter/section titles, possibly with page numbers
    // Strip trailing page numbers: "Chapter 1 Introduction ..... 5"
    const cleaned = trimmed.replace(/[\s.·]+\d+\s*$/, '').trim();
    if (cleaned) {
      entries.push({ text: cleaned, normalized: normalize(cleaned) });
    }
  }

  return entries.length > 0 ? entries : null;
}

function extractHeadings($: CheerioRoot): Heading[] {
  const headings: Heading[] = [];

  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    const tagName = $(el).prop('tagName')?.toLowerCase() || '';
    const level = parseInt(tagName.replace('h', ''), 10);
    const text = $(el).text().trim();
    const id = $(el).attr('id') || '';

    if (text) {
      headings.push({ level, text, id: id || undefined, normalized: normalize(text) });
    }
  });

  return headings;
}

export function checkTocConsistency(_text: string, html: string): CheckResult {
  const issues: CheckResult['issues'] = [];
  const $ = loadHtml(html);

  if (!$) {
    // Try text-only fallback — limited usefulness without headings
    return {
      checkType: 'TOC_CONSISTENCY',
      issues: [],
      metadata: { tocEntriesFound: 0, headingsFound: 0, skipped: true, reason: 'No HTML content' },
    };
  }

  // Extract TOC entries (HTML first, then text fallback)
  const tocEntries = extractTocFromHtml($) || extractTocFromText(_text);

  if (!tocEntries || tocEntries.length === 0) {
    return {
      checkType: 'TOC_CONSISTENCY',
      issues: [],
      metadata: { tocEntriesFound: 0, headingsFound: 0, noTocDetected: true },
    };
  }

  const headings = extractHeadings($);
  const headingNorms = new Set(headings.map((h) => h.normalized));
  const headingIds = new Set(headings.filter((h) => h.id).map((h) => h.id));

  // TOC entry with no matching heading
  for (const entry of tocEntries) {
    if (!headingNorms.has(entry.normalized)) {
      // Fuzzy: check if any heading starts with or contains the TOC entry
      const fuzzyMatch = headings.some(
        (h) => h.normalized.includes(entry.normalized) || entry.normalized.includes(h.normalized)
      );

      if (!fuzzyMatch) {
        issues.push({
          checkType: 'TOC_CONSISTENCY',
          severity: 'ERROR',
          title: 'TOC entry has no matching heading',
          description: `TOC entry "${entry.text}" does not match any heading in the document.`,
          originalText: entry.text,
          suggestedFix: 'Update the TOC to match actual headings, or add the missing heading.',
        });
      }
    }

    // Broken anchor links
    if (entry.href && entry.href.startsWith('#')) {
      const targetId = entry.href.slice(1);
      if (targetId && !headingIds.has(targetId)) {
        // Check if the id exists anywhere in the document
        const exists = $(`[id="${targetId}"]`).length > 0;
        if (!exists) {
          issues.push({
            checkType: 'TOC_CONSISTENCY',
            severity: 'ERROR',
            title: 'Broken TOC anchor link',
            description: `TOC link "${entry.text}" points to #${targetId} which does not exist in the document.`,
            originalText: entry.href,
            suggestedFix: `Add id="${targetId}" to the corresponding heading, or fix the TOC link.`,
          });
        }
      }
    }
  }

  // Major headings (h1-h3) not in TOC
  const tocNorms = new Set(tocEntries.map((e) => e.normalized));
  for (const heading of headings) {
    if (heading.level <= 3 && !tocNorms.has(heading.normalized)) {
      // Fuzzy match
      const fuzzyMatch = tocEntries.some(
        (e) => e.normalized.includes(heading.normalized) || heading.normalized.includes(e.normalized)
      );

      if (!fuzzyMatch) {
        issues.push({
          checkType: 'TOC_CONSISTENCY',
          severity: 'SUGGESTION',
          title: 'Heading not listed in TOC',
          description: `H${heading.level} heading "${heading.text}" is not listed in the Table of Contents.`,
          originalText: heading.text,
          suggestedFix: 'Add this heading to the Table of Contents.',
        });
      }
    }
  }

  // Order mismatch: check if TOC order matches heading order
  const matchedTocOrder: number[] = [];
  for (const entry of tocEntries) {
    const idx = headings.findIndex((h) => h.normalized === entry.normalized);
    if (idx >= 0) {
      matchedTocOrder.push(idx);
    }
  }

  for (let i = 1; i < matchedTocOrder.length; i++) {
    if (matchedTocOrder[i] < matchedTocOrder[i - 1]) {
      issues.push({
        checkType: 'TOC_CONSISTENCY',
        severity: 'WARNING',
        title: 'TOC order does not match document order',
        description: 'The order of entries in the Table of Contents does not match the order of headings in the document.',
        suggestedFix: 'Reorder the TOC entries to match the document heading order.',
      });
      break; // One warning is enough
    }
  }

  return {
    checkType: 'TOC_CONSISTENCY',
    issues,
    metadata: {
      tocEntriesFound: tocEntries.length,
      headingsFound: headings.length,
      matchedEntries: matchedTocOrder.length,
    },
  };
}
