import prisma, { Prisma } from '../../lib/prisma';
import { detectWithDocling } from './docling-client';
import { detectWithYolo } from './yolo-client';
import { mapDoclingLabel } from './zone-type-mapper';
import { mapYoloLabel } from './yolo-label-mapper';
import type { DetectedZone } from './types';
import { logger } from '../../lib/logger';

export type ExtractionMode = 'docling' | 'yolo';

/**
 * Detect zones in a PDF and persist them.
 *
 * @param pdfPath        - S3 path or local path to the PDF
 * @param bootstrapJobId - ZoneBootstrapJob.id
 * @param tenantId       - Required: Zone.tenantId is NOT NULL
 * @param fileId         - Zone.fileId (FK → File, nullable for corpus calibration runs)
 * @param mode           - 'docling' (default) or 'yolo' (the fine-tuned zone detector)
 *
 * Docling stores its raw label + confidence in the docling* columns. The YOLO
 * detector's labels are already canonical, so it stores its raw label in the
 * generic `label` column (there are no dedicated yolo* columns yet — a
 * yoloConfidence column is a planned follow-up).
 */
export async function detectZones(
  pdfPath: string,
  bootstrapJobId: string,
  tenantId: string,
  fileId: string,
  mode: ExtractionMode = 'docling',
): Promise<DetectedZone[]> {
  logger.info(
    `[ZoneExtractor] Starting ${mode} detection for job ${bootstrapJobId}`,
  );

  const response = mode === 'yolo'
    ? await detectWithYolo(pdfPath, bootstrapJobId)
    : await detectWithDocling(pdfPath, bootstrapJobId);

  const detected = response.zones.map((zone) => ({
    pageNumber: zone.page,
    bbox: zone.bbox,
    rawLabel: zone.label,
    zoneType: mode === 'yolo' ? mapYoloLabel(zone.label) : mapDoclingLabel(zone.label),
    confidence: zone.confidence ?? null,
  }));

  await prisma.$transaction([
    prisma.zoneBootstrapJob.update({
      where: { id: bootstrapJobId },
      data: { extractionMode: mode },
    }),
    prisma.zone.createMany({
      data: detected.map((z) => ({
        bootstrapJobId,
        tenantId,
        fileId,
        pageNumber: z.pageNumber,
        type: z.zoneType,
        bounds: z.bbox as unknown as Prisma.InputJsonValue,
        source: mode,
        ...(mode === 'docling'
          ? { doclingLabel: z.rawLabel, doclingConfidence: z.confidence }
          : { label: z.rawLabel }),
      })),
    }),
  ]);

  logger.info(
    `[ZoneExtractor] Completed ${detected.length} zones for job ${bootstrapJobId} (${mode})`,
  );

  return detected.map((z) => ({
    pageNumber: z.pageNumber,
    bbox: z.bbox,
    zoneType: z.zoneType,
    confidence: z.confidence,
    source: mode,
    ...(mode === 'docling' ? { doclingLabel: z.rawLabel } : {}),
  }));
}
