import { logger } from '../../lib/logger';

export interface CrossRefAuthor {
  given?: string;
  family: string;
  suffix?: string;
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
  private userAgent = 'Ninja-Citation-Tool/1.0 (mailto:support@ninja.com)';

  async lookupByDoi(doi: string): Promise<EnrichedMetadata | null> {
    try {
      const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '');
      const url = `${this.baseUrl}/${encodeURIComponent(cleanDoi)}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        }
      });

      if (!response.ok) {
        logger.warn(`[CrossRef] DOI lookup failed: ${response.status} for ${cleanDoi}`);
        return null;
      }

      const data = await response.json() as { message: any };
      const work = data.message;

      return this.mapCrossRefWork(work);
    } catch (error) {
      logger.error('[CrossRef] Lookup error', error instanceof Error ? error : undefined);
      return null;
    }
  }

  async search(query: string, limit = 5): Promise<EnrichedMetadata[]> {
    try {
      const url = `${this.baseUrl}?query=${encodeURIComponent(query)}&rows=${limit}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        }
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { message?: { items?: any[] } };
      const works = data.message?.items || [];

      return works.map((work: any) => this.mapCrossRefWork(work));
    } catch (error) {
      logger.error('[CrossRef] Search error', error instanceof Error ? error : undefined);
      return [];
    }
  }

  private mapCrossRefWork(work: any): EnrichedMetadata {
    const authors = (work.author || []).map((a: CrossRefAuthor) => ({
      firstName: a.given,
      lastName: a.family,
      suffix: a.suffix
    }));

    const year = work.published?.['date-parts']?.[0]?.[0]?.toString() ||
                 work.created?.['date-parts']?.[0]?.[0]?.toString();

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
      sourceType: this.mapWorkType(work.type),
      source: 'crossref',
      confidence: 0.95
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
