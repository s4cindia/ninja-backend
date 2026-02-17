/**
 * DOI Validation Service Tests
 *
 * Tests for DOI validation, normalization, and metadata retrieval
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock axios
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

import axios from 'axios';
import { doiValidationService } from '../../../../src/services/citation/doi-validation.service';

describe('DOIValidationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateDOI', () => {
    it('should validate a valid DOI and return metadata', async () => {
      const mockCrossRefResponse = {
        data: {
          message: {
            DOI: '10.1038/s41586-023-00001-0',
            title: ['Test Article Title'],
            author: [
              { family: 'Smith', given: 'John' },
              { family: 'Jones', given: 'Mary' },
            ],
            published: { 'date-parts': [[2023]] },
            'container-title': ['Nature'],
            volume: '580',
            issue: '7801',
            page: '100-105',
            publisher: 'Nature Publishing',
            URL: 'https://doi.org/10.1038/s41586-023-00001-0',
            type: 'journal-article',
          },
        },
      };

      vi.mocked(axios.get).mockResolvedValue(mockCrossRefResponse);

      const result = await doiValidationService.validateDOI('10.1038/s41586-023-00001-0');

      expect(result.valid).toBe(true);
      expect(result.doi).toBe('10.1038/s41586-023-00001-0');
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.title).toBe('Test Article Title');
      expect(result.metadata?.authors).toContain('Smith, J.');
      expect(result.metadata?.year).toBe('2023');
    });

    it('should return invalid for malformed DOI format', async () => {
      const result = await doiValidationService.validateDOI('not-a-valid-doi');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid DOI format');
    });

    it('should return invalid for DOI without slash', async () => {
      const result = await doiValidationService.validateDOI('10.1038');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid DOI format');
    });

    it('should handle DOI not found in CrossRef', async () => {
      vi.mocked(axios.get).mockRejectedValue({
        response: { status: 404 },
      });

      const result = await doiValidationService.validateDOI('10.1038/nonexistent');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('DOI not found in CrossRef database');
    });

    it('should handle network errors gracefully', async () => {
      vi.mocked(axios.get).mockRejectedValue(new Error('Network timeout'));

      const result = await doiValidationService.validateDOI('10.1038/s41586-023-00001-0');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    it('should normalize DOI with https://doi.org/ prefix', async () => {
      const mockCrossRefResponse = {
        data: {
          message: {
            DOI: '10.1038/test',
            title: ['Test'],
            author: [],
            published: { 'date-parts': [[2023]] },
            type: 'journal-article',
          },
        },
      };

      vi.mocked(axios.get).mockResolvedValue(mockCrossRefResponse);

      const result = await doiValidationService.validateDOI('https://doi.org/10.1038/test');

      expect(result.valid).toBe(true);
      expect(result.doi).toBe('10.1038/test');
    });

    it('should normalize DOI with doi: prefix', async () => {
      const mockCrossRefResponse = {
        data: {
          message: {
            DOI: '10.1038/test',
            title: ['Test'],
            author: [],
            published: { 'date-parts': [[2023]] },
            type: 'journal-article',
          },
        },
      };

      vi.mocked(axios.get).mockResolvedValue(mockCrossRefResponse);

      const result = await doiValidationService.validateDOI('doi: 10.1038/test');

      expect(result.valid).toBe(true);
      expect(result.doi).toBe('10.1038/test');
    });

    it('should normalize DOI with dx.doi.org prefix', async () => {
      const mockCrossRefResponse = {
        data: {
          message: {
            DOI: '10.1038/test',
            title: ['Test'],
            author: [],
            published: { 'date-parts': [[2023]] },
            type: 'journal-article',
          },
        },
      };

      vi.mocked(axios.get).mockResolvedValue(mockCrossRefResponse);

      const result = await doiValidationService.validateDOI('https://dx.doi.org/10.1038/test');

      expect(result.valid).toBe(true);
      expect(result.doi).toBe('10.1038/test');
    });
  });

  describe('validateReferences', () => {
    it('should validate multiple references in parallel', async () => {
      const references = [
        { id: 'ref1', number: 1, rawText: 'Ref 1', components: { doi: '10.1038/test1' }, detectedStyle: 'APA', citedBy: [] },
        { id: 'ref2', number: 2, rawText: 'Ref 2', components: { doi: '10.1038/test2' }, detectedStyle: 'APA', citedBy: [] },
        { id: 'ref3', number: 3, rawText: 'Ref 3', components: {}, detectedStyle: 'APA', citedBy: [] }, // No DOI
      ];

      const mockResponse = (doi: string) => ({
        data: {
          message: {
            DOI: doi,
            title: [`Title for ${doi}`],
            author: [{ family: 'Author', given: 'Test' }],
            published: { 'date-parts': [[2023]] },
            type: 'journal-article',
          },
        },
      });

      vi.mocked(axios.get)
        .mockResolvedValueOnce(mockResponse('10.1038/test1'))
        .mockResolvedValueOnce(mockResponse('10.1038/test2'));

      const results = await doiValidationService.validateReferences(references);

      expect(results).toHaveLength(3);
      expect(results[0].hasValidDOI).toBe(true);
      expect(results[1].hasValidDOI).toBe(true);
      expect(results[2].hasValidDOI).toBe(false);
      expect(results[2].suggestions).toContain('No DOI found in reference');
    });

    it('should detect discrepancies between reference and DOI metadata', async () => {
      const references = [
        {
          id: 'ref1',
          number: 1,
          rawText: 'Smith (2020). Wrong Title.',
          components: {
            doi: '10.1038/test1',
            year: '2020', // Different from DOI metadata
            title: 'Wrong Title',
          },
          detectedStyle: 'APA',
          citedBy: [],
        },
      ];

      vi.mocked(axios.get).mockResolvedValue({
        data: {
          message: {
            DOI: '10.1038/test1',
            title: ['Correct Title'],
            author: [{ family: 'Smith', given: 'John' }],
            published: { 'date-parts': [[2023]] }, // Different year
            type: 'journal-article',
          },
        },
      });

      const results = await doiValidationService.validateReferences(references);

      expect(results[0].hasValidDOI).toBe(true);
      expect(results[0].discrepancies).toBeDefined();
      expect(results[0].discrepancies?.length).toBeGreaterThan(0);

      const yearDiscrepancy = results[0].discrepancies?.find(d => d.field === 'year');
      expect(yearDiscrepancy).toBeDefined();
      expect(yearDiscrepancy?.referenceValue).toBe('2020');
      expect(yearDiscrepancy?.doiValue).toBe('2023');
    });

    it('should handle validation failures gracefully', async () => {
      const references = [
        { id: 'ref1', number: 1, rawText: 'Ref 1', components: { doi: '10.1038/test1' }, detectedStyle: 'APA', citedBy: [] },
      ];

      vi.mocked(axios.get).mockRejectedValue(new Error('Service unavailable'));

      const results = await doiValidationService.validateReferences(references);

      expect(results[0].hasValidDOI).toBe(false);
      // Service returns error message from the caught error
      expect(results[0].suggestions).toBeDefined();
      expect(results[0].suggestions?.length).toBeGreaterThan(0);
    });
  });

  describe('autoCompleteFromDOI', () => {
    it('should return a complete reference entry from DOI', async () => {
      vi.mocked(axios.get).mockResolvedValue({
        data: {
          message: {
            DOI: '10.1038/s41586-023-00001-0',
            title: ['Complete Article Title'],
            author: [
              { family: 'Smith', given: 'John' },
              { family: 'Jones', given: 'Mary' },
            ],
            published: { 'date-parts': [[2023]] },
            'container-title': ['Nature'],
            volume: '580',
            issue: '7801',
            page: '100-105',
            publisher: 'Nature Publishing',
            URL: 'https://doi.org/10.1038/s41586-023-00001-0',
            type: 'journal-article',
          },
        },
      });

      const result = await doiValidationService.autoCompleteFromDOI('10.1038/s41586-023-00001-0');

      expect(result).not.toBeNull();
      expect(result?.components.title).toBe('Complete Article Title');
      expect(result?.components.year).toBe('2023');
      expect(result?.components.journal).toBe('Nature');
      expect(result?.components.doi).toBe('10.1038/s41586-023-00001-0');
    });

    it('should return null for invalid DOI', async () => {
      vi.mocked(axios.get).mockRejectedValue({ response: { status: 404 } });

      const result = await doiValidationService.autoCompleteFromDOI('10.1038/invalid');

      expect(result).toBeNull();
    });
  });

  describe('extractDOIFromText', () => {
    it('should extract DOI from raw reference text', async () => {
      const text = 'Smith J. Article title. Journal. 2023. doi:10.1038/s41586-023-00001-0';

      const result = await doiValidationService.extractDOIFromText(text);

      expect(result).toBe('10.1038/s41586-023-00001-0');
    });

    it('should extract DOI from URL format', async () => {
      const text = 'Available at: https://doi.org/10.1038/s41586-023-00001-0';

      const result = await doiValidationService.extractDOIFromText(text);

      expect(result).toBe('10.1038/s41586-023-00001-0');
    });

    it('should return null when no DOI is found', async () => {
      const text = 'Smith J. Article title. Journal. 2023.';

      const result = await doiValidationService.extractDOIFromText(text);

      expect(result).toBeNull();
    });

    it('should extract DOI without prefix', async () => {
      const text = 'Reference with 10.1234/example.2023';

      const result = await doiValidationService.extractDOIFromText(text);

      expect(result).toBe('10.1234/example.2023');
    });
  });
});
