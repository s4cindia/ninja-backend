/**
 * @fileoverview Centralized logging utility for the application.
 * Provides consistent log formatting with timestamps and severity levels.
 * Includes sanitization to prevent sensitive data exposure (GDPR compliance).
 */

import { inspect } from 'util';

/** Available logging levels in order of severity: debug < info < warn < error */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fields that should be redacted from logs */
const SENSITIVE_FIELDS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'sessionId',
  'ssn',
  'creditCard',
  'cardNumber',
  'cvv',
  'pin'
]);

/** Fields containing potentially large/sensitive content that should be truncated */
const CONTENT_FIELDS = new Set([
  'fullText',
  'fullHtml',
  'content',
  'body',
  'rawText',
  'text',
  'html',
  'xml',
  'documentContent',
  'manuscriptText',
  'extractedText'
]);

/** Maximum length for content fields before truncation */
const MAX_CONTENT_LENGTH = 100;

/** Maximum length for logged messages */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Sanitizes sensitive data from objects before logging
 * - Redacts sensitive fields (passwords, tokens, etc.)
 * - Truncates large content fields
 * - Masks email addresses and personal data
 */
function sanitizeData(data: unknown, depth = 0): unknown {
  if (depth > 5) return '[max depth]';

  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    // Truncate long strings
    if (data.length > MAX_CONTENT_LENGTH) {
      return `${data.substring(0, MAX_CONTENT_LENGTH)}... [truncated ${data.length} chars]`;
    }
    // Mask email addresses
    return data.replace(
      /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
      (match, local) => `${local.substring(0, 2)}***@***`
    );
  }

  if (Array.isArray(data)) {
    if (data.length > 10) {
      return `[Array of ${data.length} items]`;
    }
    return data.map(item => sanitizeData(item, depth + 1));
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();

      // Redact sensitive fields
      if (SENSITIVE_FIELDS.has(lowerKey)) {
        sanitized[key] = '[REDACTED]';
        continue;
      }

      // Truncate content fields
      if (CONTENT_FIELDS.has(key) || CONTENT_FIELDS.has(lowerKey)) {
        if (typeof value === 'string' && value.length > MAX_CONTENT_LENGTH) {
          sanitized[key] = `[content ${value.length} chars]`;
          continue;
        }
      }

      sanitized[key] = sanitizeData(value, depth + 1);
    }
    return sanitized;
  }

  return data;
}

/**
 * Sanitizes a log message to remove/truncate sensitive content
 */
function sanitizeMessage(message: string): string {
  let sanitized = message;

  // Truncate long messages
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = `${sanitized.substring(0, MAX_MESSAGE_LENGTH)}... [truncated]`;
  }

  // Mask email addresses
  sanitized = sanitized.replace(
    /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    (match, local) => `${local.substring(0, 2)}***@***`
  );

  // Mask long quoted strings that might be document content
  sanitized = sanitized.replace(
    /"([^"]{100,})"/g,
    (_match, content) => `"${content.substring(0, 50)}... [truncated]"`
  );

  return sanitized;
}

/**
 * Formats a log message with ISO timestamp and severity level.
 * @param level - The severity level of the log
 * @param message - The message to log
 * @returns Formatted log string: [timestamp] [LEVEL] message
 */
const formatMessage = (level: LogLevel, message: string): string => {
  const timestamp = new Date().toISOString();
  const sanitizedMessage = sanitizeMessage(message);
  return `[${timestamp}] [${level.toUpperCase()}] ${sanitizedMessage}`;
};

/**
 * Safely converts objects to strings for logging with sanitization.
 * Uses JSON.stringify first, falls back to util.inspect for circular references.
 * @param obj - Object to stringify
 * @returns String representation of the sanitized object
 */
const safeStringify = (obj: unknown): string => {
  const sanitized = sanitizeData(obj);
  try {
    return JSON.stringify(sanitized);
  } catch {
    try {
      return inspect(sanitized, { depth: 3, breakLength: Infinity });
    } catch {
      return '[unserializable object]';
    }
  }
};

/**
 * Check if we're in production environment
 */
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Application logger with standardized formatting and data sanitization.
 * All logs include ISO timestamps and severity levels.
 * Sensitive data is automatically redacted or truncated.
 * Debug logs are disabled in production.
 */
export const logger = {
  /**
   * Logs debug-level messages. Disabled in production.
   * Only outputs when LOG_LEVEL=debug in non-production environments.
   * @param message - Debug message to log
   * @param meta - Optional metadata object to include in log
   */
  debug: (message: string, meta?: Record<string, unknown>): void => {
    // Always disable debug logs in production for security
    if (isProduction) return;

    if (process.env.LOG_LEVEL === 'debug') {
      const metaStr = meta ? ` ${safeStringify(meta)}` : '';
      console.warn(formatMessage('debug', message + metaStr));
    }
  },

  /**
   * Logs informational messages.
   * @param message - Info message to log
   * @param meta - Optional metadata object to include in log
   */
  info: (message: string, meta?: Record<string, unknown>): void => {
    const metaStr = meta ? ` ${safeStringify(meta)}` : '';
    console.warn(formatMessage('info', message + metaStr));
  },

  /**
   * Logs warning messages.
   * @param message - Warning message to log
   * @param error - Optional Error object or metadata to include
   */
  warn: (message: string, error?: unknown): void => {
    if (error instanceof Error) {
      console.warn(formatMessage('warn', message));
      // Only log error message, not full stack in production
      if (isProduction) {
        console.warn(`Error: ${error.message}`);
      } else {
        console.warn(error.stack || error.message);
      }
    } else if (error) {
      console.warn(formatMessage('warn', message + ` ${safeStringify(error)}`));
    } else {
      console.warn(formatMessage('warn', message));
    }
  },

  /**
   * Logs error messages with optional error stack trace.
   * @param message - Error message to log
   * @param error - Optional Error object or unknown value for stack trace
   */
  error: (message: string, error?: unknown): void => {
    console.error(formatMessage('error', message));
    if (error instanceof Error) {
      // In production, only log error message not full stack
      if (isProduction) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error(error.stack || error.message);
      }
    } else if (error) {
      console.error(safeStringify(error));
    }
  },
};
