import prisma, { Prisma } from '../../lib/prisma';
import type { MAPResult } from './ml-metrics.types';

export interface MAPSnapshot {
  runId: string;
  runDate: Date;
  overallMAP: number;
  perClass: object;
}

export async function saveMapSnapshot(
  calibrationRunId: string,
  result: MAPResult,
): Promise<void> {
  await prisma.calibrationRun.update({
    where: { id: calibrationRunId },
    data: {
      mapSnapshot: result as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function getMapHistory(
  fromDate?: Date,
  toDate?: Date,
): Promise<MAPSnapshot[]> {
  const where: Prisma.CalibrationRunWhereInput = {
    mapSnapshot: { not: Prisma.DbNull },
  };

  if (fromDate || toDate) {
    where.completedAt = {};
    if (fromDate) (where.completedAt as Prisma.DateTimeNullableFilter).gte = fromDate;
    if (toDate) (where.completedAt as Prisma.DateTimeNullableFilter).lte = toDate;
  }

  const runs = await prisma.calibrationRun.findMany({
    where,
    select: {
      id: true,
      runDate: true,
      mapSnapshot: true,
    },
    orderBy: { completedAt: 'asc' },
  });

  return runs
    .filter((r) => r.mapSnapshot !== null)
    .map((r) => {
      const snapshot = r.mapSnapshot as unknown as MAPResult;
      return {
        runId: r.id,
        runDate: r.runDate,
        overallMAP: snapshot.overallMAP,
        perClass: snapshot.perClass,
      };
    });
}

export async function getMapSnapshot(
  calibrationRunId: string,
): Promise<MAPResult | null> {
  const run = await prisma.calibrationRun.findUnique({
    where: { id: calibrationRunId },
    select: { mapSnapshot: true },
  });

  if (!run || run.mapSnapshot === null) return null;

  return run.mapSnapshot as unknown as MAPResult;
}
