/**
 * @fileoverview Centralized logging utility for the application.
 * Provides consistent log formatting with timestamps and severity levels.
 */

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
 * Application logger with standardized formatting.
 * All logs include ISO timestamps and severity levels.
 * Debug logs only appear when LOG_LEVEL=debug environment variable is set.
 */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>): void => {
    if (process.env.LOG_LEVEL === 'debug') {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      console.warn(formatMessage('debug', message + metaStr));
    }
  },
  info: (message: string, meta?: Record<string, unknown>): void => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.warn(formatMessage('info', message + metaStr));
  },
  warn: (message: string, error?: Error | Record<string, unknown>): void => {
    if (error instanceof Error) {
      console.warn(formatMessage('warn', message));
      console.warn(error.stack || error.message);
    } else if (error) {
      console.warn(formatMessage('warn', message + ` ${JSON.stringify(error)}`));
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
