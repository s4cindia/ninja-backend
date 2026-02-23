/**
 * Rate Limiting Middleware
 *
 * Provides per-tenant rate limiting for expensive operations like AI validation.
 * Uses Redis for multi-instance deployments, falls back to in-memory for development.
 */

import { Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import { getRedisClient, isRedisConfigured } from '../lib/redis';
import type { AuthenticatedRequest } from '../types/authenticated-request';

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  message?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory store for development/fallback when Redis is not available
 */
const inMemoryStore = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically (only for in-memory store)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryStore.entries()) {
    if (entry.resetAt < now) {
      inMemoryStore.delete(key);
    }
  }
}, 60000); // Cleanup every minute

/**
 * Check and increment rate limit using Redis
 * Returns { allowed: boolean, count: number, resetAt: number }
 */
async function checkRateLimitRedis(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; count: number; resetAt: number }> {
  const redis = getRedisClient();
  const redisKey = `ratelimit:${key}`;
  const now = Date.now();
  const windowSecs = Math.ceil(windowMs / 1000);

  try {
    // Use Redis MULTI for atomic operations
    const pipeline = redis.multi();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);
    const results = await pipeline.exec();

    if (!results) {
      throw new Error('Redis pipeline returned null');
    }

    const count = results[0]?.[1] as number;
    const ttl = results[1]?.[1] as number;

    // If this is a new key (ttl === -1), set expiration
    if (ttl === -1) {
      await redis.expire(redisKey, windowSecs);
    }

    const resetAt = ttl > 0 ? now + ttl : now + windowMs;

    return {
      allowed: count <= maxRequests,
      count,
      resetAt,
    };
  } catch (error) {
    logger.error('[RateLimit] Redis error, falling back to in-memory:', error);
    // Fall back to in-memory on Redis error
    return checkRateLimitInMemory(key, maxRequests, windowMs);
  }
}

/**
 * Check and increment rate limit using in-memory store
 */
function checkRateLimitInMemory(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; count: number; resetAt: number } {
  const now = Date.now();
  let entry = inMemoryStore.get(key);

  if (!entry || entry.resetAt < now) {
    // Create new window
    entry = {
      count: 1,
      resetAt: now + windowMs,
    };
    inMemoryStore.set(key, entry);
    return { allowed: true, count: 1, resetAt: entry.resetAt };
  }

  entry.count++;
  return {
    allowed: entry.count <= maxRequests,
    count: entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * Creates a rate limiting middleware for authenticated requests
 */
export function rateLimit(config: RateLimitConfig) {
  const { windowMs, maxRequests, message = 'Too many requests, please try again later' } = config;
  const useRedis = isRedisConfigured();

  if (useRedis) {
    logger.info('[RateLimit] Using Redis-backed rate limiting');
  } else {
    logger.warn('[RateLimit] Redis not configured, using in-memory rate limiting (not suitable for multi-instance)');
  }

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      // No tenant ID means not authenticated - let auth middleware handle it
      return next();
    }

    // Use route pattern instead of full path to prevent bypass via varying resource IDs
    const routePath = req.route?.path ?? req.path;
    const key = `${tenantId}:${req.baseUrl}${routePath}`;

    try {
      const result = useRedis
        ? await checkRateLimitRedis(key, maxRequests, windowMs)
        : checkRateLimitInMemory(key, maxRequests, windowMs);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - result.count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);

        logger.warn(`[RateLimit] Tenant ${tenantId} exceeded rate limit on ${req.path}`);

        res.setHeader('Retry-After', retryAfter);

        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message,
            retryAfter,
          },
        });
      }

      return next();
    } catch (error) {
      // On any error, allow the request but log the issue
      logger.error('[RateLimit] Error checking rate limit:', error);
      return next();
    }
  };
}

/**
 * Pre-configured rate limiters for common use cases
 */
export const rateLimiters = {
  // Style validation with AI: 10 requests per minute per tenant
  styleValidation: rateLimit({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    message: 'Style validation rate limit exceeded. Maximum 10 validations per minute.',
  }),

  // Style guide upload: 5 uploads per minute per tenant
  styleGuideUpload: rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 5,
    message: 'Style guide upload rate limit exceeded. Maximum 5 uploads per minute.',
  }),

  // General API: 100 requests per minute per tenant
  general: rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'API rate limit exceeded. Please slow down your requests.',
  }),
};
