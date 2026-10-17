import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be a real `function` (not an arrow fn) -- it's invoked with `new`, and
// arrow functions cannot be constructors.
const RedisMock = vi.fn().mockImplementation(function () {
  return { on: vi.fn() };
});

vi.mock('ioredis', () => ({
  default: RedisMock,
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('getRedisClient', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    RedisMock.mockClear();
    process.env = { ...ORIGINAL_ENV, REDIS_URL: 'redis://localhost:6379' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('sets commandTimeout so a stuck mid-reconnect command rejects instead of hanging forever', async () => {
    const { getRedisClient } = await import('../../../src/lib/redis');

    getRedisClient();

    expect(RedisMock).toHaveBeenCalledTimes(1);
    const [, options] = RedisMock.mock.calls[0];
    expect(options.commandTimeout).toBe(10_000);
    // maxRetriesPerRequest: null is what makes a stuck reconnect hang
    // forever without commandTimeout -- guard that the combination that
    // caused the real incident is exactly what's still configured here.
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it('reuses the same client instance across calls (singleton)', async () => {
    const { getRedisClient } = await import('../../../src/lib/redis');

    const first = getRedisClient();
    const second = getRedisClient();

    expect(first).toBe(second);
    expect(RedisMock).toHaveBeenCalledTimes(1);
  });
});
