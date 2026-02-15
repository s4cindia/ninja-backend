/**
 * Type declarations for external modules that don't have @types packages
 */

declare module 'mammoth' {
  export interface ConvertResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  export interface ExtractResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  export interface Options {
    styleMap?: string[];
    includeDefaultStyleMap?: boolean;
    convertImage?: unknown;
  }

  export function convertToHtml(input: { buffer: Buffer } | { path: string }, options?: Options): Promise<ConvertResult>;
  export function convertToMarkdown(input: { buffer: Buffer } | { path: string }, options?: Options): Promise<ConvertResult>;
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<ExtractResult>;
}

declare module '@anthropic-ai/sdk' {
  export interface MessageParam {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; source?: unknown }>;
  }

  export interface Message {
    id: string;
    type: string;
    role: string;
    content: Array<{
      type: string;
      text?: string;
    }>;
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  }

  export interface AnthropicOptions {
    apiKey?: string;
  }

  export interface MessagesCreateParams {
    model: string;
    max_tokens: number;
    messages: MessageParam[];
    system?: string;
    temperature?: number;
    top_p?: number;
    top_k?: number;
  }

  export default class Anthropic {
    constructor(options?: AnthropicOptions);
    messages: {
      create(params: MessagesCreateParams): Promise<Message>;
    };
  }
}
