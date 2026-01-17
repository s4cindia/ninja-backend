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
  /**
   * Logs debug-level messages. Only outputs when LOG_LEVEL=debug.
   * @param message - Debug message to log
   */
  debug: (message: string): void => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.warn(formatMessage('debug', message));
    }
  },
  /**
   * Logs informational messages.
   * @param message - Info message to log
   */
  info: (message: string): void => {
    console.warn(formatMessage('info', message));
  },
  /**
   * Logs warning messages.
   * @param message - Warning message to log
   */
  warn: (message: string): void => {
    console.warn(formatMessage('warn', message));
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
