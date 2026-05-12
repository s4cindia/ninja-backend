import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCalibrationRunFindFirst = vi.fn();
const mockCalibrationRunFindMany = vi.fn();
const mockZoneGroupBy = vi.fn();
const mockCorpusDocumentFindMany = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      findFirst: (...args: unknown[]) => mockCalibrationRunFindFirst(...args),
      findMany: (...args: unknown[]) => mockCalibrationRunFindMany(...args),
    },
    zone: {
      groupBy: (...args: unknown[]) => mockZoneGroupBy(...args),
    },
    corpusDocument: {
      findMany: (...args: unknown[]) => mockCorpusDocumentFindMany(...args),
    },
  },
  Prisma: {
    DbNull: 'DbNull',
  },
}));

import { getPhaseGateStatus } from '../../../../src/services/metrics/phase-gate.service';

const ALL_TYPES = [
  'paragraph', 'section-header', 'table', 'figure',
  'caption', 'footnote', 'header', 'footer',
];

function makeZoneCounts(countPerType: number | Record<string, number>) {
  return ALL_TYPES.map((type) => ({
    type,
    _count: {
      id: typeof countPerType === 'number' ? countPerType : (countPerType[type] ?? 0),
    },
  }));
}

interface SetupOptions {
  // C1: either a single mAP (single-run convenience) or an explicit list of
  // recent runs ordered newest-first. Pass null/[] to simulate "no scored runs".
  mapSnapshot?: Record<string, unknown> | null;
  recentRuns?: { id: string; mapSnapshot: Record<string, unknown> }[];
  zoneCounts?: number | Record<string, number>;
  publishers?: string[];
  contentTypes?: string[];
  spikeRun?: { summary: Record<string, unknown> } | null;
}

function setup(overrides: SetupOptions = {}) {
  const {
    mapSnapshot = null,
    recentRuns,
    zoneCounts = 20,
    publishers = ['Pub1', 'Pub2'],
    contentTypes = ['mixed', 'table-heavy'],
    spikeRun = null,
  } = overrides;

  // C1 reads the N most-recent CalibrationRuns with a mapSnapshot.
  let runs: { id: string; mapSnapshot: Record<string, unknown> }[];
  if (recentRuns !== undefined) {
    runs = recentRuns;
  } else if (mapSnapshot !== null) {
    runs = [{ id: 'run-1', mapSnapshot }];
  } else {
    runs = [];
  }
  mockCalibrationRunFindMany.mockResolvedValue(runs);

  // C5 still uses findFirst (latest spike run).
  mockCalibrationRunFindFirst.mockResolvedValue(spikeRun);

  mockZoneGroupBy.mockResolvedValue(makeZoneCounts(zoneCounts));

  mockCorpusDocumentFindMany
    .mockResolvedValueOnce(publishers.map((p) => ({ publisher: p })))
    .mockResolvedValueOnce(contentTypes.map((c) => ({ contentType: c })));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPhaseGateStatus', () => {
  it('all GREEN when all criteria met', async () => {
    setup({
      mapSnapshot: { overallMAP: 0.80 },
      zoneCounts: 35,
      publishers: ['Pearson', 'Wiley', 'OUP'],
      contentTypes: ['table-heavy', 'figure-heavy', 'mixed'],
      spikeRun: { summary: { passRate: 0.97 } },
    });

    const result = await getPhaseGateStatus();
    expect(result.overallStatus).toBe('GREEN');
    expect(result.readyForPhase2).toBe(true);
    expect(result.criteria.every((c) => c.status === 'GREEN')).toBe(true);
  });

  it('C1 AMBER when mAP is 72%', async () => {
    setup({ mapSnapshot: { overallMAP: 0.72 } });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('AMBER');
    expect(c1.currentValue).toBe('72.0% (best of last 1)');
  });

  it('C1 RED when no mapSnapshot exists', async () => {
    setup({ recentRuns: [] });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('RED');
    expect(c1.currentValue).toBe('Not yet computed');
  });

  it('C1 picks the BEST mAP across recent runs, not the latest', async () => {
    // Newest-first ordering — latest run is 0.36 (RED if alone), but the
    // window contains a 0.78 run that should drive C1 to GREEN.
    setup({
      recentRuns: [
        { id: 'latest', mapSnapshot: { overallMAP: 0.36 } },
        { id: 'middle', mapSnapshot: { overallMAP: 0.78 } },
        { id: 'oldest', mapSnapshot: { overallMAP: 0.60 } },
      ],
    });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('GREEN');
    expect(c1.currentValue).toBe('78.0% (best of last 3)');
    expect(c1.tooltip).toContain('middle');
  });

  it('C1 RED when every recent run is below 70%', async () => {
    setup({
      recentRuns: [
        { id: 'r1', mapSnapshot: { overallMAP: 0.40 } },
        { id: 'r2', mapSnapshot: { overallMAP: 0.55 } },
        { id: 'r3', mapSnapshot: { overallMAP: 0.69 } },
      ],
    });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('RED');
    expect(c1.currentValue).toBe('69.0% (best of last 3)');
  });

  it('C1 ignores malformed snapshots and uses the best valid one', async () => {
    setup({
      recentRuns: [
        { id: 'malformed', mapSnapshot: { someOtherField: 1 } },
        { id: 'valid', mapSnapshot: { overallMAP: 0.74 } },
      ],
    });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('AMBER');
    expect(c1.currentValue).toBe('74.0% (best of last 2)');
  });

  it('C2 AMBER when some types below 30', async () => {
    const counts: Record<string, number> = {};
    for (const t of ALL_TYPES) counts[t] = 35;
    counts['footnote'] = 20;
    counts['caption'] = 20;
    setup({ zoneCounts: counts });

    const result = await getPhaseGateStatus();
    const c2 = result.criteria.find((c) => c.id === 'C2')!;
    expect(c2.status).toBe('AMBER');
    expect(c2.currentValue).toContain('Min: 20');
  });

  it('C2 RED when some types below 15', async () => {
    const counts: Record<string, number> = {};
    for (const t of ALL_TYPES) counts[t] = 35;
    counts['footnote'] = 3;
    setup({ zoneCounts: counts });

    const result = await getPhaseGateStatus();
    const c2 = result.criteria.find((c) => c.id === 'C2')!;
    expect(c2.status).toBe('RED');
  });

  it('C3 RED when only 1 publisher', async () => {
    setup({ publishers: ['Solo'] });

    const result = await getPhaseGateStatus();
    const c3 = result.criteria.find((c) => c.id === 'C3')!;
    expect(c3.status).toBe('RED');
  });

  it('C5 AMBER when no spike run exists', async () => {
    setup({ spikeRun: null });

    const result = await getPhaseGateStatus();
    const c5 = result.criteria.find((c) => c.id === 'C5')!;
    expect(c5.status).toBe('AMBER');
    expect(c5.currentValue).toBe('Spike not yet run');
  });

  it('C5 RED when spike failed (passRate 0.88)', async () => {
    setup({ spikeRun: { summary: { passRate: 0.88 } } });

    const result = await getPhaseGateStatus();
    const c5 = result.criteria.find((c) => c.id === 'C5')!;
    expect(c5.status).toBe('RED');
    expect(c5.currentValue).toBe('88.0% pass rate');
  });

  it('overallStatus RED when any criterion is RED', async () => {
    const counts: Record<string, number> = {};
    for (const t of ALL_TYPES) counts[t] = 3;
    setup({
      mapSnapshot: { overallMAP: 0.80 },
      zoneCounts: counts,
      publishers: ['Pearson', 'Wiley', 'OUP'],
      contentTypes: ['table-heavy', 'figure-heavy', 'mixed'],
      spikeRun: { summary: { passRate: 0.97 } },
    });

    const result = await getPhaseGateStatus();
    expect(result.overallStatus).toBe('RED');
    expect(result.readyForPhase2).toBe(false);
  });

  it('overallStatus AMBER when mix of GREEN and AMBER', async () => {
    setup({
      mapSnapshot: { overallMAP: 0.80 },
      zoneCounts: 35,
      publishers: ['Pearson', 'Wiley', 'OUP'],
      contentTypes: ['table-heavy', 'figure-heavy', 'mixed'],
      spikeRun: null, // C5 = AMBER
    });

    const result = await getPhaseGateStatus();
    expect(result.overallStatus).toBe('AMBER');
    expect(result.readyForPhase2).toBe(false);
  });
});
