import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import prisma, { Prisma } from '../../lib/prisma';

const ssmClient = new SSMClient({
  region: process.env.AWS_REGION ?? 'ap-south-1',
});

const CLASS_NAMES = [
  'paragraph', 'section-header', 'table', 'figure',
  'caption', 'footnote', 'header', 'footer',
];

export interface PerClassDelta {
  className: string;
  fineTuned: number;
  base: number;
  delta: number;
}

export interface EvaluationResult {
  trainingRunId: string;
  fineTunedOverallMAP: number;
  baseOverallMAP: number;
  overallDelta: number;
  perClassDeltas: PerClassDelta[];
  promotionRecommendation: 'PROCEED' | 'HOLD';
  holdReason?: string;
}

export async function evaluateTrainingRun(
  trainingRunId: string,
): Promise<EvaluationResult> {
  // 1. Fetch TrainingRun
  const run = await prisma.trainingRun.findUnique({
    where: { id: trainingRunId },
  });
  if (!run) throw new Error(`TrainingRun not found: ${trainingRunId}`);
  if (run.status !== 'COMPLETED') {
    throw new Error(`TrainingRun is not COMPLETED (status: ${run.status})`);
  }

  // 2. Extract fine-tuned mAP from mapResult
  const mapResult = (run.mapResult as Record<string, unknown>) ?? {};
  const fineTunedOverallMAP = (mapResult.overallMAP as number) ?? 0;
  const fineTunedPerClass = (mapResult.perClassAP as Record<string, number>) ?? {};

  // 3. Base Docling mAP from latest CalibrationRun
  const latestCalibration = await prisma.calibrationRun.findFirst({
    where: { mapSnapshot: { not: Prisma.DbNull } },
    orderBy: { completedAt: 'desc' },
  });
  const baseMapSnapshot = (latestCalibration?.mapSnapshot as Record<string, unknown>) ?? {};
  const baseOverallMAP = (baseMapSnapshot.overallMAP as number) ?? 0;
  const basePerClass = (baseMapSnapshot.perClassAP as Record<string, number>) ?? {};

  // 4. Per-class deltas
  const perClassDeltas: PerClassDelta[] = CLASS_NAMES.map((name) => ({
    className: name,
    fineTuned: fineTunedPerClass[name] ?? 0,
    base: basePerClass[name] ?? 0,
    delta: (fineTunedPerClass[name] ?? 0) - (basePerClass[name] ?? 0),
  }));

  // 5. Decision logic
  const overallDelta = fineTunedOverallMAP - baseOverallMAP;
  const worstRegression = Math.max(0, ...perClassDeltas.map((d) => -d.delta));

  let promotionRecommendation: 'PROCEED' | 'HOLD';
  let holdReason: string | undefined;

  if (overallDelta < 0.005) {
    promotionRecommendation = 'HOLD';
    holdReason =
      `Overall mAP improvement ${(overallDelta * 100).toFixed(2)}%`
      + ` is below 0.5% threshold`;
  } else if (worstRegression > 0.02) {
    const worstClass = perClassDeltas.find((d) => -d.delta === worstRegression);
    promotionRecommendation = 'HOLD';
    holdReason =
      `Class '${worstClass?.className}' regressed `
      + `${(worstRegression * 100).toFixed(2)}%`
      + ` (max allowed: 2%)`;
  } else {
    promotionRecommendation = 'PROCEED';
  }

  // 6. Persist
  const evalResult: EvaluationResult = {
    trainingRunId,
    fineTunedOverallMAP,
    baseOverallMAP,
    overallDelta,
    perClassDeltas,
    promotionRecommendation,
    holdReason,
  };
  await prisma.trainingRun.update({
    where: { id: trainingRunId },
    data: {
      evaluationResult: evalResult as unknown as Prisma.InputJsonValue,
      promotionRecommendation,
    },
  });

  return evalResult;
}

export async function promoteTrainingRun(
  trainingRunId: string,
  promotedBy: string,
): Promise<{ promotedRunId: string; onnxPath: string }> {
  const run = await prisma.trainingRun.findUnique({
    where: { id: trainingRunId },
  });
  if (!run) throw new Error(`TrainingRun not found: ${trainingRunId}`);
  if (!run.onnxS3Path) {
    throw new Error('TrainingRun has no ONNX path — cannot promote');
  }

  // Update SSM
  await ssmClient.send(new PutParameterCommand({
    Name: '/ninja/zone-extractor/model-weights-path',
    Value: run.onnxS3Path,
    Type: 'String',
    Overwrite: true,
  }));

  // Supersede previous promoted runs
  await prisma.trainingRun.updateMany({
    where: {
      promotedAt: { not: null },
      id: { not: trainingRunId },
    },
    data: { promotionRecommendation: 'SUPERSEDED' },
  });

  // Mark this run promoted
  await prisma.trainingRun.update({
    where: { id: trainingRunId },
    data: { promotedAt: new Date(), promotedBy },
  });

  return {
    promotedRunId: trainingRunId,
    onnxPath: run.onnxS3Path,
  };
}

export async function rollbackTrainingRun(
  trainingRunId: string,
): Promise<{ rolledBackTo: string }> {
  const run = await prisma.trainingRun.findUnique({
    where: { id: trainingRunId },
  });
  if (!run?.onnxS3Path) {
    throw new Error('TrainingRun not found or has no ONNX path');
  }

  await ssmClient.send(new PutParameterCommand({
    Name: '/ninja/zone-extractor/model-weights-path',
    Value: run.onnxS3Path,
    Type: 'String',
    Overwrite: true,
  }));

  return { rolledBackTo: trainingRunId };
}
