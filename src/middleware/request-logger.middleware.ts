import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

function scrubSensitiveParams(url: string): string {
  return url.replace(/([?&])token=[^&]*/gi, '$1token=[REDACTED]');
}

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const sanitizedUrl = scrubSensitiveParams(req.originalUrl);
    const message = `${req.method} ${sanitizedUrl} ${res.statusCode} - ${duration}ms`;
    if (res.statusCode >= 500) {
      logger.error(message);
    } else if (res.statusCode >= 400) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  });
  
  next();
};
