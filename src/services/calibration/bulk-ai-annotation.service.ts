/**
 * Bulk AI Annotation Service.
 * Runs AI annotation across multiple calibration runs sequentially,
 * useful for pre-annotating batches of titles.
 */
import prisma from '../../lib/prisma';
import { runAiAnnotation, type AiAnnotationOptions, type AiAnnotationResult } from './ai-annotation.service';
import { logger } from '../../lib/logger';

export interface BulkAiAnnotationOptions extends AiAnnotationOptions {
  documentIds?: string[];  // if provided, find latest runs for these docs
  runIds?: string[];       // if provided, annotate these specific runs
}

export interface BulkAiAnnotationResult {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  results: Array<{
    calibrationRunId: string;
    documentId: string;
    documentName: string;
    status: 'success' | 'failed' | 'skipped';
    result?: AiAnnotationResult;
    error?: string;
  }>;
  totalZones: number;
  totalAnnotated: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export async function runBulkAiAnnotation(
  options: BulkAiAnnotationOptions,
): Promise<BulkAiAnnotationResult> {
  const startTime = Date.now();

  // Resolve calibration run IDs
  let runs: Array<{ id: string; documentId: string; documentName: string }>;

  if (options.runIds?.length) {
    const dbRuns = await prisma.calibrationRun.findMany({
      where: { id: { in: options.runIds } },
      select: {
        id: true,
        documentId: true,
        corpusDocument: { select: { filename: true } },
      },
    });
    runs = dbRuns.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentName: r.corpusDocument.filename,
    }));
  } else if (options.documentIds?.length) {
    // Find latest calibration run for each document
    const docs = await prisma.corpusDocument.findMany({
      where: { id: { in: options.documentIds } },
      select: {
        id: true,
        filename: true,
        calibrationRuns: {
          orderBy: { runDate: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    runs = docs
      .filter((d) => d.calibrationRuns.length > 0)
      .map((d) => ({
        id: d.calibrationRuns[0].id,
        documentId: d.id,
        documentName: d.filename,
      }));
  } else {
    throw new Error('Either documentIds or runIds must be provided');
  }

  const results: BulkAiAnnotationResult['results'] = [];
  let completedRuns = 0;
  let failedRuns = 0;
  let totalZones = 0;
  let totalAnnotated = 0;
  let totalCost = 0;

  // Process sequentially to avoid rate limits
  for (const run of runs) {
    try {
      logger.info(`[bulk-ai-annotation] Processing ${run.documentName} (run ${run.id})`);

      const aiOptions: AiAnnotationOptions = {
        confidenceThreshold: options.confidenceThreshold,
        model: options.model,
        dryRun: options.dryRun,
      };

      const result = await runAiAnnotation(run.id, aiOptions);

      results.push({
        calibrationRunId: run.id,
        documentId: run.documentId,
        documentName: run.documentName,
        status: 'success',
        result,
      });

      totalZones += result.totalZones;
      totalAnnotated += result.annotatedZones;
      totalCost += result.estimatedCostUsd;
      completedRuns++;
    } catch (err) {
      logger.error(`[bulk-ai-annotation] Failed for ${run.documentName}: ${(err as Error).message}`);
      results.push({
        calibrationRunId: run.id,
        documentId: run.documentId,
        documentName: run.documentName,
        status: 'failed',
        error: (err as Error).message,
      });
      failedRuns++;
    }
  }

  const totalDurationMs = Date.now() - startTime;

  logger.info(
    `[bulk-ai-annotation] Complete: ${completedRuns}/${runs.length} runs, ` +
    `${totalAnnotated}/${totalZones} zones, $${totalCost.toFixed(4)}, ${totalDurationMs}ms`,
  );

  return {
    totalRuns: runs.length,
    completedRuns,
    failedRuns,
    results,
    totalZones,
    totalAnnotated,
    totalCostUsd: totalCost,
    totalDurationMs,
  };
}
