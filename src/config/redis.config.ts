import { RedisOptions } from 'ioredis';

export const redisConfig: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export function isRedisConfigured(): boolean {
  return !!(
    process.env.KV_URL || 
    process.env.REDIS_URL || 
    process.env.REDIS_HOST
  );
}

export const getRedisUrl = (): string | null => {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  if (process.env.KV_URL) {
    return process.env.KV_URL;
  }
  return null;
};
