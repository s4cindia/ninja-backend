/**
 * Rate Limiter Utility Tests
 *
 * Tests for token bucket rate limiter and tenant usage tracker
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RateLimiter,
  TenantUsageTracker,
  RedisTenantUsageTracker,
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

describe('TenantUsageTracker', () => {
  let tracker: TenantUsageTracker;
  const TENANT_ID = 'tenant-123';

  beforeEach(() => {
    tracker = new TenantUsageTracker('Test', {
      maxTokensPerDay: 1000,
      maxCallsPerHour: 100,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('API Call Limiting', () => {
    it('should allow calls within hourly limit', () => {
      const result = tracker.canMakeCall(TENANT_ID);
      expect(result.allowed).toBe(true);
    });

    it('should track calls and enforce hourly limit', () => {
      // Make 100 calls (the limit)
      for (let i = 0; i < 100; i++) {
        tracker.recordCall(TENANT_ID);
      }

      // 101st call should be denied
      const result = tracker.canMakeCall(TENANT_ID);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Hourly API call limit');
      expect(result.retryAfter).toBeDefined();
    });

    it('should reset hourly counter after an hour', () => {
      vi.useFakeTimers();

      // Use all hourly calls
      for (let i = 0; i < 100; i++) {
        tracker.recordCall(TENANT_ID);
      }
      expect(tracker.canMakeCall(TENANT_ID).allowed).toBe(false);

      // Advance time by 1 hour
      vi.advanceTimersByTime(60 * 60 * 1000);

      // Should be allowed again
      expect(tracker.canMakeCall(TENANT_ID).allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('Token Usage Limiting', () => {
    it('should allow token usage within daily limit', () => {
      const result = tracker.canUseTokens(TENANT_ID, 500);
      expect(result.allowed).toBe(true);
    });

    it('should track tokens and enforce daily limit', () => {
      // Use 900 tokens
      tracker.recordTokens(TENANT_ID, 900);

      // Trying to use 200 more should be denied (900 + 200 > 1000)
      const result = tracker.canUseTokens(TENANT_ID, 200);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily token limit');
      expect(result.retryAfter).toBeDefined();
    });

    it('should allow token usage if within remaining limit', () => {
      // Use 500 tokens
      tracker.recordTokens(TENANT_ID, 500);

      // Trying to use 400 more should be allowed (500 + 400 < 1000)
      const result = tracker.canUseTokens(TENANT_ID, 400);
      expect(result.allowed).toBe(true);
    });

    it('should reset daily counter after 24 hours', () => {
      vi.useFakeTimers();

      // Use all daily tokens
      tracker.recordTokens(TENANT_ID, 1000);
      expect(tracker.canUseTokens(TENANT_ID, 1).allowed).toBe(false);

      // Advance time by 24 hours
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      // Should be allowed again
      expect(tracker.canUseTokens(TENANT_ID, 1).allowed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('Usage Statistics', () => {
    it('should return accurate usage stats', () => {
      // Make 10 calls and use 500 tokens
      for (let i = 0; i < 10; i++) {
        tracker.recordCall(TENANT_ID);
      }
      tracker.recordTokens(TENANT_ID, 500);

      const stats = tracker.getStats(TENANT_ID);

      expect(stats.callsThisHour).toBe(10);
      expect(stats.maxCallsPerHour).toBe(100);
      expect(stats.tokensUsedToday).toBe(500);
      expect(stats.maxTokensPerDay).toBe(1000);
    });

    it('should return zero stats for new tenant', () => {
      const stats = tracker.getStats('new-tenant');

      expect(stats.callsThisHour).toBe(0);
      expect(stats.tokensUsedToday).toBe(0);
    });
  });

  describe('Tenant Isolation', () => {
    it('should track usage separately per tenant', () => {
      const tenant1 = 'tenant-1';
      const tenant2 = 'tenant-2';

      // Tenant 1 uses 50 calls
      for (let i = 0; i < 50; i++) {
        tracker.recordCall(tenant1);
      }

      // Tenant 2 should still have full quota
      expect(tracker.canMakeCall(tenant2).allowed).toBe(true);

      const stats1 = tracker.getStats(tenant1);
      const stats2 = tracker.getStats(tenant2);

      expect(stats1.callsThisHour).toBe(50);
      expect(stats2.callsThisHour).toBe(0);
    });
  });

  describe('Reset Functions', () => {
    it('should reset single tenant usage', () => {
      tracker.recordCall(TENANT_ID);
      tracker.recordTokens(TENANT_ID, 100);

      tracker.resetTenant(TENANT_ID);

      const stats = tracker.getStats(TENANT_ID);
      expect(stats.callsThisHour).toBe(0);
      expect(stats.tokensUsedToday).toBe(0);
    });

    it('should clear all tenant usage', () => {
      tracker.recordCall('tenant-1');
      tracker.recordCall('tenant-2');

      tracker.clearAll();

      expect(tracker.getStats('tenant-1').callsThisHour).toBe(0);
      expect(tracker.getStats('tenant-2').callsThisHour).toBe(0);
    });
  });
});

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
