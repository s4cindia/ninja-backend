import prisma, { Prisma } from '../../lib/prisma';
import { detectWithDocling } from '../zone-extractor/docling-client';
import { mapDoclingLabel } from '../zone-extractor/zone-type-mapper';
import { detectWithPdfxt, mapPdfxtLabel } from '../pdfxt/pdfxt-client';
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

export async function runCalibration(
  documentId: string,
  tenantId: string,
  fileId: string,
): Promise<CalibrationRunResult> {
  const startTime = Date.now();

  // 1. Fetch CorpusDocument
  const doc = await prisma.corpusDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) throw new Error(`CorpusDocument not found: ${documentId}`);
  const pdfPath = doc.s3Path;

  // 2. Create CalibrationRun
  const run = await prisma.calibrationRun.create({
    data: { documentId, type: 'CALIBRATION' },
  });
  const calibrationRunId = run.id;

  // 3. Run both detections in parallel
  let doclingResponse: Awaited<ReturnType<typeof detectWithDocling>>;
  let pdfxtResponse: Awaited<ReturnType<typeof detectWithPdfxt>>;

  try {
    [doclingResponse, pdfxtResponse] = await Promise.all([
      detectWithDocling(pdfPath, calibrationRunId),
      detectWithPdfxt(pdfPath, calibrationRunId),
    ]);
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

  // 4. Map to SourceZone[]
  const doclingZones: SourceZone[] = doclingResponse.zones.map((z) => ({
    pageNumber: z.page,
    bbox: z.bbox,
    zoneType: mapDoclingLabel(z.label),
    confidence: z.confidence ?? 0.5,
    label: z.label,
  }));

  const pdfxtZones: SourceZone[] = pdfxtResponse.zones.map((z) => ({
    pageNumber: z.pageNumber,
    bbox: z.bbox,
    zoneType: mapPdfxtLabel(z.label),
    confidence: z.confidence ?? 0.5,
    label: z.label,
  }));

  // 5. Match and summarise
  const matches = matchZones(doclingZones, pdfxtZones);
  const summary = summariseCalibrationRun(matches);

  // 6. Persist in transaction
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
          fileId,
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
