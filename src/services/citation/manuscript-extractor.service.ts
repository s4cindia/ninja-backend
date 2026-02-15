/**
 * Manuscript Extractor Service
 * Extracts manuscript content with citation positions for editor
 */

import mammoth from 'mammoth';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';

interface CitationMarker {
  id: string;
  number: number;
  marker: string;
  position: number;
  paragraph: number;
  hasReference: boolean;
  context: string;
}

interface ManuscriptContent {
  html: string;
  plainText: string;
  citations: CitationMarker[];
  wordCount: number;
  paragraphCount: number;
}

export class ManuscriptExtractorService {
  /**
   * Extract manuscript content with citation positions
   */
  async extractContent(buffer: Buffer, citationNumbers: number[]): Promise<ManuscriptContent> {
    logger.info('[ManuscriptExtractor] Extracting content from DOCX');

    try {
      // Convert DOCX to HTML with styling preserved
      const result = await mammoth.convertToHtml({ buffer }, {
        includeDefaultStyleMap: true,
        styleMap: [
          // Preserve common styles
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Title'] => h1.title:fresh",
          "p[style-name='Abstract'] => p.abstract:fresh",
          "b => strong",
          "i => em",
        ],
      });

      let html = result.value;

      // Remove references section before processing
      // Pattern matches when References/Bibliography is the main heading (possibly with prefix like <REFH>)
      // Uses negative lookbehind to avoid matching "references" mentioned in regular text
      const refSectionMatch = html.match(/<p[^>]*>(?:&lt;[A-Z]+&gt;)?\s*(References|Bibliography|Works Cited|Literature Cited)\s*<\/p>/i);
      if (refSectionMatch) {
        const refStartIndex = refSectionMatch.index || 0;
        html = html.substring(0, refStartIndex);
        logger.info(`[ManuscriptExtractor] Excluded references section starting at position ${refStartIndex}`);
      } else {
        logger.warn('[ManuscriptExtractor] References section not found - processing entire document');
      }

      // Remove superscript tags (author affiliations)
      html = html.replace(/<sup>.*?<\/sup>/gi, '');

      const plainText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

      // Extract citations from HTML (already cleaned above)
      const citations = this.extractCitations(html, citationNumbers);

      // Count paragraphs
      const paragraphCount = html.split('</p>').length - 1;

      // Word count
      const wordCount = plainText.split(/\s+/).length;

      logger.info(`[ManuscriptExtractor] Extracted ${citations.length} citations, ${wordCount} words, ${paragraphCount} paragraphs`);

      return {
        html,
        plainText,
        citations,
        wordCount,
        paragraphCount,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[ManuscriptExtractor] Extraction failed: ${errorMessage}`);
      throw AppError.internal(`Failed to extract manuscript content: ${errorMessage}`, 'EXTRACTION_FAILED');
    }
  }

  /**
   * Extract citation markers from HTML content
   * Supports: [1], (1), [8-10], (8-10), [1,2,3], (1,2,3)
   * IMPORTANT: Skips <sup> tags (author affiliations, not citations)
   * IMPORTANT: Excludes references section to avoid counting reference list numbers
   */
  private extractCitations(html: string, referenceNumbers: number[]): CitationMarker[] {
    const citations: CitationMarker[] = [];

    // HTML is already cleaned (references section and sup tags removed in extractContent)
    // Split into paragraphs
    const paragraphs = html.split(/<\/?p[^>]*>/);

    // Pattern 1: Range citations [8-10] or (8-10)
    // Negative lookbehind (?<!\d\s) prevents matching statistical values like "18.9 (66)"
    const rangePattern = /(?<!\d\s)[\[\(](\d+)-(\d+)[\]\)]/g;

    // Pattern 2: List citations [1,2,3] or (1,2,3)
    // Negative lookbehind prevents matching after numbers
    const listPattern = /(?<!\d\s)[\[\(](\d+(?:,\s*\d+)+)[\]\)]/g;

    // Pattern 3: Single numbered citations [1] or (1)
    // Negative lookbehind prevents matching statistical values
    const numberedPattern = /(?<!\d\s)[\[\(](\d+)[\]\)]/g;

    paragraphs.forEach((para, paraIndex) => {
      // Extract range citations first (e.g., [8-10])
      let rangeMatch: RegExpExecArray | null;
      rangePattern.lastIndex = 0;
      while ((rangeMatch = rangePattern.exec(para)) !== null) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        const marker = rangeMatch[0];
        const position = rangeMatch.index;

        // Get context
        const contextStart = Math.max(0, position - 50);
        const contextEnd = Math.min(para.length, position + 50);
        const context = para
          .substring(contextStart, contextEnd)
          .replace(/<[^>]*>/g, '')
          .trim();

        // Expand range to individual citations
        for (let num = start; num <= end; num++) {
          citations.push({
            id: `citation-${paraIndex}-${num}-${position}`,
            number: num,
            marker, // Keep original marker like (8-10)
            position,
            paragraph: paraIndex,
            hasReference: referenceNumbers.includes(num),
            context,
          });
        }
      }

      // Extract list citations (e.g., [1,2,3])
      let listMatch: RegExpExecArray | null;
      listPattern.lastIndex = 0;
      while ((listMatch = listPattern.exec(para)) !== null) {
        const marker = listMatch[0];
        const position = listMatch.index;
        const numbers = listMatch[1].split(',').map(n => parseInt(n.trim()));

        // Get context
        const contextStart = Math.max(0, position - 50);
        const contextEnd = Math.min(para.length, position + 50);
        const context = para
          .substring(contextStart, contextEnd)
          .replace(/<[^>]*>/g, '')
          .trim();

        // Add each number as separate citation
        numbers.forEach((num) => {
          citations.push({
            id: `citation-${paraIndex}-${num}-${position}`,
            number: num,
            marker, // Keep original marker like (1,2,3)
            position,
            paragraph: paraIndex,
            hasReference: referenceNumbers.includes(num),
            context,
          });
        });
      }

      // Extract single numbered citations (but skip if already part of range/list)
      const existingPositions = new Set(citations.map(c => `${c.paragraph}-${c.position}`));

      let numberedMatch: RegExpExecArray | null;
      numberedPattern.lastIndex = 0;
      while ((numberedMatch = numberedPattern.exec(para)) !== null) {
        const position = numberedMatch.index;
        const posKey = `${paraIndex}-${position}`;

        // Skip if this position was already processed as part of range/list
        if (existingPositions.has(posKey)) {
          continue;
        }

        const number = parseInt(numberedMatch[1]);
        const marker = numberedMatch[0];

        // Get context (50 chars before and after)
        const start = Math.max(0, position - 50);
        const end = Math.min(para.length, position + 50);
        const context = para
          .substring(start, end)
          .replace(/<[^>]*>/g, '')
          .trim();

        citations.push({
          id: `citation-${paraIndex}-${number}-${position}`,
          number,
          marker,
          position,
          paragraph: paraIndex,
          hasReference: referenceNumbers.includes(number),
          context,
        });
      }
    });

    // Sort by paragraph and position
    return citations.sort((a, b) => a.paragraph - b.paragraph || a.position - b.position);
  }

  /**
   * Highlight citations in HTML for editor display
   */
  highlightCitations(html: string, citations: CitationMarker[]): string {
    // Find all citation patterns in HTML and replace with spans
    const usedCitations = new Set<string>();
    let result = html;

    // Create a map of positions to track what we've already replaced
    const processedPositions = new Set<number>();

    // Pattern to match all citation styles: [N], (N), [N-M], (N-M), [N,M,...], (N,M,...)
    const allCitationsPattern = /(?<!\d\s)[\[\(](\d+(?:-\d+|(?:,\s*\d+)+)?)[\]\)]/g;

    // Process all citations in order
    const matches: Array<{ match: string; index: number; replacement: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = allCitationsPattern.exec(result)) !== null) {
      const fullMatch = match[0];
      const inner = match[1];
      const position = match.index;

      // Skip if already processed
      if (processedPositions.has(position)) {
        continue;
      }

      let numbers: number[] = [];

      // Parse the citation to get all numbers
      if (inner.includes('-')) {
        // Range: [1-3]
        const [start, end] = inner.split('-').map(n => parseInt(n));
        for (let i = start; i <= end; i++) {
          numbers.push(i);
        }
      } else if (inner.includes(',')) {
        // List: [1,2,3]
        numbers = inner.split(',').map(n => parseInt(n.trim()));
      } else {
        // Single: [1]
        numbers = [parseInt(inner)];
      }

      // Find any unused citation that matches any of these numbers
      const citation = citations.find(
        c => numbers.includes(c.number) && !usedCitations.has(c.id)
      );

      if (citation) {
        // Mark this citation as used
        usedCitations.add(citation.id);
        processedPositions.add(position);

        const cssClass = citation.hasReference ? 'citation-valid' : 'citation-ghost';
        const dataAttrs = `data-citation-id="${citation.id}" data-citation-number="${citation.number}"`;
        const replacement = `<span class="${cssClass}" ${dataAttrs}>${fullMatch}</span>`;

        matches.push({ match: fullMatch, index: position, replacement });
      }
    }

    // Apply replacements from end to start to preserve positions
    for (let i = matches.length - 1; i >= 0; i--) {
      const { match: matchStr, index, replacement } = matches[i];
      result = result.substring(0, index) + replacement + result.substring(index + matchStr.length);
    }

    return result;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Add CSS styles for citation highlighting
   */
  getCitationStyles(): string {
    return `
      <style>
        .citation-valid {
          background-color: #d4edda;
          border: 1px solid #28a745;
          border-radius: 3px;
          padding: 2px 4px;
          cursor: pointer;
          font-weight: 600;
          transition: background-color 0.2s;
        }

        .citation-valid:hover {
          background-color: #b8e2c1;
        }

        .citation-ghost {
          background-color: #f8d7da;
          border: 1px solid #dc3545;
          border-radius: 3px;
          padding: 2px 4px;
          cursor: pointer;
          font-weight: 600;
          transition: background-color 0.2s;
        }

        .citation-ghost:hover {
          background-color: #f5c2c7;
        }

        .citation-selected {
          background-color: #cfe2ff;
          border-color: #0d6efd;
          box-shadow: 0 0 0 2px rgba(13, 110, 253, 0.25);
        }

        .manuscript-content {
          font-family: 'Times New Roman', Times, serif;
          font-size: 12pt;
          line-height: 2;
          max-width: 800px;
          margin: 0 auto;
          padding: 40px;
        }

        .manuscript-content h1 {
          font-size: 16pt;
          font-weight: bold;
          text-align: center;
          margin-bottom: 20px;
        }

        .manuscript-content p {
          margin-bottom: 12px;
          text-align: justify;
        }

        .manuscript-content .abstract {
          font-style: italic;
          margin: 20px 0;
        }
      </style>
    `;
  }
}

export const manuscriptExtractorService = new ManuscriptExtractorService();
