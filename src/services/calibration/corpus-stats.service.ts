import prisma from '../../lib/prisma';

export interface CorpusStats {
  totalDocuments: number;
  totalRuns: number;
  totalConfirmedZones: number;
  averageAgreementRate: number;
  byPublisher: Record<string, number>;
  byContentType: Record<string, number>;
}

export async function getCorpusStats(): Promise<CorpusStats> {
  const [totalDocuments, totalRuns, totalConfirmedZones, runs, documents] =
    await Promise.all([
      prisma.corpusDocument.count(),
      prisma.calibrationRun.count({ where: { isArchived: false } }),
      prisma.zone.count({
        where: { operatorVerified: true, isArtefact: false },
      }),
      prisma.calibrationRun.findMany({
        where: { isArchived: false },
        select: { greenCount: true, amberCount: true, redCount: true },
      }),
      prisma.corpusDocument.findMany({
        select: { publisher: true, contentType: true },
      }),
    ]);

  // Average agreement rate
  let averageAgreementRate = 0;
  const rates: number[] = [];
  for (const run of runs) {
    const total =
      (run.greenCount ?? 0) + (run.amberCount ?? 0) + (run.redCount ?? 0);
    if (total > 0) {
      rates.push((run.greenCount ?? 0) / total);
    }
  }
  if (rates.length > 0) {
    const sum = rates.reduce((a, b) => a + b, 0);
    averageAgreementRate =
      Math.round((sum / rates.length) * 10000) / 10000;
  }

  // Group by publisher
  const byPublisher: Record<string, number> = {};
  for (const doc of documents) {
    if (doc.publisher != null) {
      byPublisher[doc.publisher] = (byPublisher[doc.publisher] ?? 0) + 1;
    }
  }

  // Group by contentType
  const byContentType: Record<string, number> = {};
  for (const doc of documents) {
    if (doc.contentType != null) {
      byContentType[doc.contentType] =
        (byContentType[doc.contentType] ?? 0) + 1;
    }
  }

  return {
    totalDocuments,
    totalRuns,
    totalConfirmedZones,
    averageAgreementRate,
    byPublisher,
    byContentType,
  };
}
