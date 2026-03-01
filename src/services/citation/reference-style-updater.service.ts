/**
 * Reference Style Updater Service
 * Handles applying converted reference formats to the DOCX reference section
 * SEPARATE from main conversion logic for easier debugging
 */

import { logger } from '../../lib/logger';

export interface ReferenceStyleUpdate {
  id: string;
  originalText: string;
  convertedText: string;
  authorLastName: string;
}

export interface ReferenceDbFields {
  id: string;
  authors: string[] | { firstName?: string; lastName: string }[];
  year?: string | null;
  title: string;
  journalName?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  formattedApa?: string | null;
  sortKey: string;
}

class ReferenceStyleUpdaterService {
  /**
   * Verify that style conversion data is correctly saved
   * Returns diagnostic info without modifying anything
   */
  verifyConversionData(
    dbReferences: Array<{
      id: string;
      authors: string[] | { firstName?: string; lastName: string }[];
      formattedApa: string | null;
      sortKey: string;
    }>
  ): {
    hasConvertedRefs: boolean;
    convertedCount: number;
    missingCount: number;
    details: Array<{
      id: string;
      author: string;
      hasFormattedApa: boolean;
      formattedApaPreview: string | null;
    }>;
  } {
    const details = dbReferences.map(ref => {
      const authors = Array.isArray(ref.authors) ? ref.authors as string[] : [];
      const a0 = authors[0] ? String(authors[0]).trim() : '';
      const firstAuthor = a0
        ? (a0.includes(',') ? a0.substring(0, a0.indexOf(',')).trim() : (a0.split(/\s+/).pop() || 'Unknown'))
        : 'Unknown';

      return {
        id: ref.id,
        author: firstAuthor,
        hasFormattedApa: !!ref.formattedApa,
        formattedApaPreview: ref.formattedApa ? ref.formattedApa.substring(0, 80) + '...' : null
      };
    });

    const convertedCount = details.filter(d => d.hasFormattedApa).length;
    const missingCount = details.filter(d => !d.hasFormattedApa).length;

    logger.info(`[Reference Style Updater] Verification: ${convertedCount} converted, ${missingCount} missing formattedApa`);

    return {
      hasConvertedRefs: convertedCount > 0,
      convertedCount,
      missingCount,
      details
    };
  }

  /**
   * Build complete APA citation from database fields
   * This ensures journal name, volume, issue, pages are included
   * SEPARATE function for easier debugging
   */
  buildCompleteApaCitation(ref: ReferenceDbFields): string {
    const authors = Array.isArray(ref.authors) ? ref.authors as string[] : [];

    // Format authors for APA: "Last, F. M., & Last, F. M."
    const formattedAuthors = this.formatAuthorsForApa(authors);

    // Year
    const year = ref.year || 'n.d.';

    // Title (sentence case in APA)
    const title = ref.title || '';

    // Build the citation parts
    let citation = `${formattedAuthors} (${year}). ${title}`;

    // Add journal details if available
    if (ref.journalName) {
      // Expand common abbreviations for APA (which prefers full journal names)
      const expandedJournal = this.expandJournalAbbreviation(ref.journalName);
      citation += `. ${expandedJournal}`;

      if (ref.volume) {
        citation += `, ${ref.volume}`;
        if (ref.issue) {
          citation += `(${ref.issue})`;
        }
      }

      if (ref.pages) {
        citation += `, ${ref.pages}`;
      }
    }

    // Add DOI if available
    if (ref.doi) {
      if (!citation.endsWith('.')) {
        citation += '.';
      }
      // Format DOI as URL per APA 7th edition
      const doiUrl = ref.doi.startsWith('http') ? ref.doi : `https://doi.org/${ref.doi}`;
      citation += ` ${doiUrl}`;
    }

    // Ensure proper ending
    if (!citation.endsWith('.') && !ref.doi) {
      citation += '.';
    }

    logger.info(`[Reference Style Updater] Built complete APA: "${citation.substring(0, 80)}..."`);
    return citation;
  }

  /**
   * Format authors for APA style
   * "Smith JA" -> "Smith, J. A."
   * Multiple authors joined with ", &" before last author
   */
  private formatAuthorsForApa(authors: string[]): string {
    if (!authors || authors.length === 0) {
      return 'Unknown';
    }

    const formatted = authors.map(author => {
      const trimmed = String(author).trim();

      // Already in "Last, F. M." format?
      if (/^[A-Z][a-z]+,\s*[A-Z]\./.test(trimmed)) {
        return trimmed;
      }

      // Vancouver format: "Smith JA" or "Smith J"
      const match = trimmed.match(/^([A-Za-z'-]+)\s+([A-Z]+)$/);
      if (match) {
        const lastName = match[1];
        const initials = match[2].split('').join('. ') + '.';
        return `${lastName}, ${initials}`;
      }

      // Handle "Smith, John A" format
      if (trimmed.includes(',')) {
        const [lastName, rest] = trimmed.split(',').map(s => s.trim());
        // Convert first name to initials if needed
        const parts = rest.split(/\s+/);
        const initials = parts.map(p => p.charAt(0).toUpperCase() + '.').join(' ');
        return `${lastName}, ${initials}`;
      }

      return trimmed;
    });

    if (formatted.length === 1) {
      return formatted[0];
    } else if (formatted.length === 2) {
      return `${formatted[0]}, & ${formatted[1]}`;
    } else {
      // More than 2: First, Second, ..., & Last
      const lastAuthor = formatted.pop();
      return `${formatted.join(', ')}, & ${lastAuthor}`;
    }
  }

  /**
   * Expand common journal abbreviations
   * APA 7th edition prefers full journal names
   */
  private expandJournalAbbreviation(abbrev: string): string {
    const expansions: Record<string, string> = {
      'Plast Reconstr Surg': 'Plastic and Reconstructive Surgery',
      'Aesthetic Plast Surg': 'Aesthetic Plastic Surgery',
      'Ann Plast Surg': 'Annals of Plastic Surgery',
      'J Plast Reconstr Aesthet Surg': 'Journal of Plastic, Reconstructive & Aesthetic Surgery',
      'Br J Plast Surg': 'British Journal of Plastic Surgery',
      'Clin Plast Surg': 'Clinics in Plastic Surgery',
      'GMS Interdiscip Plast Reconstr Surg DGPW': 'GMS Interdisciplinary Plastic and Reconstructive Surgery DGPW',
      // Add more as needed
    };

    return expansions[abbrev] || abbrev;
  }

  /**
   * Build reference updates for DOCX export
   * Maps database references with converted text to DOCX paragraph matching data
   * NOW uses buildCompleteApaCitation to ensure all details are included
   */
  buildReferenceUpdates(
    dbReferences: ReferenceDbFields[]
  ): ReferenceStyleUpdate[] {
    const updates: ReferenceStyleUpdate[] = [];

    for (const ref of dbReferences) {
      const authors = Array.isArray(ref.authors) ? ref.authors as string[] : [];
      const a0 = authors[0] ? String(authors[0]).trim() : '';
      const authorLastName = a0
        ? (a0.includes(',') ? a0.substring(0, a0.indexOf(',')).trim() : (a0.split(/\s+/).pop() || ''))
        : '';

      if (!authorLastName) {
        logger.warn(`[Reference Style Updater] Reference ${ref.id} has no author - skipping`);
        continue;
      }

      // Use complete citation built from DB fields, not just formattedApa
      // This ensures journal, volume, issue, pages are always included
      let convertedText: string;

      if (ref.journalName || ref.volume || ref.pages) {
        // We have bibliographic details - build complete citation
        convertedText = this.buildCompleteApaCitation(ref);
        logger.info(`[Reference Style Updater] Using complete citation for ${authorLastName}`);
      } else if (ref.formattedApa) {
        // Fallback to formattedApa if no journal details available
        convertedText = ref.formattedApa;
        logger.info(`[Reference Style Updater] Using formattedApa for ${authorLastName} (no journal details)`);
      } else {
        logger.warn(`[Reference Style Updater] Reference ${ref.id} has no conversion data - skipping`);
        continue;
      }

      updates.push({
        id: ref.id,
        originalText: '', // Will be filled from DOCX matching
        convertedText,
        authorLastName
      });

      logger.info(`[Reference Style Updater] Prepared update for ${authorLastName}: "${convertedText.substring(0, 80)}..."`);
    }

    return updates;
  }

  /**
   * Match DOCX paragraph to database reference by author name
   * Returns the converted text if found, null otherwise
   */
  findConvertedTextForParagraph(
    paragraphText: string,
    updates: ReferenceStyleUpdate[]
  ): { convertedText: string; matchedAuthor: string } | null {
    for (const update of updates) {
      // Match by author last name (case-insensitive, word boundary)
      const authorRegex = new RegExp(`\\b${this.escapeRegex(update.authorLastName)}\\b`, 'i');

      if (authorRegex.test(paragraphText)) {
        logger.info(`[Reference Style Updater] Matched "${update.authorLastName}" in paragraph`);
        return {
          convertedText: update.convertedText,
          matchedAuthor: update.authorLastName
        };
      }
    }

    return null;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export const referenceStyleUpdaterService = new ReferenceStyleUpdaterService();
