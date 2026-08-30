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

    it('logs a small excerpt centered on the JSON parser\'s reported error position, not the full response', async () => {
      // The response is long on both sides of the actual break so a
      // "logs the whole thing" regression would be obvious: only a ~80-char
      // window around the error position should appear, not the full text.
      const prefix = 'A'.repeat(200);
      const suffix = 'B'.repeat(200);
      const rawText = `${prefix}{not valid json}${suffix}`;
      const callModel = vi.fn().mockResolvedValue({ text: rawText });

      await expect(
        responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, { maxRetries: 1 })
      ).rejects.toThrow();

      expect(callModel).toHaveBeenCalledTimes(2); // initial + 1 retry
      const [, meta] = vi.mocked(logger.error).mock.calls[0];
      const { excerptAroundErrorPosition, responseLength } = meta as {
        excerptAroundErrorPosition: string;
        responseLength: number;
      };
      expect(responseLength).toBe(rawText.length);
      expect(excerptAroundErrorPosition.length).toBeLessThan(rawText.length);
      expect(excerptAroundErrorPosition.length).toBeLessThanOrEqual(80);
      // Never logs the full padding on either side -- only a window near the break.
      expect(excerptAroundErrorPosition).not.toContain(prefix);
      expect(excerptAroundErrorPosition).not.toContain(suffix);
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

    it('does not attach a stale response excerpt from an earlier attempt to a later transport-error failure', async () => {
      // Regression for a gap CodeRabbit caught: attempt 1 gets a real (if
      // unparseable) response; attempt 2's callModel() itself throws (e.g. a
      // network/rate-limit error) before returning any text. The final log
      // must reflect attempt 2's failure without silently reusing attempt
      // 1's leftover text as if it belonged to the same failure.
      const callModel = vi
        .fn()
        .mockResolvedValueOnce({ text: 'some malformed { json' })
        .mockRejectedValueOnce(new Error('rate limit exceeded'));

      await expect(
        responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, { maxRetries: 1 })
      ).rejects.toThrow('rate limit exceeded');

      const [message, meta] = vi.mocked(logger.error).mock.calls[0];
      expect(message).toContain('rate limit exceeded');
      expect(meta).not.toHaveProperty('excerptAroundErrorPosition');
      expect((meta as { responseLength?: number }).responseLength).toBeUndefined();
    });

    it('logs no excerpt for a schema-validation failure (no JSON syntax error, nothing to excerpt)', async () => {
      const callModel = vi.fn().mockResolvedValue({ text: JSON.stringify({ matchesContent: true }) }); // missing suggestedAltText

      await expect(
        responseParserService.parseWithRetryUsing(callModel, 'prompt', ASSESSMENT_SCHEMA, { maxRetries: 0 })
      ).rejects.toThrow();

      const [message, meta] = vi.mocked(logger.error).mock.calls[0];
      expect(message).toContain('Schema validation failed');
      expect(meta).not.toHaveProperty('excerptAroundErrorPosition');
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
