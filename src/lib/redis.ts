import Redis from 'ioredis';
import { getRedisUrl, isRedisConfigured as checkRedisConfigured } from '../config/redis.config';
import { logger } from './logger';

let redisClient: Redis | null = null;

export { checkRedisConfigured as isRedisConfigured };

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = getRedisUrl();
    
    if (!redisUrl) {
      throw new Error('Redis URL not configured');
    }

    const useTls = redisUrl.startsWith('rediss://') || redisUrl.includes('upstash');
    
    const options: Record<string, unknown> = {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 200, 1000);
      },
    };

    if (useTls) {
      options.tls = {
        rejectUnauthorized: false,
      };
    }

    let connectionUrl = redisUrl;
    if (redisUrl.startsWith('rediss://')) {
      connectionUrl = redisUrl.replace('rediss://', 'redis://');
      options.tls = {
        rejectUnauthorized: false,
      };
    }

    redisClient = new Redis(connectionUrl, options);

    redisClient.on('connect', () => {
      logger.info('📦 Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error('Redis error:', err);
    });

    redisClient.on('close', () => {
      logger.info('Redis connection closed');
    });
  }

  return redisClient;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
