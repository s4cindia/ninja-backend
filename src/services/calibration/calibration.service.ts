import prisma, { Prisma } from '../../lib/prisma';
import { detectWithDocling } from '../zone-extractor/docling-client';
import { mapDoclingLabel } from '../zone-extractor/zone-type-mapper';
import { detectWithPdfxt, mapPdfxtLabel } from '../pdfxt/pdfxt-client';
import { extractZonesFromTaggedPdf, type TaggedPdfExtractionStats } from '../zone-extractor/tagged-pdf-extractor';
import { matchZones, type SourceZone } from './zone-matcher';
import { summariseCalibrationRun } from './calibration-summary';
import { logger } from '../../lib/logger';

export interface CalibrationRunResult {
  calibrationRunId: string;
  documentId: string;
  doclingZoneCount: number;
  pdfxtZoneCount: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  durationMs: number;
}

export interface RunCalibrationOptions {
  fileId?: string;
  existingRunId?: string;
  taggedPdfPath?: string;
}

export async function runCalibration(
  documentId: string,
  tenantId: string,
  opts: RunCalibrationOptions = {},
): Promise<CalibrationRunResult> {
  const { fileId, existingRunId, taggedPdfPath } = opts;
  const startTime = Date.now();

  // 1. Fetch CorpusDocument
  const doc = await prisma.corpusDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`CorpusDocument not found: ${documentId}`);
  const pdfPath = doc.s3Path;

  // 2. Use existing CalibrationRun or create a new one
  let calibrationRunId: string;
  if (existingRunId) {
    calibrationRunId = existingRunId;
  } else {
    const run = await prisma.calibrationRun.create({
      data: { documentId, type: 'CALIBRATION' },
    });
    calibrationRunId = run.id;
  }

  // 3. Run both detections in parallel
  let doclingZones: SourceZone[];
  let pdfxtZones: SourceZone[];
  let doclingFailed = false;

  // Map each detection to SourceZone[] before settling
  const doclingPromise = detectWithDocling(pdfPath, calibrationRunId).then(
    (res) => res.zones.map((z): SourceZone => ({
      pageNumber: z.page,
      bbox: z.bbox,
      zoneType: mapDoclingLabel(z.label),
      confidence: z.confidence ?? null,
      label: z.label,
    })),
  );

  // pdfxt source: if operator uploaded a tagged PDF, extract zones from StructTreeRoot;
  // otherwise fall back to the pdfxt HTTP API if available, or skip
  let pdfxtPromise: Promise<SourceZone[]>;
  let pdfxtExtractionStats: TaggedPdfExtractionStats | undefined;
  let pdfxtGhostZones: import('../zone-extractor/tagged-pdf-extractor').TaggedPdfZone[] = [];
  if (taggedPdfPath) {
    pdfxtPromise = extractZonesFromTaggedPdf(taggedPdfPath, calibrationRunId).then(
      (res) => {
        pdfxtExtractionStats = res.extractionStats;
        // Separate ghost zones (no bbox) from real zones
        const realZones = res.zones.filter((z) => z.bbox !== null);
        pdfxtGhostZones = res.zones.filter((z) => z.bbox === null);
        return realZones.map((z): SourceZone => ({
          pageNumber: z.pageNumber,
          bbox: z.bbox!,
          zoneType: z.zoneType,
          confidence: z.confidence,
          label: z.label,
          content: z.content,
        }));
      },
    );
  } else if (process.env.PDFXT_SERVICE_URL) {
    pdfxtPromise = detectWithPdfxt(pdfPath, calibrationRunId).then(
      (res) => res.zones.map((z): SourceZone => ({
        pageNumber: z.pageNumber,
        bbox: z.bbox,
        zoneType: mapPdfxtLabel(z.label),
        confidence: z.confidence ?? null,
        label: z.label,
      })),
    );
  } else {
    logger.warn(`[Calibration] PDFXT_SERVICE_URL not set and no taggedPdfPath — running Docling-only`);
    pdfxtPromise = Promise.resolve([]);
  }

  // Use allSettled so Docling failure doesn't kill the whole run
  const [doclingResult, pdfxtResult] = await Promise.allSettled([doclingPromise, pdfxtPromise]);

  if (doclingResult.status === 'fulfilled') {
    doclingZones = doclingResult.value;
  } else {
    logger.warn(`[Calibration] Docling failed (non-fatal): ${(doclingResult.reason as Error).message}`);
    doclingZones = [];
    doclingFailed = true;
  }

  if (pdfxtResult.status === 'fulfilled') {
    pdfxtZones = pdfxtResult.value;
  } else {
    // pdfxt (tagged-PDF) failure is also non-fatal — proceed with whatever we have
    logger.warn(`[Calibration] pdfxt/tagged-PDF extraction failed (non-fatal): ${(pdfxtResult.reason as Error).message}`);
    pdfxtZones = [];
  }

  // If BOTH sources failed, mark the run as failed
  if (doclingZones.length === 0 && pdfxtZones.length === 0 && pdfxtGhostZones.length === 0) {
    const errorMsg = doclingResult.status === 'rejected'
      ? (doclingResult.reason as Error).message
      : 'Both extraction sources returned 0 zones';
    await prisma.calibrationRun.update({
      where: { id: calibrationRunId },
      data: {
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        summary: { error: errorMsg, status: 'FAILED' },
      },
    });
    throw new Error(errorMsg);
  }

  // 4. Match and summarise
  const matches = matchZones(doclingZones, pdfxtZones);
  const summary = summariseCalibrationRun(matches);

  const totalPages = doc.pageCount ?? 0;
  const extractedZonePages = [
    ...matches.map((m) => (m.doclingZone ?? m.pdfxtZone!).pageNumber),
    ...pdfxtGhostZones.map((gz) => gz.pageNumber),
  ];
  // Clamp to [1, totalPages] so pagesWithZonesCount stays consistent with
  // emptyPageCount/emptyPages when an extractor emits an out-of-range page.
  const zonePages = new Set<number>(
    totalPages > 0
      ? extractedZonePages.filter((p) => Number.isInteger(p) && p >= 1 && p <= totalPages)
      : extractedZonePages,
  );
  const emptyPages: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!zonePages.has(p)) emptyPages.push(p);
  }

  // 5. Persist in transaction
  await prisma.$transaction([
    prisma.calibrationRun.update({
      where: { id: calibrationRunId },
      data: {
        doclingZoneCount: doclingZones.length,
        pdfxtZoneCount: pdfxtZones.length,
        greenCount: summary.greenCount,
        amberCount: summary.amberCount,
        redCount: summary.redCount,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        summary: {
          ...summary,
          pagesWithZonesCount: zonePages.size,
          emptyPageCount: emptyPages.length,
          emptyPages,
          ...(pdfxtExtractionStats ? { pdfxtExtractionStats } : {}),
          ...(doclingFailed ? { doclingFailed: true } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.zone.createMany({
      data: matches.map((m) => {
        const zone = m.doclingZone ?? m.pdfxtZone!;
        return {
          calibrationRunId,
          tenantId,
          ...(fileId ? { fileId } : {}),
          pageNumber: zone.pageNumber,
          type: zone.zoneType,
          bounds: zone.bbox as unknown as Prisma.InputJsonValue,
          source: m.doclingZone ? 'docling' : 'pdfxt',
          reconciliationBucket: m.reconciliationBucket,
          doclingLabel: m.doclingZone?.label ?? null,
          doclingConfidence: m.doclingZone?.confidence ?? null,
          pdfxtLabel: m.pdfxtZone?.label ?? null,
          content: zone.content ?? null,
        };
      }),
    }),
  ]);

  // 6. Persist ghost zones (structure elements with no computable bbox)
  if (pdfxtGhostZones.length > 0) {
    await prisma.zone.createMany({
      data: pdfxtGhostZones.map((gz) => ({
        calibrationRunId,
        tenantId,
        ...(fileId ? { fileId } : {}),
        pageNumber: gz.pageNumber,
        type: gz.zoneType,
        bounds: Prisma.DbNull,
        source: 'pdfxt',
        pdfxtLabel: gz.label,
        isGhost: true,
        ghostTag: gz.ghostTag ?? gz.label,
        reconciliationBucket: 'RED',
      })),
    });
    logger.info(
      `[Calibration] Created ${pdfxtGhostZones.length} ghost zones (struct elements with no bbox)`,
    );
  }

  logger.info(
    `[Calibration] Run ${calibrationRunId} complete: G:${summary.greenCount} A:${summary.amberCount} R:${summary.redCount} ghosts:${pdfxtGhostZones.length} (${Date.now() - startTime}ms)`,
  );

  return {
    calibrationRunId,
    documentId,
    doclingZoneCount: doclingZones.length,
    pdfxtZoneCount: pdfxtZones.length,
    greenCount: summary.greenCount,
    amberCount: summary.amberCount,
    redCount: summary.redCount,
    durationMs: Date.now() - startTime,
  };
}
