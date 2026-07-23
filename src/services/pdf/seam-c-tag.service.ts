import { PDFDocument } from 'pdf-lib';
import { detectWithYolo } from '../zone-extractor/yolo-client';
import { ensureYoloServiceUp, touchYoloIdleTimer } from '../zone-extractor/yolo-service-scaler';
import { mapYoloLabel } from '../zone-extractor/yolo-label-mapper';
import { buildStructTreeFromZones } from '../zone-extractor/seam-c/struct-tree-builder';
import type { OrderableZone } from '../zone-extractor/seam-c/reading-order';
import { s3Service } from '../s3.service';
import { config } from '../../config';
import { logger } from '../../lib/logger';

// Seam C — Phase 3: the tagging producer.
//
// Turns an untagged PDF buffer into a tagged one, as a peer of adobeAutoTagService
// with the SAME return shape so it drops into the worker's tag branch unchanged.
// Pipeline: on-demand YOLO detection → canonical zones → buildStructTreeFromZones.
//
// The detector reads from S3, so the buffer is staged to a temp key, detected, and
// the temp object removed. Only `taggedPdfBuffer` is load-bearing downstream; the
// report/word/elementCounts/parsedFlags fields exist purely to match Adobe's shape
// (they are UI-only and Seam C leaves them null/empty).

export interface SeamCTagResult {
  taggedPdfBuffer: Buffer;
  reportBuffer: null;
  wordBuffer: null;
  elementCounts: null;
  parsedFlags: never[];
  source: 'seam-c';
  buildResult: { elements: number; mcids: number; pages: number };
}

/** Seams injected for testing (the real detector needs a live GPU service). */
export interface SeamCDeps {
  ensureUp: () => Promise<void>;
  touchIdle: () => void;
  detect: (pdfPath: string, jobId: string) => Promise<{ zones: Array<{ page: number; bbox: { x: number; y: number; w: number; h: number }; label: string }> }>;
  uploadTemp: (buffer: Buffer, jobId: string) => Promise<string>;   // returns s3://uri
  deleteTemp: (uri: string) => Promise<void>;
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
};

export class SeamCTagService {
  async tagPdf(pdfBuffer: Buffer, jobId: string, deps: SeamCDeps = defaultDeps): Promise<SeamCTagResult> {
    // 1 — detect zones via the on-demand YOLO service
    await deps.ensureUp();
    const uri = await deps.uploadTemp(pdfBuffer, jobId);
    let zones: OrderableZone[];
    try {
      const response = await deps.detect(uri, jobId);
      zones = response.zones
        .filter((z) => z.bbox && typeof z.bbox.x === 'number')
        .map((z) => ({ pageNumber: z.page, bbox: z.bbox, zoneType: mapYoloLabel(z.label) }));
    } finally {
      await deps.deleteTemp(uri);
      deps.touchIdle();
    }
    if (zones.length === 0) {
      throw new Error('SEAM_C_NO_ZONES: detector returned no zones');
    }

    // 2 — build the /StructTreeRoot (throws SEAM_C_ALREADY_TAGGED if not untagged)
    const doc = await PDFDocument.load(pdfBuffer);
    const buildResult = buildStructTreeFromZones(doc, zones);
    const taggedPdfBuffer = Buffer.from(await doc.save());

    logger.info(
      `[SeamC] job ${jobId}: tagged ${zones.length} zones → ${buildResult.elements} elements, ` +
      `${buildResult.mcids} MCIDs across ${buildResult.pages} pages`,
    );
    return {
      taggedPdfBuffer,
      reportBuffer: null,
      wordBuffer: null,
      elementCounts: null,
      parsedFlags: [],
      source: 'seam-c',
      buildResult,
    };
  }
}

export const seamCTagService = new SeamCTagService();
