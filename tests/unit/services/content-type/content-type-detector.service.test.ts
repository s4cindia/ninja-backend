import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { detectContentType } from '../../../../src/services/content-type/content-type-detector.service';

describe('contentTypeDetector.detectContentType', () => {
  // =========================================================================
  // Journal Article Detection
  // =========================================================================
  describe('JOURNAL_ARTICLE detection', () => {
    it('detects JOURNAL_ARTICLE from abstract and keywords', () => {
      const text = `
        Title of the Study
        Abstract
        This paper examines the effects of climate change.
        Keywords: climate, environment, sustainability
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'journal:abstract-heading',
          'journal:keywords-section',
        ])
      );
    });

    it('detects JOURNAL_ARTICLE from DOI identifier', () => {
      const text = `
        Abstract
        This paper explores novel approaches to machine learning.
        DOI: 10.1234/journal.2024.001
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'journal:abstract-heading',
          'journal:doi-identifier',
        ])
      );
    });

    it('detects JOURNAL_ARTICLE from corresponding author mention', () => {
      const text = `
        Abstract
        Study on renewable energy sources.
        Corresponding author: Dr. Smith, email@university.edu
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'journal:abstract-heading',
          'journal:corresponding-author',
        ])
      );
    });

    it('detects JOURNAL_ARTICLE from superscript affiliations in HTML', () => {
      const text = 'Abstract\nJohn Smith1, Jane Doe2\nSome university affiliations';
      const html = `
        <h1>Title</h1>
        <p>John Smith<sup>1</sup>, Jane Doe<sup>2</sup>, Bob<sup>3</sup></p>
        <p>Abstract</p>
        <p>This paper discusses important findings.</p>
      `;

      const result = detectContentType(text, html);

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.signals).toEqual(
        expect.arrayContaining(['journal:superscript-affiliations(3)'])
      );
    });

    it('detects JOURNAL_ARTICLE from received/accepted dates', () => {
      const text = `
        Abstract
        A comprehensive review of recent advances.
        Received: 15 January 2024
        Accepted: 20 March 2024
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'journal:abstract-heading',
          'journal:received-accepted-dates',
        ])
      );
    });

    it('detects ORCID as a journal signal', () => {
      const text = `
        Abstract
        Keywords: test, analysis
        ORCID: 0000-0002-1234-5678
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.signals).toEqual(
        expect.arrayContaining(['journal:orcid'])
      );
    });
  });

  // =========================================================================
  // Book Detection
  // =========================================================================
  describe('BOOK detection', () => {
    it('detects BOOK from table of contents', () => {
      const text = `
        Table of Contents
        Chapter 1: Introduction .......... 1
        Chapter 2: Background .......... 15
        Chapter 3: Methods ............. 30
        Chapter 4: Results ............. 45
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('BOOK');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'book:table-of-contents',
          expect.stringMatching(/^book:chapter-headings/),
        ])
      );
    });

    it('detects BOOK from chapter headings', () => {
      const text = `
        Preface
        This is a comprehensive guide to modern software engineering.

        Chapter 1: Getting Started
        Lorem ipsum dolor sit amet.

        Chapter 2: Core Concepts
        Consectetur adipiscing elit.

        Chapter 3: Advanced Topics
        Sed do eiusmod tempor incididunt.
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('BOOK');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^book:chapter-headings/),
          'book:preface',
        ])
      );
    });

    it('detects BOOK from ISBN', () => {
      const text = `
        Table of Contents
        Introduction .......... 1
        ISBN 978-3-16-148410-0
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('BOOK');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'book:table-of-contents',
          'book:isbn',
        ])
      );
    });

    it('detects BOOK from TOC HTML element', () => {
      const text = 'Table of Contents\nSome chapters listed here.';
      const html = `
        <div class="table-of-contents">
          <ul>
            <li>Chapter 1</li>
            <li>Chapter 2</li>
          </ul>
        </div>
      `;

      const result = detectContentType(text, html);

      expect(result.contentType).toBe('BOOK');
      expect(result.signals).toEqual(
        expect.arrayContaining(['book:toc-html-element'])
      );
    });

    it('detects BOOK from book-specific sections (preface, foreword, glossary)', () => {
      const text = `
        Table of Contents
        Foreword by Professor Brown
        Preface
        Glossary of Terms
        Appendix A: Supplementary Data
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('BOOK');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          'book:preface',
          'book:foreword',
          'book:glossary',
          'book:appendix',
        ])
      );
    });

    it('detects BOOK from Part I/II/III structure', () => {
      const text = `
        Table of Contents
        Part I: Foundations
        Part II: Applications
        Part III: Future Directions
      `;

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('BOOK');
      expect(result.signals).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^book:part-structure/),
        ])
      );
    });
  });

  // =========================================================================
  // UNKNOWN detection
  // =========================================================================
  describe('UNKNOWN detection', () => {
    it('returns UNKNOWN when signals are insufficient', () => {
      const text = 'This is a simple paragraph with no distinguishing features.';

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
    });

    it('returns UNKNOWN when scores are tied', () => {
      // Craft text that gives roughly equal scores to both
      // Journal: abstract (3) + keywords (2) = 5
      // Book: table of contents (4) + preface (1) = 5
      const text = `
        Abstract
        Keywords: test
        Table of Contents
        Preface
      `;

      const result = detectContentType(text, '');

      // When scores are tied, neither condition (journalScore > bookScore
      // or bookScore > journalScore) is satisfied, so UNKNOWN is returned
      expect(result.contentType).toBe('UNKNOWN');
    });

    it('returns UNKNOWN when a single weak signal is present', () => {
      // Only ORCID (+1 for journal) - below threshold of 4
      const text = 'Author ORCID: 0000-0001-2345-6789. Some general text here.';

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('UNKNOWN');
      expect(result.signals).toEqual(
        expect.arrayContaining(['journal:orcid'])
      );
    });
  });

  // =========================================================================
  // Empty / null inputs
  // =========================================================================
  describe('empty and null-like inputs', () => {
    it('handles empty text and empty HTML', () => {
      const result = detectContentType('', '');

      expect(result.contentType).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
      expect(result.signals).toEqual([]);
    });

    it('handles empty text with non-empty HTML', () => {
      const html = '<div class="toc"><p>Chapter 1</p></div>';

      const result = detectContentType('', html);

      // Score from toc-html-element is only 2, below BOOK_THRESHOLD of 4
      expect(result.contentType).toBe('UNKNOWN');
    });

    it('handles whitespace-only text', () => {
      const result = detectContentType('   \n\n\t  ', '');

      expect(result.contentType).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
    });

    it('handles very short text with no signals', () => {
      const result = detectContentType('Hello world.', '');

      expect(result.contentType).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
      expect(result.signals).toEqual([]);
    });
  });

  // =========================================================================
  // Confidence scoring
  // =========================================================================
  describe('confidence scoring', () => {
    it('caps confidence at 1.0 even with many signals', () => {
      // Load up with many journal signals to exceed score/10 > 1
      const text = `
        Abstract
        Keywords: many, signals, here
        DOI: 10.1234/example
        Corresponding author: Dr. X
        ORCID: 0000-0001-0000-0000
        Received: 1 Jan 2024
        Accepted: 1 Feb 2024
      `;
      const html = `
        <p>A<sup>1</sup>, B<sup>2</sup>, C<sup>3</sup></p>
      `;

      const result = detectContentType(text, html);

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    it('returns confidence proportional to signal strength', () => {
      // Abstract (3) + keywords (2) = score 5, confidence = 5/10 = 0.5
      const text = 'Abstract\nSome study text.\nKeywords: a, b, c';

      const result = detectContentType(text, '');

      expect(result.contentType).toBe('JOURNAL_ARTICLE');
      expect(result.confidence).toBe(0.5);
    });
  });
});
