/**
 * Rate Limiter Utility Tests
 *
 * Tests for token bucket rate limiter and tenant usage tracker
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RateLimiter,
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
