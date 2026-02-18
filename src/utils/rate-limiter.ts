/**
 * Rate Limiter Utility
 *
 * Provides rate limiting for external API calls using token bucket algorithm.
 * Supports per-tenant limits and global limits.
 *
 * For multi-instance deployments (ECS Fargate, Kubernetes), use RedisRateLimiter
 * which provides distributed rate limiting via Redis.
 */

import { logger } from '../lib/logger';
import type { Redis } from 'ioredis';

export interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Name for logging */
  name: string;
  /** Whether to throw on rate limit (default: false - waits instead) */
  throwOnLimit?: boolean;
}

export interface TenantUsageConfig {
  /** Maximum AI tokens per tenant per day */
  maxTokensPerDay: number;
  /** Maximum API calls per tenant per hour */
  maxCallsPerHour: number;
}

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

interface TenantUsage {
  tokensUsed: number;
  callsThisHour: number;
  lastHourReset: number;
  lastDayReset: number;
}

/**
 * Token bucket rate limiter for API calls
 */
export class RateLimiter {
  private bucket: RateLimitBucket;
  private config: Required<RateLimiterConfig>;

  constructor(config: RateLimiterConfig) {
    this.config = {
      ...config,
      throwOnLimit: config.throwOnLimit ?? false,
    };
    this.bucket = {
      tokens: config.maxRequests,
      lastRefill: Date.now(),
    };
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.bucket.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.config.windowMs) * this.config.maxRequests);

    if (tokensToAdd > 0) {
      this.bucket.tokens = Math.min(this.config.maxRequests, this.bucket.tokens + tokensToAdd);
      this.bucket.lastRefill = now;
    }
  }

  /**
   * Check if request can proceed, wait if necessary
   */
  async acquire(): Promise<void> {
    this.refillTokens();

    if (this.bucket.tokens > 0) {
      this.bucket.tokens--;
      return;
    }

    // Calculate wait time for next token
    const waitTime = Math.ceil(this.config.windowMs / this.config.maxRequests);

    if (this.config.throwOnLimit) {
      throw new RateLimitError(
        `${this.config.name} rate limit exceeded. Try again in ${waitTime}ms.`,
        waitTime
      );
    }

    logger.warn(`[${this.config.name}] Rate limit reached, waiting ${waitTime}ms...`);
    await this.delay(waitTime);

    // Refill and acquire after waiting
    this.refillTokens();
    this.bucket.tokens--;
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return this.bucket.tokens;
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.bucket = {
      tokens: this.config.maxRequests,
      lastRefill: Date.now(),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Per-tenant usage tracker for AI and API usage (in-process)
 *
 * WARNING: This is NOT safe for multi-instance deployments (ECS Fargate, Kubernetes).
 * Use RedisTenantUsageTracker for distributed environments.
 *
 * @deprecated Use RedisTenantUsageTracker for production multi-instance deployments
 */
export class TenantUsageTracker {
  private usage: Map<string, TenantUsage> = new Map();
  private config: TenantUsageConfig;
  private name: string;

  constructor(name: string, config: TenantUsageConfig) {
    this.name = name;
    this.config = config;
    logger.warn(`[${name}] Using in-process TenantUsageTracker - not safe for multi-instance deployments`);
  }

  /**
   * Get or create usage record for tenant
   */
  private getUsage(tenantId: string): TenantUsage {
    const now = Date.now();
    let usage = this.usage.get(tenantId);

    if (!usage) {
      usage = {
        tokensUsed: 0,
        callsThisHour: 0,
        lastHourReset: now,
        lastDayReset: now,
      };
      this.usage.set(tenantId, usage);
    }

    // Reset hourly counter if needed
    if (now - usage.lastHourReset >= 60 * 60 * 1000) {
      usage.callsThisHour = 0;
      usage.lastHourReset = now;
    }

    // Reset daily counter if needed
    if (now - usage.lastDayReset >= 24 * 60 * 60 * 1000) {
      usage.tokensUsed = 0;
      usage.lastDayReset = now;
    }

    return usage;
  }

  /**
   * Check if tenant can make an API call
   */
  canMakeCall(tenantId: string): { allowed: boolean; reason?: string; retryAfter?: number } {
    const usage = this.getUsage(tenantId);

    if (usage.callsThisHour >= this.config.maxCallsPerHour) {
      const retryAfter = Math.ceil((60 * 60 * 1000 - (Date.now() - usage.lastHourReset)) / 1000);
      return {
        allowed: false,
        reason: `Hourly API call limit (${this.config.maxCallsPerHour}) exceeded`,
        retryAfter,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if tenant can use tokens
   */
  canUseTokens(tenantId: string, tokens: number): { allowed: boolean; reason?: string; retryAfter?: number } {
    const usage = this.getUsage(tenantId);

    if (usage.tokensUsed + tokens > this.config.maxTokensPerDay) {
      const retryAfter = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - usage.lastDayReset)) / 1000);
      return {
        allowed: false,
        reason: `Daily token limit (${this.config.maxTokensPerDay}) exceeded`,
        retryAfter,
      };
    }

    return { allowed: true };
  }

  /**
   * Record an API call for tenant
   */
  recordCall(tenantId: string): void {
    const usage = this.getUsage(tenantId);
    usage.callsThisHour++;
    logger.debug(`[${this.name}] Tenant ${tenantId} calls this hour: ${usage.callsThisHour}/${this.config.maxCallsPerHour}`);
  }

  /**
   * Record token usage for tenant
   */
  recordTokens(tenantId: string, tokens: number): void {
    const usage = this.getUsage(tenantId);
    usage.tokensUsed += tokens;
    logger.debug(`[${this.name}] Tenant ${tenantId} tokens today: ${usage.tokensUsed}/${this.config.maxTokensPerDay}`);
  }

  /**
   * Get usage statistics for tenant
   */
  getStats(tenantId: string): {
    callsThisHour: number;
    maxCallsPerHour: number;
    tokensUsedToday: number;
    maxTokensPerDay: number;
  } {
    const usage = this.getUsage(tenantId);
    return {
      callsThisHour: usage.callsThisHour,
      maxCallsPerHour: this.config.maxCallsPerHour,
      tokensUsedToday: usage.tokensUsed,
      maxTokensPerDay: this.config.maxTokensPerDay,
    };
  }

  /**
   * Reset usage for a specific tenant (for testing)
   */
  resetTenant(tenantId: string): void {
    this.usage.delete(tenantId);
  }

  /**
   * Clear all usage data (for testing)
   */
  clearAll(): void {
    this.usage.clear();
  }
}

/**
 * Redis-based per-tenant usage tracker for multi-instance deployments
 *
 * Safe for ECS Fargate, Kubernetes, and other multi-instance environments.
 * Falls back gracefully when Redis is unavailable.
 */
export class RedisTenantUsageTracker {
  private redis: Redis | null = null;
  private config: TenantUsageConfig;
  private name: string;
  private keyPrefix: string;
  private initPromise: Promise<void> | null = null;

  constructor(name: string, config: TenantUsageConfig) {
    this.name = name;
    this.config = config;
    this.keyPrefix = `tenant-usage:${name}`;
  }

  /**
   * Lazy initialization of Redis client
   */
  private async ensureRedis(): Promise<Redis | null> {
    if (this.initPromise) {
      await this.initPromise;
      return this.redis;
    }

    this.initPromise = (async () => {
      try {
        const { isRedisConfigured } = await import('../config/redis.config');
        if (!isRedisConfigured()) {
          logger.debug(`[${this.name}] Redis not configured, tenant usage tracking disabled`);
          return;
        }

        const { getRedisClient } = await import('../lib/redis');
        this.redis = getRedisClient();
        logger.info(`[${this.name}] Redis tenant usage tracker initialized`);
      } catch (error) {
        logger.warn(`[${this.name}] Failed to initialize Redis tenant usage tracker:`, error);
        this.redis = null;
      }
    })();

    await this.initPromise;
    return this.redis;
  }

  /**
   * Get Redis key for hourly call count
   */
  private getHourlyKey(tenantId: string): string {
    const hour = Math.floor(Date.now() / (60 * 60 * 1000));
    return `${this.keyPrefix}:${tenantId}:calls:${hour}`;
  }

  /**
   * Get Redis key for daily token count
   */
  private getDailyKey(tenantId: string): string {
    const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    return `${this.keyPrefix}:${tenantId}:tokens:${day}`;
  }

  /**
   * Check if tenant can make an API call
   */
  async canMakeCall(tenantId: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    const redis = await this.ensureRedis();

    if (!redis) {
      // Redis not available - allow (fail open)
      return { allowed: true };
    }

    try {
      const key = this.getHourlyKey(tenantId);
      const count = await redis.get(key);
      const currentCalls = count ? parseInt(count, 10) : 0;

      if (currentCalls >= this.config.maxCallsPerHour) {
        const ttl = await redis.ttl(key);
        return {
          allowed: false,
          reason: `Hourly API call limit (${this.config.maxCallsPerHour}) exceeded`,
          retryAfter: ttl > 0 ? ttl : 3600,
        };
      }

      return { allowed: true };
    } catch (error) {
      logger.error(`[${this.name}] Redis canMakeCall check failed:`, error);
      return { allowed: true }; // Fail open
    }
  }

  /**
   * Check if tenant can use tokens
   */
  async canUseTokens(tenantId: string, tokens: number): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    const redis = await this.ensureRedis();

    if (!redis) {
      return { allowed: true };
    }

    try {
      const key = this.getDailyKey(tenantId);
      const count = await redis.get(key);
      const currentTokens = count ? parseInt(count, 10) : 0;

      if (currentTokens + tokens > this.config.maxTokensPerDay) {
        const ttl = await redis.ttl(key);
        return {
          allowed: false,
          reason: `Daily token limit (${this.config.maxTokensPerDay}) exceeded`,
          retryAfter: ttl > 0 ? ttl : 86400,
        };
      }

      return { allowed: true };
    } catch (error) {
      logger.error(`[${this.name}] Redis canUseTokens check failed:`, error);
      return { allowed: true };
    }
  }

  /**
   * Record an API call for tenant
   */
  async recordCall(tenantId: string): Promise<void> {
    const redis = await this.ensureRedis();

    if (!redis) {
      return;
    }

    try {
      const key = this.getHourlyKey(tenantId);
      const multi = redis.multi();
      multi.incr(key);
      multi.expire(key, 3600); // Expire after 1 hour
      await multi.exec();
      logger.debug(`[${this.name}] Recorded call for tenant ${tenantId}`);
    } catch (error) {
      logger.error(`[${this.name}] Redis recordCall failed:`, error);
    }
  }

  /**
   * Record token usage for tenant
   */
  async recordTokens(tenantId: string, tokens: number): Promise<void> {
    const redis = await this.ensureRedis();

    if (!redis) {
      return;
    }

    try {
      const key = this.getDailyKey(tenantId);
      const multi = redis.multi();
      multi.incrby(key, tokens);
      multi.expire(key, 86400); // Expire after 24 hours
      await multi.exec();
      logger.debug(`[${this.name}] Recorded ${tokens} tokens for tenant ${tenantId}`);
    } catch (error) {
      logger.error(`[${this.name}] Redis recordTokens failed:`, error);
    }
  }

  /**
   * Get usage statistics for tenant
   */
  async getStats(tenantId: string): Promise<{
    callsThisHour: number;
    maxCallsPerHour: number;
    tokensUsedToday: number;
    maxTokensPerDay: number;
  }> {
    const redis = await this.ensureRedis();

    if (!redis) {
      return {
        callsThisHour: 0,
        maxCallsPerHour: this.config.maxCallsPerHour,
        tokensUsedToday: 0,
        maxTokensPerDay: this.config.maxTokensPerDay,
      };
    }

    try {
      const [calls, tokens] = await Promise.all([
        redis.get(this.getHourlyKey(tenantId)),
        redis.get(this.getDailyKey(tenantId)),
      ]);

      return {
        callsThisHour: calls ? parseInt(calls, 10) : 0,
        maxCallsPerHour: this.config.maxCallsPerHour,
        tokensUsedToday: tokens ? parseInt(tokens, 10) : 0,
        maxTokensPerDay: this.config.maxTokensPerDay,
      };
    } catch (error) {
      logger.error(`[${this.name}] Redis getStats failed:`, error);
      return {
        callsThisHour: 0,
        maxCallsPerHour: this.config.maxCallsPerHour,
        tokensUsedToday: 0,
        maxTokensPerDay: this.config.maxTokensPerDay,
      };
    }
  }

  /**
   * Check if Redis is available
   */
  async isAvailable(): Promise<boolean> {
    const redis = await this.ensureRedis();
    return redis !== null;
  }
}

/**
 * Rate limit error with retry information
 */
export class RateLimitError extends Error {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Redis-based distributed rate limiter for multi-instance deployments
 * Uses sliding window counter pattern with atomic Redis operations
 *
 * Safe for ECS Fargate, Kubernetes, and other multi-instance environments
 * where each container needs to share rate limit state.
 */
export class RedisRateLimiter {
  private redis: Redis | null = null;
  private config: Required<RateLimiterConfig>;
  private keyPrefix: string;
  private initPromise: Promise<void> | null = null;

  constructor(config: RateLimiterConfig) {
    this.config = {
      ...config,
      throwOnLimit: config.throwOnLimit ?? false,
    };
    this.keyPrefix = `ratelimit:${config.name}`;
  }

  /**
   * Lazy initialization of Redis client
   * Only loads Redis when actually needed to avoid startup failures
   */
  private async ensureRedis(): Promise<Redis | null> {
    if (this.initPromise) {
      await this.initPromise;
      return this.redis;
    }

    this.initPromise = (async () => {
      try {
        const { isRedisConfigured } = await import('../config/redis.config');
        if (!isRedisConfigured()) {
          logger.debug(`[${this.config.name}] Redis not configured, rate limiting disabled`);
          return;
        }

        const { getRedisClient } = await import('../lib/redis');
        this.redis = getRedisClient();
        logger.info(`[${this.config.name}] Redis rate limiter initialized`);
      } catch (error) {
        logger.warn(`[${this.config.name}] Failed to initialize Redis rate limiter:`, error);
        this.redis = null;
      }
    })();

    await this.initPromise;
    return this.redis;
  }

  /**
   * Check if request can proceed using Redis atomic operations
   * Uses INCR + EXPIRE for sliding window rate limiting
   */
  async acquire(): Promise<void> {
    const redis = await this.ensureRedis();

    if (!redis) {
      // Redis not available - skip rate limiting
      // The Anthropic SDK will handle 429 responses with retry/backoff
      logger.debug(`[${this.config.name}] Redis unavailable, skipping rate limit check`);
      return;
    }

    const now = Date.now();
    const windowKey = `${this.keyPrefix}:${Math.floor(now / this.config.windowMs)}`;

    try {
      // Atomic increment with expiry
      const multi = redis.multi();
      multi.incr(windowKey);
      multi.pexpire(windowKey, this.config.windowMs * 2); // 2x window for safety
      const results = await multi.exec();

      if (!results || results.length === 0) {
        logger.warn(`[${this.config.name}] Redis multi exec returned empty results`);
        return;
      }

      const [incrResult] = results;
      const currentCount = incrResult && incrResult[1] ? Number(incrResult[1]) : 0;

      if (currentCount > this.config.maxRequests) {
        const waitTime = this.config.windowMs - (now % this.config.windowMs);

        if (this.config.throwOnLimit) {
          throw new RateLimitError(
            `${this.config.name} rate limit exceeded (${currentCount}/${this.config.maxRequests}). Try again in ${waitTime}ms.`,
            waitTime
          );
        }

        logger.warn(`[${this.config.name}] Rate limit reached (${currentCount}/${this.config.maxRequests}), waiting ${waitTime}ms...`);
        await this.delay(waitTime);
      }
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }
      // Redis error - fail open (allow request)
      logger.error(`[${this.config.name}] Redis rate limit check failed:`, error);
    }
  }

  /**
   * Get current request count in the window
   */
  async getCurrentCount(): Promise<number> {
    const redis = await this.ensureRedis();
    if (!redis) return 0;

    const now = Date.now();
    const windowKey = `${this.keyPrefix}:${Math.floor(now / this.config.windowMs)}`;

    try {
      const count = await redis.get(windowKey);
      return count ? parseInt(count, 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if Redis is available for rate limiting
   */
  async isAvailable(): Promise<boolean> {
    const redis = await this.ensureRedis();
    return redis !== null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Pre-configured rate limiters for services
// ============================================

/**
 * CrossRef API rate limiter
 * CrossRef recommends max 50 requests per second for polite use
 * We use a conservative 30 req/sec to stay well within limits
 */
export const crossRefRateLimiter = new RateLimiter({
  name: 'CrossRef',
  maxRequests: 30,
  windowMs: 1000, // 30 requests per second
  throwOnLimit: false, // Wait instead of throwing
});

/**
 * DOI.org rate limiter (more conservative)
 */
export const doiOrgRateLimiter = new RateLimiter({
  name: 'DOI.org',
  maxRequests: 10,
  windowMs: 1000, // 10 requests per second
  throwOnLimit: false,
});

/**
 * Per-tenant AI usage tracker (Redis-based for multi-instance safety)
 * Limits: 1M tokens/day, 1000 calls/hour
 *
 * Safe for ECS Fargate, Kubernetes, and other multi-instance deployments.
 * Falls back gracefully when Redis is unavailable.
 */
export const tenantAIUsageTracker = new RedisTenantUsageTracker('AI-Usage', {
  maxTokensPerDay: 1_000_000,
  maxCallsPerHour: 1000,
});

/**
 * Per-tenant citation API usage tracker (Redis-based for multi-instance safety)
 * Limits: 500 DOI validations/hour, 10000 "tokens" (operations) per day
 *
 * Safe for ECS Fargate, Kubernetes, and other multi-instance deployments.
 * Falls back gracefully when Redis is unavailable.
 */
export const tenantCitationUsageTracker = new RedisTenantUsageTracker('Citation-Usage', {
  maxTokensPerDay: 10000, // Operations per day
  maxCallsPerHour: 500, // DOI validations per hour
});

/**
 * Claude API rate limiter (Redis-based for multi-instance safety)
 * Anthropic rate limits vary by tier; using conservative 50 req/min
 *
 * This is safe for multi-instance deployments (ECS Fargate, Kubernetes)
 * where in-process counters would allow N × limit requests.
 */
export const claudeRateLimiter = new RedisRateLimiter({
  name: 'Claude',
  maxRequests: 50,
  windowMs: 60000, // 50 requests per minute
  throwOnLimit: false, // Wait instead of throwing - let SDK handle 429
});

/**
 * Gemini API rate limiter (Redis-based for multi-instance safety)
 * Google Gemini: 60 req/min, 1M tokens/min for most models
 */
export const geminiRateLimiter = new RedisRateLimiter({
  name: 'Gemini',
  maxRequests: 60,
  windowMs: 60000, // 60 requests per minute
  throwOnLimit: false,
});
