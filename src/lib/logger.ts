import { inspect } from 'util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const formatMessage = (level: LogLevel, message: string): string => {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
};

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

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>): void => {
    if (process.env.LOG_LEVEL === 'debug') {
      const metaStr = meta ? ` ${safeStringify(meta)}` : '';
      console.warn(formatMessage('debug', message + metaStr));
    }
  },
  info: (message: string, meta?: Record<string, unknown>): void => {
    const metaStr = meta ? ` ${safeStringify(meta)}` : '';
    console.warn(formatMessage('info', message + metaStr));
  },
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
  error: (message: string, error?: Error): void => {
    console.error(formatMessage('error', message));
    if (error) {
      console.error(error.stack || error.message);
    }
  },
};
