import prisma, { Prisma } from '../../lib/prisma';
import { detectWithDocling } from './docling-client';
import { mapDoclingLabel } from './zone-type-mapper';
import type { DetectedZone } from './types';
import { logger } from '../../lib/logger';

/**
 * Detect zones in a PDF using the Docling sidecar and persist them.
 *
 * @param pdfPath       - S3 path or local path to the PDF
 * @param bootstrapJobId - ZoneBootstrapJob.id
 * @param tenantId      - Required: Zone.tenantId is NOT NULL
 * @param fileId        - Required: Zone.fileId is NOT NULL (FK → File)
 */
export async function detectZones(
  pdfPath: string,
  bootstrapJobId: string,
  tenantId: string,
  fileId: string,
): Promise<DetectedZone[]> {
  logger.info(
    `[ZoneExtractor] Starting detection for job ${bootstrapJobId}`,
  );

  const response = await detectWithDocling(pdfPath, bootstrapJobId);

  const detectedZones: DetectedZone[] = response.zones.map((zone) => ({
    pageNumber: zone.page,
    bbox: zone.bbox,
    zoneType: mapDoclingLabel(zone.label),
    confidence: zone.confidence ?? 0.5,
    source: 'docling' as const,
    doclingLabel: zone.label,
  }));

  await prisma.$transaction([
    prisma.zoneBootstrapJob.update({
      where: { id: bootstrapJobId },
      data: { extractionMode: 'docling' },
    }),
    prisma.zone.createMany({
      data: detectedZones.map((z) => ({
        bootstrapJobId,
        tenantId,
        fileId,
        pageNumber: z.pageNumber,
        type: z.zoneType,
        bounds: z.bbox as unknown as Prisma.InputJsonValue,
        source: z.source,
        doclingLabel: z.doclingLabel,
        doclingConfidence: z.confidence,
      })),
    }),
  ]);

  logger.info(
    `[ZoneExtractor] Completed ${detectedZones.length} zones for job ${bootstrapJobId}`,
  );

  return detectedZones;
}
