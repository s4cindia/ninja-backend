/**
 * DOI Validation and Metadata Retrieval Service
 * Validates DOIs and retrieves metadata from CrossRef
 */

import axios from 'axios';
import { logger } from '../../lib/logger';
import { ReferenceEntry } from './ai-citation-detector.service';

export interface DOIMetadata {
  doi: string;
  title: string;
  authors: string[];
  year: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  url: string;
  type: string; // journal-article, book-chapter, etc.
}

export interface DOIValidationResult {
  valid: boolean;
  doi?: string;
  metadata?: DOIMetadata;
  error?: string;
}

export interface ReferenceValidation {
  referenceId: string;
  hasValidDOI: boolean;
  metadata?: DOIMetadata;
  discrepancies?: {
    field: string;
    referenceValue: string;
    doiValue: string;
  }[];
  suggestions?: string[];
}

class DOIValidationService {
  private crossrefApiBase = 'https://api.crossref.org/works';
  private doiOrgBase = 'https://doi.org';

  /**
   * Validate a DOI and retrieve metadata
   */
  async validateDOI(doi: string): Promise<DOIValidationResult> {
    try {
      // Clean and normalize DOI
      const cleanDOI = this.normalizeDOI(doi);

      if (!this.isValidDOIFormat(cleanDOI)) {
        return {
          valid: false,
          error: 'Invalid DOI format'
        };
      }

      // Fetch metadata from CrossRef
      const metadata = await this.fetchCrossRefMetadata(cleanDOI);

      return {
        valid: true,
        doi: cleanDOI,
        metadata
      };
    } catch (error: any) {
      logger.error(`[DOI Validation] Failed to validate DOI ${doi}:`, error.message);
      return {
        valid: false,
        error: error.message || 'Failed to validate DOI'
      };
    }
  }

  /**
   * Batch validate DOIs for multiple references
   */
  async validateReferences(references: ReferenceEntry[]): Promise<ReferenceValidation[]> {
    logger.info(`[DOI Validation] Validating ${references.length} references`);

    const results: ReferenceValidation[] = [];

    for (const ref of references) {
      if (!ref.components.doi) {
        results.push({
          referenceId: ref.id,
          hasValidDOI: false,
          suggestions: ['No DOI found in reference']
        });
        continue;
      }

      const validation = await this.validateDOI(ref.components.doi);

      if (!validation.valid) {
        results.push({
          referenceId: ref.id,
          hasValidDOI: false,
          suggestions: [validation.error || 'Invalid DOI']
        });
        continue;
      }

      // Check for discrepancies between reference and DOI metadata
      const discrepancies = this.findDiscrepancies(ref, validation.metadata!);

      results.push({
        referenceId: ref.id,
        hasValidDOI: true,
        metadata: validation.metadata,
        discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
        suggestions: discrepancies.length > 0
          ? ['Metadata mismatch detected - review reference details']
          : undefined
      });
    }

    return results;
  }

  /**
   * Auto-complete reference from DOI
   */
  async autoCompleteFromDOI(doi: string): Promise<ReferenceEntry | null> {
    const validation = await this.validateDOI(doi);

    if (!validation.valid || !validation.metadata) {
      return null;
    }

    const metadata = validation.metadata;

    return {
      id: `ref-${Date.now()}`,
      number: 0,
      rawText: this.formatReferenceFromMetadata(metadata),
      components: {
        authors: metadata.authors,
        year: metadata.year,
        title: metadata.title,
        journal: metadata.journal,
        volume: metadata.volume,
        issue: metadata.issue,
        pages: metadata.pages,
        doi: metadata.doi,
        url: metadata.url,
        publisher: metadata.publisher
      },
      detectedStyle: 'APA',
      citedBy: []
    };
  }

  /**
   * Fetch metadata from CrossRef API
   */
  private async fetchCrossRefMetadata(doi: string): Promise<DOIMetadata> {
    try {
      const response = await axios.get(`${this.crossrefApiBase}/${doi}`, {
        headers: {
          'User-Agent': 'Ninja-Citation-Tool/1.0 (mailto:support@ninja.com)'
        },
        timeout: 10000
      });

      const data = response.data.message;

      // Parse authors
      const authors = (data.author || []).map((author: any) => {
        if (author.family && author.given) {
          return `${author.family}, ${author.given.charAt(0)}.`;
        }
        return author.name || '';
      }).filter(Boolean);

      // Parse date
      const year = data.published?.['date-parts']?.[0]?.[0]?.toString() ||
                   data.created?.['date-parts']?.[0]?.[0]?.toString() ||
                   '';

      // Parse pages
      const pages = data.page || '';

      return {
        doi: data.DOI,
        title: data.title?.[0] || '',
        authors,
        year,
        journal: data['container-title']?.[0],
        volume: data.volume,
        issue: data.issue,
        pages,
        publisher: data.publisher,
        url: data.URL || `https://doi.org/${data.DOI}`,
        type: data.type || 'journal-article'
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new Error('DOI not found in CrossRef database');
      }
      throw new Error(`Failed to fetch metadata: ${error.message}`);
    }
  }

  /**
   * Normalize DOI (remove prefixes, clean)
   */
  private normalizeDOI(doi: string): string {
    // Remove common prefixes
    let cleaned = doi.trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .replace(/^DOI:\s*/i, '');

    return cleaned;
  }

  /**
   * Validate DOI format
   */
  private isValidDOIFormat(doi: string): boolean {
    // DOI format: 10.xxxx/yyyy
    // Basic validation - starts with "10." and contains "/"
    return doi.startsWith('10.') && doi.includes('/');
  }

  /**
   * Find discrepancies between reference and DOI metadata
   */
  private findDiscrepancies(
    ref: ReferenceEntry,
    metadata: DOIMetadata
  ): { field: string; referenceValue: string; doiValue: string }[] {
    const discrepancies: { field: string; referenceValue: string; doiValue: string }[] = [];

    // Check title
    if (ref.components.title && metadata.title) {
      const refTitle = ref.components.title.toLowerCase().trim();
      const metaTitle = metadata.title.toLowerCase().trim();
      if (refTitle !== metaTitle && !refTitle.includes(metaTitle) && !metaTitle.includes(refTitle)) {
        discrepancies.push({
          field: 'title',
          referenceValue: ref.components.title,
          doiValue: metadata.title
        });
      }
    }

    // Check year
    if (ref.components.year && metadata.year) {
      if (ref.components.year !== metadata.year) {
        discrepancies.push({
          field: 'year',
          referenceValue: ref.components.year,
          doiValue: metadata.year
        });
      }
    }

    // Check journal
    if (ref.components.journal && metadata.journal) {
      const refJournal = ref.components.journal.toLowerCase().trim();
      const metaJournal = metadata.journal.toLowerCase().trim();
      if (refJournal !== metaJournal && !refJournal.includes(metaJournal) && !metaJournal.includes(refJournal)) {
        discrepancies.push({
          field: 'journal',
          referenceValue: ref.components.journal,
          doiValue: metadata.journal
        });
      }
    }

    // Check volume
    if (ref.components.volume && metadata.volume) {
      if (ref.components.volume !== metadata.volume) {
        discrepancies.push({
          field: 'volume',
          referenceValue: ref.components.volume,
          doiValue: metadata.volume
        });
      }
    }

    return discrepancies;
  }

  /**
   * Format reference text from metadata (APA style)
   */
  private formatReferenceFromMetadata(metadata: DOIMetadata): string {
    const parts: string[] = [];

    // Authors
    if (metadata.authors.length > 0) {
      if (metadata.authors.length === 1) {
        parts.push(metadata.authors[0]);
      } else if (metadata.authors.length === 2) {
        parts.push(`${metadata.authors[0]}, & ${metadata.authors[1]}`);
      } else {
        parts.push(`${metadata.authors[0]}, et al.`);
      }
    }

    // Year
    if (metadata.year) {
      parts.push(`(${metadata.year}).`);
    }

    // Title
    if (metadata.title) {
      parts.push(`${metadata.title}.`);
    }

    // Journal
    if (metadata.journal) {
      parts.push(`${metadata.journal},`);
    }

    // Volume and Issue
    if (metadata.volume) {
      let volIssue = metadata.volume;
      if (metadata.issue) {
        volIssue += `(${metadata.issue})`;
      }
      parts.push(`${volIssue},`);
    }

    // Pages
    if (metadata.pages) {
      parts.push(`${metadata.pages}.`);
    }

    // DOI
    if (metadata.doi) {
      parts.push(`https://doi.org/${metadata.doi}`);
    }

    return parts.join(' ');
  }

  /**
   * Search for DOI in reference text using AI (as fallback)
   */
  async extractDOIFromText(referenceText: string): Promise<string | null> {
    // Look for DOI patterns in text
    const doiPatterns = [
      /10\.\d{4,}\/[^\s]+/g,
      /doi:\s*10\.\d{4,}\/[^\s]+/gi,
      /https?:\/\/(dx\.)?doi\.org\/10\.\d{4,}\/[^\s]+/gi
    ];

    for (const pattern of doiPatterns) {
      const matches = referenceText.match(pattern);
      if (matches && matches.length > 0) {
        return this.normalizeDOI(matches[0]);
      }
    }

    return null;
  }
}

export const doiValidationService = new DOIValidationService();
