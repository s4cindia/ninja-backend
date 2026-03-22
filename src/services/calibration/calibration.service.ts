import prisma, { Prisma } from '../../lib/prisma';
import { detectWithDocling } from '../zone-extractor/docling-client';
import { mapDoclingLabel } from '../zone-extractor/zone-type-mapper';
import { detectWithPdfxt, mapPdfxtLabel } from '../pdfxt/pdfxt-client';
import { extractZonesFromTaggedPdf } from '../zone-extractor/tagged-pdf-extractor';
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

  // Map each detection to SourceZone[] before Promise.all to keep types clean
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
  if (taggedPdfPath) {
    pdfxtPromise = extractZonesFromTaggedPdf(taggedPdfPath, calibrationRunId).then(
      (res) => res.zones.map((z): SourceZone => ({
        pageNumber: z.pageNumber,
        bbox: z.bbox,
        zoneType: z.zoneType,
        confidence: z.confidence,
        label: z.label,
      })),
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

  try {
    [doclingZones, pdfxtZones] = await Promise.all([doclingPromise, pdfxtPromise]);
  } catch (err) {
    await prisma.calibrationRun.update({
      where: { id: calibrationRunId },
      data: {
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        summary: { error: (err as Error).message, status: 'FAILED' },
      },
    });
    throw err;
  }

  // 4. Match and summarise
  const matches = matchZones(doclingZones, pdfxtZones);
  const summary = summariseCalibrationRun(matches);

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
        summary: summary as unknown as Prisma.InputJsonValue,
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
        };
      }),
    }),
  ]);

  logger.info(
    `[Calibration] Run ${calibrationRunId} complete: G:${summary.greenCount} A:${summary.amberCount} R:${summary.redCount} (${Date.now() - startTime}ms)`,
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
