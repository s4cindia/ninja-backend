/**
 * Rate Limiter Utility
 *
 * Provides rate limiting for external API calls using token bucket algorithm.
 * Supports per-tenant limits and global limits.
 */

import { logger } from '../lib/logger';

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
 * Per-tenant usage tracker for AI and API usage
 */
export class TenantUsageTracker {
  private usage: Map<string, TenantUsage> = new Map();
  private config: TenantUsageConfig;
  private name: string;

  constructor(name: string, config: TenantUsageConfig) {
    this.name = name;
    this.config = config;
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
 * Per-tenant AI usage tracker
 * Limits: 1M tokens/day, 1000 calls/hour
 */
export const tenantAIUsageTracker = new TenantUsageTracker('AI-Usage', {
  maxTokensPerDay: 1_000_000,
  maxCallsPerHour: 1000,
});

/**
 * Per-tenant citation API usage tracker
 * Limits: 500 DOI validations/hour, 10000 "tokens" (operations) per day
 */
export const tenantCitationUsageTracker = new TenantUsageTracker('Citation-Usage', {
  maxTokensPerDay: 10000, // Operations per day
  maxCallsPerHour: 500, // DOI validations per hour
});
