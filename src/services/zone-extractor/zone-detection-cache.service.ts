import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import prisma from '../../lib/prisma';
import { s3Client } from '../s3.service';
import { logger } from '../../lib/logger';

// Caches a YOLO zone-detector result (seam-c-tag.service.ts) keyed on
// (source PDF bytes, weights identity, deploy version, detection params),
// so the exact same input never calls the GPU service twice -- see
// ZoneDetectionCache's own doc comment in schema.prisma for the real bug
// (T4's run-to-run Figure-count divergence) this closes, alongside the
// zone-detector service's own cuDNN-deterministic-mode fix.
//
// Deliberately never calls the YOLO service itself to build a cache key --
// ensureYoloServiceUp/touchYoloIdleTimer (yolo-service-scaler.ts) scale a
// real GPU task up/down on demand, and a cache HIT must never defeat that
// by waking it just to ask what weights it's using. SSM + S3 HeadObject
// (both cheap, non-GPU, TTL-cached below) stand in for "ask the service."

const WEIGHTS_SSM_PARAM = process.env.WEIGHTS_SSM_PARAM ?? '/ninja/zone-extractor/model-weights-path';
// Deploy-time identity meant to capture "service image digest + detection
// params" from one shared source across both this backend and
// zone-detector-service -- not auto-derived from either service's image
// (a real deploy-pipeline concern, still not wired up), just read as a
// plain env var manually bumped in
// infrastructure/ecs/ninja-backend-worker-task-definition.json whenever a
// change to zone-detector-service/main.py's detection behavior (model
// weights are already covered by resolveWeightsIdentity() above --
// bump this for everything else: RENDER_DPI/MAX_EDGE/IMGSZ/CONF handling,
// cuDNN/torch settings, ultralytics version) should force every existing
// cache row to miss. Defaults to 'unknown' rather than throwing: this
// cache is a pure optimization, never a reason to block tagging -- but an
// unset value here is itself a diagnostic signal (see
// zoneDetectionCache.cacheKeyPrefix on job.output), not something to rely on.
const ZONE_DETECTOR_VERSION = process.env.ZONE_DETECTOR_VERSION ?? 'unknown';

// Mirrors zone-detector-service/main.py's own env-var defaults
// (RENDER_DPI/MAX_EDGE/IMGSZ/CONF). Deliberately NOT imported across
// languages -- if a deploy ever changes one service's value without the
// other, that's exactly this cache key correctly forcing a miss (and a
// fresh, correct detection), not a bug to "fix" by sharing one literal.
const RENDER_DPI = process.env.ZONE_DETECTOR_RENDER_DPI ?? '150';
const MAX_EDGE = process.env.ZONE_DETECTOR_MAX_EDGE ?? '1280';
const IMGSZ = process.env.ZONE_DETECTOR_IMGSZ ?? '1024';
const CONF = process.env.ZONE_DETECTOR_CONF ?? '0.25';

const ssmClient = new SSMClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });

const S3_URI_PATTERN = /^s3:\/\/([^/]+)\/(.+)$/;

export interface WeightsIdentity {
  weightsUri: string;
  weightsETag: string;
}

const IDENTITY_TTL_MS = 5 * 60 * 1000;
let cachedIdentity: { value: WeightsIdentity; expiresAt: number } | null = null;

/** Test-only: clears the in-process TTL cache so a test can control timing. */
export function _resetWeightsIdentityCacheForTests(): void {
  cachedIdentity = null;
}

/**
 * Resolves the YOLO service's own weights identity (the S3 URI it reads at
 * startup, plus that object's current ETag) via SSM + S3 HeadObject only --
 * never the GPU service itself. TTL-cached in-process (~5 min) so normal
 * operation costs zero network calls after the first one in a window.
 */
export async function resolveWeightsIdentity(now: number = Date.now()): Promise<WeightsIdentity> {
  if (cachedIdentity && cachedIdentity.expiresAt > now) {
    return cachedIdentity.value;
  }
  const param = await ssmClient.send(new GetParameterCommand({ Name: WEIGHTS_SSM_PARAM }));
  const weightsUri = param.Parameter?.Value;
  if (!weightsUri) {
    throw new Error(`SSM parameter ${WEIGHTS_SSM_PARAM} has no value`);
  }

  const match = S3_URI_PATTERN.exec(weightsUri);
  if (!match) {
    throw new Error(`Weights URI "${weightsUri}" is not an s3:// URI`);
  }
  const [, bucket, key] = match;
  const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const weightsETag = head.ETag ?? '';

  const value: WeightsIdentity = { weightsUri, weightsETag };
  cachedIdentity = { value, expiresAt: now + IDENTITY_TTL_MS };
  return value;
}

/**
 * sha256 of every input that should distinguish one detection from
 * another. The last four (RENDER_DPI/MAX_EDGE/IMGSZ/CONF) are this
 * service's own env-var mirrors of the Python service's defaults -- see
 * this module's header comment for why they're never imported across
 * languages.
 */
export function computeCacheKey(
  sourcePdfSha256: string,
  weightsUri: string,
  weightsETag: string,
  zoneDetectorVersion: string = ZONE_DETECTOR_VERSION
): string {
  const raw = `${sourcePdfSha256}:${weightsUri}:${weightsETag}:${zoneDetectorVersion}:${RENDER_DPI}:${MAX_EDGE}:${IMGSZ}:${CONF}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface RawYoloZone {
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
  label: string;
  confidence?: number;
}

/** First 12 hex chars of a cache key -- enough to tell "two runs computed
 *  the same key" from "two runs computed different keys" in a log line or
 *  a job record, without printing the full (not secret, but noisy) hash. */
function keyPrefix(cacheKey: string): string {
  return cacheKey.slice(0, 12);
}

/**
 * Looks up a cached detection for `pdfBuffer` under `tenantId`. Resolves
 * the weights identity (TTL-cached) and computes the cache key itself, so
 * a caller never needs to know this module's own key composition. Never
 * throws on a lookup miss (a miss is a normal, expected outcome); DOES
 * throw on a genuine infra failure (SSM/S3/DB unreachable) so the caller
 * can decide how to degrade -- see seam-c-tag.service.ts's own try/catch
 * around this call.
 *
 * Real bug, 2026-11-26 (see git log): this cache went live, but T4's own
 * run-to-run Figure-count divergence recurred in the EXACT pre-cache
 * shape -- with no AWS CloudWatch/log access available to diagnose why,
 * confirmed root cause was ninja-backend-task-role missing
 * ssm:GetParameter/s3:HeadObject on the weights resources, so every
 * lookup/store silently failed and fell through to a fresh (non-
 * deterministic) detection every time. `cacheKeyPrefix` on the return
 * value exists so a caller (and ultimately job.output, see
 * pdf-auto-tag-orchestrator.service.ts) can make this outcome visible
 * without needing AWS log access at all.
 */
export interface LookupCachedZonesResult {
  hit: boolean;
  /** The key THIS lookup computed, regardless of hit/miss -- a miss still
   *  needs this so a caller can confirm the SUBSEQUENT store wrote under
   *  the SAME key a later run's own lookup will compute, not just that
   *  "a store happened." */
  cacheKeyPrefix: string;
  zones?: RawYoloZone[];
}

export async function lookupCachedZones(
  tenantId: string,
  pdfBuffer: Buffer
): Promise<LookupCachedZonesResult> {
  const sourcePdfSha256 = sha256OfBuffer(pdfBuffer);
  const { weightsUri, weightsETag } = await resolveWeightsIdentity();
  const cacheKey = computeCacheKey(sourcePdfSha256, weightsUri, weightsETag);
  const prefix = keyPrefix(cacheKey);

  const row = await prisma.zoneDetectionCache.findUnique({
    where: { tenantId_cacheKey: { tenantId, cacheKey } },
  });
  if (!row) return { hit: false, cacheKeyPrefix: prefix };
  return { hit: true, cacheKeyPrefix: prefix, zones: row.zones as unknown as RawYoloZone[] };
}

export type StoreDetectedZonesOutcome =
  | { outcome: 'stored'; cacheKeyPrefix: string }
  | { outcome: 'skipped_mismatch'; cacheKeyPrefix: string }
  | { outcome: 'failed'; error: string };

/**
 * Stores a freshly-detected result under `pdfBuffer`'s cache key for
 * `tenantId`. Applies the safety net first: if an existing row for the
 * SAME source PDF (any zoneDetectorVersion) reported a DIFFERENT weights
 * sha256 than this detection's own live response did, the SSM-URI+ETag
 * proxy failed to distinguish two real model versions -- logs an error
 * and skips the write entirely rather than risk a false cache hit later.
 * Never throws (infra failures here are logged and swallowed) -- caching
 * is a pure optimization, never a reason to fail a tagging job; see this
 * function's own caller for why that contract matters. Returns an
 * outcome instead of void (2026-11-26, see git log) so a caller without
 * AWS log access can still tell a silent infra failure (e.g. a missing
 * IAM permission -- the real bug that motivated this) from a genuine
 * store.
 */
export async function storeDetectedZones(params: {
  tenantId: string;
  pdfBuffer: Buffer;
  zones: RawYoloZone[];
  reportedWeightsSha256: string | null | undefined;
}): Promise<StoreDetectedZonesOutcome> {
  const { tenantId, pdfBuffer, zones, reportedWeightsSha256 } = params;
  try {
    const sourcePdfSha256 = sha256OfBuffer(pdfBuffer);
    const { weightsUri, weightsETag } = await resolveWeightsIdentity();
    const cacheKey = computeCacheKey(sourcePdfSha256, weightsUri, weightsETag);

    if (reportedWeightsSha256) {
      const priorMismatch = await prisma.zoneDetectionCache.findFirst({
        where: {
          tenantId,
          sourcePdfSha256,
          reportedWeightsSha256: { not: null },
          NOT: { reportedWeightsSha256 },
        },
        select: { cacheKey: true, reportedWeightsSha256: true },
      });
      if (priorMismatch) {
        logger.error(
          `[ZoneDetectionCache] Weights-identity proxy mismatch for source ${sourcePdfSha256}: this ` +
          `detection reported weights sha256 ${reportedWeightsSha256} (cacheKey ${cacheKey}), but an ` +
          `existing cache row for the SAME source PDF reported ${priorMismatch.reportedWeightsSha256} ` +
          `(cacheKey ${priorMismatch.cacheKey}) -- the SSM URI + S3 ETag identity failed to distinguish ` +
          `two real model versions. Skipping the cache write for this detection; the real zones are still ` +
          `returned to the caller unaffected.`
        );
        return { outcome: 'skipped_mismatch', cacheKeyPrefix: keyPrefix(cacheKey) };
      }
    }

    await prisma.zoneDetectionCache.upsert({
      where: { tenantId_cacheKey: { tenantId, cacheKey } },
      create: {
        tenantId,
        cacheKey,
        sourcePdfSha256,
        weightsUri,
        weightsETag,
        zoneDetectorVersion: ZONE_DETECTOR_VERSION,
        reportedWeightsSha256: reportedWeightsSha256 ?? null,
        zones: zones as unknown as object,
      },
      update: {
        zones: zones as unknown as object,
        reportedWeightsSha256: reportedWeightsSha256 ?? null,
      },
    });
    return { outcome: 'stored', cacheKeyPrefix: keyPrefix(cacheKey) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[ZoneDetectionCache] Failed to store detection result (non-fatal, tagging already succeeded): ${message}`
    );
    return { outcome: 'failed', error: message };
  }
}
