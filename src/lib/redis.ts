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
      connectTimeout: 10_000,
      // Real incident (2026-10-17): with maxRetriesPerRequest: null, a command
      // issued while this client is mid-reconnect just queues forever waiting
      // for the connection to come back -- no error, no rejection, nothing. A
      // Gemini-audit alt-text call hung for 14+ minutes because of exactly
      // this, inside geminiRateLimiter's redis.multi().exec(), with no
      // downstream timeout able to catch it since the promise never settled.
      // commandTimeout bounds every command on THIS client (not the separate
      // BullMQ connection in queues/index.ts, which legitimately needs
      // maxRetriesPerRequest: null for its blocking commands) so a stuck
      // reconnect rejects instead of hanging -- callers' existing
      // try/catch-and-fail-open logic (e.g. RedisRateLimiter.acquire,
      // checkRateLimit) can then actually run.
      commandTimeout: 10_000,
      keepAlive: 30_000,
      retryStrategy: (times: number) => {
        if (times > 20) {
          console.error('Redis connection failed after 20 retries — giving up');
          return null;
        }
        const jitter = Math.floor(Math.random() * 500);
        return Math.min(times * 500, 10_000) + jitter;
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
