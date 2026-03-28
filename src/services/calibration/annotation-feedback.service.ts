/**
 * Annotation Feedback Service.
 * Tracks when humans override AI decisions, providing
 * data for prompt improvement and accuracy monitoring.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface AiFeedbackSummary {
  calibrationRunId: string;
  totalAiAnnotated: number;
  totalHumanOverrides: number;
  overrideRate: number;
  overridesByType: Array<{
    aiLabel: string;
    humanLabel: string;
    count: number;
  }>;
  overridesByDecision: {
    aiConfirmedHumanCorrected: number;
    aiConfirmedHumanRejected: number;
    aiCorrectedHumanConfirmed: number;
    aiCorrectedHumanCorrected: number; // corrected to different label
    aiCorrectedHumanRejected: number;
    aiRejectedHumanConfirmed: number;
    aiRejectedHumanCorrected: number;
  };
  averageOverriddenConfidence: number;
  confidenceDistribution: Array<{
    bucket: string;
    overrides: number;
    total: number;
    overrideRate: number;
  }>;
}

export async function getAnnotationFeedback(
  calibrationRunId: string,
): Promise<AiFeedbackSummary> {
  // Get all zones that were AI-annotated
  const aiZones = await prisma.zone.findMany({
    where: {
      calibrationRunId,
      aiDecision: { not: null },
      isGhost: false,
    },
    select: {
      id: true,
      type: true,
      decision: true,
      operatorLabel: true,
      verifiedBy: true,
      aiLabel: true,
      aiConfidence: true,
      aiDecision: true,
    },
  });

  // Find overrides: zones where human made a different decision than AI
  const overrides = aiZones.filter((z) => {
    if (!z.decision || !z.verifiedBy) return false;
    // If verified by AI, no human override happened
    if (z.verifiedBy.startsWith('ai:')) return false;
    // Human overrode if decision differs or label differs
    if (z.decision !== z.aiDecision) return true;
    if (z.decision === 'CORRECTED' && z.operatorLabel !== z.aiLabel) return true;
    if (z.decision === 'CONFIRMED' && z.operatorLabel && z.operatorLabel !== z.aiLabel) return true;
    return false;
  });

  // Override patterns by label
  const labelCounts = new Map<string, number>();
  for (const z of overrides) {
    const humanLabel = z.decision === 'REJECTED' ? 'REJECTED' : (z.operatorLabel ?? z.type);
    const aiLabel = z.aiDecision === 'REJECTED' ? 'REJECTED' : (z.aiLabel ?? z.type);
    const key = `${aiLabel}→${humanLabel}`;
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }

  const overridesByType = [...labelCounts.entries()]
    .map(([key, count]) => {
      const [aiLabel, humanLabel] = key.split('→');
      return { aiLabel, humanLabel, count };
    })
    .sort((a, b) => b.count - a.count);

  // Override patterns by decision type
  const byDecision = {
    aiConfirmedHumanCorrected: 0,
    aiConfirmedHumanRejected: 0,
    aiCorrectedHumanConfirmed: 0,
    aiCorrectedHumanCorrected: 0,
    aiCorrectedHumanRejected: 0,
    aiRejectedHumanConfirmed: 0,
    aiRejectedHumanCorrected: 0,
  };

  for (const z of overrides) {
    const ai = z.aiDecision;
    const human = z.decision;
    if (ai === 'CONFIRMED' && human === 'CORRECTED') byDecision.aiConfirmedHumanCorrected++;
    else if (ai === 'CONFIRMED' && human === 'REJECTED') byDecision.aiConfirmedHumanRejected++;
    else if (ai === 'CORRECTED' && human === 'CONFIRMED') byDecision.aiCorrectedHumanConfirmed++;
    else if (ai === 'CORRECTED' && human === 'CORRECTED') byDecision.aiCorrectedHumanCorrected++;
    else if (ai === 'CORRECTED' && human === 'REJECTED') byDecision.aiCorrectedHumanRejected++;
    else if (ai === 'REJECTED' && human === 'CONFIRMED') byDecision.aiRejectedHumanConfirmed++;
    else if (ai === 'REJECTED' && human === 'CORRECTED') byDecision.aiRejectedHumanCorrected++;
  }

  // Average confidence of overridden zones
  const overriddenConfs = overrides.map((z) => z.aiConfidence ?? 0);
  const avgOverriddenConf = overriddenConfs.length > 0
    ? overriddenConfs.reduce((a, b) => a + b, 0) / overriddenConfs.length
    : 0;

  // Confidence distribution of overrides
  const bucketDefs = [
    { label: '0.00-0.50', min: 0, max: 0.50 },
    { label: '0.50-0.70', min: 0.50, max: 0.70 },
    { label: '0.70-0.80', min: 0.70, max: 0.80 },
    { label: '0.80-0.90', min: 0.80, max: 0.90 },
    { label: '0.90-0.95', min: 0.90, max: 0.95 },
    { label: '0.95-1.00', min: 0.95, max: 1.01 },
  ];

  const confDist = bucketDefs.map((def) => {
    const inBucket = aiZones.filter(
      (z) => (z.aiConfidence ?? 0) >= def.min && (z.aiConfidence ?? 0) < def.max,
    );
    const overridesInBucket = overrides.filter(
      (z) => (z.aiConfidence ?? 0) >= def.min && (z.aiConfidence ?? 0) < def.max,
    );
    return {
      bucket: def.label,
      overrides: overridesInBucket.length,
      total: inBucket.length,
      overrideRate: inBucket.length > 0 ? overridesInBucket.length / inBucket.length : 0,
    };
  }).filter((b) => b.total > 0);

  logger.info(
    `[annotation-feedback] Run ${calibrationRunId}: ${overrides.length}/${aiZones.length} overrides ` +
    `(${(overrides.length / Math.max(aiZones.length, 1) * 100).toFixed(1)}%), avg conf ${avgOverriddenConf.toFixed(3)}`,
  );

  return {
    calibrationRunId,
    totalAiAnnotated: aiZones.length,
    totalHumanOverrides: overrides.length,
    overrideRate: aiZones.length > 0 ? overrides.length / aiZones.length : 0,
    overridesByType,
    overridesByDecision: byDecision,
    averageOverriddenConfidence: avgOverriddenConf,
    confidenceDistribution: confDist,
  };
}

/**
 * Get aggregate feedback across multiple calibration runs.
 */
export async function getAggregateFeedback(
  calibrationRunIds: string[],
): Promise<{
  runs: Array<{ calibrationRunId: string; overrideRate: number; totalZones: number }>;
  aggregate: {
    totalAiAnnotated: number;
    totalOverrides: number;
    overrideRate: number;
    topMistakes: Array<{ aiLabel: string; humanLabel: string; count: number }>;
  };
}> {
  const results = await Promise.all(
    calibrationRunIds.map((id) => getAnnotationFeedback(id)),
  );

  const totalAi = results.reduce((s, r) => s + r.totalAiAnnotated, 0);
  const totalOverrides = results.reduce((s, r) => s + r.totalHumanOverrides, 0);

  // Merge override patterns across runs
  const merged = new Map<string, number>();
  for (const r of results) {
    for (const o of r.overridesByType) {
      const key = `${o.aiLabel}→${o.humanLabel}`;
      merged.set(key, (merged.get(key) ?? 0) + o.count);
    }
  }

  const topMistakes = [...merged.entries()]
    .map(([key, count]) => {
      const [aiLabel, humanLabel] = key.split('→');
      return { aiLabel, humanLabel, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    runs: results.map((r) => ({
      calibrationRunId: r.calibrationRunId,
      overrideRate: r.overrideRate,
      totalZones: r.totalAiAnnotated,
    })),
    aggregate: {
      totalAiAnnotated: totalAi,
      totalOverrides: totalOverrides,
      overrideRate: totalAi > 0 ? totalOverrides / totalAi : 0,
      topMistakes,
    },
  };
}
