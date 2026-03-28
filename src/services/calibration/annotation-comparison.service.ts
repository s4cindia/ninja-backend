/**
 * Annotation Comparison Service.
 * Compares human vs AI annotations for the same calibration run.
 * Computes agreement rate, Cohen's kappa, per-type accuracy,
 * confidence calibration, and common mistake patterns.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ZoneComparison {
  zoneId: string;
  pageNumber: number;
  type: string;
  reconciliationBucket: string | null;
  humanDecision: string;
  humanLabel: string;
  aiDecision: string;
  aiLabel: string;
  aiConfidence: number;
  agrees: boolean;
}

interface ConfidenceBucket {
  bucket: string;
  predicted: number;
  actual: number;
  count: number;
}

interface MistakePattern {
  from: string;
  to: string;
  count: number;
}

export interface ComparisonResult {
  comparisonId: string;
  calibrationRunId: string;
  totalZones: number;
  comparableZones: number;
  agreementCount: number;
  disagreementCount: number;
  agreementRate: number;
  cohensKappa: number | null;
  perTypeAccuracy: Record<string, number>;
  perBucketAccuracy: Record<string, number>;
  confidenceCalibration: ConfidenceBucket[];
  commonMistakes: MistakePattern[];
  zoneDetails: ZoneComparison[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function runAnnotationComparison(
  calibrationRunId: string,
): Promise<ComparisonResult> {
  const startTime = Date.now();

  const comparison = await prisma.annotationComparison.create({
    data: { calibrationRunId, status: 'RUNNING' },
  });

  try {
    // Fetch zones that have BOTH a human decision and an AI decision
    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId,
        decision: { not: null },
        aiDecision: { not: null },
        isGhost: false,
      },
      select: {
        id: true,
        pageNumber: true,
        type: true,
        label: true,
        reconciliationBucket: true,
        decision: true,
        operatorLabel: true,
        aiDecision: true,
        aiLabel: true,
        aiConfidence: true,
      },
    });

    // Also count total zones for context
    const totalZones = await prisma.zone.count({
      where: { calibrationRunId, isGhost: false },
    });

    if (zones.length === 0) {
      const result = emptyResult(comparison.id, calibrationRunId, totalZones, Date.now() - startTime);
      await persistResult(comparison.id, result);
      return result;
    }

    // Build zone-level comparisons
    const details: ZoneComparison[] = zones.map((z) => {
      const humanLabel = resolveHumanLabel(z);
      const aiLabel = z.aiLabel ?? z.type;
      const agrees =
        z.decision === z.aiDecision &&
        (z.decision === 'REJECTED' || humanLabel === aiLabel);

      return {
        zoneId: z.id,
        pageNumber: z.pageNumber,
        type: z.type,
        reconciliationBucket: z.reconciliationBucket,
        humanDecision: z.decision!,
        humanLabel,
        aiDecision: z.aiDecision!,
        aiLabel,
        aiConfidence: z.aiConfidence ?? 0,
        agrees,
      };
    });

    const agreementCount = details.filter((d) => d.agrees).length;
    const disagreementCount = details.length - agreementCount;
    const agreementRate = details.length > 0 ? agreementCount / details.length : 0;

    const kappa = computeCohensKappa(details);
    const perType = computePerTypeAccuracy(details);
    const perBucket = computePerBucketAccuracy(details);
    const confCal = computeConfidenceCalibration(details);
    const mistakes = computeCommonMistakes(details);

    const durationMs = Date.now() - startTime;

    const result: ComparisonResult = {
      comparisonId: comparison.id,
      calibrationRunId,
      totalZones,
      comparableZones: details.length,
      agreementCount,
      disagreementCount,
      agreementRate,
      cohensKappa: kappa,
      perTypeAccuracy: perType,
      perBucketAccuracy: perBucket,
      confidenceCalibration: confCal,
      commonMistakes: mistakes,
      zoneDetails: details,
      durationMs,
    };

    await persistResult(comparison.id, result);

    logger.info(
      `[annotation-comparison] Run ${comparison.id}: ${agreementCount}/${details.length} agree ` +
      `(${(agreementRate * 100).toFixed(1)}%), kappa=${kappa?.toFixed(3) ?? 'N/A'}, ${durationMs}ms`,
    );

    return result;
  } catch (err) {
    await prisma.annotationComparison.update({
      where: { id: comparison.id },
      data: {
        status: 'FAILED',
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
        completedAt: new Date(),
      },
    });
    throw err;
  }
}

export async function getComparisonReport(calibrationRunId: string) {
  const comparisons = await prisma.annotationComparison.findMany({
    where: { calibrationRunId },
    orderBy: { createdAt: 'desc' },
  });

  return { comparisons };
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the "final" human label for a zone.
 * If operator corrected, use operatorLabel; otherwise use original type.
 */
function resolveHumanLabel(z: {
  decision: string | null;
  operatorLabel: string | null;
  type: string;
}): string {
  if (z.decision === 'CORRECTED' && z.operatorLabel) return z.operatorLabel;
  return z.type;
}

/**
 * Cohen's kappa: measures inter-rater agreement beyond chance.
 * We treat the "effective label" (including REJECTED) as the category.
 */
function computeCohensKappa(details: ZoneComparison[]): number | null {
  if (details.length < 2) return null;

  const n = details.length;

  // Build effective labels: for REJECTED zones use "REJECTED", otherwise the label
  const humanLabels = details.map((d) =>
    d.humanDecision === 'REJECTED' ? '__REJECTED__' : d.humanLabel,
  );
  const aiLabels = details.map((d) =>
    d.aiDecision === 'REJECTED' ? '__REJECTED__' : d.aiLabel,
  );

  // Collect all categories
  const categories = new Set([...humanLabels, ...aiLabels]);

  // Observed agreement
  let po = 0;
  for (let i = 0; i < n; i++) {
    if (humanLabels[i] === aiLabels[i]) po++;
  }
  po /= n;

  // Expected agreement by chance
  let pe = 0;
  for (const cat of categories) {
    const humanCount = humanLabels.filter((l) => l === cat).length;
    const aiCount = aiLabels.filter((l) => l === cat).length;
    pe += (humanCount / n) * (aiCount / n);
  }

  if (pe >= 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

function computePerTypeAccuracy(details: ZoneComparison[]): Record<string, number> {
  const byType = new Map<string, { total: number; agree: number }>();

  for (const d of details) {
    const t = d.type;
    if (!byType.has(t)) byType.set(t, { total: 0, agree: 0 });
    const entry = byType.get(t)!;
    entry.total++;
    if (d.agrees) entry.agree++;
  }

  const result: Record<string, number> = {};
  for (const [type, { total, agree }] of byType) {
    result[type] = total > 0 ? agree / total : 0;
  }
  return result;
}

function computePerBucketAccuracy(details: ZoneComparison[]): Record<string, number> {
  const byBucket = new Map<string, { total: number; agree: number }>();

  for (const d of details) {
    const b = d.reconciliationBucket ?? 'UNKNOWN';
    if (!byBucket.has(b)) byBucket.set(b, { total: 0, agree: 0 });
    const entry = byBucket.get(b)!;
    entry.total++;
    if (d.agrees) entry.agree++;
  }

  const result: Record<string, number> = {};
  for (const [bucket, { total, agree }] of byBucket) {
    result[bucket] = total > 0 ? agree / total : 0;
  }
  return result;
}

/**
 * Confidence calibration: bucket AI confidence into ranges
 * and check whether the actual agreement rate matches.
 */
function computeConfidenceCalibration(details: ZoneComparison[]): ConfidenceBucket[] {
  const bucketDefs = [
    { label: '0.00-0.50', min: 0, max: 0.50 },
    { label: '0.50-0.70', min: 0.50, max: 0.70 },
    { label: '0.70-0.80', min: 0.70, max: 0.80 },
    { label: '0.80-0.90', min: 0.80, max: 0.90 },
    { label: '0.90-0.95', min: 0.90, max: 0.95 },
    { label: '0.95-1.00', min: 0.95, max: 1.01 },
  ];

  return bucketDefs
    .map((def) => {
      const inBucket = details.filter(
        (d) => d.aiConfidence >= def.min && d.aiConfidence < def.max,
      );
      if (inBucket.length === 0) return null;

      const avgConf =
        inBucket.reduce((sum, d) => sum + d.aiConfidence, 0) / inBucket.length;
      const actualAgreement =
        inBucket.filter((d) => d.agrees).length / inBucket.length;

      return {
        bucket: def.label,
        predicted: Math.round(avgConf * 1000) / 1000,
        actual: Math.round(actualAgreement * 1000) / 1000,
        count: inBucket.length,
      };
    })
    .filter((b): b is ConfidenceBucket => b !== null);
}

/**
 * Most common AI→human label disagreements.
 */
function computeCommonMistakes(details: ZoneComparison[]): MistakePattern[] {
  const disagreements = details.filter((d) => !d.agrees);
  const counts = new Map<string, number>();

  for (const d of disagreements) {
    const aiEff = d.aiDecision === 'REJECTED' ? 'REJECTED' : d.aiLabel;
    const humanEff = d.humanDecision === 'REJECTED' ? 'REJECTED' : d.humanLabel;
    const key = `${aiEff}→${humanEff}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('→');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistResult(comparisonId: string, result: ComparisonResult) {
  await prisma.annotationComparison.update({
    where: { id: comparisonId },
    data: {
      status: 'COMPLETED',
      totalZones: result.totalZones,
      comparableZones: result.comparableZones,
      agreementCount: result.agreementCount,
      disagreementCount: result.disagreementCount,
      agreementRate: result.agreementRate,
      cohensKappa: result.cohensKappa,
      perTypeAccuracy: result.perTypeAccuracy,
      perBucketAccuracy: result.perBucketAccuracy,
      confidenceCalibration: result.confidenceCalibration,
      commonMistakes: result.commonMistakes,
      zoneDetails: result.zoneDetails,
      durationMs: result.durationMs,
      completedAt: new Date(),
    },
  });
}

function emptyResult(
  comparisonId: string,
  calibrationRunId: string,
  totalZones: number,
  durationMs: number,
): ComparisonResult {
  return {
    comparisonId,
    calibrationRunId,
    totalZones,
    comparableZones: 0,
    agreementCount: 0,
    disagreementCount: 0,
    agreementRate: 0,
    cohensKappa: null,
    perTypeAccuracy: {},
    perBucketAccuracy: {},
    confidenceCalibration: [],
    commonMistakes: [],
    zoneDetails: [],
    durationMs,
  };
}
