/**
 * zone-detection-cache.service.ts
 *
 * Real bug this closes (2026-11-26, see git log): the SAME source PDF,
 * detected by the SAME YOLO model/params, produced a DIFFERENT Figure
 * count across two full-pipeline runs of the identical commit -- GPU
 * inference has no determinism guarantee by default. This cache is the
 * second, independent layer (alongside zone-detector-service's own
 * cuDNN-deterministic-mode fix): same cache key -> same real zones,
 * served without ever calling the GPU service again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
const mockUpsert = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    zoneDetectionCache: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}));

const mockSsmSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => {
  const MockSSMClient = vi.fn();
  MockSSMClient.prototype.send = (...args: unknown[]) => mockSsmSend(...args);
  class MockGetParameterCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SSMClient: MockSSMClient, GetParameterCommand: MockGetParameterCommand };
});

const mockS3Send = vi.fn();
vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: (...args: unknown[]) => mockS3Send(...args) },
}));
vi.mock('@aws-sdk/client-s3', () => {
  class MockHeadObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { HeadObjectCommand: MockHeadObjectCommand };
});

vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  computeCacheKey,
  resolveWeightsIdentity,
  lookupCachedZones,
  storeDetectedZones,
  sha256OfBuffer,
  _resetWeightsIdentityCacheForTests,
} from '../../../../src/services/zone-extractor/zone-detection-cache.service';
import { logger } from '../../../../src/lib/logger';

const SAMPLE_ZONES = [{ page: 1, bbox: { x: 0, y: 0, w: 100, h: 50 }, label: 'figure' }];

function mockSsmOk(uri = 's3://ninja-weights/model-v7.pt') {
  mockSsmSend.mockResolvedValue({ Parameter: { Value: uri } });
}
function mockS3Ok(etag = '"etag-abc"') {
  mockS3Send.mockResolvedValue({ ETag: etag });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWeightsIdentityCacheForTests();
  mockSsmOk();
  mockS3Ok();
});

afterEach(() => {
  _resetWeightsIdentityCacheForTests();
});

describe('computeCacheKey', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeCacheKey('sha-source', 's3://bucket/weights.pt', '"etag"', 'v1');
    const b = computeCacheKey('sha-source', 's3://bucket/weights.pt', '"etag"', 'v1');
    expect(a).toBe(b);
  });

  it('changes when any single component changes', () => {
    const base = computeCacheKey('sha-source', 's3://bucket/weights.pt', '"etag"', 'v1');
    expect(computeCacheKey('sha-DIFFERENT', 's3://bucket/weights.pt', '"etag"', 'v1')).not.toBe(base);
    expect(computeCacheKey('sha-source', 's3://bucket/OTHER.pt', '"etag"', 'v1')).not.toBe(base);
    expect(computeCacheKey('sha-source', 's3://bucket/weights.pt', '"DIFFERENT"', 'v1')).not.toBe(base);
    expect(computeCacheKey('sha-source', 's3://bucket/weights.pt', '"etag"', 'v2')).not.toBe(base);
  });
});

describe('sha256OfBuffer', () => {
  it('is deterministic for the same bytes and differs for different bytes', () => {
    const a = sha256OfBuffer(Buffer.from('hello'));
    const b = sha256OfBuffer(Buffer.from('hello'));
    const c = sha256OfBuffer(Buffer.from('world'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64); // hex sha256
  });
});

describe('resolveWeightsIdentity', () => {
  it('resolves the weights URI (SSM) and its ETag (S3 HeadObject), never calling the GPU service', async () => {
    const identity = await resolveWeightsIdentity();
    expect(identity).toEqual({ weightsUri: 's3://ninja-weights/model-v7.pt', weightsETag: '"etag-abc"' });
    expect(mockSsmSend).toHaveBeenCalledOnce();
    expect(mockS3Send).toHaveBeenCalledOnce();
  });

  it('caches the result for repeated calls within the TTL window -- no repeated SSM/S3 calls', async () => {
    const now = 1_000_000;
    await resolveWeightsIdentity(now);
    await resolveWeightsIdentity(now + 1000); // well within the ~5 min TTL
    expect(mockSsmSend).toHaveBeenCalledOnce();
    expect(mockS3Send).toHaveBeenCalledOnce();
  });

  /**
   * Real bug this guards against: a cache that never refreshes would
   * silently keep serving a PREVIOUS model's zones forever after a real
   * model promotion. Verified this test fails (never re-fetches) against
   * a version of the TTL check that never expires, before confirming it
   * passes against the real ~5-minute TTL.
   */
  it('re-resolves after the TTL window elapses', async () => {
    const now = 2_000_000;
    await resolveWeightsIdentity(now);
    mockSsmOk('s3://ninja-weights/model-v8.pt'); // a real model promotion
    const sixMinutesLater = now + 6 * 60 * 1000;
    const identity = await resolveWeightsIdentity(sixMinutesLater);
    expect(identity.weightsUri).toBe('s3://ninja-weights/model-v8.pt');
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
  });

  it('throws when the SSM parameter has no value, rather than silently proceeding', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: undefined } });
    await expect(resolveWeightsIdentity()).rejects.toThrow(/no value/);
  });

  it('throws when the resolved value is not an s3:// URI', async () => {
    mockSsmOk('not-an-s3-uri');
    await expect(resolveWeightsIdentity()).rejects.toThrow(/not an s3:\/\/ URI/);
  });
});

describe('lookupCachedZones', () => {
  it('returns null on a miss', async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await lookupCachedZones('tenant-1', Buffer.from('pdf-bytes'));
    expect(result).toBeNull();
  });

  it('returns the cached zones on a hit, keyed by (tenantId, cacheKey)', async () => {
    mockFindUnique.mockResolvedValue({ zones: SAMPLE_ZONES });
    const result = await lookupCachedZones('tenant-1', Buffer.from('pdf-bytes'));
    expect(result).toEqual({ zones: SAMPLE_ZONES });
    const call = mockFindUnique.mock.calls[0][0];
    expect(call.where.tenantId_cacheKey.tenantId).toBe('tenant-1');
    expect(typeof call.where.tenantId_cacheKey.cacheKey).toBe('string');
  });

  /** Different tenants for the SAME source PDF must never collide -- a
   *  global/shared cache was explicitly rejected (tenant-scoped data
   *  retention requirement). Verified this fails against a version of
   *  lookupCachedZones that queries by sourcePdfSha256 alone (no
   *  tenantId in the where clause), before confirming it passes. */
  it('scopes the lookup by tenantId -- the same PDF bytes for two tenants use the same cacheKey but different rows', async () => {
    mockFindUnique.mockResolvedValue(null);
    const buf = Buffer.from('same-pdf-bytes');
    await lookupCachedZones('tenant-A', buf);
    await lookupCachedZones('tenant-B', buf);
    const [callA, callB] = mockFindUnique.mock.calls;
    expect(callA[0].where.tenantId_cacheKey.tenantId).toBe('tenant-A');
    expect(callB[0].where.tenantId_cacheKey.tenantId).toBe('tenant-B');
    expect(callA[0].where.tenantId_cacheKey.cacheKey).toBe(callB[0].where.tenantId_cacheKey.cacheKey);
  });
});

describe('storeDetectedZones', () => {
  it('writes a new cache row when no prior row disagrees on the reported weights hash', async () => {
    mockFindFirst.mockResolvedValue(null); // no mismatching prior row
    mockUpsert.mockResolvedValue({});

    await storeDetectedZones({
      tenantId: 'tenant-1',
      pdfBuffer: Buffer.from('pdf-bytes'),
      zones: SAMPLE_ZONES,
      reportedWeightsSha256: 'sha-of-real-weights',
    });

    expect(mockUpsert).toHaveBeenCalledOnce();
    const call = mockUpsert.mock.calls[0][0];
    expect(call.create.tenantId).toBe('tenant-1');
    expect(call.create.reportedWeightsSha256).toBe('sha-of-real-weights');
    expect(call.create.zones).toEqual(SAMPLE_ZONES);
  });

  it('skips the prior-mismatch check (and writes normally) when reportedWeightsSha256 is not provided', async () => {
    mockUpsert.mockResolvedValue({});
    await storeDetectedZones({
      tenantId: 'tenant-1',
      pdfBuffer: Buffer.from('pdf-bytes'),
      zones: SAMPLE_ZONES,
      reportedWeightsSha256: undefined,
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledOnce();
  });

  /**
   * The safety net: the SSM-URI+ETag proxy is just that -- a proxy. If a
   * live detection ever reports a DIFFERENT weights hash than an existing
   * row for the SAME source PDF, the proxy failed to distinguish two real
   * model versions. Must log an error and skip the write, never silently
   * trust the proxy. Verified this test fails (writes anyway) against a
   * version of storeDetectedZones with the mismatch check removed, before
   * confirming it passes against the real check.
   */
  it('logs an error and skips the write when the reported weights hash disagrees with an existing row for the same source PDF', async () => {
    mockFindFirst.mockResolvedValue({ cacheKey: 'old-key', reportedWeightsSha256: 'sha-of-OLD-weights' });

    await storeDetectedZones({
      tenantId: 'tenant-1',
      pdfBuffer: Buffer.from('pdf-bytes'),
      zones: SAMPLE_ZONES,
      reportedWeightsSha256: 'sha-of-NEW-weights',
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    const message = vi.mocked(logger.error).mock.calls[0][0] as string;
    expect(message).toContain('sha-of-NEW-weights');
    expect(message).toContain('sha-of-OLD-weights');
  });

  it('never throws -- a Prisma failure is logged and swallowed, never propagated to the caller', async () => {
    mockFindFirst.mockRejectedValue(new Error('DB unreachable'));
    await expect(
      storeDetectedZones({
        tenantId: 'tenant-1',
        pdfBuffer: Buffer.from('pdf-bytes'),
        zones: SAMPLE_ZONES,
        reportedWeightsSha256: 'sha-x',
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('never throws -- an SSM/S3 failure resolving weights identity is also logged and swallowed', async () => {
    mockSsmSend.mockRejectedValue(new Error('SSM unreachable'));
    await expect(
      storeDetectedZones({
        tenantId: 'tenant-1',
        pdfBuffer: Buffer.from('pdf-bytes'),
        zones: SAMPLE_ZONES,
        reportedWeightsSha256: 'sha-x',
      })
    ).resolves.toBeUndefined();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
