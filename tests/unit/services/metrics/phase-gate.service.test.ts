import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCalibrationRunFindFirst = vi.fn();
const mockZoneGroupBy = vi.fn();
const mockCorpusDocumentFindMany = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      findFirst: (...args: unknown[]) => mockCalibrationRunFindFirst(...args),
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
  mapSnapshot?: Record<string, unknown> | null;
  zoneCounts?: number | Record<string, number>;
  publishers?: string[];
  contentTypes?: string[];
  spikeRun?: { summary: Record<string, unknown> } | null;
}

function setup(overrides: SetupOptions = {}) {
  const {
    mapSnapshot = null,
    zoneCounts = 20,
    publishers = ['Pub1', 'Pub2'],
    contentTypes = ['mixed', 'table-heavy'],
    spikeRun = null,
  } = overrides;

  // findFirst is called twice: once for mapSnapshot (C1), once for spike (C5)
  mockCalibrationRunFindFirst
    .mockResolvedValueOnce(mapSnapshot !== null ? { mapSnapshot } : null)
    .mockResolvedValueOnce(spikeRun);

  mockZoneGroupBy.mockResolvedValue(makeZoneCounts(zoneCounts));

  // findMany is called twice: once for publishers (C3), once for contentTypes (C4)
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
    expect(c1.currentValue).toBe('72.0%');
  });

  it('C1 RED when no mapSnapshot exists', async () => {
    setup({ mapSnapshot: null });

    const result = await getPhaseGateStatus();
    const c1 = result.criteria.find((c) => c.id === 'C1')!;
    expect(c1.status).toBe('RED');
    expect(c1.currentValue).toBe('Not yet computed');
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
