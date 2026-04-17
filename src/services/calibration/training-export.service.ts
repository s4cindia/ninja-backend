/**
 * Training Export Service.
 * Queries annotated zones from DB and prepares data for
 * the YOLO training export pipeline (export.py).
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface TrainingExportDocument {
  documentId: string;
  pdfPath: string;
  publisher: string | null;
  contentType: string | null;
  zones: Array<{
    pageNumber: number;
    bounds: unknown;
    type: string;
    operatorLabel: string | null;
    decision: string | null;
    aiLabel: string | null;
    aiConfidence: number | null;
    aiDecision: string | null;
  }>;
}

export interface TrainingExportResult {
  documents: TrainingExportDocument[];
  stats: {
    totalDocuments: number;
    totalZones: number;
    zonesWithHumanLabel: number;
    zonesWithAiLabel: number;
    zonesRejected: number;
    byPublisher: Record<string, number>;
  };
}

export interface ExportOptions {
  documentIds?: string[];
  minConfidence?: number;
  includeAiOnly?: boolean; // include zones with only AI labels (no human review)
  split?: 'train' | 'val' | 'test'; // filter to specific split
}

/**
 * Query annotated zones from the database, ready for YOLO export.
 * Returns data in the format expected by export.py.
 */
export async function getTrainingExportData(
  options: ExportOptions = {},
): Promise<TrainingExportResult> {
  const { documentIds, minConfidence = 0, includeAiOnly = false } = options;

  // Get corpus documents with calibration runs
  const whereDoc: Record<string, unknown> = {};
  if (documentIds?.length) {
    whereDoc.id = { in: documentIds };
  }
  if (options.split) {
    whereDoc.trainingSplit = options.split;
  }

  const documents = await prisma.corpusDocument.findMany({
    where: whereDoc,
    select: {
      id: true,
      filename: true,
      s3Path: true,
      publisher: true,
      contentType: true,
      calibrationRuns: {
        orderBy: { runDate: 'desc' },
        take: 1,
        select: { id: true },
      },
    },
  });

  const result: TrainingExportDocument[] = [];
  let totalZones = 0;
  let zonesWithHumanLabel = 0;
  let zonesWithAiLabel = 0;
  let zonesRejected = 0;
  const byPublisher: Record<string, number> = {};

  for (const doc of documents) {
    const latestRun = doc.calibrationRuns[0];
    if (!latestRun) continue;

    // Build zone query — exclude ghosts, include zones with labels
    const zoneWhere: Record<string, unknown> = {
      calibrationRunId: latestRun.id,
      isGhost: false,
      bounds: { not: null as unknown },
    };

    // If not including AI-only zones, require a human decision
    if (!includeAiOnly) {
      zoneWhere.decision = { not: null };
    }

    const zones = await prisma.zone.findMany({
      where: zoneWhere,
      select: {
        pageNumber: true,
        bounds: true,
        type: true,
        operatorLabel: true,
        decision: true,
        aiLabel: true,
        aiConfidence: true,
        aiDecision: true,
      },
    });

    // Filter out rejected zones and low-confidence AI-only zones
    const exportZones = zones.filter((z) => {
      if (z.decision === 'REJECTED') { zonesRejected++; return false; }
      if (z.aiDecision === 'REJECTED' && !z.decision) { zonesRejected++; return false; }

      // If zone has no human decision and only AI, check confidence
      if (!z.decision && z.aiLabel) {
        if ((z.aiConfidence ?? 0) < minConfidence) return false;
      }

      return true;
    });

    if (exportZones.length === 0) continue;

    // Count stats
    for (const z of exportZones) {
      if (z.operatorLabel || z.decision) zonesWithHumanLabel++;
      if (z.aiLabel) zonesWithAiLabel++;
    }
    totalZones += exportZones.length;

    const pub = doc.publisher ?? 'unknown';
    byPublisher[pub] = (byPublisher[pub] ?? 0) + exportZones.length;

    result.push({
      documentId: doc.id,
      pdfPath: doc.s3Path,
      publisher: doc.publisher,
      contentType: doc.contentType,
      zones: exportZones,
    });
  }

  logger.info(
    `[training-export] Prepared ${result.length} documents, ${totalZones} zones ` +
    `(${zonesWithHumanLabel} human, ${zonesWithAiLabel} AI, ${zonesRejected} rejected)`,
  );

  return {
    documents: result,
    stats: {
      totalDocuments: result.length,
      totalZones,
      zonesWithHumanLabel,
      zonesWithAiLabel,
      zonesRejected,
      byPublisher,
    },
  };
}
