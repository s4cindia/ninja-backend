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
    const maxRetries = parseOptions.maxRetries ?? 2;
    let lastError: Error | undefined;
    let totalUsage: GeminiResponse['usage'] | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const currentPrompt = attempt === 0 
          ? prompt 
          : this.buildCorrectionPrompt(prompt, lastError?.message || 'Invalid response', parseOptions.correctionPrompt);
        
        const response = await geminiService.generateText(currentPrompt, options);
        
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

  fixCommonJsonIssues(json: string): string {
    let fixed = json;
    
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
    
    fixed = fixed.replace(/\/\/.*$/gm, '');
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
    
    fixed = fixed.replace(/(['"])?([a-zA-Z_][a-zA-Z0-9_]*)\1?\s*:/g, '"$2":');
    
    fixed = fixed.replace(/:(\s*)'([^']*)'/g, ':$1"$2"');
    
    fixed = fixed.replace(/,(\s*),/g, ',$1');
    
    fixed = fixed.replace(/:\s*undefined\b/g, ': null');
    fixed = fixed.replace(/:\s*NaN\b/g, ': null');
    
    return fixed;
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
