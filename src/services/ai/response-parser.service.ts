import { ZodSchema, ZodError } from 'zod';
import { geminiService, GeminiOptions, GeminiResponse } from './gemini.service';
import { AppError } from '../../utils/app-error';

export interface ParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  rawResponse?: string;
}

export interface ParseOptions {
  maxRetries?: number;
  correctionPrompt?: string;
}

class ResponseParserService {
  parse<T>(response: string, schema: ZodSchema<T>): T {
    const jsonText = this.extractJson(response);
    const cleanedJson = this.cleanJsonResponse(jsonText);
    
    try {
      const parsed = JSON.parse(cleanedJson);
      return schema.parse(parsed);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw AppError.badRequest(`Schema validation failed: ${issues}`);
      }
      if (error instanceof SyntaxError) {
        throw AppError.badRequest(`Invalid JSON response: ${error.message}`);
      }
      throw error;
    }
  }

  safeParse<T>(response: string, schema: ZodSchema<T>): T | null {
    try {
      return this.parse(response, schema);
    } catch {
      return null;
    }
  }

  parseWithDefault<T>(response: string, schema: ZodSchema<T>, defaultValue: T): T {
    try {
      return this.parse(response, schema);
    } catch {
      return defaultValue;
    }
  }

  async parseWithRetry<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options: GeminiOptions = {},
    parseOptions: ParseOptions = {}
  ): Promise<{ data: T; usage?: GeminiResponse['usage']; attempts: number }> {
    return this.parseWithRetryUsing(
      (currentPrompt) => geminiService.generateText(currentPrompt, options),
      prompt,
      schema,
      parseOptions
    );
  }

  /**
   * Same retry-with-correction-prompt loop as parseWithRetry, but with "how
   * to call the model" injected — lets a vision call (which needs the image
   * re-attached on every attempt, not just the text prompt) share this logic
   * instead of duplicating it. See GeminiService.analyzeImageWithSchema.
   */
  async parseWithRetryUsing<T>(
    callModel: (prompt: string) => Promise<GeminiResponse>,
    prompt: string,
    schema: ZodSchema<T>,
    parseOptions: ParseOptions = {}
  ): Promise<{ data: T; usage?: GeminiResponse['usage']; attempts: number }> {
    const maxRetries = parseOptions.maxRetries ?? 2;
    let lastError: Error | undefined;
    let totalUsage: GeminiResponse['usage'] | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const currentPrompt = attempt === 0
          ? prompt
          : this.buildCorrectionPrompt(prompt, lastError?.message || 'Invalid response', parseOptions.correctionPrompt);

        const response = await callModel(currentPrompt);

        if (response.usage) {
          if (totalUsage) {
            totalUsage.promptTokens += response.usage.promptTokens;
            totalUsage.completionTokens += response.usage.completionTokens;
            totalUsage.totalTokens += response.usage.totalTokens;
          } else {
            totalUsage = { ...response.usage };
          }
        }

        const data = this.parse(response.text, schema);
        return { data, usage: totalUsage, attempts: attempt + 1 };
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError || AppError.internal('Failed to parse response after retries');
  }

  extractJson(response: string): string {
    let text = response.trim();
    
    if (text.startsWith('```json')) {
      text = text.slice(7);
    } else if (text.startsWith('```')) {
      text = text.slice(3);
    }
    
    if (text.endsWith('```')) {
      text = text.slice(0, -3);
    }
    
    text = text.trim();
    
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    
    return text;
  }

  cleanJsonResponse(json: string): string {
    let cleaned = json;

    cleaned = this.fixCommonJsonIssues(cleaned);

    return cleaned.trim();
  }

  /**
   * Applies a handful of regex-based repairs (unquoted keys, trailing
   * commas, single-quoted values, undefined/NaN) for near-miss JSON that an
   * LLM sometimes emits, plus strips // and /* *\/ comments. These are
   * line/char-level, not JSON-aware, so they're only ever run on -- or, for
   * comments, only ever recognized within -- text OUTSIDE double-quoted
   * string literals. Confirmed in production that running them
   * unconditionally corrupts otherwise-valid JSON whenever a generated
   * string VALUE happens to contain ordinary text that looks like one of
   * these patterns (e.g. an AI-written image description "Note: this chart
   * shows..." looks identical to an unquoted object key, and "see
   * http://example.com" looks identical to a "//" comment) -- see
   * tokenizeJsonLikeText. Comment stripping and string-literal detection
   * share one left-to-right scan (rather than each being its own
   * regex/pass) specifically so a quote character inside a real comment
   * (e.g. `// see "example.com"`) is never mistaken for the start of a JSON
   * string, and a `//`/`/*` sequence inside a real string value is never
   * mistaken for the start of a comment.
   */
  fixCommonJsonIssues(json: string): string {
    return this.tokenizeJsonLikeText(json)
      .map((segment) => {
        if (segment.kind === 'string') return segment.value;
        if (segment.kind === 'comment') return '';
        return this.applyJsonRepairHeuristics(segment.value);
      })
      .join('');
  }

  private applyJsonRepairHeuristics(text: string): string {
    let fixed = text;

    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    fixed = fixed.replace(/(['"])?([a-zA-Z_][a-zA-Z0-9_]*)\1?\s*:/g, '"$2":');

    fixed = fixed.replace(/:(\s*)'([^']*)'/g, ':$1"$2"');

    fixed = fixed.replace(/,(\s*),/g, ',$1');

    fixed = fixed.replace(/:\s*undefined\b/g, ': null');
    fixed = fixed.replace(/:\s*NaN\b/g, ': null');

    return fixed;
  }

  /**
   * Scans `text` left to right and splits it into segments: double-quoted
   * JSON string literals ('string', quotes included, contents passed
   * through byte-for-byte untouched -- backslash-escapes like \" are
   * respected and do not end the string), `//` and `/* *\/` comments
   * ('comment', dropped entirely by the caller), and everything else
   * ('plain', where the repair regexes are applied). String detection takes
   * priority at each position: once a `"` is seen outside a string, the
   * scanner consumes the whole literal atomically before considering
   * whether subsequent characters start a comment, so a `//` or `/*` inside
   * a real string value is never misread as a comment. Text with no
   * double-quoted strings at all (e.g. fully single-quoted, non-standard
   * JSON) comes back as a single 'plain' segment, matching the prior
   * global-regex behavior for that case.
   */
  private tokenizeJsonLikeText(
    text: string
  ): Array<{ value: string; kind: 'string' | 'comment' | 'plain' }> {
    const segments: Array<{ value: string; kind: 'string' | 'comment' | 'plain' }> = [];
    let i = 0;
    let start = 0;

    const flushPlain = (end: number) => {
      if (end > start) segments.push({ value: text.slice(start, end), kind: 'plain' });
    };

    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];

      if (ch === '"') {
        flushPlain(i);
        const stringStart = i;
        i++;
        while (i < text.length && text[i] !== '"') {
          i += text[i] === '\\' ? 2 : 1;
        }
        i = Math.min(i + 1, text.length); // include the closing quote, if one was found
        segments.push({ value: text.slice(stringStart, i), kind: 'string' });
        start = i;
        continue;
      }

      if (ch === '/' && next === '/') {
        flushPlain(i);
        const commentStart = i;
        while (i < text.length && text[i] !== '\n') i++;
        segments.push({ value: text.slice(commentStart, i), kind: 'comment' });
        start = i;
        continue;
      }

      if (ch === '/' && next === '*') {
        flushPlain(i);
        const commentStart = i;
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i = Math.min(i + 2, text.length); // include the closing */, if one was found
        segments.push({ value: text.slice(commentStart, i), kind: 'comment' });
        start = i;
        continue;
      }

      i++;
    }

    flushPlain(text.length);

    return segments;
  }

  private buildCorrectionPrompt(originalPrompt: string, error: string, customCorrection?: string): string {
    const correctionInstructions = customCorrection || `
The previous response had the following error: ${error}

Please try again and ensure:
1. The response is valid JSON
2. All required fields are present
3. Field types match the expected schema
4. No trailing commas or comments in JSON
`;

    return `${originalPrompt}

${correctionInstructions}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;
  }

  validatePartial<T>(data: unknown, schema: ZodSchema<T>): { valid: boolean; errors: string[] } {
    const result = schema.safeParse(data);
    
    if (result.success) {
      return { valid: true, errors: [] };
    }
    
    const errors = result.error.issues.map(issue => 
      `${issue.path.join('.')}: ${issue.message}`
    );
    
    return { valid: false, errors };
  }

  mergeResponses<T extends object>(responses: Partial<T>[]): Partial<T> {
    return responses.reduce((acc, response) => {
      for (const [key, value] of Object.entries(response)) {
        if (value !== undefined && value !== null) {
          (acc as Record<string, unknown>)[key] = value;
        }
      }
      return acc;
    }, {} as Partial<T>);
  }

  extractArrayFromResponse<T>(
    response: string,
    itemSchema: ZodSchema<T>,
    options: { minItems?: number; maxItems?: number } = {}
  ): T[] {
    const jsonText = this.extractJson(response);
    const cleanedJson = this.cleanJsonResponse(jsonText);
    
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanedJson);
    } catch {
      throw AppError.badRequest('Failed to parse JSON array from response');
    }
    
    let items: unknown[];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const arrayField = Object.values(obj).find(v => Array.isArray(v));
      if (arrayField) {
        items = arrayField as unknown[];
      } else {
        throw AppError.badRequest('No array found in response');
      }
    } else {
      throw AppError.badRequest('Response is not an array or object');
    }
    
    if (options.minItems !== undefined && items.length < options.minItems) {
      throw AppError.badRequest(`Expected at least ${options.minItems} items, got ${items.length}`);
    }
    
    if (options.maxItems !== undefined && items.length > options.maxItems) {
      items = items.slice(0, options.maxItems);
    }
    
    const validItems: T[] = [];
    for (const item of items) {
      const result = itemSchema.safeParse(item);
      if (result.success) {
        validItems.push(result.data);
      }
    }
    
    return validItems;
  }
}

export const responseParserService = new ResponseParserService();
