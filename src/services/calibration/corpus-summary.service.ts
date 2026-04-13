/**
 * Corpus Summary v2 — cross-title lineage & timesheet aggregations with
 * time-range filtering.
 *
 * Scope (Backend PR #2 of BACKEND_SPEC_MARK_COMPLETE_AND_CORPUS_SUMMARY.md):
 * - GET /calibration/corpus/lineage-summary
 * - GET /calibration/corpus/timesheet-summary
 * - CSV exports (flat per-zone lineage, per-operator, per-title)
 * - PDF export (timesheet)
 *
 * Correctness notes:
 * - Only includes runs with `completedAt` inside [from, to].
 * - Empty ranges return a valid, zeroed response — never a 404 or throw.
 * - Cost is computed through the SAME formula as the per-run path:
 *     annotatorActiveHours = sum(session.activeMs) / 3_600_000
 *     annotatorCostInr     = annotatorActiveHours * ANNOTATOR_RATE_INR_PER_HOUR
 *   (see annotation-analysis.service.ts — we import the constant to prevent drift)
 */

import prisma from '../../lib/prisma';
import type { RunIssueCategory } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ── Constants (kept in sync with annotation-analysis.service.ts) ────────
// These must match the per-run cost-computation path. If
// annotation-analysis.service.ts ever changes its rate, update this value and
// the cost-parity test will immediately catch the drift.
export const ANNOTATOR_RATE_INR_PER_HOUR = 400;

// ── Types ───────────────────────────────────────────────────────────────

export interface DateRange {
  from: Date;
  to: Date;
}

export interface LineageSummaryResult {
  range: { from: string; to: string };
  runsIncluded: number;
  headline: {
    totalZones: number;
    aiAgreementRate: number;
    humanCorrectionRate: number;
    humanRejectionRate: number;
  };
  confusionMatrix: {
    labels: string[];
    cells: number[][];
  };
  perZoneType: Array<{
    zoneType: string;
    totalZones: number;
    aiConfirmPct: number;
    aiCorrectionPct: number;
    aiRejectionPct: number;
    topCorrectedTo: string | null;
  }>;
  bucketFlow: {
    green: BucketRow;
    amber: BucketRow;
    red: BucketRow;
  };
  issuesLog: Array<{
    category: RunIssueCategory;
    titleCount: number;
    totalPagesAffected: number;
    blockingCount: number;
    titles: Array<{
      runId: string;
      documentName: string;
      completedAt: string;
      pagesAffected: number | null;
      description: string;
      blocking: boolean;
    }>;
  }>;
  extractorDisagreement: Array<{
    finalLabel: string;
    totalZones: number;
    disagreementPct: number;
  }>;
}

interface BucketRow {
  total: number;
  humanConfirmed: number;
  humanCorrected: number;
  humanRejected: number;
}

export interface TimesheetSummaryResult {
  range: { from: string; to: string };
  runsIncluded: number;
  totals: {
    wallClockHours: number;
    activeHours: number;
    idleHours: number;
    zonesReviewed: number;
    zonesPerHour: number;
    annotatorCostInr: number;
  };
  perOperator: Array<{
    operator: string;
    activeHours: number;
    zonesReviewed: number;
    zonesPerHour: number;
    confirmPct: number;
    correctPct: number;
    rejectPct: number;
    runsContributedTo: number;
    costInr: number;
  }>;
  perTitle: Array<{
    runId: string;
    documentName: string;
    pages: number;
    activeHours: number;
    zonesReviewed: number;
    zonesPerHour: number;
    costInr: number;
    issuesCount: number;
    completedAt: string;
  }>;
  perZoneType: Array<{
    zoneType: string;
    totalZones: number;
    avgSecondsPerZone: number;
  }>;
  throughputTrend: Array<{
    date: string;
    zonesReviewed: number;
    activeHours: number;
    zonesPerHour: number;
    operatorsActive: number;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const SYSTEM_OPERATOR_IDS = new Set(['auto-annotation', 'unknown']);

/** Resolve operator UUIDs to human-readable display names. */
async function resolveOperatorNames(ids: string[]): Promise<Map<string, string>> {
  const userIds = ids.filter(id => id && !SYSTEM_OPERATOR_IDS.has(id));
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  for (const u of users) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
    map.set(u.id, name);
  }
  return map;
}

/**
 * Determine the "final" (human-verified) label for a zone. The confusion matrix
 * and CSV exports both rely on this, so we centralize it here.
 *
 * - CONFIRMED → the zone's current `type` (AI/extractor label the operator accepted)
 * - CORRECTED → the `operatorLabel` the operator chose instead
 * - REJECTED or null → null (no final label)
 */
function finalLabelOf(zone: {
  decision: string | null;
  type: string;
  operatorLabel: string | null;
}): string | null {
  if (zone.decision === 'CONFIRMED') return zone.type;
  if (zone.decision === 'CORRECTED') return zone.operatorLabel ?? zone.type;
  return null;
}

/** Return a new Date set to the start of the UTC day containing `d`. */
function startOfUtcDay(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/** YYYY-MM-DD in UTC. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Enumerate UTC day boundaries inclusive on both ends. */
function enumerateDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(new Date(d));
  }
  return days;
}

/**
 * Standard empty-range envelopes. Spec §"Aggregation rules" — MUST return
 * valid zeroed responses, never 404.
 */
function emptyLineageSummary(range: DateRange): LineageSummaryResult {
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    runsIncluded: 0,
    headline: {
      totalZones: 0,
      aiAgreementRate: 0,
      humanCorrectionRate: 0,
      humanRejectionRate: 0,
    },
    confusionMatrix: { labels: [], cells: [] },
    perZoneType: [],
    bucketFlow: {
      green: { total: 0, humanConfirmed: 0, humanCorrected: 0, humanRejected: 0 },
      amber: { total: 0, humanConfirmed: 0, humanCorrected: 0, humanRejected: 0 },
      red: { total: 0, humanConfirmed: 0, humanCorrected: 0, humanRejected: 0 },
    },
    issuesLog: [],
    extractorDisagreement: [],
  };
}

function emptyTimesheetSummary(range: DateRange): TimesheetSummaryResult {
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    runsIncluded: 0,
    totals: {
      wallClockHours: 0,
      activeHours: 0,
      idleHours: 0,
      zonesReviewed: 0,
      zonesPerHour: 0,
      annotatorCostInr: 0,
    },
    perOperator: [],
    perTitle: [],
    perZoneType: [],
    // Throughput trend still emits one entry per day, even when empty.
    throughputTrend: enumerateDays(range.from, range.to).map(d => ({
      date: ymd(d),
      zonesReviewed: 0,
      activeHours: 0,
      zonesPerHour: 0,
      operatorsActive: 0,
    })),
  };
}

// ── Lineage summary ─────────────────────────────────────────────────────

export async function getLineageSummary(range: DateRange): Promise<LineageSummaryResult> {
  const runs = await prisma.calibrationRun.findMany({
    where: {
      completedAt: { gte: range.from, lte: range.to, not: null },
    },
    select: {
      id: true,
      completedAt: true,
      corpusDocument: { select: { filename: true } },
      zones: {
        select: {
          type: true,
          operatorLabel: true,
          decision: true,
          aiLabel: true,
          aiDecision: true,
          reconciliationBucket: true,
          doclingLabel: true,
          pdfxtLabel: true,
        },
      },
      issues: {
        select: {
          category: true,
          pagesAffected: true,
          description: true,
          blocking: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { completedAt: 'asc' },
  });

  if (runs.length === 0) return emptyLineageSummary(range);

  // ── Section 1: headline ───────────────────────────────────────────────
  const allZones = runs.flatMap(r =>
    r.zones.map(z => ({ ...z, runId: r.id, documentName: r.corpusDocument.filename, completedAt: r.completedAt })),
  );
  const totalZones = allZones.length;

  // aiAgreementRate — of zones that have both an AI label AND a final label,
  // how many match. Zones without either are excluded from the denominator so
  // unreviewed / AI-untouched zones don't artificially deflate the rate.
  let aiAgreementDenominator = 0;
  let aiAgreementNumerator = 0;
  for (const z of allZones) {
    const final = finalLabelOf(z);
    if (z.aiLabel && final) {
      aiAgreementDenominator++;
      if (z.aiLabel === final) aiAgreementNumerator++;
    }
  }
  const aiAgreementRate = aiAgreementDenominator > 0 ? aiAgreementNumerator / aiAgreementDenominator : 0;

  // humanCorrection/Rejection — denominator is zones with ANY human decision.
  const humanDecided = allZones.filter(z => z.decision != null);
  const humanCorrectedCount = humanDecided.filter(z => z.decision === 'CORRECTED').length;
  const humanRejectedCount = humanDecided.filter(z => z.decision === 'REJECTED').length;
  const humanCorrectionRate = humanDecided.length > 0 ? humanCorrectedCount / humanDecided.length : 0;
  const humanRejectionRate = humanDecided.length > 0 ? humanRejectedCount / humanDecided.length : 0;

  // ── Section 2: confusion matrix (AI × final) ──────────────────────────
  // Only include labels that actually appear. Sorted alphabetically so the
  // frontend receives a deterministic order.
  const labelSet = new Set<string>();
  const pairs: Array<{ ai: string; final: string }> = [];
  for (const z of allZones) {
    const final = finalLabelOf(z);
    if (!z.aiLabel || !final) continue;
    labelSet.add(z.aiLabel);
    labelSet.add(final);
    pairs.push({ ai: z.aiLabel, final });
  }
  const labels = [...labelSet].sort();
  const labelIdx = new Map(labels.map((l, i) => [l, i] as const));
  const cells: number[][] = labels.map(() => labels.map(() => 0));
  for (const p of pairs) {
    const r = labelIdx.get(p.ai);
    const c = labelIdx.get(p.final);
    if (r !== undefined && c !== undefined) cells[r]![c]!++;
  }

  // ── Section 3: per-zone-type performance ──────────────────────────────
  // Group by the zone's `type`. For each type compute AI confirm/correction/
  // rejection rates based on `aiDecision`. "topCorrectedTo" is the most common
  // operatorLabel seen among zones where decision === 'CORRECTED'.
  const zoneTypeMap = new Map<
    string,
    { total: number; aiConfirm: number; aiCorrect: number; aiReject: number; correctionCounts: Map<string, number> }
  >();
  for (const z of allZones) {
    const key = z.type || 'unknown';
    const existing = zoneTypeMap.get(key) ?? {
      total: 0,
      aiConfirm: 0,
      aiCorrect: 0,
      aiReject: 0,
      correctionCounts: new Map<string, number>(),
    };
    existing.total++;
    if (z.aiDecision === 'CONFIRMED') existing.aiConfirm++;
    else if (z.aiDecision === 'CORRECTED') existing.aiCorrect++;
    else if (z.aiDecision === 'REJECTED') existing.aiReject++;
    if (z.decision === 'CORRECTED' && z.operatorLabel) {
      existing.correctionCounts.set(z.operatorLabel, (existing.correctionCounts.get(z.operatorLabel) ?? 0) + 1);
    }
    zoneTypeMap.set(key, existing);
  }
  const perZoneType = [...zoneTypeMap.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([zoneType, d]) => {
      let topCorrectedTo: string | null = null;
      let topCount = 0;
      for (const [label, cnt] of d.correctionCounts) {
        if (cnt > topCount) {
          topCorrectedTo = label;
          topCount = cnt;
        }
      }
      return {
        zoneType,
        totalZones: d.total,
        aiConfirmPct: d.total > 0 ? (d.aiConfirm / d.total) * 100 : 0,
        aiCorrectionPct: d.total > 0 ? (d.aiCorrect / d.total) * 100 : 0,
        aiRejectionPct: d.total > 0 ? (d.aiReject / d.total) * 100 : 0,
        topCorrectedTo,
      };
    });

  // ── Section 4: bucket flow ────────────────────────────────────────────
  const emptyBucket = (): BucketRow => ({ total: 0, humanConfirmed: 0, humanCorrected: 0, humanRejected: 0 });
  const bucketFlow = {
    green: emptyBucket(),
    amber: emptyBucket(),
    red: emptyBucket(),
  };
  for (const z of allZones) {
    const bucket = z.reconciliationBucket;
    let row: BucketRow | null = null;
    if (bucket === 'GREEN') row = bucketFlow.green;
    else if (bucket === 'AMBER') row = bucketFlow.amber;
    else if (bucket === 'RED') row = bucketFlow.red;
    if (!row) continue;
    row.total++;
    if (z.decision === 'CONFIRMED') row.humanConfirmed++;
    else if (z.decision === 'CORRECTED') row.humanCorrected++;
    else if (z.decision === 'REJECTED') row.humanRejected++;
  }

  // ── Section 5: issues log ─────────────────────────────────────────────
  // Group all issues across runs by category, preserving per-title detail.
  const issuesByCategory = new Map<
    RunIssueCategory,
    {
      titleCount: Set<string>;
      totalPagesAffected: number;
      blockingCount: number;
      titles: Array<{
        runId: string;
        documentName: string;
        completedAt: string;
        pagesAffected: number | null;
        description: string;
        blocking: boolean;
      }>;
    }
  >();
  for (const run of runs) {
    if (!run.completedAt) continue;
    for (const iss of run.issues) {
      const entry =
        issuesByCategory.get(iss.category) ??
        {
          titleCount: new Set<string>(),
          totalPagesAffected: 0,
          blockingCount: 0,
          titles: [] as Array<{
            runId: string;
            documentName: string;
            completedAt: string;
            pagesAffected: number | null;
            description: string;
            blocking: boolean;
          }>,
        };
      entry.titleCount.add(run.id);
      entry.totalPagesAffected += iss.pagesAffected ?? 0;
      if (iss.blocking) entry.blockingCount++;
      entry.titles.push({
        runId: run.id,
        documentName: run.corpusDocument.filename,
        completedAt: run.completedAt.toISOString(),
        pagesAffected: iss.pagesAffected,
        description: iss.description,
        blocking: iss.blocking,
      });
      issuesByCategory.set(iss.category, entry);
    }
  }
  const issuesLog = [...issuesByCategory.entries()]
    .sort(([, a], [, b]) => b.titles.length - a.titles.length)
    .map(([category, d]) => ({
      category,
      titleCount: d.titleCount.size,
      totalPagesAffected: d.totalPagesAffected,
      blockingCount: d.blockingCount,
      titles: d.titles,
    }));

  // ── Section 6: extractor disagreement ─────────────────────────────────
  // Group by final label; a zone "disagrees" when docling and pdfxt labels
  // differ. Zones missing either extractor label are excluded so the rate
  // reflects head-to-head comparisons only.
  const disagreementMap = new Map<string, { total: number; disagreements: number }>();
  for (const z of allZones) {
    const final = finalLabelOf(z);
    if (!final) continue;
    if (!z.doclingLabel || !z.pdfxtLabel) continue;
    const entry = disagreementMap.get(final) ?? { total: 0, disagreements: 0 };
    entry.total++;
    if (z.doclingLabel !== z.pdfxtLabel) entry.disagreements++;
    disagreementMap.set(final, entry);
  }
  const extractorDisagreement = [...disagreementMap.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([finalLabel, d]) => ({
      finalLabel,
      totalZones: d.total,
      disagreementPct: d.total > 0 ? (d.disagreements / d.total) * 100 : 0,
    }));

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    runsIncluded: runs.length,
    headline: {
      totalZones,
      aiAgreementRate,
      humanCorrectionRate,
      humanRejectionRate,
    },
    confusionMatrix: { labels, cells },
    perZoneType,
    bucketFlow,
    issuesLog,
    extractorDisagreement,
  };
}

// ── Timesheet summary ───────────────────────────────────────────────────

export async function getTimesheetSummary(range: DateRange): Promise<TimesheetSummaryResult> {
  const runs = await prisma.calibrationRun.findMany({
    where: {
      completedAt: { gte: range.from, lte: range.to, not: null },
    },
    select: {
      id: true,
      completedAt: true,
      corpusDocument: { select: { filename: true, pageCount: true } },
      zones: {
        select: {
          type: true,
          decision: true,
          verifiedBy: true,
        },
      },
      annotationSessions: {
        // NOTE: don't select sessionLog — it's a potentially-large JSONB blob
        // and this aggregation never reads it. Including it multiplied the
        // payload size on corpus-wide ranges for no benefit.
        select: {
          operatorId: true,
          startedAt: true,
          endedAt: true,
          activeMs: true,
          idleMs: true,
          zonesReviewed: true,
          zonesConfirmed: true,
          zonesCorrected: true,
          zonesRejected: true,
        },
      },
      _count: { select: { issues: true } },
    },
    orderBy: { completedAt: 'asc' },
  });

  if (runs.length === 0) return emptyTimesheetSummary(range);

  // ── Totals ────────────────────────────────────────────────────────────
  let totalActiveMs = 0;
  let totalIdleMs = 0;
  let totalZonesReviewed = 0;
  let earliestStart: Date | null = null;
  let latestEnd: Date | null = null;
  for (const run of runs) {
    for (const sess of run.annotationSessions) {
      totalActiveMs += sess.activeMs;
      totalIdleMs += sess.idleMs;
      totalZonesReviewed += sess.zonesReviewed;
      if (!earliestStart || sess.startedAt < earliestStart) earliestStart = sess.startedAt;
      if (sess.endedAt && (!latestEnd || sess.endedAt > latestEnd)) latestEnd = sess.endedAt;
    }
  }
  const totalActiveHours = totalActiveMs / 3_600_000;
  const totalIdleHours = totalIdleMs / 3_600_000;
  const totalWallClockHours =
    earliestStart && latestEnd
      ? (latestEnd.getTime() - earliestStart.getTime()) / 3_600_000
      : totalActiveHours + totalIdleHours;
  const totalZonesPerHour = totalActiveHours > 0 ? totalZonesReviewed / totalActiveHours : 0;
  const totalCostInr = totalActiveHours * ANNOTATOR_RATE_INR_PER_HOUR;

  // ── Per operator ──────────────────────────────────────────────────────
  const operatorMap = new Map<
    string,
    {
      activeMs: number;
      zonesReviewed: number;
      confirmed: number;
      corrected: number;
      rejected: number;
      runIds: Set<string>;
    }
  >();
  for (const run of runs) {
    for (const sess of run.annotationSessions) {
      const entry = operatorMap.get(sess.operatorId) ?? {
        activeMs: 0,
        zonesReviewed: 0,
        confirmed: 0,
        corrected: 0,
        rejected: 0,
        runIds: new Set<string>(),
      };
      entry.activeMs += sess.activeMs;
      entry.zonesReviewed += sess.zonesReviewed;
      entry.confirmed += sess.zonesConfirmed;
      entry.corrected += sess.zonesCorrected;
      entry.rejected += sess.zonesRejected;
      entry.runIds.add(run.id);
      operatorMap.set(sess.operatorId, entry);
    }
  }
  const nameMap = await resolveOperatorNames([...operatorMap.keys()]);
  const perOperator = [...operatorMap.entries()]
    .map(([opId, d]) => {
      const activeHours = d.activeMs / 3_600_000;
      const decided = d.confirmed + d.corrected + d.rejected;
      return {
        operator: nameMap.get(opId) ?? opId,
        activeHours,
        zonesReviewed: d.zonesReviewed,
        zonesPerHour: activeHours > 0 ? d.zonesReviewed / activeHours : 0,
        confirmPct: decided > 0 ? (d.confirmed / decided) * 100 : 0,
        correctPct: decided > 0 ? (d.corrected / decided) * 100 : 0,
        rejectPct: decided > 0 ? (d.rejected / decided) * 100 : 0,
        runsContributedTo: d.runIds.size,
        costInr: activeHours * ANNOTATOR_RATE_INR_PER_HOUR,
      };
    })
    .sort((a, b) => b.activeHours - a.activeHours);

  // ── Per title ─────────────────────────────────────────────────────────
  // IMPORTANT cost-parity invariant: per-title costInr MUST equal
  //   sum(annotationSessions.activeMs for runId) / 3_600_000 * 400
  // which is exactly what the per-run timesheet and the existing corpus
  // analysis-summary path use. Do not "improve" this formula in isolation.
  const perTitle = runs.map(run => {
    const runActiveMs = run.annotationSessions.reduce((s, sess) => s + sess.activeMs, 0);
    const runZonesReviewed = run.annotationSessions.reduce((s, sess) => s + sess.zonesReviewed, 0);
    const runActiveHours = runActiveMs / 3_600_000;
    return {
      runId: run.id,
      documentName: run.corpusDocument.filename,
      pages: run.corpusDocument.pageCount ?? 0,
      activeHours: runActiveHours,
      zonesReviewed: runZonesReviewed,
      zonesPerHour: runActiveHours > 0 ? runZonesReviewed / runActiveHours : 0,
      costInr: runActiveHours * ANNOTATOR_RATE_INR_PER_HOUR,
      issuesCount: run._count.issues,
      completedAt: (run.completedAt ?? new Date(0)).toISOString(),
    };
  });

  // ── Per zone type (avg seconds per zone) ──────────────────────────────
  // Apportion totalActiveMs across zone types proportional to each type's
  // share of reviewed zones. This matches the per-run approach of treating
  // operator time as uniformly distributed over the zones actually decided.
  const typeCounts = new Map<string, number>();
  let decidedZoneCount = 0;
  for (const run of runs) {
    for (const z of run.zones) {
      if (!z.decision) continue;
      if (z.verifiedBy === 'auto-annotation') continue;
      decidedZoneCount++;
      const key = z.type || 'unknown';
      typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
    }
  }
  const perZoneType = [...typeCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([zoneType, count]) => {
      const shareMs = decidedZoneCount > 0 ? totalActiveMs * (count / decidedZoneCount) : 0;
      return {
        zoneType,
        totalZones: count,
        avgSecondsPerZone: count > 0 ? shareMs / count / 1000 : 0,
      };
    });

  // ── Throughput trend ──────────────────────────────────────────────────
  // One bucket per UTC day in the range. A session is attributed to the day
  // its `endedAt` (or `startedAt` fallback) falls on, mirroring how the
  // per-run timesheet associates time with a wall-clock day.
  const trendMap = new Map<
    string,
    { zonesReviewed: number; activeMs: number; operators: Set<string> }
  >();
  for (const d of enumerateDays(range.from, range.to)) {
    trendMap.set(ymd(d), { zonesReviewed: 0, activeMs: 0, operators: new Set<string>() });
  }
  for (const run of runs) {
    for (const sess of run.annotationSessions) {
      const anchor = sess.endedAt ?? sess.startedAt;
      const key = ymd(anchor);
      const bucket = trendMap.get(key);
      if (!bucket) continue; // session outside range — shouldn't happen given the run filter
      bucket.zonesReviewed += sess.zonesReviewed;
      bucket.activeMs += sess.activeMs;
      bucket.operators.add(sess.operatorId);
    }
  }
  const throughputTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      const activeHours = d.activeMs / 3_600_000;
      return {
        date,
        zonesReviewed: d.zonesReviewed,
        activeHours,
        zonesPerHour: activeHours > 0 ? d.zonesReviewed / activeHours : 0,
        operatorsActive: d.operators.size,
      };
    });

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    runsIncluded: runs.length,
    totals: {
      wallClockHours: totalWallClockHours,
      activeHours: totalActiveHours,
      idleHours: totalIdleHours,
      zonesReviewed: totalZonesReviewed,
      zonesPerHour: totalZonesPerHour,
      annotatorCostInr: totalCostInr,
    },
    perOperator,
    perTitle,
    perZoneType,
    throughputTrend,
  };
}

// ── CSV helpers ─────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const raw = v === null || v === undefined ? '' : String(v);
  // CSV-formula-injection guard: cells starting with =, +, -, or @ are
  // interpreted as formulas in Excel / Google Sheets. Prepend a single quote
  // so the cell renders as text when opened in a spreadsheet tool. This is
  // particularly important for operator-entered fields like documentName and
  // issue descriptions that flow into lineage/timesheet CSV exports.
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

// ── Lineage CSV export (flat per-zone) ──────────────────────────────────

export async function exportLineageSummaryCsv(range: DateRange): Promise<string> {
  const runs = await prisma.calibrationRun.findMany({
    where: {
      completedAt: { gte: range.from, lte: range.to, not: null },
    },
    select: {
      id: true,
      completedAt: true,
      corpusDocument: { select: { filename: true } },
      zones: {
        select: {
          id: true,
          pageNumber: true,
          type: true,
          operatorLabel: true,
          decision: true,
          verifiedBy: true,
          doclingLabel: true,
          pdfxtLabel: true,
          reconciliationBucket: true,
          aiLabel: true,
          aiDecision: true,
          aiConfidence: true,
        },
        orderBy: [{ pageNumber: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: { completedAt: 'asc' },
  });

  const headers = [
    'runId',
    'documentName',
    'completedAt',
    'pageNumber',
    'zoneId',
    'zoneIndex',
    'doclingLabel',
    'pdfxtLabel',
    'reconciliationBucket',
    'aiDecision',
    'aiLabel',
    'aiConfidence',
    'humanDecision',
    'humanLabel',
    'verifiedBy',
    'finalLabel',
  ];
  const lines: string[] = [headers.join(',')];

  for (const run of runs) {
    let zoneIndex = 0;
    for (const z of run.zones) {
      const humanLabel =
        z.decision === 'CORRECTED' ? z.operatorLabel : z.decision === 'CONFIRMED' ? z.type : null;
      lines.push(
        csvRow([
          run.id,
          run.corpusDocument.filename,
          run.completedAt ? run.completedAt.toISOString() : '',
          z.pageNumber,
          z.id,
          zoneIndex,
          z.doclingLabel ?? '',
          z.pdfxtLabel ?? '',
          z.reconciliationBucket ?? '',
          z.aiDecision ?? '',
          z.aiLabel ?? '',
          z.aiConfidence !== null && z.aiConfidence !== undefined ? z.aiConfidence.toFixed(3) : '',
          z.decision ?? '',
          humanLabel ?? '',
          z.verifiedBy ?? '',
          finalLabelOf(z) ?? '',
        ]),
      );
      zoneIndex++;
    }
  }

  return lines.join('\n');
}

// ── Timesheet CSV exports ───────────────────────────────────────────────

export async function exportTimesheetPerOperatorCsv(range: DateRange): Promise<string> {
  const summary = await getTimesheetSummary(range);
  const headers = [
    'operator',
    'activeHours',
    'zonesReviewed',
    'zonesPerHour',
    'confirmPct',
    'correctPct',
    'rejectPct',
    'runsContributedTo',
    'costInr',
  ];
  const lines: string[] = [headers.join(',')];
  for (const r of summary.perOperator) {
    lines.push(
      csvRow([
        r.operator,
        r.activeHours.toFixed(3),
        r.zonesReviewed,
        r.zonesPerHour.toFixed(1),
        r.confirmPct.toFixed(1),
        r.correctPct.toFixed(1),
        r.rejectPct.toFixed(1),
        r.runsContributedTo,
        r.costInr.toFixed(2),
      ]),
    );
  }
  return lines.join('\n');
}

export async function exportTimesheetPerTitleCsv(range: DateRange): Promise<string> {
  const summary = await getTimesheetSummary(range);
  const headers = [
    'runId',
    'documentName',
    'pages',
    'activeHours',
    'zonesReviewed',
    'zonesPerHour',
    'costInr',
    'issuesCount',
    'completedAt',
  ];
  const lines: string[] = [headers.join(',')];
  for (const r of summary.perTitle) {
    lines.push(
      csvRow([
        r.runId,
        r.documentName,
        r.pages,
        r.activeHours.toFixed(3),
        r.zonesReviewed,
        r.zonesPerHour.toFixed(1),
        r.costInr.toFixed(2),
        r.issuesCount,
        r.completedAt,
      ]),
    );
  }
  return lines.join('\n');
}

// ── Timesheet PDF export ────────────────────────────────────────────────

export async function exportTimesheetSummaryPdf(range: DateRange): Promise<Buffer> {
  const summary = await getTimesheetSummary(range);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawText = (text: string, x: number, yPos: number, size: number, useBold = false) => {
    page.drawText(text, {
      x,
      y: yPos,
      size,
      font: useBold ? boldFont : font,
      color: rgb(0, 0, 0),
    });
  };

  const ensureSpace = (needed: number) => {
    if (y < margin + needed) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  // Title
  drawText('Corpus Timesheet Summary', margin, y, 18, true);
  y -= 25;
  drawText(
    `Range: ${summary.range.from.slice(0, 10)} → ${summary.range.to.slice(0, 10)}  |  Runs: ${summary.runsIncluded}`,
    margin,
    y,
    10,
  );
  y -= 25;

  // Totals card
  drawText('Totals', margin, y, 14, true);
  y -= 18;
  const t = summary.totals;
  for (const line of [
    `Active Hours: ${t.activeHours.toFixed(2)}`,
    `Wall Clock Hours: ${t.wallClockHours.toFixed(2)}`,
    `Idle Hours: ${t.idleHours.toFixed(2)}`,
    `Zones Reviewed: ${t.zonesReviewed}`,
    `Zones / Hour: ${t.zonesPerHour.toFixed(1)}`,
    `Annotator Cost (INR): ₹${t.annotatorCostInr.toFixed(2)}`,
  ]) {
    drawText(line, margin + 10, y, 10);
    y -= 14;
  }
  y -= 10;

  // Per-operator
  ensureSpace(60);
  drawText('Per-Operator Breakdown', margin, y, 14, true);
  y -= 18;
  for (const op of summary.perOperator) {
    ensureSpace(28);
    drawText(
      `${op.operator}: ${op.zonesReviewed} zones, ${op.activeHours.toFixed(2)}h, ${op.zonesPerHour.toFixed(0)} zones/hr, ₹${op.costInr.toFixed(0)}`,
      margin + 10,
      y,
      9,
    );
    y -= 13;
  }
  y -= 10;

  // Per-title
  ensureSpace(60);
  drawText('Per-Title Breakdown', margin, y, 14, true);
  y -= 18;
  for (const tit of summary.perTitle) {
    ensureSpace(28);
    drawText(
      `${tit.documentName} (${tit.pages}p): ${tit.zonesReviewed} zones, ${tit.activeHours.toFixed(2)}h, ${tit.issuesCount} issues, ₹${tit.costInr.toFixed(0)}`,
      margin + 10,
      y,
      9,
    );
    y -= 13;
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
