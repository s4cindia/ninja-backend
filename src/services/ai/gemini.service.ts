import { GoogleGenerativeAI, GenerativeModel, GenerationConfig, Content } from '@google/generative-ai';
import { ZodSchema } from 'zod';
import { aiConfig } from '../../config/ai.config';
import { AppError } from '../../utils/app-error';
import { tokenCounterService, UsageRecord } from './token-counter.service';
import { responseParserService } from './response-parser.service';

export interface GeminiResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export interface GeminiOptions {
  model?: 'flash' | 'pro';
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
}

class GeminiService {
  private client: GoogleGenerativeAI | null = null;
  private requestCount = 0;
  private lastResetTime = Date.now();

  private getClient(): GoogleGenerativeAI {
    if (!this.client) {
      if (!aiConfig.gemini.apiKey) {
        throw AppError.internal('GEMINI_API_KEY is not configured');
      }
      this.client = new GoogleGenerativeAI(aiConfig.gemini.apiKey);
    }
    return this.client;
  }

  private getModel(options: GeminiOptions = {}): GenerativeModel {
    const client = this.getClient();
    const modelName = options.model === 'pro' 
      ? aiConfig.gemini.modelPro 
      : aiConfig.gemini.model;
    
    const generationConfig: GenerationConfig = {
      temperature: options.temperature ?? aiConfig.defaults.temperature,
      topP: aiConfig.defaults.topP,
      topK: aiConfig.defaults.topK,
      maxOutputTokens: options.maxOutputTokens ?? aiConfig.defaults.maxOutputTokens,
    };

    return client.getGenerativeModel({
      model: modelName,
      generationConfig,
      systemInstruction: options.systemInstruction,
    });
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceReset = now - this.lastResetTime;
    
    if (timeSinceReset >= 60000) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }
    
    if (this.requestCount >= aiConfig.gemini.rateLimit.requestsPerMinute) {
      const waitTime = 60000 - timeSinceReset;
      console.log(`Rate limit reached. Waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.requestCount = 0;
      this.lastResetTime = Date.now();
    }
    
    this.requestCount++;
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    retries = aiConfig.gemini.maxRetries
  ): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (error instanceof Error) {
          const msg = error.message.toLowerCase();
          if (msg.includes('api key') || 
              msg.includes('api_key') ||
              msg.includes('not configured') ||
              msg.includes('invalid') ||
              msg.includes('not found') ||
              msg.includes('quota') ||
              msg.includes('exceeded')) {
            throw error;
          }
        }
        
        if (attempt < retries) {
          const delay = aiConfig.gemini.retryDelay * Math.pow(2, attempt);
          console.log(`Gemini API error, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError || new Error('Unknown error in Gemini API call');
  }

  async generateText(prompt: string, options: GeminiOptions = {}): Promise<GeminiResponse> {
    await this.checkRateLimit();
    
    return this.retryWithBackoff(async () => {
      const model = this.getModel(options);
      const result = await model.generateContent(prompt);
      const response = result.response;
      
      const text = response.text();
      const usageMetadata = response.usageMetadata;
      
      return {
        text,
        usage: usageMetadata ? {
          promptTokens: usageMetadata.promptTokenCount || 0,
          completionTokens: usageMetadata.candidatesTokenCount || 0,
          totalTokens: usageMetadata.totalTokenCount || 0,
        } : undefined,
        finishReason: response.candidates?.[0]?.finishReason,
      };
    });
  }

  async generateStructuredOutput<T>(
    prompt: string,
    options: GeminiOptions = {}
  ): Promise<{ data: T; usage?: GeminiResponse['usage'] }> {
    const jsonPrompt = `${prompt}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.`;

    const response = await this.generateText(jsonPrompt, options);
    
    try {
      const jsonText = responseParserService.extractJson(response.text);
      const cleanedJson = responseParserService.cleanJsonResponse(jsonText);
      const data = JSON.parse(cleanedJson) as T;
      return { data, usage: response.usage };
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', response.text);
      throw AppError.internal('Failed to parse AI response as JSON');
    }
  }

  async generateWithSchema<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options: GeminiOptions = {}
  ): Promise<{ data: T; usage?: GeminiResponse['usage']; attempts: number }> {
    return responseParserService.parseWithRetry(prompt, schema, options, { maxRetries: 2 });
  }

  async generateWithSchemaAndTracking<T>(
    prompt: string,
    schema: ZodSchema<T>,
    tenantId: string,
    userId: string,
    operation: string,
    options: GeminiOptions = {}
  ): Promise<{ data: T; usage?: GeminiResponse['usage']; usageRecord?: UsageRecord; attempts: number }> {
    const result = await this.generateWithSchema(prompt, schema, options);
    
    let usageRecord;
    if (result.usage) {
      const model = options.model === 'pro' ? aiConfig.gemini.modelPro : aiConfig.gemini.model;
      usageRecord = tokenCounterService.recordUsage(
        tenantId,
        userId,
        model,
        operation,
        result.usage
      );
    }
    
    return { ...result, usageRecord };
  }

  async analyzeImage(
    imageBase64: string,
    mimeType: string,
    prompt: string,
    options: GeminiOptions = {}
  ): Promise<GeminiResponse> {
    await this.checkRateLimit();
    
    return this.retryWithBackoff(async () => {
      const model = this.getModel(options);
      
      const imagePart = {
        inlineData: {
          data: imageBase64,
          mimeType,
        },
      };
      
      const result = await model.generateContent([prompt, imagePart]);
      const response = result.response;
      
      return {
        text: response.text(),
        usage: response.usageMetadata ? {
          promptTokens: response.usageMetadata.promptTokenCount || 0,
          completionTokens: response.usageMetadata.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata.totalTokenCount || 0,
        } : undefined,
        finishReason: response.candidates?.[0]?.finishReason,
      };
    });
  }

  async chat(
    messages: Array<{ role: 'user' | 'model'; content: string }>,
    options: GeminiOptions = {}
  ): Promise<GeminiResponse> {
    await this.checkRateLimit();
    
    return this.retryWithBackoff(async () => {
      const model = this.getModel(options);
      
      const history: Content[] = messages.slice(0, -1).map(msg => ({
        role: msg.role,
        parts: [{ text: msg.content }],
      }));
      
      const chat = model.startChat({ history });
      const lastMessage = messages[messages.length - 1];
      
      const result = await chat.sendMessage(lastMessage.content);
      const response = result.response;
      
      return {
        text: response.text(),
        usage: response.usageMetadata ? {
          promptTokens: response.usageMetadata.promptTokenCount || 0,
          completionTokens: response.usageMetadata.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata.totalTokenCount || 0,
        } : undefined,
        finishReason: response.candidates?.[0]?.finishReason,
      };
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.generateText('Say "OK" if you can read this.', {
        maxOutputTokens: 10,
      });
      return response.text.toLowerCase().includes('ok');
    } catch (error) {
      console.error('Gemini health check failed:', error);
      return false;
    }
  }

  async generateTextWithTracking(
    prompt: string,
    tenantId: string,
    userId: string,
    operation: string,
    options: GeminiOptions = {}
  ): Promise<GeminiResponse & { usageRecord?: UsageRecord }> {
    const response = await this.generateText(prompt, options);
    
    let usageRecord;
    if (response.usage) {
      const model = options.model === 'pro' ? aiConfig.gemini.modelPro : aiConfig.gemini.model;
      usageRecord = tokenCounterService.recordUsage(
        tenantId,
        userId,
        model,
        operation,
        response.usage
      );
    }
    
    return { ...response, usageRecord };
  }
}

export const geminiService = new GeminiService();
