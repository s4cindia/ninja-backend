/**
 * Claude AI Service (Anthropic API)
 * Provides AI capabilities using Claude models
 */

import Anthropic from '@anthropic-ai/sdk';
import { aiConfig as _aiConfig } from '../../config/ai.config';
import { AppError } from '../../utils/app-error';
import { logger } from '../../lib/logger';

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
  private requestCount = 0;
  private lastResetTime = Date.now();

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw AppError.internal('ANTHROPIC_API_KEY is not configured');
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  private getModelName(options: ClaudeOptions = {}): string {
    const modelType = options.model || 'sonnet';

    // Claude models - use latest aliases for automatic updates
    const models = {
      haiku: 'claude-3-5-haiku-latest',        // Fast, cost-effective
      sonnet: 'claude-sonnet-4-20250514',      // Balanced performance (Claude Sonnet 4)
      opus: 'claude-opus-4-5-20251101'         // Most capable (Claude Opus 4.5)
    };

    return models[modelType] || models.sonnet;
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceReset = now - this.lastResetTime;

    // Reset counter every minute
    if (timeSinceReset >= 60000) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }

    // Anthropic rate limits vary by tier, using conservative limit
    const rateLimit = 50; // requests per minute

    if (this.requestCount >= rateLimit) {
      const waitTime = 60000 - timeSinceReset;
      logger.warn(`[Claude Service] Rate limit reached. Waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.requestCount = 0;
      this.lastResetTime = Date.now();
    }

    this.requestCount++;
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
      const text = textContent && textContent.type === 'text' ? textContent.text : '';

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
    } catch (error: any) {
      logger.error('[Claude Service] Generation failed:', error);

      if (error.status === 429) {
        throw AppError.tooManyRequests('Claude API rate limit exceeded');
      }

      if (error.status === 401) {
        throw AppError.internal('Invalid Claude API key');
      }

      throw AppError.internal(`Claude API error: ${error.message}`);
    }
  }

  /**
   * Generate JSON response with Claude
   */
  async generateJSON<T = any>(
    prompt: string,
    options: ClaudeOptions = {}
  ): Promise<T> {
    const response = await this.generate(prompt, {
      ...options,
      systemPrompt: options.systemPrompt || 'You are a helpful AI assistant. Always respond with valid JSON only, no markdown or explanations.'
    });

    try {
      let jsonText = response.text.trim();

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
    } catch (error) {
      const preview = response.text.substring(0, 500);
      logger.error('[Claude Service] Failed to parse JSON. Response preview:', preview);
      logger.error('[Claude Service] Parse error:', error);
      throw AppError.internal('Failed to parse Claude response as JSON');
    }
  }

  /**
   * Check if Claude service is available
   */
  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }
}

export const claudeService = new ClaudeService();
