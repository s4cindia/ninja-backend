/**
 * Response Parser Service Tests
 *
 * Focus: fixCommonJsonIssues' regex-based repairs (unquoted keys, trailing
 * commas, single-quoted values, JS comments, undefined/NaN) must only ever
 * touch text OUTSIDE double-quoted string literals. Confirmed in production
 * (PDFAltTextValidator's AI assessment on the Altman trial) that running
 * them unconditionally corrupts otherwise-valid JSON whenever a
 * model-generated string VALUE contains ordinary text that happens to look
 * like one of these patterns -- e.g. "Note: this chart shows..." reads as
 * an unquoted object key, and "see http://example.com" reads as a "//"
 * comment. Both produced real "Invalid JSON response" / "Expected ','..."
 * SyntaxErrors at low string positions (not truncation, which fails near
 * the end of a long response).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { responseParserService } from '../../../../src/services/ai/response-parser.service';
import { logger } from '../../../../src/lib/logger';

const ASSESSMENT_SCHEMA = z.object({
  matchesContent: z.boolean(),
  suggestedAltText: z.string(),
});

describe('response-parser.service', () => {
  describe('parseWithRetryUsing -- diagnostic logging on exhausted retries', () => {
    beforeEach(() => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('logs the raw response text once all attempts are exhausted', async () => {
      const rawText = 'not valid json at all';
      const callModel = vi.fn().mockResolvedValue({ text: rawText });

      await expect(
        responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, { maxRetries: 1 })
      ).rejects.toThrow();

      expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Exhausted 2 attempt(s)'),
        expect.objectContaining({ rawResponse: rawText, rawResponseLength: rawText.length, truncatedForLog: false })
      );
    });

    it('does not log when a retry eventually succeeds', async () => {
      const callModel = vi
        .fn()
        .mockResolvedValueOnce({ text: 'not valid json' })
        .mockResolvedValueOnce({ text: JSON.stringify({ matchesContent: true, suggestedAltText: 'A red apple' }) });

      const result = await responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, {
        maxRetries: 1,
      });

      expect(result.data).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('truncates an oversized raw response in the logged metadata', async () => {
      const rawText = 'x'.repeat(5000);
      const callModel = vi.fn().mockResolvedValue({ text: rawText });

      await expect(
        responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, { maxRetries: 0 })
      ).rejects.toThrow();

      const [, meta] = vi.mocked(logger.error).mock.calls[0];
      expect((meta as { rawResponse: string }).rawResponse.length).toBe(4000);
      expect((meta as { rawResponseLength: number }).rawResponseLength).toBe(5000);
      expect((meta as { truncatedForLog: boolean }).truncatedForLog).toBe(true);
    });
  });
  describe('fixCommonJsonIssues -- string-boundary safety (regression)', () => {
    it('does not corrupt a string value containing a bare "word:" label', () => {
      const raw = JSON.stringify({
        matchesContent: true,
        suggestedAltText: 'Note: this chart shows quarterly earnings growth',
      });

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result.suggestedAltText).toBe('Note: this chart shows quarterly earnings growth');
    });

    it('does not corrupt a string value containing multiple "word:" labels', () => {
      const raw = JSON.stringify({
        matchesContent: false,
        suggestedAltText: 'A diagram with labels: Input: raw data and Output: results',
      });

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result.suggestedAltText).toBe('A diagram with labels: Input: raw data and Output: results');
    });

    it('does not corrupt a string value containing a URL (looks like a "//" comment)', () => {
      const raw = JSON.stringify({
        matchesContent: true,
        suggestedAltText: 'Screenshot of https://example.com/dashboard showing revenue',
      });

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result.suggestedAltText).toBe('Screenshot of https://example.com/dashboard showing revenue');
    });

    it('does not corrupt a string value containing a single-quoted phrase', () => {
      const raw = JSON.stringify({
        matchesContent: true,
        suggestedAltText: `Chart titled 'Revenue Growth' for fiscal year 2025`,
      });

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result.suggestedAltText).toBe(`Chart titled 'Revenue Growth' for fiscal year 2025`);
    });

    it('does not corrupt a string value containing an escaped double quote', () => {
      const raw = JSON.stringify({
        matchesContent: true,
        suggestedAltText: 'A sign reading "Exit Here" above the doorway',
      });

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result.suggestedAltText).toBe('A sign reading "Exit Here" above the doorway');
    });

    it('still fixes a genuinely unquoted key outside any string', () => {
      const raw = '{matchesContent: true, suggestedAltText: "A red apple"}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('still strips a trailing comma before a closing brace', () => {
      const raw = '{"matchesContent": true, "suggestedAltText": "A red apple",}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('still converts a single-quoted value outside a string to double quotes', () => {
      const raw = "{\"matchesContent\": true, \"suggestedAltText\": 'A red apple'}";

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('still strips a genuine // comment outside any string', () => {
      const raw = '{"matchesContent": true, // this is a comment\n"suggestedAltText": "A red apple"}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('still strips a genuine /* */ block comment outside any string', () => {
      const raw = '{"matchesContent": true, /* a block comment */ "suggestedAltText": "A red apple"}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('strips a // comment that itself contains a quote character without corrupting subsequent strings', () => {
      // Regression for a gap CodeRabbit caught in the first version of this
      // fix: a naive "split on double quotes only" scanner misread the
      // quote inside the comment as the start of a real JSON string,
      // exempting "example.com" from comment-stripping and corrupting the
      // result. Comment and string detection must share one scan.
      const raw = '{"matchesContent": true, // see "example.com" for reference\n"suggestedAltText": "A red apple"}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });

    it('strips a /* */ comment that itself contains a quote character without corrupting subsequent strings', () => {
      const raw = '{"matchesContent": true, /* a "quoted" block comment */ "suggestedAltText": "A red apple"}';

      const result = responseParserService.parse(raw, ASSESSMENT_SCHEMA);

      expect(result).toEqual({ matchesContent: true, suggestedAltText: 'A red apple' });
    });
  });
});
