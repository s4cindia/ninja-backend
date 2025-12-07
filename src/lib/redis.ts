import Redis from 'ioredis';
import { getRedisUrl } from '../config/redis.config.js';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = getRedisUrl();
    
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 200, 1000);
      },
    });

    redisClient.on('connect', () => {
      console.log('📦 Redis connected');
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
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
