import prisma, { Prisma } from '../../lib/prisma';

export type CriterionStatus = 'GREEN' | 'AMBER' | 'RED';

export interface PhaseCriterion {
  id: string;
  label: string;
  status: CriterionStatus;
  currentValue: string;
  threshold: string;
  tooltip: string;
}

export interface PhaseGateStatus {
  criteria: PhaseCriterion[];
  overallStatus: CriterionStatus;
  readyForPhase2: boolean;
}

const ALL_ZONE_TYPES = [
  'paragraph', 'section-header', 'table', 'figure',
  'caption', 'footnote', 'header', 'footer',
];

export async function getPhaseGateStatus(): Promise<PhaseGateStatus> {
  const [latestMapRun, zoneCounts, publishers, contentTypes, spikeRun] =
    await Promise.all([
      // C1: latest CalibrationRun with mapSnapshot
      prisma.calibrationRun.findFirst({
        where: { mapSnapshot: { not: Prisma.DbNull } },
        orderBy: { completedAt: 'desc' },
        select: { mapSnapshot: true },
      }),
      // C2: confirmed zone counts by type
      prisma.zone.groupBy({
        by: ['type'],
        where: { operatorVerified: true, isArtefact: false },
        _count: { id: true },
      }),
      // C3: distinct publishers
      prisma.corpusDocument.findMany({
        select: { publisher: true },
        distinct: ['publisher'],
        where: { publisher: { not: null } },
      }),
      // C4: distinct content types
      prisma.corpusDocument.findMany({
        select: { contentType: true },
        distinct: ['contentType'],
        where: { contentType: { not: null } },
      }),
      // C5: latest pikepdf spike run
      prisma.calibrationRun.findFirst({
        where: { type: 'PIKE_PDF_SPIKE' },
        orderBy: { completedAt: 'desc' },
        select: { summary: true },
      }),
    ]);

  // --- C1: Overall mAP ≥75% ---
  let c1Status: CriterionStatus = 'RED';
  let c1Value = 'Not yet computed';
  const mapSnapshot = latestMapRun?.mapSnapshot as Record<string, unknown> | null;
  const overallMAP = typeof mapSnapshot?.overallMAP === 'number' ? mapSnapshot.overallMAP : null;
  if (overallMAP !== null) {
    c1Value = `${(overallMAP * 100).toFixed(1)}%`;
    if (overallMAP >= 0.75) c1Status = 'GREEN';
    else if (overallMAP >= 0.70) c1Status = 'AMBER';
  }

  // --- C2: All 8 zone types ≥30 confirmed instances ---
  const countMap = new Map<string, number>();
  for (const row of zoneCounts) {
    countMap.set(row.type, row._count.id);
  }
  const counts = ALL_ZONE_TYPES.map((t) => countMap.get(t) ?? 0);
  const minCount = Math.min(...counts);
  const typesAbove30 = counts.filter((c) => c >= 30).length;
  let c2Status: CriterionStatus = 'RED';
  if (minCount >= 30) c2Status = 'GREEN';
  else if (minCount >= 15) c2Status = 'AMBER';

  // --- C3: Publisher diversity ≥3 ---
  const publisherCount = publishers.length;
  let c3Status: CriterionStatus = 'RED';
  if (publisherCount >= 3) c3Status = 'GREEN';
  else if (publisherCount === 2) c3Status = 'AMBER';

  // --- C4: Content type diversity ≥3 ---
  const contentTypeCount = contentTypes.length;
  let c4Status: CriterionStatus = 'RED';
  if (contentTypeCount >= 3) c4Status = 'GREEN';
  else if (contentTypeCount === 2) c4Status = 'AMBER';

  // --- C5: Write quality pass rate ≥95% ---
  let c5Status: CriterionStatus = 'AMBER';
  let c5Value = 'Spike not yet run';
  let c5Tooltip = 'Run the pikepdf write spike (ML-3.8)';
  const spikeSummary = spikeRun?.summary as Record<string, unknown> | null;
  const passRate = typeof spikeSummary?.passRate === 'number' ? spikeSummary.passRate : null;
  if (passRate !== null) {
    c5Value = `${(passRate * 100).toFixed(1)}% pass rate`;
    if (passRate >= 0.95) {
      c5Status = 'GREEN';
      c5Tooltip = 'pikepdf write spike passed — ready for Phase 2';
    } else {
      c5Status = 'RED';
      c5Tooltip = 'pikepdf spike failed — review failure report';
    }
  }

  const criteria: PhaseCriterion[] = [
    {
      id: 'C1',
      label: 'Overall mAP ≥75%',
      status: c1Status,
      currentValue: c1Value,
      threshold: '75%',
      tooltip: 'Run POST /ml-metrics/metrics/map on a calibration run to compute mAP',
    },
    {
      id: 'C2',
      label: 'All 8 zone types ≥30 instances',
      status: c2Status,
      currentValue: `Min: ${minCount} instances (${typesAbove30}/8 types at target)`,
      threshold: '30 per zone type',
      tooltip: 'Requires operator annotation of 300+ pages',
    },
    {
      id: 'C3',
      label: 'Publisher diversity ≥3',
      status: c3Status,
      currentValue: `${publisherCount} publisher(s)`,
      threshold: '3 publishers',
      tooltip: 'Source documents from at least 3 publishers',
    },
    {
      id: 'C4',
      label: 'Content type diversity ≥3',
      status: c4Status,
      currentValue: `${contentTypeCount} content type(s)`,
      threshold: '3 content types',
      tooltip: 'Include table-heavy, figure-heavy, and text-dominant documents',
    },
    {
      id: 'C5',
      label: 'Write quality pass rate ≥95%',
      status: c5Status,
      currentValue: c5Value,
      threshold: '95% PAC 2024 pass rate',
      tooltip: c5Tooltip,
    },
  ];

  const allGreen = criteria.every((c) => c.status === 'GREEN');
  const anyRed = criteria.some((c) => c.status === 'RED');
  const overallStatus: CriterionStatus = allGreen ? 'GREEN' : anyRed ? 'RED' : 'AMBER';

  return { criteria, overallStatus, readyForPhase2: allGreen };
}
