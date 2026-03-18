import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import prisma from '../../lib/prisma';

const region = process.env.AWS_REGION ?? 'ap-south-1';
const ecsClient = new ECSClient({ region });
const ssmClient = new SSMClient({ region });

async function setSSMParameter(name: string, value: string): Promise<void> {
  await ssmClient.send(new PutParameterCommand({
    Name: name,
    Value: value,
    Type: 'String',
    Overwrite: true,
  }));
}

async function launchECSTask(): Promise<string> {
  const cluster = process.env.TRAINING_CLUSTER ?? 'ninja-staging';
  const res = await ecsClient.send(new RunTaskCommand({
    cluster,
    taskDefinition: 'ninja-training-service',
    launchType: 'EC2',
  }));
  return res.tasks?.[0]?.taskArn ?? 'unknown';
}

export async function startTraining(config: {
  corpusExportS3Path: string;
  modelVariant?: string;
}): Promise<string> {
  const modelVariant = config.modelVariant ?? 'yolov8m';

  const run = await prisma.trainingRun.create({
    data: {
      corpusExportS3Path: config.corpusExportS3Path,
      modelVariant,
      status: 'PENDING',
    },
  });
  const trainingRunId = run.id;
  const outputS3 = `s3://ninja-ml-models/${trainingRunId}`;

  await setSSMParameter('/ninja/training/corpus-s3-path', config.corpusExportS3Path);
  await setSSMParameter('/ninja/training/run-id', trainingRunId);
  await setSSMParameter('/ninja/training/output-s3-path', outputS3);

  await launchECSTask();

  await prisma.trainingRun.update({
    where: { id: trainingRunId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  return trainingRunId;
}

export async function onTrainingComplete(
  trainingRunId: string,
  success: boolean,
  resultData?: Record<string, unknown>,
): Promise<void> {
  if (success && resultData) {
    await prisma.trainingRun.update({
      where: { id: trainingRunId },
      data: {
        status: 'COMPLETED',
        mapResult: JSON.parse(JSON.stringify(resultData)),
        weightsS3Path: resultData.weightsS3 as string,
        onnxS3Path: resultData.onnxS3 as string,
        epochs: resultData.epochs as number,
        durationMs: resultData.durationMs as number,
        completedAt: new Date(),
      },
    });
  } else {
    await prisma.trainingRun.update({
      where: { id: trainingRunId },
      data: { status: 'FAILED', completedAt: new Date() },
    });
  }
}

export async function getTrainingStatus(
  trainingRunId: string,
): Promise<{ status: string; mapResult?: unknown } | null> {
  const run = await prisma.trainingRun.findUnique({
    where: { id: trainingRunId },
    select: { status: true, mapResult: true },
  });
  if (!run) return null;
  return {
    status: run.status,
    mapResult: run.mapResult ?? undefined,
  };
}
