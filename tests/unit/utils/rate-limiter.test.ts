/**
 * Rate Limiter Utility Tests
 *
 * Tests for token bucket rate limiter and tenant usage tracker
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  RedisTenantUsageTracker,
  RedisRateLimiter,
  RateLimitError,
} from '../../../src/utils/rate-limiter';

vi.mock('../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Defaults match the real isRedisConfigured()'s own behavior in this test
// environment (no REDIS_URL set, so false) -- the RedisTenantUsageTracker
// tests below rely on exactly this "unconfigured" default for their own
// graceful-fallback coverage. Only the RedisRateLimiter tests override these
// per-test to exercise the real Redis-backed path.
let redisConfigured = false;
let fakeRedisClient: unknown = null;

vi.mock('../../../src/config/redis.config', () => ({
  isRedisConfigured: () => redisConfigured,
}));
vi.mock('../../../src/lib/redis', () => ({
  getRedisClient: () => fakeRedisClient,
}));

describe('RateLimiter', () => {
  describe('Token Bucket Algorithm', () => {
    it('should allow requests within limit', async () => {
      const limiter = new RateLimiter({
        name: 'Test',
        maxRequests: 5,
        windowMs: 1000,
        throwOnLimit: false,
      });

      // Should be able to acquire 5 tokens
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      expect(limiter.getAvailableTokens()).toBe(0);
    });

    it('should throw RateLimitError when throwOnLimit is true', async () => {
      const limiter = new RateLimiter({
        name: 'Test',
        maxRequests: 1,
        windowMs: 1000,
        throwOnLimit: true,
      });

      // First request should succeed
      await limiter.acquire();

      // Second request should throw
      await expect(limiter.acquire()).rejects.toThrow(RateLimitError);
    });

    it('should refill tokens over time', async () => {
      vi.useFakeTimers();

      const limiter = new RateLimiter({
        name: 'Test',
        maxRequests: 10,
        windowMs: 1000, // 10 tokens per second
        throwOnLimit: false,
      });

      // Use all tokens
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }
      expect(limiter.getAvailableTokens()).toBe(0);

      // Advance time by 500ms (should refill ~5 tokens)
      vi.advanceTimersByTime(500);
      expect(limiter.getAvailableTokens()).toBeGreaterThanOrEqual(4);

      vi.useRealTimers();
    });

    it('should not exceed max tokens after refill', async () => {
      vi.useFakeTimers();

      const limiter = new RateLimiter({
        name: 'Test',
        maxRequests: 5,
        windowMs: 1000,
        throwOnLimit: false,
      });

      // Use 2 tokens
      await limiter.acquire();
      await limiter.acquire();

      // Advance time significantly
      vi.advanceTimersByTime(5000);

      // Should cap at max (5), not exceed it
      expect(limiter.getAvailableTokens()).toBe(5);

      vi.useRealTimers();
    });

    it('should reset to full capacity', () => {
      const limiter = new RateLimiter({
        name: 'Test',
        maxRequests: 10,
        windowMs: 1000,
        throwOnLimit: false,
      });

      // Use some tokens synchronously by checking available
      expect(limiter.getAvailableTokens()).toBe(10);

      // Reset
      limiter.reset();

      expect(limiter.getAvailableTokens()).toBe(10);
    });
  });

  describe('RateLimitError', () => {
    it('should include retry after information', () => {
      const error = new RateLimitError('Rate limit exceeded', 5000);

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.retryAfterMs).toBe(5000);
      expect(error.name).toBe('RateLimitError');
    });
  });
});

// Note: In-process TenantUsageTracker has been removed.
// Use RedisTenantUsageTracker for all tenant usage tracking (multi-instance safe).

describe('RedisTenantUsageTracker', () => {
  const TENANT_ID = 'tenant-redis-123';

  /**
   * Note: Full Redis integration tests require a running Redis instance.
   * These tests verify the graceful fallback behavior when Redis is unavailable.
   * The class is designed to fail-open (allow requests) when Redis cannot be reached
   * to maintain availability in production.
   */

  describe('Graceful Fallback', () => {
    it('should allow calls when Redis is not configured', async () => {
      // When Redis URL is not set, should fail-open
      const tracker = new RedisTenantUsageTracker('Test', {
        maxTokensPerDay: 1000,
        maxCallsPerHour: 100,
      });

      const result = await tracker.canMakeCall(TENANT_ID);
      // Should gracefully allow when Redis unavailable (fail-open for availability)
      expect(result.allowed).toBe(true);
    });

    it('should allow token usage when Redis is not configured', async () => {
      const tracker = new RedisTenantUsageTracker('Test', {
        maxTokensPerDay: 1000,
        maxCallsPerHour: 100,
      });

      const result = await tracker.canUseTokens(TENANT_ID, 100);
      expect(result.allowed).toBe(true);
    });

    it('should not throw when recording calls without Redis', async () => {
      const tracker = new RedisTenantUsageTracker('Test', {
        maxTokensPerDay: 1000,
        maxCallsPerHour: 100,
      });

      // Should not throw
      await expect(tracker.recordCall(TENANT_ID)).resolves.not.toThrow();
    });

    it('should not throw when recording tokens without Redis', async () => {
      const tracker = new RedisTenantUsageTracker('Test', {
        maxTokensPerDay: 1000,
        maxCallsPerHour: 100,
      });

      // Should not throw
      await expect(tracker.recordTokens(TENANT_ID, 100)).resolves.not.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should create tracker with provided config', () => {
      const tracker = new RedisTenantUsageTracker('AI-Test', {
        maxTokensPerDay: 5000,
        maxCallsPerHour: 200,
      });

      expect(tracker).toBeDefined();
    });
  });
});

describe('RedisRateLimiter', () => {
  function makeFakeRedis(execImpl: () => Promise<Array<[Error | null, unknown]> | null>) {
    const pipeline = {
      incr: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockImplementation(execImpl),
    };
    return { multi: vi.fn().mockReturnValue(pipeline) };
  }

  beforeEach(() => {
    redisConfigured = true;
  });

  afterEach(() => {
    redisConfigured = false;
    fakeRedisClient = null;
    vi.useRealTimers();
  });

  it('proceeds immediately when the count is within the limit', async () => {
    fakeRedisClient = makeFakeRedis(async () => [[null, 1]]);
    const limiter = new RedisRateLimiter({ name: 'Test', maxRequests: 60, windowMs: 60_000 });

    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('fails open within its own short timeout if the Redis multi/exec call hangs forever (real incident, 2026-10-17: geminiRateLimiter.acquire() hung indefinitely even with commandTimeout configured, since redis.multi()\'s own Pipeline bypasses that wiring)', async () => {
    fakeRedisClient = makeFakeRedis(() => new Promise(() => {}));
    const limiter = new RedisRateLimiter({ name: 'Test', maxRequests: 60, windowMs: 60_000 });

    vi.useFakeTimers();
    const acquirePromise = limiter.acquire();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(acquirePromise).resolves.toBeUndefined();
  });

  it('waits out the full remaining window when the limit is exceeded, instead of being cut short by the Redis-hang timeout (real incident, 2026-10-19: this let FMHE_PDF.pdf\'s 11991-issue AI analysis pass blow past the configured 60/min Gemini limit by nearly 2x, since every caller past the limit used to "time out" after 5s and proceed anyway)', async () => {
    fakeRedisClient = makeFakeRedis(async () => [[null, 61]]); // 1 over the limit of 60
    const limiter = new RedisRateLimiter({ name: 'Test', maxRequests: 60, windowMs: 60_000 });

    vi.useFakeTimers();
    // Pin to an exact minute boundary so waitTime (windowMs - now % windowMs)
    // is deterministically the full 60s, not whatever now % windowMs happens
    // to be at the real moment this test runs.
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let resolved = false;
    limiter.acquire().then(() => { resolved = true; });

    // Past the old 5s external-timeout bug's cutoff, but short of the real
    // window wait -- the bug would have already resolved this by now.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(false);

    // Let the rest of the (up to windowMs) wait elapse for real.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toBe(true);
  });

  it('fails open when Redis returns an error synchronously (not just on a hang)', async () => {
    fakeRedisClient = makeFakeRedis(() => Promise.reject(new Error('ECONNREFUSED')));
    const limiter = new RedisRateLimiter({ name: 'Test', maxRequests: 60, windowMs: 60_000 });

    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});
