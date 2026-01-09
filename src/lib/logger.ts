type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const formatMessage = (level: LogLevel, message: string): string => {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
};

export const logger = {
  debug: (message: string): void => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.warn(formatMessage('debug', message));
    }
  },
  info: (message: string): void => {
    console.warn(formatMessage('info', message));
  },
  warn: (message: string): void => {
    console.warn(formatMessage('warn', message));
  },
  error: (message: string, error?: Error): void => {
    console.error(formatMessage('error', message));
    if (error) {
      console.error(error.stack || error.message);
    }
  },
};
