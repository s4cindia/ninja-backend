import { PDFDocument } from 'pdf-lib';
import { detectWithYolo } from '../zone-extractor/yolo-client';
import { ensureYoloServiceUp, touchYoloIdleTimer } from '../zone-extractor/yolo-service-scaler';
import { mapYoloLabel } from '../zone-extractor/yolo-label-mapper';
import { buildStructTreeFromZones } from '../zone-extractor/seam-c/struct-tree-builder';
import { fontToUnicodeService } from './font-tounicode.service';
import type { OrderableZone } from '../zone-extractor/seam-c/reading-order';
import type { RawYoloZone, LookupCachedZonesResult, StoreDetectedZonesOutcome } from '../zone-extractor/zone-detection-cache.service';
import { lookupCachedZones, storeDetectedZones } from '../zone-extractor/zone-detection-cache.service';
import { s3Service } from '../s3.service';
import { config } from '../../config';
import { logger } from '../../lib/logger';

// Seam C — Phase 3: the tagging producer.
//
// Turns an untagged PDF buffer into a tagged one, as a peer of adobeAutoTagService
// with the SAME return shape so it drops into the worker's tag branch unchanged.
// Pipeline: zone-detection cache lookup (skips the GPU entirely on a hit) → on-demand
// YOLO detection on a miss → canonical zones → buildStructTreeFromZones.
//
// The detector reads from S3, so the buffer is staged to a temp key, detected, and
// the temp object removed. Only `taggedPdfBuffer` is load-bearing downstream; the
// report/word fields exist purely to match Adobe's shape (UI-only, Seam C leaves
// them null). elementCounts is real — a per-zone-type tally from the detector's own
// classification (paragraph/table/figure/etc.), keyed by the 11 canonical zone types
// rather than Adobe's narrower {figures,tables,headings,paragraphs} shape.

// Real bug, 2026-11-26 (see git log): the zone-detection cache went live,
// but T4's own run-to-run Figure-count divergence recurred in the exact
// pre-cache shape, with no AWS CloudWatch/log access available from this
// environment to find out why (root cause, confirmed separately:
// ninja-backend-task-role was missing ssm:GetParameter/s3:HeadObject on
// the weights resources, so every lookup/store silently failed and fell
// through to a fresh, non-deterministic detection every time). This
// outcome is surfaced all the way to job.output (see
// pdf-auto-tag-orchestrator.service.ts) specifically so a silently
// failing optimization is observable without needing AWS log access at
// all -- the exact gap that let this go undiagnosed.
export type ZoneDetectionCacheOutcome =
  | { outcome: 'hit'; cacheKeyPrefix: string }
  | { outcome: 'miss'; cacheKeyPrefix: string }
  | { outcome: 'lookup_failed'; error: string }
  | { outcome: 'store_failed'; error: string }
  | { outcome: 'skipped_mismatch'; cacheKeyPrefix: string }
  | { outcome: 'skipped_no_tenant' };

export interface SeamCTagResult {
  taggedPdfBuffer: Buffer;
  reportBuffer: null;
  wordBuffer: null;
  elementCounts: Record<string, number>;
  parsedFlags: never[];
  source: 'seam-c';
  buildResult: { elements: number; mcids: number; pages: number };
  zoneDetectionCache: ZoneDetectionCacheOutcome;
}

type DetectResponse = { zones: RawYoloZone[]; modelInfo?: { weightsSha256?: string | null } };

/** Seams injected for testing (the real detector needs a live GPU service). */
export interface SeamCDeps {
  ensureUp: () => Promise<void>;
  touchIdle: () => void;
  detect: (pdfPath: string, jobId: string) => Promise<DetectResponse>;
  uploadTemp: (buffer: Buffer, jobId: string) => Promise<string>;   // returns s3://uri
  deleteTemp: (uri: string) => Promise<void>;
  /** Zone-detection cache (zone-detection-cache.service.ts) -- real bug this
   *  closes, 2026-11-26 (see git log): the SAME source PDF, detected by the
   *  SAME model/params, produced a DIFFERENT Figure count across two
   *  full-pipeline runs of the identical commit (GPU inference has no
   *  determinism guarantee by default). A HIT here skips ensureUp/
   *  uploadTemp/detect/deleteTemp/touchIdle entirely -- no GPU wake, not
   *  just a faster response. */
  cacheLookup: (tenantId: string, pdfBuffer: Buffer) => Promise<LookupCachedZonesResult>;
  cacheStore: (tenantId: string, pdfBuffer: Buffer, zones: RawYoloZone[], reportedWeightsSha256: string | null | undefined) => Promise<StoreDetectedZonesOutcome>;
}

const defaultDeps: SeamCDeps = {
  ensureUp: ensureYoloServiceUp,
  touchIdle: touchYoloIdleTimer,
  detect: detectWithYolo,
  uploadTemp: async (buffer, jobId) => {
    const key = await s3Service.uploadBuffer('seam-c', `${jobId}.pdf`, buffer, 'application/pdf', 'seam-c-temp');
    return `s3://${config.s3Bucket}/${key}`;
  },
  deleteTemp: async (uri) => {
    const key = uri.replace(/^s3:\/\/[^/]+\//, '');
    await s3Service.deleteFile(key).catch(() => {});
  },
  cacheLookup: lookupCachedZones,
  cacheStore: (tenantId, pdfBuffer, zones, reportedWeightsSha256) =>
    storeDetectedZones({ tenantId, pdfBuffer, zones, reportedWeightsSha256 }),
};

export class SeamCTagService {
  async tagPdf(pdfBuffer: Buffer, jobId: string, tenantId?: string, deps: SeamCDeps = defaultDeps): Promise<SeamCTagResult> {
    // 1 — detect zones, via the zone-detection cache on a hit or the
    // on-demand YOLO service on a miss. Caching is strictly opt-in on
    // tenantId being provided (never a global/shared cache -- see
    // ZoneDetectionCache's own schema.prisma doc comment) and a pure
    // optimization: any cache failure (SSM/S3/DB unreachable) falls
    // through to the normal detect flow rather than failing tagging.
    let rawZones: RawYoloZone[] | null = null;
    let lookupFailed: { error: string } | null = null;
    let cacheOutcome: ZoneDetectionCacheOutcome = tenantId
      ? { outcome: 'miss', cacheKeyPrefix: '' } // overwritten below once the lookup actually runs
      : { outcome: 'skipped_no_tenant' };
    if (tenantId) {
      try {
        const cached = await deps.cacheLookup(tenantId, pdfBuffer);
        if (cached.hit) {
          rawZones = cached.zones ?? null;
          cacheOutcome = { outcome: 'hit', cacheKeyPrefix: cached.cacheKeyPrefix };
          logger.info(`[SeamC] job ${jobId}: zone-detection cache HIT (key ${cached.cacheKeyPrefix}) -- skipping GPU detection`);
        } else {
          cacheOutcome = { outcome: 'miss', cacheKeyPrefix: cached.cacheKeyPrefix };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lookupFailed = { error: message };
        cacheOutcome = { outcome: 'lookup_failed', error: message };
        logger.warn(`[SeamC] job ${jobId}: zone-detection cache lookup failed (non-fatal, detecting normally): ${message}`);
      }
    }

    if (rawZones === null) {
      await deps.ensureUp();
      const uri = await deps.uploadTemp(pdfBuffer, jobId);
      let response: DetectResponse;
      try {
        response = await deps.detect(uri, jobId);
      } finally {
        await deps.deleteTemp(uri);
        deps.touchIdle();
      }
      rawZones = response.zones;
      if (tenantId) {
        // storeDetectedZones' own real implementation never throws (it
        // catches its own errors and returns {outcome:'failed'}), but
        // deps.cacheStore is an injected dependency -- defend against a
        // misbehaving one anyway, same "pure optimization, never fails
        // tagging" contract as the lookup side above.
        //
        // If the LOOKUP already failed, that's the more alarming signal to
        // keep: it means lookups for this exact input are broken right now
        // (e.g. the SSM/S3 permission gap this whole mechanism exists to
        // surface), which a later store succeeding doesn't resolve -- a
        // future run's own lookup will hit the same failure before it ever
        // reaches the DB. Only overwrite cacheOutcome with the store's own
        // result when the lookup itself didn't fail.
        try {
          const stored = await deps.cacheStore(tenantId, pdfBuffer, rawZones, response.modelInfo?.weightsSha256);
          if (!lookupFailed) {
            if (stored.outcome === 'failed') {
              cacheOutcome = { outcome: 'store_failed', error: stored.error };
            } else if (stored.outcome === 'skipped_mismatch') {
              cacheOutcome = { outcome: 'skipped_mismatch', cacheKeyPrefix: stored.cacheKeyPrefix };
            } else {
              // A successful store after a miss -- keep reporting 'miss' (what
              // actually happened on lookup) isn't as useful here as recording
              // the key that got stored, so a later run's own lookup outcome
              // can be compared against it directly.
              cacheOutcome = { outcome: 'miss', cacheKeyPrefix: stored.cacheKeyPrefix };
            }
          }
          if (stored.outcome === 'failed') {
            logger.warn(`[SeamC] job ${jobId}: zone-detection cache store failed (non-fatal): ${stored.error}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!lookupFailed) {
            cacheOutcome = { outcome: 'store_failed', error: message };
          }
          logger.warn(`[SeamC] job ${jobId}: zone-detection cache store failed (non-fatal): ${message}`);
        }
      }
    }

    const zones: OrderableZone[] = rawZones
      .filter((z) => z.bbox && typeof z.bbox.x === 'number')
      .map((z) => ({ pageNumber: z.page, bbox: z.bbox, zoneType: mapYoloLabel(z.label) }));
    if (zones.length === 0) {
      throw new Error('SEAM_C_NO_ZONES: detector returned no zones');
    }

    // 2 — build the /StructTreeRoot (throws SEAM_C_ALREADY_TAGGED if not untagged)
    const doc = await PDFDocument.load(pdfBuffer);
    const buildResult = buildStructTreeFromZones(doc, zones);

    // Tally raw detected zones, then subtract any the struct-tree builder
    // dropped for having no bound content (e.g. a "figure" zone over blank
    // page space) -- otherwise this over-reports zones that never actually
    // made it into the emitted structure.
    const elementCounts = zones.reduce<Record<string, number>>((counts, zone) => {
      counts[zone.zoneType] = (counts[zone.zoneType] ?? 0) + 1;
      return counts;
    }, {});
    for (const [zoneType, dropped] of Object.entries(buildResult.droppedZoneCounts)) {
      const remaining = (elementCounts[zoneType] ?? 0) - dropped;
      if (remaining > 0) elementCounts[zoneType] = remaining;
      else delete elementCounts[zoneType];
    }

    // 3 — synthesise /ToUnicode for fonts missing one (veraPDF 7.21.7). Best-effort,
    // deterministic, and never wrong for standard text; math fonts fall to a PUA
    // mapping whose real reading comes from the Formula /ActualText (rec #2).
    const toUni = fontToUnicodeService.synthesizeToUnicode(doc);

    const taggedPdfBuffer = Buffer.from(await doc.save());

    logger.info(
      `[SeamC] job ${jobId}: tagged ${zones.length} zones → ${buildResult.elements} elements, ` +
      `${buildResult.mcids} MCIDs across ${buildResult.pages} pages` +
      (toUni.fontsProcessed > 0 ? `; +ToUnicode on ${toUni.fontsProcessed} font(s)` : ''),
    );
    return {
      taggedPdfBuffer,
      reportBuffer: null,
      wordBuffer: null,
      elementCounts,
      parsedFlags: [],
      source: 'seam-c',
      buildResult,
      zoneDetectionCache: cacheOutcome,
    };
  }
}

export const seamCTagService = new SeamCTagService();
