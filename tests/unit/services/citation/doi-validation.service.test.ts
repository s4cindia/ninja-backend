/**
 * DoiValidationService Unit Tests
 *
 * Tests DOI validation format checking and error handling.
 * Note: Integration tests cover actual CrossRef API calls.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock axios before importing
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../src/utils/rate-limiter', () => ({
  crossRefRateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
  },
  tenantCitationUsageTracker: {
    checkLimit: vi.fn().mockResolvedValue(true),
    canMakeCall: vi.fn().mockReturnValue({ allowed: true }),
    recordCall: vi.fn(),
    recordTokens: vi.fn(),
    increment: vi.fn().mockResolvedValue(undefined),
  },
  RateLimitError: class RateLimitError extends Error {
    retryAfter: number;
    constructor(message: string, retryAfter = 60000) {
      super(message);
      this.name = 'RateLimitError';
      this.retryAfter = retryAfter;
    }
  },
}));

import axios from 'axios';
import { crossRefRateLimiter } from '../../../../src/utils/rate-limiter';

describe('DoiValidationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateDOI', () => {
    it('should validate a correct DOI format', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      vi.mocked(axios.get).mockResolvedValue({
        data: {
          message: {
            DOI: '10.1000/test',
            title: ['Test Article'],
            author: [{ family: 'Smith', given: 'John' }],
            published: { 'date-parts': [[2020]] },
          },
        },
      });

      const result = await doiValidationService.validateDOI('10.1000/test');

      expect(result.valid).toBe(true);
      expect(result.doi).toBe('10.1000/test');
    });

    it('should handle invalid DOI format - not starting with 10.', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const result = await doiValidationService.validateDOI('invalid-doi');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle CrossRef API errors gracefully', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      const result = await doiValidationService.validateDOI('10.1000/test');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should acquire rate limit token before API call', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      vi.mocked(axios.get).mockResolvedValue({
        data: {
          message: {
            DOI: '10.1000/test',
            title: ['Test'],
            author: [],
            published: { 'date-parts': [[2020]] },
          },
        },
      });

      await doiValidationService.validateDOI('10.1000/test');

      expect(crossRefRateLimiter.acquire).toHaveBeenCalled();
    });

    it('should handle rate limit exceeded', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      // Rate limit errors are caught and returned as invalid DOI result
      vi.mocked(crossRefRateLimiter.acquire).mockRejectedValue(
        new Error('Rate limit exceeded')
      );

      const result = await doiValidationService.validateDOI('10.1000/test');

      // The service catches errors and returns { valid: false, error: ... }
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Rate limit exceeded');
    });
  });

  describe('DOI Format Validation', () => {
    it('should reject DOI not starting with 10.', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const result = await doiValidationService.validateDOI('11.1234/test');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid DOI format');
    });

    it('should reject DOI without /', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const result = await doiValidationService.validateDOI('10.1234test');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid DOI format');
    });

    it('should accept empty string as invalid', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const result = await doiValidationService.validateDOI('');

      expect(result.valid).toBe(false);
    });

    // Note: DOI prefix normalization is tested via integration tests
    // where module caching doesn't affect mock behavior
  });

  describe('extractDOIFromText', () => {
    it('should extract DOI from reference text', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const text = 'Smith, J. (2020). Article Title. Journal, 10(2), 1-10. https://doi.org/10.1234/test.2020';
      const doi = await doiValidationService.extractDOIFromText(text);

      expect(doi).toBe('10.1234/test.2020');
    });

    it('should return null when no DOI found', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const text = 'Smith, J. (2020). Article Title. Journal, 10(2), 1-10.';
      const doi = await doiValidationService.extractDOIFromText(text);

      expect(doi).toBeNull();
    });

    it('should extract DOI with doi: prefix', async () => {
      const { doiValidationService } = await import('../../../../src/services/citation/doi-validation.service');

      const text = 'Reference text doi: 10.1234/abc.123';
      const doi = await doiValidationService.extractDOIFromText(text);

      expect(doi).toBe('10.1234/abc.123');
    });
  });
});
