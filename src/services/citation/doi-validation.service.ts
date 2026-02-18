/**
 * DOI Validation and Metadata Retrieval Service
 * Validates DOIs and retrieves metadata from CrossRef
 *
 * Rate limiting:
 * - Global rate limit: 30 requests/second to CrossRef
 * - Per-tenant limit: 500 validations/hour, 10000 operations/day
 */

import axios from 'axios';
import { logger } from '../../lib/logger';
import { ReferenceEntry } from './ai-citation-detector.service';
import { crossRefRateLimiter, tenantCitationUsageTracker, RateLimitError } from '../../utils/rate-limiter';

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
  private userAgent: string;

  constructor() {
    const contactEmail = process.env.CROSSREF_CONTACT_EMAIL || 'support@s4carlisle.com';
    this.userAgent = `Ninja-Citation-Tool/1.0 (mailto:${contactEmail})`;
  }

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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[DOI Validation] Failed to validate DOI ${doi}:`, errorMessage);
      return {
        valid: false,
        error: errorMessage || 'Failed to validate DOI'
      };
    }
  }

  /**
   * Batch validate DOIs for multiple references with per-tenant rate limiting
   * Uses parallel processing with Promise.allSettled for better performance
   *
   * @param references - Array of references to validate
   * @param tenantId - Optional tenant ID for per-tenant rate limiting
   */
  async validateReferences(references: ReferenceEntry[], tenantId?: string): Promise<ReferenceValidation[]> {
    logger.info(`[DOI Validation] Validating ${references.length} references in parallel`);

    // Check per-tenant rate limits if tenantId provided
    if (tenantId) {
      const canProceed = tenantCitationUsageTracker.canMakeCall(tenantId);
      if (!canProceed.allowed) {
        logger.warn(`[DOI Validation] Tenant ${tenantId} rate limited: ${canProceed.reason}`);
        throw new RateLimitError(
          canProceed.reason || 'Rate limit exceeded',
          (canProceed.retryAfter || 60) * 1000
        );
      }
      // Record the batch call
      tenantCitationUsageTracker.recordCall(tenantId);
      // Record operations (one per reference with DOI)
      const operationCount = references.filter(r => r.components.doi).length;
      tenantCitationUsageTracker.recordTokens(tenantId, operationCount);
    }

    // Separate references with and without DOIs
    const refsWithDOI = references.filter(ref => ref.components.doi);
    const refsWithoutDOI = references.filter(ref => !ref.components.doi);

    // Process references without DOI immediately
    const noDoiResults: ReferenceValidation[] = refsWithoutDOI.map(ref => ({
      referenceId: ref.id,
      hasValidDOI: false,
      suggestions: ['No DOI found in reference']
    }));

    // Validate DOIs in parallel
    const validationPromises = refsWithDOI.map(async (ref) => {
      const validation = await this.validateDOI(ref.components.doi!);
      return { ref, validation };
    });

    const settledResults = await Promise.allSettled(validationPromises);

    // Process parallel validation results
    const doiResults: ReferenceValidation[] = settledResults.map((result, index) => {
      const ref = refsWithDOI[index];

      if (result.status === 'rejected') {
        logger.warn(`[DOI Validation] Failed for ref ${ref.id}: ${result.reason}`);
        return {
          referenceId: ref.id,
          hasValidDOI: false,
          suggestions: ['DOI validation failed - service unavailable']
        };
      }

      const { validation } = result.value;

      if (!validation.valid) {
        return {
          referenceId: ref.id,
          hasValidDOI: false,
          suggestions: [validation.error || 'Invalid DOI']
        };
      }

      // Check for discrepancies between reference and DOI metadata
      const discrepancies = this.findDiscrepancies(ref, validation.metadata!);

      return {
        referenceId: ref.id,
        hasValidDOI: true,
        metadata: validation.metadata,
        discrepancies: discrepancies.length > 0 ? discrepancies : undefined,
        suggestions: discrepancies.length > 0
          ? ['Metadata mismatch detected - review reference details']
          : undefined
      };
    });

    // Combine results maintaining original order
    const resultMap = new Map<string, ReferenceValidation>();
    [...noDoiResults, ...doiResults].forEach(r => resultMap.set(r.referenceId, r));

    return references.map(ref => resultMap.get(ref.id)!);
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
   * Rate limited to prevent API abuse
   */
  private async fetchCrossRefMetadata(doi: string): Promise<DOIMetadata> {
    try {
      // Apply rate limiting before making request
      await crossRefRateLimiter.acquire();

      const response = await axios.get(`${this.crossrefApiBase}/${doi}`, {
        headers: {
          'User-Agent': this.userAgent
        },
        timeout: 10000
      });

      const data = response.data.message;

      // Parse authors
      const authors = (data.author || []).map((author: { family?: string; given?: string; name?: string }) => {
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
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number }; message?: string };
      if (axiosError.response?.status === 404) {
        throw new Error('DOI not found in CrossRef database');
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch metadata: ${errorMessage}`);
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
