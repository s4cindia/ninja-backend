/**
 * Content Type Detector Service
 *
 * Auto-detects whether a document is a JOURNAL_ARTICLE or BOOK
 * using scoring-based heuristics on HTML and plain text content.
 * No AI calls — pure regex + cheerio analysis.
 */

import * as cheerio from 'cheerio';
import { logger } from '../../lib/logger';

export interface DetectionResult {
  contentType: 'JOURNAL_ARTICLE' | 'BOOK' | 'UNKNOWN';
  confidence: number;
  signals: string[];
}

const JOURNAL_THRESHOLD = 4;
const BOOK_THRESHOLD = 4;

/**
 * Detect whether the document is a journal article or a book.
 */
export function detectContentType(text: string, html: string): DetectionResult {
  const journalScore = { total: 0, signals: [] as string[] };
  const bookScore = { total: 0, signals: [] as string[] };

  const earlyText = text.slice(0, 3000);
  const earlyHtml = html.slice(0, 4000);

  // === Journal Article Signals ===

  // 1. Superscript numbers in early HTML (author affiliations)
  if (html) {
    const earlyHtmlFragment = cheerio.load(earlyHtml);
    let supCount = 0;
    earlyHtmlFragment('sup').each((_i, el) => {
      const t = earlyHtmlFragment(el).text().trim();
      if (/^\d{1,2}$/.test(t)) supCount++;
    });
    if (supCount >= 2) {
      journalScore.total += 2;
      journalScore.signals.push(`superscript-affiliations(${supCount})`);
    }
  }

  // 2. "Abstract" heading
  if (/\b(abstract)\b/i.test(earlyText)) {
    journalScore.total += 3;
    journalScore.signals.push('abstract-heading');
  }

  // 3. "Keywords:" section
  if (/\bkeywords?\s*:/i.test(earlyText)) {
    journalScore.total += 2;
    journalScore.signals.push('keywords-section');
  }

  // 4. DOI identifier
  if (/10\.\d{4,}\//.test(text)) {
    journalScore.total += 2;
    journalScore.signals.push('doi-identifier');
  }

  // 5. "Corresponding author" / "Correspondence"
  if (/\b(corresponding\s+author|correspondence)\b/i.test(earlyText)) {
    journalScore.total += 2;
    journalScore.signals.push('corresponding-author');
  }

  // 6. ORCID identifiers
  if (/orcid/i.test(earlyText)) {
    journalScore.total += 1;
    journalScore.signals.push('orcid');
  }

  // 7. "Received/Accepted/Published" dates typical of journal articles
  if (/\b(received|accepted|published)\s*:?\s*\d/i.test(earlyText)) {
    journalScore.total += 2;
    journalScore.signals.push('received-accepted-dates');
  }

  // === Book Signals ===

  // 1. Table of Contents
  const tocPatterns = /\b(table\s+of\s+contents|contents)\b/i;
  if (tocPatterns.test(text)) {
    bookScore.total += 4;
    bookScore.signals.push('table-of-contents');
  }
  if (html) {
    const $doc = cheerio.load(html);
    const tocEl = $doc('[class*="toc"], [id*="toc"], [class*="table-of-contents"], [id*="table-of-contents"]');
    if (tocEl.length > 0) {
      bookScore.total += 2;
      bookScore.signals.push('toc-html-element');
    }
  }

  // 2. Chapter headings (2+)
  const chapterMatches = text.match(/\bchapter\s+\d+/gi);
  if (chapterMatches && chapterMatches.length >= 2) {
    bookScore.total += 4;
    bookScore.signals.push(`chapter-headings(${chapterMatches.length})`);
  }

  // 3. ISBN
  if (/\bISBN\b/i.test(text)) {
    bookScore.total += 3;
    bookScore.signals.push('isbn');
  }

  // 4. Preface/Foreword/Index/Glossary/Appendix
  const bookSections = ['preface', 'foreword', 'index', 'glossary', 'appendix'];
  for (const section of bookSections) {
    const pattern = new RegExp(`\\b${section}\\b`, 'i');
    if (pattern.test(text)) {
      bookScore.total += 1;
      bookScore.signals.push(section);
    }
  }

  // 5. "Part I/II/III" structure
  const partMatches = text.match(/\bpart\s+(I{1,3}|IV|V|[1-5])\b/gi);
  if (partMatches && partMatches.length >= 2) {
    bookScore.total += 2;
    bookScore.signals.push(`part-structure(${partMatches.length})`);
  }

  // === Determine Result ===
  const allSignals = [
    ...journalScore.signals.map(s => `journal:${s}`),
    ...bookScore.signals.map(s => `book:${s}`),
  ];

  logger.debug(
    `[ContentType] Scores — journal=${journalScore.total}, book=${bookScore.total}, signals=[${allSignals.join(', ')}]`
  );

  if (journalScore.total >= JOURNAL_THRESHOLD && journalScore.total > bookScore.total) {
    return {
      contentType: 'JOURNAL_ARTICLE',
      confidence: Math.min(journalScore.total / 10, 1),
      signals: allSignals,
    };
  }

  if (bookScore.total >= BOOK_THRESHOLD && bookScore.total > journalScore.total) {
    return {
      contentType: 'BOOK',
      confidence: Math.min(bookScore.total / 10, 1),
      signals: allSignals,
    };
  }

  return {
    contentType: 'UNKNOWN',
    confidence: 0,
    signals: allSignals,
  };
}

export const contentTypeDetector = { detectContentType };
