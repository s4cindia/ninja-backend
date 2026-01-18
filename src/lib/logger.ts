/**
 * @fileoverview Centralized logging utility for the application.
 * Provides consistent log formatting with timestamps and severity levels.
 */

import { inspect } from 'util';

/** Available logging levels in order of severity: debug < info < warn < error */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Formats a log message with ISO timestamp and severity level.
 * @param level - The severity level of the log
 * @param message - The message to log
 * @returns Formatted log string: [timestamp] [LEVEL] message
 */
const formatMessage = (level: LogLevel, message: string): string => {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
};

/**
 * Safely converts objects to strings for logging.
 * Uses JSON.stringify first, falls back to util.inspect for circular references.
 * @param obj - Object to stringify
 * @returns String representation of the object
 */
const safeStringify = (obj: unknown): string => {
  try {
    return JSON.stringify(obj);
  } catch {
    try {
      return inspect(obj, { depth: 3, breakLength: Infinity });
    } catch {
      return '[unserializable object]';
    }
  }
};

/**
 * Application logger with standardized formatting.
 * All logs include ISO timestamps and severity levels.
 * Debug logs only appear when LOG_LEVEL=debug environment variable is set.
 */
export const logger = {
  /**
   * Logs debug-level messages. Only outputs when LOG_LEVEL=debug.
   * @param message - Debug message to log
   * @param meta - Optional metadata object to include in log
   */
  debug: (message: string, meta?: Record<string, unknown>): void => {
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
  warn: (message: string, error?: Error | Record<string, unknown>): void => {
    if (error instanceof Error) {
      console.warn(formatMessage('warn', message));
      console.warn(error.stack || error.message);
    } else if (error) {
      console.warn(formatMessage('warn', message + ` ${safeStringify(error)}`));
    } else {
      console.warn(formatMessage('warn', message));
    }
  },
  /**
   * Logs error messages with optional error stack trace.
   * @param message - Error message to log
   * @param error - Optional Error object for stack trace
   */
  error: (message: string, error?: Error): void => {
    console.error(formatMessage('error', message));
    if (error) {
      console.error(error.stack || error.message);
    }
  },
};