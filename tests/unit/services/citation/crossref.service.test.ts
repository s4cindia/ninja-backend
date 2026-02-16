/**
 * CrossRef Service Tests
 *
 * Tests for CrossRef API integration for DOI lookup and metadata enrichment
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { crossRefService } from '../../../../src/services/citation/crossref.service';

describe('CrossRefService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lookupByDoi', () => {
    it('should retrieve metadata for a valid DOI', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/s41586-023-00001-0',
            title: ['Research Article Title'],
            author: [
              { given: 'John', family: 'Smith' },
              { given: 'Jane', family: 'Doe', suffix: 'Jr' },
            ],
            published: { 'date-parts': [[2023, 5, 15]] },
            'container-title': ['Nature'],
            volume: '580',
            issue: '7801',
            page: '100-105',
            publisher: 'Nature Publishing Group',
            URL: 'https://doi.org/10.1038/s41586-023-00001-0',
            type: 'journal-article',
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await crossRefService.lookupByDoi('10.1038/s41586-023-00001-0');

      expect(result).not.toBeNull();
      expect(result?.title).toBe('Research Article Title');
      expect(result?.authors).toHaveLength(2);
      expect(result?.authors[0].firstName).toBe('John');
      expect(result?.authors[0].lastName).toBe('Smith');
      expect(result?.authors[1].suffix).toBe('Jr');
      expect(result?.year).toBe('2023');
      expect(result?.journalName).toBe('Nature');
      expect(result?.volume).toBe('580');
      expect(result?.issue).toBe('7801');
      expect(result?.pages).toBe('100-105');
      expect(result?.sourceType).toBe('journal');
      expect(result?.source).toBe('crossref');
      expect(result?.confidence).toBe(0.95);
    });

    it('should handle DOI with https://doi.org/ prefix', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/test',
            title: ['Test Article'],
            type: 'journal-article',
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await crossRefService.lookupByDoi('https://doi.org/10.1038/test');

      expect(result).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('10.1038%2Ftest'),
        expect.any(Object)
      );
    });

    it('should return null for non-existent DOI', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await crossRefService.lookupByDoi('10.1038/nonexistent');

      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await crossRefService.lookupByDoi('10.1038/test');

      expect(result).toBeNull();
    });

    it('should handle missing optional fields gracefully', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/minimal',
            title: ['Minimal Article'],
            type: 'journal-article',
            // No author, date, journal, etc.
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await crossRefService.lookupByDoi('10.1038/minimal');

      expect(result).not.toBeNull();
      expect(result?.title).toBe('Minimal Article');
      expect(result?.authors).toHaveLength(0);
      expect(result?.year).toBeUndefined();
      expect(result?.journalName).toBeUndefined();
    });

    it('should use created date when published date is unavailable', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/created-date',
            title: ['Article with Created Date'],
            created: { 'date-parts': [[2022, 3, 10]] },
            // No published date
            type: 'journal-article',
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await crossRefService.lookupByDoi('10.1038/created-date');

      expect(result?.year).toBe('2022');
    });

    it('should generate URL from DOI when URL is missing', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/no-url',
            title: ['Article without URL'],
            type: 'journal-article',
            // No URL field
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const result = await crossRefService.lookupByDoi('10.1038/no-url');

      expect(result?.url).toBe('https://doi.org/10.1038/no-url');
    });
  });

  describe('search', () => {
    it('should search for works by query string', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            items: [
              {
                DOI: '10.1038/result1',
                title: ['First Result'],
                author: [{ given: 'John', family: 'Smith' }],
                published: { 'date-parts': [[2023]] },
                type: 'journal-article',
              },
              {
                DOI: '10.1038/result2',
                title: ['Second Result'],
                author: [{ given: 'Jane', family: 'Doe' }],
                published: { 'date-parts': [[2022]] },
                type: 'journal-article',
              },
            ],
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const results = await crossRefService.search('machine learning');

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('First Result');
      expect(results[0].doi).toBe('10.1038/result1');
      expect(results[1].title).toBe('Second Result');
    });

    it('should respect the limit parameter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: { items: [] },
        }),
      });

      await crossRefService.search('test query', 10);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('rows=10'),
        expect.any(Object)
      );
    });

    it('should return empty array on error', async () => {
      mockFetch.mockRejectedValue(new Error('Search failed'));

      const results = await crossRefService.search('test');

      expect(results).toEqual([]);
    });

    it('should return empty array for non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const results = await crossRefService.search('test');

      expect(results).toEqual([]);
    });

    it('should encode query parameters properly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: { items: [] },
        }),
      });

      await crossRefService.search('test & special characters');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('test & special characters')),
        expect.any(Object)
      );
    });
  });

  describe('Work Type Mapping', () => {
    const testWorkTypeMapping = async (crossRefType: string, expectedSourceType: string) => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/test',
            title: ['Test'],
            type: crossRefType,
          },
        }),
      });

      const result = await crossRefService.lookupByDoi('10.1038/test');
      expect(result?.sourceType).toBe(expectedSourceType);
    };

    it('should map journal-article to journal', async () => {
      await testWorkTypeMapping('journal-article', 'journal');
    });

    it('should map book to book', async () => {
      await testWorkTypeMapping('book', 'book');
    });

    it('should map book-chapter to chapter', async () => {
      await testWorkTypeMapping('book-chapter', 'chapter');
    });

    it('should map proceedings-article to conference', async () => {
      await testWorkTypeMapping('proceedings-article', 'conference');
    });

    it('should map posted-content to website', async () => {
      await testWorkTypeMapping('posted-content', 'website');
    });

    it('should map unknown types to unknown', async () => {
      await testWorkTypeMapping('unknown-type', 'unknown');
    });
  });

  describe('User-Agent Header', () => {
    it('should include proper User-Agent header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          message: {
            DOI: '10.1038/test',
            title: ['Test'],
            type: 'journal-article',
          },
        }),
      });

      await crossRefService.lookupByDoi('10.1038/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('Ninja-Citation-Tool'),
          }),
        })
      );
    });
  });
});
