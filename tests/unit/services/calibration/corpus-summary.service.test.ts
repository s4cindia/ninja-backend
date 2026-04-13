import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Prisma mock ───────────────────────────────────────────────────────
const mockCalibrationRunFindMany = vi.fn();
const mockUserFindMany = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    calibrationRun: {
      findMany: (...args: unknown[]) => mockCalibrationRunFindMany(...args),
    },
    user: {
      findMany: (...args: unknown[]) => mockUserFindMany(...args),
    },
  },
}));

import {
  getLineageSummary,
  getTimesheetSummary,
  ANNOTATOR_RATE_INR_PER_HOUR,
} from '../../../../src/services/calibration/corpus-summary.service';

// ── Fixtures ─────────────────────────────────────────────────────────
const RANGE = {
  from: new Date('2026-04-01T00:00:00.000Z'),
  to: new Date('2026-04-13T23:59:59.999Z'),
};

/** Minimal zone factory. */
function zone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `z-${Math.random().toString(36).slice(2, 8)}`,
    pageNumber: 1,
    type: 'Text',
    operatorLabel: null,
    decision: null,
    verifiedBy: null,
    aiLabel: null,
    aiDecision: null,
    aiConfidence: null,
    reconciliationBucket: null,
    doclingLabel: null,
    pdfxtLabel: null,
    ...overrides,
  };
}

/** Minimal session factory — activeMs in ms. */
function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operatorId: 'op-alice',
    startedAt: new Date('2026-04-05T09:00:00Z'),
    endedAt: new Date('2026-04-05T10:00:00Z'),
    activeMs: 60 * 60 * 1000, // 1 hour
    idleMs: 0,
    zonesReviewed: 0,
    zonesConfirmed: 0,
    zonesCorrected: 0,
    zonesRejected: 0,
    sessionLog: null,
    ...overrides,
  };
}

/** Run with completedAt, zones, sessions, and issue count. */
function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    completedAt: new Date('2026-04-05T10:00:00Z'),
    corpusDocument: { filename: 'Book A.pdf', pageCount: 100 },
    zones: [],
    annotationSessions: [],
    issues: [],
    _count: { issues: 0 },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  mockUserFindMany.mockResolvedValue([]);
});

describe('getTimesheetSummary', () => {
  it('empty range returns a valid zeroed envelope (not a 404 or throw)', async () => {
    mockCalibrationRunFindMany.mockResolvedValue([]);

    const result = await getTimesheetSummary(RANGE);

    expect(result.runsIncluded).toBe(0);
    expect(result.totals).toEqual({
      wallClockHours: 0,
      activeHours: 0,
      idleHours: 0,
      zonesReviewed: 0,
      zonesPerHour: 0,
      annotatorCostInr: 0,
    });
    expect(result.perOperator).toEqual([]);
    expect(result.perTitle).toEqual([]);
    expect(result.perZoneType).toEqual([]);
    // Throughput trend still emits one bucket per UTC day in the range.
    expect(result.throughputTrend.length).toBeGreaterThan(0);
    expect(result.throughputTrend.every(d => d.activeHours === 0)).toBe(true);
  });

  it('passes completedAt filter for the supplied range to Prisma', async () => {
    mockCalibrationRunFindMany.mockResolvedValue([]);

    await getTimesheetSummary(RANGE);

    const call = mockCalibrationRunFindMany.mock.calls[0]![0] as {
      where: { completedAt: { gte: Date; lte: Date; not: null } };
    };
    expect(call.where.completedAt.gte).toEqual(RANGE.from);
    expect(call.where.completedAt.lte).toEqual(RANGE.to);
    expect(call.where.completedAt.not).toBeNull();
  });

  // ── Cost parity ──────────────────────────────────────────────────
  // This is the load-bearing invariant the whole PR #2 hinges on. If
  // per-run and per-corpus costs ever diverge, the rate discrepancy will
  // surface immediately in the finance report. These assertions exist so
  // nobody can "simplify" the formula without tripping a loud test.
  describe('cost-parity invariant (ANNOTATOR_RATE_INR_PER_HOUR × sum(activeMs) / 3_600_000)', () => {
    it('constant matches the value the spec and per-run path use', () => {
      expect(ANNOTATOR_RATE_INR_PER_HOUR).toBe(400);
    });

    it('perTitle[i].costInr = (sum of session activeMs for that run) / 3_600_000 × 400', async () => {
      // Run A: two sessions totaling 2.5h → expect ₹1000
      // Run B: one session of 45 minutes → expect ₹300
      const runA = makeRun({
        id: 'run-A',
        corpusDocument: { filename: 'Alpha.pdf', pageCount: 50 },
        annotationSessions: [
          session({ operatorId: 'op-alice', activeMs: 90 * 60 * 1000, zonesReviewed: 30 }),
          session({ operatorId: 'op-bob', activeMs: 60 * 60 * 1000, zonesReviewed: 20 }),
        ],
        _count: { issues: 2 },
      });
      const runB = makeRun({
        id: 'run-B',
        corpusDocument: { filename: 'Beta.pdf', pageCount: 75 },
        annotationSessions: [
          session({ operatorId: 'op-alice', activeMs: 45 * 60 * 1000, zonesReviewed: 10 }),
        ],
        _count: { issues: 0 },
      });
      mockCalibrationRunFindMany.mockResolvedValue([runA, runB]);

      const result = await getTimesheetSummary(RANGE);

      const byName = new Map(result.perTitle.map(t => [t.documentName, t]));
      const alpha = byName.get('Alpha.pdf')!;
      const beta = byName.get('Beta.pdf')!;

      expect(alpha.activeHours).toBeCloseTo(2.5, 6);
      expect(alpha.costInr).toBeCloseTo(2.5 * ANNOTATOR_RATE_INR_PER_HOUR, 6);
      expect(alpha.costInr).toBeCloseTo(1000, 6);

      expect(beta.activeHours).toBeCloseTo(0.75, 6);
      expect(beta.costInr).toBeCloseTo(0.75 * ANNOTATOR_RATE_INR_PER_HOUR, 6);
      expect(beta.costInr).toBeCloseTo(300, 6);
    });

    it('totals.annotatorCostInr = sum(perTitle.costInr) — per-run and per-corpus paths cannot drift', async () => {
      const runA = makeRun({
        id: 'run-A',
        corpusDocument: { filename: 'Alpha.pdf', pageCount: 50 },
        annotationSessions: [
          session({ operatorId: 'op-alice', activeMs: 90 * 60 * 1000 }),
          session({ operatorId: 'op-bob', activeMs: 60 * 60 * 1000 }),
        ],
      });
      const runB = makeRun({
        id: 'run-B',
        corpusDocument: { filename: 'Beta.pdf', pageCount: 75 },
        annotationSessions: [session({ operatorId: 'op-alice', activeMs: 45 * 60 * 1000 })],
      });
      mockCalibrationRunFindMany.mockResolvedValue([runA, runB]);

      const result = await getTimesheetSummary(RANGE);

      const sumOfTitleCosts = result.perTitle.reduce((s, t) => s + t.costInr, 0);
      expect(result.totals.annotatorCostInr).toBeCloseTo(sumOfTitleCosts, 6);

      // And the overall total must equal totalActiveHours × 400
      expect(result.totals.annotatorCostInr).toBeCloseTo(
        result.totals.activeHours * ANNOTATOR_RATE_INR_PER_HOUR,
        6,
      );

      // Sanity: total = 3.25h × 400 = ₹1300
      expect(result.totals.annotatorCostInr).toBeCloseTo(1300, 6);
    });

    it('perOperator[i].costInr = operator.activeHours × 400 (no hidden multipliers)', async () => {
      const run = makeRun({
        annotationSessions: [
          session({ operatorId: 'op-alice', activeMs: 120 * 60 * 1000 }), // 2h
          session({ operatorId: 'op-bob', activeMs: 30 * 60 * 1000 }), //   0.5h
        ],
      });
      mockCalibrationRunFindMany.mockResolvedValue([run]);

      const result = await getTimesheetSummary(RANGE);
      for (const op of result.perOperator) {
        expect(op.costInr).toBeCloseTo(op.activeHours * ANNOTATOR_RATE_INR_PER_HOUR, 6);
      }
      // Labels resolve to UUID since user lookup returned [] — fine, we key on activeHours
      const alice = result.perOperator.find(o => o.activeHours === 2)!;
      const bob = result.perOperator.find(o => o.activeHours === 0.5)!;
      expect(alice.costInr).toBeCloseTo(800, 6);
      expect(bob.costInr).toBeCloseTo(200, 6);
    });
  });

  it('per-operator rolls up sessions across multiple runs', async () => {
    const runA = makeRun({
      id: 'run-A',
      annotationSessions: [
        session({
          operatorId: 'op-alice',
          activeMs: 60 * 60 * 1000,
          zonesReviewed: 10,
          zonesConfirmed: 8,
          zonesCorrected: 2,
          zonesRejected: 0,
        }),
      ],
    });
    const runB = makeRun({
      id: 'run-B',
      corpusDocument: { filename: 'Beta.pdf', pageCount: 50 },
      annotationSessions: [
        session({
          operatorId: 'op-alice',
          activeMs: 30 * 60 * 1000,
          zonesReviewed: 5,
          zonesConfirmed: 3,
          zonesCorrected: 1,
          zonesRejected: 1,
        }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([runA, runB]);

    const result = await getTimesheetSummary(RANGE);
    expect(result.perOperator).toHaveLength(1);
    const op = result.perOperator[0]!;
    expect(op.activeHours).toBeCloseTo(1.5, 6);
    expect(op.zonesReviewed).toBe(15);
    expect(op.runsContributedTo).toBe(2);
    // confirm/correct/reject percentages across combined decisions (11 conf, 3 corr, 1 rej = 15 decided)
    expect(op.confirmPct).toBeCloseTo((11 / 15) * 100, 6);
    expect(op.correctPct).toBeCloseTo((3 / 15) * 100, 6);
    expect(op.rejectPct).toBeCloseTo((1 / 15) * 100, 6);
  });

  it('perZoneType avgSecondsPerZone apportions totalActiveMs across decided zones', async () => {
    // 1 run, 1h active, 4 decided zones (3 Text + 1 Heading) and 1 undecided zone.
    // Expected share: Text gets 3/4 of 3600s = 2700s → 900s/zone.
    //                 Heading gets 1/4 of 3600s = 900s → 900s/zone.
    const run = makeRun({
      zones: [
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
        zone({ type: 'Text', decision: 'CORRECTED', operatorLabel: 'Heading', verifiedBy: 'op-alice' }),
        zone({ type: 'Heading', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
        zone({ type: 'Text' }), // undecided → excluded
      ],
      annotationSessions: [session({ activeMs: 60 * 60 * 1000 })],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getTimesheetSummary(RANGE);
    const byType = new Map(result.perZoneType.map(r => [r.zoneType, r]));
    expect(byType.get('Text')!.totalZones).toBe(3);
    expect(byType.get('Text')!.avgSecondsPerZone).toBeCloseTo(900, 3);
    expect(byType.get('Heading')!.totalZones).toBe(1);
    expect(byType.get('Heading')!.avgSecondsPerZone).toBeCloseTo(900, 3);
  });

  it('perZoneType ignores active time from runs with zero decided zones', async () => {
    // Run A: 1h active, 2 decided Text zones (operator-verified).
    // Run B: 1h active, ZERO decided zones — an abandoned/QA-only run.
    // Regression: previously runB's 1h was apportioned across runA's zones,
    // inflating avgSecondsPerZone from 1800s to 3600s.
    const runA = makeRun({
      id: 'run-A',
      zones: [
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
      ],
      annotationSessions: [session({ activeMs: 60 * 60 * 1000 })],
    });
    const runB = makeRun({
      id: 'run-B',
      corpusDocument: { filename: 'Abandoned.pdf', pageCount: 10 },
      zones: [], // nothing decided
      annotationSessions: [session({ activeMs: 60 * 60 * 1000 })],
    });
    mockCalibrationRunFindMany.mockResolvedValue([runA, runB]);

    const result = await getTimesheetSummary(RANGE);
    const text = result.perZoneType.find(r => r.zoneType === 'Text')!;
    expect(text.totalZones).toBe(2);
    // 1h active / 2 zones = 1800s per zone. runB's hour does NOT contribute.
    expect(text.avgSecondsPerZone).toBeCloseTo(1800, 3);
  });

  it('totals.wallClockHours sums per-session durations, not range span', async () => {
    // Two 1-hour sessions 24 hours apart. A naive max(endedAt)-min(startedAt)
    // would report ~25h. Correct answer is 2h: the gap between sessions is
    // not work time.
    const run = makeRun({
      annotationSessions: [
        session({
          startedAt: new Date('2026-04-05T09:00:00Z'),
          endedAt: new Date('2026-04-05T10:00:00Z'),
          activeMs: 60 * 60 * 1000,
        }),
        session({
          operatorId: 'op-bob',
          startedAt: new Date('2026-04-06T09:00:00Z'),
          endedAt: new Date('2026-04-06T10:00:00Z'),
          activeMs: 60 * 60 * 1000,
        }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getTimesheetSummary(RANGE);
    expect(result.totals.wallClockHours).toBeCloseTo(2, 6);
    expect(result.totals.activeHours).toBeCloseTo(2, 6);
  });

  it('auto-annotated zones are excluded from perZoneType apportionment', async () => {
    const run = makeRun({
      zones: [
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'op-alice' }),
        zone({ type: 'Text', decision: 'CONFIRMED', verifiedBy: 'auto-annotation' }),
      ],
      annotationSessions: [session({ activeMs: 60 * 60 * 1000 })],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getTimesheetSummary(RANGE);
    const text = result.perZoneType.find(r => r.zoneType === 'Text')!;
    // Only 1 operator-decided zone → whole 3600s attributed to it.
    expect(text.totalZones).toBe(1);
    expect(text.avgSecondsPerZone).toBeCloseTo(3600, 3);
  });

  it('throughputTrend attributes sessions to UTC end-day', async () => {
    const run = makeRun({
      annotationSessions: [
        session({
          operatorId: 'op-alice',
          startedAt: new Date('2026-04-05T23:30:00Z'),
          endedAt: new Date('2026-04-06T00:30:00Z'), // crosses midnight UTC
          activeMs: 60 * 60 * 1000,
          zonesReviewed: 20,
        }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getTimesheetSummary(RANGE);
    const byDate = new Map(result.throughputTrend.map(d => [d.date, d]));
    // Session attributed to endedAt day (2026-04-06), not startedAt day.
    expect(byDate.get('2026-04-06')!.zonesReviewed).toBe(20);
    expect(byDate.get('2026-04-06')!.activeHours).toBeCloseTo(1, 6);
    expect(byDate.get('2026-04-05')!.zonesReviewed).toBe(0);
  });

  it('resolves operator display names from User table when available', async () => {
    const run = makeRun({
      annotationSessions: [session({ operatorId: 'user-uuid-1', activeMs: 60 * 60 * 1000 })],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);
    mockUserFindMany.mockResolvedValue([
      { id: 'user-uuid-1', firstName: 'Alice', lastName: 'Example', email: 'alice@example.com' },
    ]);

    const result = await getTimesheetSummary(RANGE);
    expect(result.perOperator[0]!.operator).toBe('Alice Example');
  });
});

describe('getLineageSummary', () => {
  it('empty range returns a zeroed envelope', async () => {
    mockCalibrationRunFindMany.mockResolvedValue([]);

    const result = await getLineageSummary(RANGE);
    expect(result.runsIncluded).toBe(0);
    expect(result.headline.totalZones).toBe(0);
    expect(result.headline.aiAgreementRate).toBe(0);
    expect(result.confusionMatrix.labels).toEqual([]);
    expect(result.issuesLog).toEqual([]);
  });

  it('passes completedAt filter for the supplied range to Prisma', async () => {
    mockCalibrationRunFindMany.mockResolvedValue([]);
    await getLineageSummary(RANGE);
    const call = mockCalibrationRunFindMany.mock.calls[0]![0] as {
      where: { completedAt: { gte: Date; lte: Date; not: null } };
    };
    expect(call.where.completedAt.gte).toEqual(RANGE.from);
    expect(call.where.completedAt.lte).toEqual(RANGE.to);
  });

  it('headline.aiAgreementRate excludes zones without both aiLabel and finalLabel', async () => {
    // 4 zones:
    //   A: aiLabel=Text, CONFIRMED Text → agreement denominator +1, numerator +1
    //   B: aiLabel=Text, CORRECTED Heading → denom +1, num 0
    //   C: aiLabel=null, CONFIRMED Text → excluded (no AI label)
    //   D: aiLabel=Text, decision=null → excluded (no final label)
    const run = makeRun({
      zones: [
        zone({ aiLabel: 'Text', type: 'Text', decision: 'CONFIRMED' }),
        zone({ aiLabel: 'Text', type: 'Text', decision: 'CORRECTED', operatorLabel: 'Heading' }),
        zone({ aiLabel: null, type: 'Text', decision: 'CONFIRMED' }),
        zone({ aiLabel: 'Text', type: 'Text', decision: null }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getLineageSummary(RANGE);
    // 1/2 agreed → 0.5
    expect(result.headline.aiAgreementRate).toBeCloseTo(0.5, 6);
  });

  it('humanCorrectionRate and humanRejectionRate use all human-decided zones as denominator', async () => {
    const run = makeRun({
      zones: [
        zone({ decision: 'CONFIRMED' }),
        zone({ decision: 'CONFIRMED' }),
        zone({ decision: 'CORRECTED', operatorLabel: 'Heading' }),
        zone({ decision: 'REJECTED' }),
        zone({ decision: null }), // excluded
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getLineageSummary(RANGE);
    expect(result.headline.humanCorrectionRate).toBeCloseTo(1 / 4, 6);
    expect(result.headline.humanRejectionRate).toBeCloseTo(1 / 4, 6);
  });

  it('confusionMatrix sorts labels alphabetically and counts (ai, final) pairs', async () => {
    const run = makeRun({
      zones: [
        zone({ aiLabel: 'Text', type: 'Text', decision: 'CONFIRMED' }), // Text→Text
        zone({ aiLabel: 'Text', type: 'Text', decision: 'CONFIRMED' }), // Text→Text
        zone({ aiLabel: 'Text', type: 'Text', decision: 'CORRECTED', operatorLabel: 'Heading' }), // Text→Heading
        zone({ aiLabel: 'Heading', type: 'Heading', decision: 'CONFIRMED' }), // Heading→Heading
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getLineageSummary(RANGE);
    expect(result.confusionMatrix.labels).toEqual(['Heading', 'Text']);
    // rows=ai, cols=final; alphabetical order
    //       Heading  Text
    // H:       1      0
    // T:       1      2
    expect(result.confusionMatrix.cells).toEqual([
      [1, 0],
      [1, 2],
    ]);
  });

  it('bucketFlow counts human decisions per reconciliation bucket', async () => {
    const run = makeRun({
      zones: [
        zone({ reconciliationBucket: 'GREEN', decision: 'CONFIRMED' }),
        zone({ reconciliationBucket: 'GREEN', decision: 'CONFIRMED' }),
        zone({ reconciliationBucket: 'AMBER', decision: 'CORRECTED', operatorLabel: 'Heading' }),
        zone({ reconciliationBucket: 'AMBER', decision: 'REJECTED' }),
        zone({ reconciliationBucket: 'RED', decision: 'REJECTED' }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getLineageSummary(RANGE);
    expect(result.bucketFlow.green).toEqual({
      total: 2,
      humanConfirmed: 2,
      humanCorrected: 0,
      humanRejected: 0,
    });
    expect(result.bucketFlow.amber).toEqual({
      total: 2,
      humanConfirmed: 0,
      humanCorrected: 1,
      humanRejected: 1,
    });
    expect(result.bucketFlow.red).toEqual({
      total: 1,
      humanConfirmed: 0,
      humanCorrected: 0,
      humanRejected: 1,
    });
  });

  it('issuesLog groups issues by category across titles and counts distinct titles', async () => {
    const runA = makeRun({
      id: 'run-A',
      corpusDocument: { filename: 'Alpha.pdf', pageCount: 50 },
      issues: [
        {
          category: 'PAGE_ALIGNMENT_MISMATCH',
          pagesAffected: 5,
          description: 'mismatch A1',
          blocking: true,
        },
        {
          category: 'PAGE_ALIGNMENT_MISMATCH',
          pagesAffected: 2,
          description: 'mismatch A2',
          blocking: false,
        },
      ],
    });
    const runB = makeRun({
      id: 'run-B',
      corpusDocument: { filename: 'Beta.pdf', pageCount: 75 },
      issues: [
        {
          category: 'PAGE_ALIGNMENT_MISMATCH',
          pagesAffected: 3,
          description: 'mismatch B',
          blocking: false,
        },
        { category: 'OTHER', pagesAffected: null, description: 'other thing', blocking: false },
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([runA, runB]);

    const result = await getLineageSummary(RANGE);
    const byCategory = new Map(result.issuesLog.map(i => [i.category, i]));
    const pam = byCategory.get('PAGE_ALIGNMENT_MISMATCH')!;
    expect(pam.titleCount).toBe(2); // distinct runs A + B
    expect(pam.totalPagesAffected).toBe(5 + 2 + 3);
    expect(pam.blockingCount).toBe(1);
    expect(pam.titles).toHaveLength(3);

    const other = byCategory.get('OTHER')!;
    expect(other.titleCount).toBe(1);
    expect(other.totalPagesAffected).toBe(0);
  });

  it('extractorDisagreement excludes zones missing either extractor label', async () => {
    const run = makeRun({
      zones: [
        // included: both extractors present, agreement → disagreement count 0
        zone({
          type: 'Text',
          decision: 'CONFIRMED',
          doclingLabel: 'Text',
          pdfxtLabel: 'Text',
        }),
        // included: disagreement → disagreement count 1
        zone({
          type: 'Text',
          decision: 'CONFIRMED',
          doclingLabel: 'Text',
          pdfxtLabel: 'Heading',
        }),
        // excluded: missing pdfxt
        zone({
          type: 'Text',
          decision: 'CONFIRMED',
          doclingLabel: 'Text',
          pdfxtLabel: null,
        }),
        // excluded: no final label
        zone({
          type: 'Text',
          decision: null,
          doclingLabel: 'Text',
          pdfxtLabel: 'Text',
        }),
      ],
    });
    mockCalibrationRunFindMany.mockResolvedValue([run]);

    const result = await getLineageSummary(RANGE);
    const textRow = result.extractorDisagreement.find(r => r.finalLabel === 'Text')!;
    expect(textRow.totalZones).toBe(2);
    expect(textRow.disagreementPct).toBeCloseTo(50, 6);
  });
});
