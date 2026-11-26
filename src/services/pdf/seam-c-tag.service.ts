import { PDFDocument } from 'pdf-lib';
import { detectWithYolo } from '../zone-extractor/yolo-client';
import { ensureYoloServiceUp, touchYoloIdleTimer } from '../zone-extractor/yolo-service-scaler';
import { mapYoloLabel } from '../zone-extractor/yolo-label-mapper';
import { buildStructTreeFromZones } from '../zone-extractor/seam-c/struct-tree-builder';
import { fontToUnicodeService } from './font-tounicode.service';
import type { OrderableZone } from '../zone-extractor/seam-c/reading-order';
import type { RawYoloZone } from '../zone-extractor/zone-detection-cache.service';
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

export interface SeamCTagResult {
  taggedPdfBuffer: Buffer;
  reportBuffer: null;
  wordBuffer: null;
  elementCounts: Record<string, number>;
  parsedFlags: never[];
  source: 'seam-c';
  buildResult: { elements: number; mcids: number; pages: number };
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
  cacheLookup: (tenantId: string, pdfBuffer: Buffer) => Promise<{ zones: RawYoloZone[] } | null>;
  cacheStore: (tenantId: string, pdfBuffer: Buffer, zones: RawYoloZone[], reportedWeightsSha256: string | null | undefined) => Promise<void>;
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
    if (tenantId) {
      try {
        const cached = await deps.cacheLookup(tenantId, pdfBuffer);
        if (cached) {
          rawZones = cached.zones;
          logger.info(`[SeamC] job ${jobId}: zone-detection cache HIT -- skipping GPU detection`);
        }
      } catch (err) {
        logger.warn(`[SeamC] job ${jobId}: zone-detection cache lookup failed (non-fatal, detecting normally): ${err instanceof Error ? err.message : String(err)}`);
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
        try {
          await deps.cacheStore(tenantId, pdfBuffer, rawZones, response.modelInfo?.weightsSha256);
        } catch (err) {
          logger.warn(`[SeamC] job ${jobId}: zone-detection cache store failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
    };
  }
}

export const seamCTagService = new SeamCTagService();
