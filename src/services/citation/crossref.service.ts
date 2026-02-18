import { logger } from '../../lib/logger';
import { crossRefRateLimiter } from '../../utils/rate-limiter';

export interface CrossRefAuthor {
  given?: string;
  family: string;
  suffix?: string;
}

interface CrossRefWork {
  author?: CrossRefAuthor[];
  title?: string[];
  published?: { 'date-parts'?: number[][] };
  created?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  URL?: string;
  publisher?: string;
  type?: string;
  score?: number; // CrossRef relevance score (search results only)
}

export interface EnrichedMetadata {
  authors: { firstName?: string; lastName: string; suffix?: string }[];
  title: string;
  year?: string;
  journalName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  publisher?: string;
  isbn?: string;
  sourceType: 'journal' | 'book' | 'chapter' | 'conference' | 'website' | 'unknown';
  source: 'crossref' | 'pubmed' | 'manual' | 'ai';
  confidence: number;
}

class CrossRefService {
  private baseUrl = 'https://api.crossref.org/works';
  private userAgent: string;
  private readonly REQUEST_TIMEOUT_MS = 10000; // 10 second timeout

  constructor() {
    const contactEmail = process.env.CROSSREF_CONTACT_EMAIL || 'support@s4carlisle.com';
    this.userAgent = `Ninja-Citation-Tool/1.0 (mailto:${contactEmail})`;
  }

  /**
   * Validate DOI format to prevent SSRF attacks
   * Valid DOIs start with "10." followed by registrant code and suffix
   */
  private isValidDoiFormat(doi: string): boolean {
    // DOI format: 10.xxxx/yyyy (must start with "10." and contain "/")
    return /^10\.\d{4,}\/[^\s]+$/.test(doi);
  }

  async lookupByDoi(doi: string): Promise<EnrichedMetadata | null> {
    try {
      // Apply rate limiting before making request
      await crossRefRateLimiter.acquire();

      const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '').replace(/^doi:/i, '').trim();

      // Validate DOI format to prevent SSRF
      if (!this.isValidDoiFormat(cleanDoi)) {
        logger.warn(`[CrossRef] Invalid DOI format rejected: ${cleanDoi.substring(0, 50)}`);
        return null;
      }

      const url = `${this.baseUrl}/${encodeURIComponent(cleanDoi)}`;

      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(`[CrossRef] DOI lookup failed: ${response.status} for ${cleanDoi}`);
        return null;
      }

      const data = await response.json() as { message: CrossRefWork };
      const work = data.message;

      return this.mapCrossRefWork(work, true); // Direct DOI lookup = high confidence
    } catch (error) {
      logger.error('[CrossRef] Lookup error', error instanceof Error ? error : undefined);
      return null;
    }
  }

  async search(query: string, limit = 5): Promise<EnrichedMetadata[]> {
    try {
      // Apply rate limiting before making request
      await crossRefRateLimiter.acquire();

      // Limit query length to prevent abuse
      const sanitizedQuery = query.substring(0, 500);
      const url = `${this.baseUrl}?query=${encodeURIComponent(sanitizedQuery)}&rows=${Math.min(limit, 20)}`;

      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { message?: { items?: CrossRefWork[] } };
      const works = data.message?.items || [];

      return works.map((work: CrossRefWork) => this.mapCrossRefWork(work));
    } catch (error) {
      logger.error('[CrossRef] Search error', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Map CrossRef API response to EnrichedMetadata
   * @param work - CrossRef work object
   * @param isDirectLookup - true for DOI lookup (high confidence), false for search results
   */
  private mapCrossRefWork(work: CrossRefWork, isDirectLookup = false): EnrichedMetadata {
    const authors = (work.author || []).map((a: CrossRefAuthor) => ({
      firstName: a.given,
      lastName: a.family,
      suffix: a.suffix
    }));

    const year = work.published?.['date-parts']?.[0]?.[0]?.toString() ||
                 work.created?.['date-parts']?.[0]?.[0]?.toString();

    // Calculate confidence based on source:
    // - Direct DOI lookup: 0.95 (verified match)
    // - Search results: Normalize CrossRef score (typically 0-200+) to 0.5-0.95 range
    let confidence: number;
    if (isDirectLookup) {
      confidence = 0.95; // Direct DOI lookup is highly reliable
    } else if (work.score !== undefined) {
      // CrossRef scores typically range 0-200+, normalize to 0.5-0.95
      // Score of 100+ gets high confidence, lower scores get proportionally lower
      confidence = Math.min(0.95, Math.max(0.5, 0.5 + (work.score / 200) * 0.45));
    } else {
      confidence = 0.7; // Default for search without score
    }

    return {
      authors,
      title: work.title?.[0] || '',
      year,
      journalName: work['container-title']?.[0],
      volume: work.volume,
      issue: work.issue,
      pages: work.page,
      doi: work.DOI,
      url: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : undefined),
      publisher: work.publisher,
      sourceType: this.mapWorkType(work.type || ''),
      source: 'crossref',
      confidence
    };
  }

  private mapWorkType(type: string): EnrichedMetadata['sourceType'] {
    const typeMap: Record<string, EnrichedMetadata['sourceType']> = {
      'journal-article': 'journal',
      'book': 'book',
      'book-chapter': 'chapter',
      'proceedings-article': 'conference',
      'posted-content': 'website'
    };
    return typeMap[type] || 'unknown';
  }
}

export const crossRefService = new CrossRefService();
