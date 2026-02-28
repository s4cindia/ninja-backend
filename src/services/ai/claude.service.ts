/**
 * Claude AI Service (Anthropic API)
 * Provides AI capabilities using Claude models
 *
 * Rate Limiting:
 * Uses Redis-based distributed rate limiting for multi-instance deployments.
 * When Redis is unavailable, relies on the Anthropic SDK's built-in retry/backoff
 * mechanism for handling 429 rate limit responses.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../../utils/app-error';
import { logger } from '../../lib/logger';
import { claudeRateLimiter } from '../../utils/rate-limiter';

export interface ClaudeResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export interface ClaudeOptions {
  model?: 'haiku' | 'sonnet' | 'opus';
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

class ClaudeService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Generic error to avoid exposing API configuration details
        logger.error('[Claude Service] AI service configuration missing');
        throw AppError.internal('AI service unavailable');
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  private getModelName(options: ClaudeOptions = {}): string {
    const modelType = options.model || 'sonnet';

    // Claude models - verified against Anthropic API (2026-02-17)
    // Model IDs must match Anthropic API exactly to avoid 400/404 errors
    const models: Record<string, string> = {
      haiku: 'claude-haiku-4-5-20251001',       // Fast, cost-effective (Claude Haiku 4.5)
      sonnet: 'claude-sonnet-4-20250514',      // Balanced performance (Claude Sonnet 4)
      opus: 'claude-opus-4-5-20251101'         // Most capable (Claude Opus 4.5)
    };

    return models[modelType] || models.sonnet;
  }

  /**
   * Check rate limit using Redis-based distributed limiter
   * Falls back gracefully when Redis is unavailable
   */
  private async checkRateLimit(): Promise<void> {
    try {
      // Use Redis-based rate limiter for multi-instance safety
      // If Redis is unavailable, this will skip and let SDK handle 429s
      await claudeRateLimiter.acquire();
    } catch (error) {
      // Log but don't block - SDK will handle 429 with retry/backoff
      logger.warn('[Claude Service] Rate limit check failed, proceeding with request:', error);
    }
  }

  /**
   * Parse JSON from AI response text
   * Handles markdown code blocks, escaped strings, and embedded JSON
   */
  private parseJSONResponse(text: string): unknown {
    let jsonText = text.trim();

    // Remove markdown code blocks first
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?$/g, '').trim();
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/```\n?/g, '').trim();
    }

    // If the response is a JSON-encoded string (wrapped in quotes with escaped chars)
    if (jsonText.startsWith('"')) {
      // Remove leading quote
      jsonText = jsonText.slice(1);
      // Remove trailing quote if present
      if (jsonText.endsWith('"')) {
        jsonText = jsonText.slice(0, -1);
      }
      // Unescape the string
      jsonText = jsonText
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\');
    }

    // Try to find JSON array or object if text doesn't start with [ or {
    if (!jsonText.startsWith('[') && !jsonText.startsWith('{')) {
      const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
      const objectMatch = jsonText.match(/\{[\s\S]*\}/);

      if (arrayMatch) {
        logger.warn('[Claude Service] Found JSON array embedded in text, extracting...');
        jsonText = arrayMatch[0];
      } else if (objectMatch) {
        logger.warn('[Claude Service] Found JSON object embedded in text, extracting...');
        jsonText = objectMatch[0];
      }
    }

    return JSON.parse(jsonText);
  }

  /**
   * Generate completion with Claude
   */
  async generate(
    prompt: string,
    options: ClaudeOptions = {}
  ): Promise<ClaudeResponse> {
    await this.checkRateLimit();

    const client = this.getClient();
    const modelName = this.getModelName(options);

    try {
      logger.info(`[Claude Service] Generating with model: ${modelName}`);

      const response = await client.messages.create({
        model: modelName,
        max_tokens: options.maxTokens || 16384, // Claude Sonnet 4.5: 64K max (using 16K default)
        temperature: options.temperature ?? 0.2,
        system: options.systemPrompt || 'You are a helpful AI assistant.',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const textContent = response.content.find(block => block.type === 'text');
      const text: string = textContent && textContent.type === 'text' && textContent.text ? textContent.text : '';

      const usage = response.usage;

      logger.info(`[Claude Service] Success - Tokens: ${usage.input_tokens + usage.output_tokens}`);

      return {
        text,
        usage: {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens
        },
        finishReason: response.stop_reason || 'end_turn'
      };
    } catch (error: unknown) {
      // Log detailed error information for debugging
      const errorDetails = {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        status: (error as { status?: number }).status,
        code: (error as { code?: string }).code,
        cause: (error as { cause?: unknown }).cause
      };
      logger.error('[Claude Service] Generation failed:', errorDetails);

      const apiError = error as { status?: number; message?: string; code?: string };

      if (apiError.status === 429) {
        throw AppError.tooManyRequests('Claude API rate limit exceeded');
      }

      if (apiError.status === 401) {
        throw AppError.internal('Invalid Claude API key - check ANTHROPIC_API_KEY');
      }

      if (apiError.status === 403) {
        throw AppError.internal('Claude API access forbidden - check API key permissions');
      }

      // Network/connection errors
      if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ENOTFOUND') {
        throw AppError.internal('Cannot reach Claude API - check network connectivity');
      }

      if (apiError.code === 'ETIMEDOUT' || apiError.code === 'ESOCKETTIMEDOUT') {
        throw AppError.internal('Claude API connection timed out');
      }

      // Check for connection error pattern (common with invalid keys or network issues)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('Connection error') || errorMessage.includes('connect')) {
        // Log API key presence (not the actual key) for debugging
        const keyPresent = !!process.env.ANTHROPIC_API_KEY;
        const keyPrefix = keyPresent ? process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...' : 'NOT SET';
        logger.error(`[Claude Service] Connection error - API key present: ${keyPresent}, prefix: ${keyPrefix}`);
        throw AppError.internal('Claude API connection error - verify API key format and network access');
      }

      throw AppError.internal(`Claude API error: ${errorMessage}`);
    }
  }

  /**
   * Generate JSON response with Claude
   */
  async generateJSON<T = unknown>(
    prompt: string,
    options: ClaudeOptions = {}
  ): Promise<T> {
    const response = await this.generate(prompt, {
      ...options,
      systemPrompt: options.systemPrompt || 'You are a helpful AI assistant. Always respond with valid JSON only, no markdown or explanations.'
    });

    try {
      return this.parseJSONResponse(response.text) as T;
    } catch (error) {
      const preview = response.text.substring(0, 500);
      logger.error('[Claude Service] Failed to parse JSON. Response preview:', preview);
      logger.error('[Claude Service] Parse error:', error);
      throw AppError.internal('Failed to parse Claude response as JSON');
    }
  }

  /**
   * Generate JSON response with usage tracking
   * Returns both the parsed JSON and token usage for cost tracking
   */
  async generateJSONWithUsage<T = unknown>(
    prompt: string,
    options: ClaudeOptions = {}
  ): Promise<{ data: T; usage: ClaudeResponse['usage'] }> {
    const response = await this.generate(prompt, {
      ...options,
      systemPrompt: options.systemPrompt || 'You are a helpful AI assistant. Always respond with valid JSON only, no markdown or explanations.'
    });

    try {
      return {
        data: this.parseJSONResponse(response.text) as T,
        usage: response.usage
      };
    } catch (parseError) {
      const preview = response.text.substring(0, 500);
      logger.error('[Claude Service] Failed to parse JSON. Response preview:', preview);
      logger.error('[Claude Service] Parse error:', parseError);
      throw AppError.internal('Failed to parse Claude response as JSON');
    }
  }

  /**
   * Check if Claude service is available
   */
  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Validate API key format
   * Anthropic API keys should start with 'sk-ant-'
   */
  validateApiKey(): { valid: boolean; error?: string } {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return { valid: false, error: 'ANTHROPIC_API_KEY not set' };
    }

    // Check for common issues
    const trimmedKey = apiKey.trim();
    if (trimmedKey !== apiKey) {
      logger.warn('[Claude Service] API key has leading/trailing whitespace');
    }

    // Check for JSON wrapper (common Secrets Manager mistake)
    if (trimmedKey.startsWith('{') || trimmedKey.startsWith('"')) {
      return { valid: false, error: 'API key appears to be JSON-wrapped - use plain text value' };
    }

    // Check for expected prefix
    if (!trimmedKey.startsWith('sk-ant-')) {
      return { valid: false, error: 'API key should start with sk-ant-' };
    }

    // Check minimum length (Anthropic keys are typically 100+ chars)
    if (trimmedKey.length < 50) {
      return { valid: false, error: 'API key appears too short' };
    }

    return { valid: true };
  }

  /**
   * Health check - validate configuration and test API connection
   */
  async healthCheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    const details: Record<string, unknown> = {
      apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
      apiKeyValidation: this.validateApiKey()
    };

    if (!details.apiKeyPresent || !(details.apiKeyValidation as { valid: boolean }).valid) {
      return { healthy: false, details };
    }

    try {
      // Make a minimal API call to verify connection
      const response = await this.generate('Say "OK" and nothing else.', {
        model: 'haiku',
        maxTokens: 10,
        temperature: 0
      });
      details.testResponse = response.text.substring(0, 50);
      details.tokensUsed = response.usage?.totalTokens;
      return { healthy: true, details };
    } catch (error) {
      details.connectionError = error instanceof Error ? error.message : String(error);
      return { healthy: false, details };
    }
  }
}

export const claudeService = new ClaudeService();
