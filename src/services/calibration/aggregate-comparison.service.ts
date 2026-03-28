/**
 * Aggregate Comparison Service.
 * Cross-title comparison metrics across multiple calibration runs.
 * Used to evaluate overall AI annotation quality across the corpus.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface AggregateComparisonResult {
  totalRuns: number;
  totalComparableZones: number;
  overallAgreementRate: number;
  overallCohensKappa: number | null;
  perRunSummary: Array<{
    calibrationRunId: string;
    documentName: string;
    publisher: string | null;
    comparableZones: number;
    agreementRate: number;
    cohensKappa: number | null;
    createdAt: string;
  }>;
  perTypeAccuracy: Record<string, { agree: number; total: number; rate: number }>;
  perBucketAccuracy: Record<string, { agree: number; total: number; rate: number }>;
  perPublisherAccuracy: Record<string, { agree: number; total: number; rate: number }>;
  topMistakes: Array<{ from: string; to: string; count: number }>;
  promptVersionStats: Array<{
    promptVersion: string;
    runs: number;
    avgAgreementRate: number;
    avgCohensKappa: number | null;
  }>;
  timeSavingsEstimate: {
    avgHumanTimePerZoneMs: number | null;
    avgAiAssistedTimePerZoneMs: number | null;
    estimatedSpeedup: number | null;
  };
}

export async function getAggregateComparison(
  options: {
    documentIds?: string[];
    fromDate?: Date;
    toDate?: Date;
  } = {},
): Promise<AggregateComparisonResult> {
  // Find all completed comparisons
  const where: Record<string, unknown> = { status: 'COMPLETED' };

  if (options.documentIds?.length) {
    const runs = await prisma.calibrationRun.findMany({
      where: { documentId: { in: options.documentIds } },
      select: { id: true },
    });
    where.calibrationRunId = { in: runs.map((r) => r.id) };
  }
  if (options.fromDate) {
    where.createdAt = { ...(where.createdAt as Record<string, unknown> || {}), gte: options.fromDate };
  }
  if (options.toDate) {
    where.createdAt = { ...(where.createdAt as Record<string, unknown> || {}), lte: options.toDate };
  }

  const comparisons = await prisma.annotationComparison.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      calibrationRun: {
        select: {
          documentId: true,
          corpusDocument: { select: { filename: true, publisher: true } },
        },
      },
    },
  });

  if (comparisons.length === 0) {
    return emptyAggregate();
  }

  // Per-run summary
  const perRunSummary = comparisons.map((c) => ({
    calibrationRunId: c.calibrationRunId,
    documentName: c.calibrationRun.corpusDocument.filename,
    publisher: c.calibrationRun.corpusDocument.publisher,
    comparableZones: c.comparableZones,
    agreementRate: c.agreementRate,
    cohensKappa: c.cohensKappa,
    createdAt: c.createdAt.toISOString(),
  }));

  // Aggregate metrics from zone details
  const allDetails: Array<{
    type: string;
    reconciliationBucket: string | null;
    humanLabel: string;
    aiLabel: string;
    agrees: boolean;
    publisher: string | null;
  }> = [];

  for (const c of comparisons) {
    const details = (c.zoneDetails as Array<Record<string, unknown>>) ?? [];
    const publisher = c.calibrationRun.corpusDocument.publisher;
    for (const d of details) {
      allDetails.push({
        type: d.type as string,
        reconciliationBucket: d.reconciliationBucket as string | null,
        humanLabel: d.humanLabel as string,
        aiLabel: d.aiLabel as string,
        agrees: d.agrees as boolean,
        publisher,
      });
    }
  }

  const totalComparable = allDetails.length;
  const totalAgree = allDetails.filter((d) => d.agrees).length;
  const overallRate = totalComparable > 0 ? totalAgree / totalComparable : 0;

  // Per-type accuracy
  const perType = computeGroupedAccuracy(allDetails, (d) => d.type);

  // Per-bucket accuracy
  const perBucket = computeGroupedAccuracy(allDetails, (d) => d.reconciliationBucket ?? 'UNKNOWN');

  // Per-publisher accuracy
  const perPublisher = computeGroupedAccuracy(allDetails, (d) => d.publisher ?? 'unknown');

  // Top mistakes (merged across all runs)
  const mistakeCounts = new Map<string, number>();
  for (const d of allDetails) {
    if (!d.agrees) {
      const key = `${d.aiLabel}→${d.humanLabel}`;
      mistakeCounts.set(key, (mistakeCounts.get(key) ?? 0) + 1);
    }
  }
  const topMistakes = [...mistakeCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('→');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Prompt version stats
  const promptVersionStats = await getPromptVersionStats(
    comparisons.map((c) => c.calibrationRunId),
  );

  // Time savings estimate
  const timeSavings = await estimateTimeSavings(
    comparisons.map((c) => c.calibrationRunId),
  );

  // Overall kappa (weighted average)
  const kappaValues = comparisons
    .filter((c) => c.cohensKappa !== null)
    .map((c) => ({ kappa: c.cohensKappa!, weight: c.comparableZones }));
  const totalWeight = kappaValues.reduce((s, k) => s + k.weight, 0);
  const overallKappa = totalWeight > 0
    ? kappaValues.reduce((s, k) => s + k.kappa * k.weight, 0) / totalWeight
    : null;

  logger.info(
    `[aggregate-comparison] ${comparisons.length} runs, ${totalComparable} zones, ` +
    `${(overallRate * 100).toFixed(1)}% agreement, kappa=${overallKappa?.toFixed(3) ?? 'N/A'}`,
  );

  return {
    totalRuns: comparisons.length,
    totalComparableZones: totalComparable,
    overallAgreementRate: overallRate,
    overallCohensKappa: overallKappa,
    perRunSummary,
    perTypeAccuracy: perType,
    perBucketAccuracy: perBucket,
    perPublisherAccuracy: perPublisher,
    topMistakes,
    promptVersionStats,
    timeSavingsEstimate: timeSavings,
  };
}

function computeGroupedAccuracy<T extends { agrees: boolean }>(
  details: T[],
  keyFn: (d: T) => string,
): Record<string, { agree: number; total: number; rate: number }> {
  const groups = new Map<string, { agree: number; total: number }>();
  for (const d of details) {
    const key = keyFn(d);
    if (!groups.has(key)) groups.set(key, { agree: 0, total: 0 });
    const g = groups.get(key)!;
    g.total++;
    if (d.agrees) g.agree++;
  }
  const result: Record<string, { agree: number; total: number; rate: number }> = {};
  for (const [key, { agree, total }] of groups) {
    result[key] = { agree, total, rate: total > 0 ? agree / total : 0 };
  }
  return result;
}

async function getPromptVersionStats(
  calibrationRunIds: string[],
): Promise<AggregateComparisonResult['promptVersionStats']> {
  if (calibrationRunIds.length === 0) return [];

  const aiRuns = await prisma.aiAnnotationRun.findMany({
    where: {
      calibrationRunId: { in: calibrationRunIds },
      status: 'COMPLETED',
    },
    select: {
      promptVersion: true,
      calibrationRunId: true,
    },
  });

  const comparisons = await prisma.annotationComparison.findMany({
    where: {
      calibrationRunId: { in: calibrationRunIds },
      status: 'COMPLETED',
    },
    select: {
      calibrationRunId: true,
      agreementRate: true,
      cohensKappa: true,
    },
  });

  // Map runId → comparison
  const compMap = new Map(comparisons.map((c) => [c.calibrationRunId, c]));

  // Group by prompt version
  const byVersion = new Map<string, { rates: number[]; kappas: number[] }>();
  for (const run of aiRuns) {
    const version = run.promptVersion ?? 'unknown';
    if (!byVersion.has(version)) byVersion.set(version, { rates: [], kappas: [] });
    const comp = compMap.get(run.calibrationRunId);
    if (comp) {
      byVersion.get(version)!.rates.push(comp.agreementRate);
      if (comp.cohensKappa !== null) byVersion.get(version)!.kappas.push(comp.cohensKappa);
    }
  }

  return [...byVersion.entries()].map(([version, { rates, kappas }]) => ({
    promptVersion: version,
    runs: rates.length,
    avgAgreementRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0,
    avgCohensKappa: kappas.length > 0 ? kappas.reduce((a, b) => a + b, 0) / kappas.length : null,
  }));
}

async function estimateTimeSavings(
  calibrationRunIds: string[],
): Promise<AggregateComparisonResult['timeSavingsEstimate']> {
  if (calibrationRunIds.length === 0) {
    return { avgHumanTimePerZoneMs: null, avgAiAssistedTimePerZoneMs: null, estimatedSpeedup: null };
  }

  const sessions = await prisma.annotationSession.findMany({
    where: {
      calibrationRunId: { in: calibrationRunIds },
      endedAt: { not: null },
      zonesReviewed: { gt: 0 },
    },
    select: {
      activeMs: true,
      zonesReviewed: true,
      annotationMode: true,
    },
  });

  const blind = sessions.filter((s) => s.annotationMode === 'blind' || !s.annotationMode);
  const assisted = sessions.filter((s) => s.annotationMode === 'ai-assisted' || s.annotationMode === 'ai-review-only');

  const avgBlind = blind.length > 0
    ? blind.reduce((s, x) => s + x.activeMs / x.zonesReviewed, 0) / blind.length
    : null;
  const avgAssisted = assisted.length > 0
    ? assisted.reduce((s, x) => s + x.activeMs / x.zonesReviewed, 0) / assisted.length
    : null;

  const speedup = avgBlind && avgAssisted && avgAssisted > 0
    ? avgBlind / avgAssisted
    : null;

  return {
    avgHumanTimePerZoneMs: avgBlind ? Math.round(avgBlind) : null,
    avgAiAssistedTimePerZoneMs: avgAssisted ? Math.round(avgAssisted) : null,
    estimatedSpeedup: speedup ? Math.round(speedup * 100) / 100 : null,
  };
}

function emptyAggregate(): AggregateComparisonResult {
  return {
    totalRuns: 0,
    totalComparableZones: 0,
    overallAgreementRate: 0,
    overallCohensKappa: null,
    perRunSummary: [],
    perTypeAccuracy: {},
    perBucketAccuracy: {},
    perPublisherAccuracy: {},
    topMistakes: [],
    promptVersionStats: [],
    timeSavingsEstimate: {
      avgHumanTimePerZoneMs: null,
      avgAiAssistedTimePerZoneMs: null,
      estimatedSpeedup: null,
    },
  };
}
