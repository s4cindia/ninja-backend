import prisma from '../../lib/prisma';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ── Types ───────────────────────────────────────────────────────────

export interface OperatorRow {
  operatorId: string;
  zonesReviewed: number;
  activeMs: number;
  zonesPerHour: number | null;
  confirmPct: number | null;
  correctPct: number | null;
  rejectPct: number | null;
  lastActivity: string | null;
}

export interface PageTimeRow {
  pageNumber: number;
  zoneCount: number;
  timeSpentMs: number;
  zonesPerMin: number | null;
  confirmed: number;
  corrected: number;
  rejected: number;
  /** How timeSpentMs was computed: 'measured' from sessionLog page segments, or 'derived' by apportionment. */
  timingSource: 'measured' | 'derived';
  /** Review workflow mode inferred from decision pattern. */
  reviewMode: 'deep' | 'sampling' | 'unreviewed';
}

export interface ZoneTypeRow {
  zoneType: string;
  total: number;
  confirmed: number;
  corrected: number;
  rejected: number;
  confirmPct: number | null;
  correctPct: number | null;
  rejectPct: number | null;
}

/** Single entry inside AnnotationSession.sessionLog when the frontend timer emits page-tagged segments. */
interface SessionSegmentEntry {
  openedAt?: string;
  closedAt?: string;
  activeMs?: number;
  idleMs?: number;
  pageNumber?: number | null;
}

export interface TimesheetReport {
  header: {
    documentName: string;
    documentId: string;
    calibrationRunId: string;
    totalPages: number;
    pageCount: number;
    totalZones: number;
    zoneCount: number;
    reportPeriod: { from: string | null; to: string | null };
  };
  timeSummary: {
    totalWallClockMs: number;
    wallClockMs: number;
    totalActiveMs: number;
    activeMs: number;
    totalIdleMs: number;
    idleMs: number;
    autoAnnotationMs: number;
    manualReviewMs: number;
    zonesPerHour: number | null;
    avgSecsPerZone: number | null;
    pagesPerHour: number | null;
  };
  operatorBreakdown: OperatorRow[];
  byOperator: (OperatorRow & { operator: string })[];
  pageBreakdown: PageTimeRow[];
  byPage: (PageTimeRow & { zones: number })[];
  zoneTypeBreakdown: ZoneTypeRow[];
  efficiencyMetrics: {
    autoAnnotationSavingsMs: number;
    reviewQueueReductionPct: number | null;
    estimatedCost: number | null;
    complexityScore: number | null;
  };
  efficiency: {
    autoAnnotationSavings: number;
    reviewQueueReduction: number | null;
    estimatedCost: number | null;
    complexityScore: number | null;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

const SYSTEM_IDS = new Set(['auto-annotation', 'unknown']);

async function resolveUserNames(ids: string[]): Promise<Map<string, string>> {
  const userIds = ids.filter(id => id && !SYSTEM_IDS.has(id));
  if (userIds.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true },
  });

  const map = new Map<string, string>();
  for (const u of users) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    if (name) map.set(u.id, name);
  }
  return map;
}

// ── Service ─────────────────────────────────────────────────────────

class AnnotationTimesheetService {
  async startSession(runId: string, operatorId: string, pageNumber?: number): Promise<string> {
    const session = await prisma.annotationSession.create({
      data: {
        calibrationRunId: runId,
        operatorId,
        pageNumber: pageNumber ?? null,
        startedAt: new Date(),
      },
    });
    return session.id;
  }

  async endSession(
    sessionId: string,
    data: {
      activeMs: number;
      idleMs: number;
      zonesReviewed: number;
      zonesConfirmed: number;
      zonesCorrected: number;
      zonesRejected: number;
      sessionLog?: unknown;
    },
  ): Promise<void> {
    await prisma.annotationSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        activeMs: data.activeMs,
        idleMs: data.idleMs,
        zonesReviewed: data.zonesReviewed,
        zonesConfirmed: data.zonesConfirmed,
        zonesCorrected: data.zonesCorrected,
        zonesRejected: data.zonesRejected,
        sessionLog: (data.sessionLog as object) ?? undefined,
      },
    });
  }

  async getTimesheetReport(runId: string): Promise<TimesheetReport | null> {
    const run = await prisma.calibrationRun.findUnique({
      where: { id: runId },
      include: {
        corpusDocument: { select: { filename: true, id: true, pageCount: true } },
        zones: {
          orderBy: [{ pageNumber: 'asc' }],
          select: {
            id: true,
            type: true,
            operatorLabel: true,
            pageNumber: true,
            decision: true,
            verifiedBy: true,
            verifiedAt: true,
            reconciliationBucket: true,
          },
        },
        annotationSessions: {
          orderBy: { startedAt: 'asc' },
        },
      },
    });

    if (!run) return null;

    const doc = run.corpusDocument;
    const zones = run.zones;
    const sessions = run.annotationSessions;

    // Time summary from sessions
    const totalActiveMs = sessions.reduce((s, sess) => s + sess.activeMs, 0);
    const totalIdleMs = sessions.reduce((s, sess) => s + sess.idleMs, 0);

    let earliestStart: Date | null = null;
    let latestEnd: Date | null = null;
    for (const sess of sessions) {
      if (!earliestStart || sess.startedAt < earliestStart) earliestStart = sess.startedAt;
      if (sess.endedAt && (!latestEnd || sess.endedAt > latestEnd)) latestEnd = sess.endedAt;
    }

    const totalWallClockMs = earliestStart && latestEnd
      ? latestEnd.getTime() - earliestStart.getTime()
      : totalActiveMs + totalIdleMs;

    const autoAnnotatedCount = zones.filter(z => z.verifiedBy === 'auto-annotation').length;
    const reviewedCount = zones.filter(z => z.decision).length;
    const humanReviewedCount = reviewedCount - autoAnnotatedCount;

    // Estimate auto-annotation time as negligible (~1ms per zone)
    const autoAnnotationMs = autoAnnotatedCount; // ~1ms each
    const manualReviewMs = totalActiveMs;

    const uniquePages = new Set(zones.map(z => z.pageNumber));
    const totalHours = totalActiveMs / 3_600_000;

    const zonesPerHour = totalHours > 0 ? humanReviewedCount / totalHours : null;
    const avgSecsPerZone = humanReviewedCount > 0 ? (totalActiveMs / 1000) / humanReviewedCount : null;
    const pagesPerHour = totalHours > 0 ? uniquePages.size / totalHours : null;

    // Operator breakdown
    const operatorMap = new Map<string, {
      activeMs: number; zonesReviewed: number;
      confirmed: number; corrected: number; rejected: number;
      lastActivity: Date | null;
    }>();

    for (const sess of sessions) {
      const existing = operatorMap.get(sess.operatorId) ?? {
        activeMs: 0, zonesReviewed: 0, confirmed: 0, corrected: 0, rejected: 0, lastActivity: null,
      };
      existing.activeMs += sess.activeMs;
      existing.zonesReviewed += sess.zonesReviewed;
      existing.confirmed += sess.zonesConfirmed;
      existing.corrected += sess.zonesCorrected;
      existing.rejected += sess.zonesRejected;
      if (sess.endedAt && (!existing.lastActivity || sess.endedAt > existing.lastActivity)) {
        existing.lastActivity = sess.endedAt;
      }
      operatorMap.set(sess.operatorId, existing);
    }

    // Add auto-annotation as a virtual operator
    if (autoAnnotatedCount > 0) {
      const autoConfirmed = zones.filter(z => z.verifiedBy === 'auto-annotation' && z.decision === 'CONFIRMED').length;
      const autoCorrected = zones.filter(z => z.verifiedBy === 'auto-annotation' && z.decision === 'CORRECTED').length;
      const autoRejected = zones.filter(z => z.verifiedBy === 'auto-annotation' && z.decision === 'REJECTED').length;
      operatorMap.set('auto-annotation', {
        activeMs: autoAnnotationMs,
        zonesReviewed: autoAnnotatedCount,
        confirmed: autoConfirmed,
        corrected: autoCorrected,
        rejected: autoRejected,
        lastActivity: null,
      });
    }

    const operatorBreakdown: OperatorRow[] = [...operatorMap.entries()].map(([opId, data]) => {
      const hours = data.activeMs / 3_600_000;
      const total = data.confirmed + data.corrected + data.rejected;
      return {
        operatorId: opId,
        zonesReviewed: data.zonesReviewed,
        activeMs: data.activeMs,
        zonesPerHour: hours > 0 ? data.zonesReviewed / hours : null,
        confirmPct: total > 0 ? data.confirmed / total : null,
        correctPct: total > 0 ? data.corrected / total : null,
        rejectPct: total > 0 ? data.rejected / total : null,
        lastActivity: data.lastActivity ? data.lastActivity.toISOString() : null,
      };
    });

    // Page breakdown — aggregate decisions per page.
    // `pageMap` counts ALL zones for the visible page row; `humanPageMap` excludes zones
    // that were applied by auto-annotation (so apportionment of human review time is not
    // diluted by pages that the human never actually opened).
    const pageMap = new Map<number, { count: number; humanCount: number; confirmed: number; corrected: number; rejected: number }>();
    for (const z of zones) {
      const existing = pageMap.get(z.pageNumber) ?? { count: 0, humanCount: 0, confirmed: 0, corrected: 0, rejected: 0 };
      existing.count++;
      if (z.verifiedBy !== 'auto-annotation') existing.humanCount++;
      if (z.decision === 'CONFIRMED') existing.confirmed++;
      if (z.decision === 'CORRECTED') existing.corrected++;
      if (z.decision === 'REJECTED') existing.rejected++;
      pageMap.set(z.pageNumber, existing);
    }

    // Measured per-page time: aggregate active time from sessionLog segments that carry pageNumber.
    // Falls back to proportional apportionment for pages with no segments (older sessions or missing tags).
    const measuredMsByPage = new Map<number, number>();
    let measuredTotalMs = 0;
    for (const sess of sessions) {
      const log = sess.sessionLog as unknown;
      if (!Array.isArray(log)) continue;
      for (const entry of log as SessionSegmentEntry[]) {
        if (!entry || typeof entry !== 'object') continue;
        const page = entry.pageNumber;
        const ms = entry.activeMs;
        if (typeof page !== 'number' || typeof ms !== 'number' || ms <= 0) continue;
        measuredMsByPage.set(page, (measuredMsByPage.get(page) ?? 0) + ms);
        measuredTotalMs += ms;
      }
    }

    // Apportionment pool: distribute the leftover active time across pages with no measured
    // segments, weighted by *human* zone count. Use a largest-remainder (Hamilton) distribution
    // so the per-page integers sum exactly to `unmeasuredActiveMs` instead of drifting due to
    // independent rounding.
    const unmeasuredActiveMs = Math.max(0, totalActiveMs - measuredTotalMs);
    const totalHumanZoneCount = [...pageMap.values()].reduce((sum, d) => sum + d.humanCount, 0);
    const unmeasuredPages = [...pageMap.entries()].filter(([page]) => !measuredMsByPage.has(page));
    const unmeasuredHumanZoneCount = unmeasuredPages.reduce((sum, [, d]) => sum + d.humanCount, 0);

    const apportionedMs = new Map<number, number>();
    if (unmeasuredHumanZoneCount > 0 && unmeasuredActiveMs > 0) {
      // Largest-remainder method
      const exact = unmeasuredPages.map(([page, d]) => ({
        page,
        exact: unmeasuredActiveMs * (d.humanCount / unmeasuredHumanZoneCount),
      }));
      let assigned = 0;
      const withFloor = exact.map(e => {
        const floor = Math.floor(e.exact);
        assigned += floor;
        return { page: e.page, floor, remainder: e.exact - floor };
      });
      let remainder = unmeasuredActiveMs - assigned;
      withFloor.sort((a, b) => b.remainder - a.remainder);
      for (const row of withFloor) {
        const bonus = remainder > 0 ? 1 : 0;
        apportionedMs.set(row.page, row.floor + bonus);
        if (remainder > 0) remainder--;
      }
    } else if (totalHumanZoneCount > 0 && totalActiveMs > 0) {
      // No segments at all and no measurable split — fall back to a proportional split over all pages
      const allPages = [...pageMap.entries()];
      const exact = allPages.map(([page, d]) => ({
        page,
        exact: totalActiveMs * (d.humanCount / totalHumanZoneCount),
      }));
      let assigned = 0;
      const withFloor = exact.map(e => {
        const floor = Math.floor(e.exact);
        assigned += floor;
        return { page: e.page, floor, remainder: e.exact - floor };
      });
      let remainder = totalActiveMs - assigned;
      withFloor.sort((a, b) => b.remainder - a.remainder);
      for (const row of withFloor) {
        const bonus = remainder > 0 ? 1 : 0;
        apportionedMs.set(row.page, row.floor + bonus);
        if (remainder > 0) remainder--;
      }
    }

    // Build the union of pages with zones AND pages with measured time only — a page may have
    // recorded segments before any zone was decided, and we must not drop it from the report.
    const allPageNumbers = new Set<number>([...pageMap.keys(), ...measuredMsByPage.keys()]);
    const sortedPageNumbers = [...allPageNumbers].sort((a, b) => a - b);

    // First pass: compute time + per-page rows without reviewMode
    const preliminary = sortedPageNumbers.map(page => {
      const data = pageMap.get(page) ?? { count: 0, humanCount: 0, confirmed: 0, corrected: 0, rejected: 0 };
      let timeSpentMs = 0;
      let timingSource: 'measured' | 'derived' = 'derived';
      const measured = measuredMsByPage.get(page);
      if (measured !== undefined) {
        timeSpentMs = Math.round(measured);
        timingSource = 'measured';
      } else {
        timeSpentMs = apportionedMs.get(page) ?? 0;
      }
      const mins = timeSpentMs / 60_000;
      return {
        pageNumber: page,
        zoneCount: data.count,
        timeSpentMs,
        zonesPerMin: mins > 0 ? data.count / mins : null,
        confirmed: data.confirmed,
        corrected: data.corrected,
        rejected: data.rejected,
        timingSource,
      };
    });

    // Phase detection: classify each page as 'deep', 'sampling', or 'unreviewed'.
    // - unreviewed: no decisions recorded on a page that has zones
    // - sampling:  the page belongs to a run of >= 3 consecutive pages where confirmed <= 3 on pages with > 10 zones
    //              (matches the pattern seen in Phase B of cmnmw6d4 where triage replaced deep review)
    // - deep:      everything else (the default quality tier)
    const SAMPLING_MIN_RUN = 3;
    const SAMPLING_ZONE_THRESHOLD = 10;
    const SAMPLING_CONFIRMED_CAP = 3;

    const baseMode: ('deep' | 'sampling' | 'unreviewed')[] = preliminary.map(p => {
      if (p.confirmed === 0 && p.corrected === 0 && p.rejected === 0) return 'unreviewed';
      return 'deep';
    });

    // Walk runs of pages looking for sampling patterns. A run must be both consecutive
    // *by page number* (no gaps in the page sequence) and meet the sampling heuristic
    // — otherwise reports with sparse page coverage would falsely group unrelated pages.
    let runStart = -1;
    let prevPageNumber = -Infinity;
    for (let i = 0; i <= preliminary.length; i++) {
      const p = preliminary[i];
      const isContiguous = p !== undefined && p.pageNumber === prevPageNumber + 1;
      const isSamplingCandidate =
        p !== undefined &&
        p.zoneCount > SAMPLING_ZONE_THRESHOLD &&
        p.confirmed <= SAMPLING_CONFIRMED_CAP &&
        baseMode[i] !== 'unreviewed';

      if (isSamplingCandidate && (runStart === -1 || isContiguous)) {
        if (runStart === -1) runStart = i;
      } else {
        if (runStart !== -1 && i - runStart >= SAMPLING_MIN_RUN) {
          for (let j = runStart; j < i; j++) baseMode[j] = 'sampling';
        }
        // If the current page is itself a candidate but broke the run because of a page gap,
        // start a fresh run from this index.
        runStart = isSamplingCandidate ? i : -1;
      }

      if (p !== undefined) prevPageNumber = p.pageNumber;
    }

    const pageBreakdown: PageTimeRow[] = preliminary.map((p, i) => ({
      ...p,
      reviewMode: baseMode[i],
    }));

    // Zone type breakdown — correction rates by zone.type (or operatorLabel if corrected)
    const typeMap = new Map<string, { total: number; confirmed: number; corrected: number; rejected: number }>();
    for (const z of zones) {
      if (!z.decision) continue;
      const key = z.type || 'unknown';
      const existing = typeMap.get(key) ?? { total: 0, confirmed: 0, corrected: 0, rejected: 0 };
      existing.total++;
      if (z.decision === 'CONFIRMED') existing.confirmed++;
      else if (z.decision === 'CORRECTED') existing.corrected++;
      else if (z.decision === 'REJECTED') existing.rejected++;
      typeMap.set(key, existing);
    }
    const zoneTypeBreakdown: ZoneTypeRow[] = [...typeMap.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([zoneType, d]) => ({
        zoneType,
        total: d.total,
        confirmed: d.confirmed,
        corrected: d.corrected,
        rejected: d.rejected,
        confirmPct: d.total > 0 ? d.confirmed / d.total : null,
        correctPct: d.total > 0 ? d.corrected / d.total : null,
        rejectPct: d.total > 0 ? d.rejected / d.total : null,
      }));

    // Efficiency metrics
    const avgSecsPerZoneSafe = avgSecsPerZone ?? 6.4; // default estimate
    const autoAnnotationSavingsMs = autoAnnotatedCount * avgSecsPerZoneSafe * 1000;
    const reviewQueueReductionPct = zones.length > 0 ? autoAnnotatedCount / zones.length : null;
    const hourlyRate = 25; // default $/hr
    const estimatedCost = totalHours > 0 ? totalHours * hourlyRate : null;
    const amberRedCount = zones.filter(z =>
      z.reconciliationBucket === 'AMBER' || z.reconciliationBucket === 'RED',
    ).length;
    const complexityScore = zones.length > 0 ? amberRedCount / zones.length : null;

    // Resolve operator UUIDs to display names
    const operatorIds = operatorBreakdown.map(o => o.operatorId);
    const nameMap = await resolveUserNames(operatorIds);
    for (const op of operatorBreakdown) {
      op.operatorId = nameMap.get(op.operatorId) ?? op.operatorId;
    }

    const pageCount = doc.pageCount ?? uniquePages.size;
    const zoneCount = zones.length;

    return {
      header: {
        documentName: doc.filename,
        documentId: doc.id,
        calibrationRunId: run.id,
        totalPages: pageCount,
        pageCount,
        totalZones: zoneCount,
        zoneCount,
        reportPeriod: {
          from: earliestStart ? earliestStart.toISOString() : null,
          to: latestEnd ? latestEnd.toISOString() : null,
        },
      },
      timeSummary: {
        totalWallClockMs,
        wallClockMs: totalWallClockMs,
        totalActiveMs,
        activeMs: totalActiveMs,
        totalIdleMs,
        idleMs: totalIdleMs,
        autoAnnotationMs,
        manualReviewMs,
        zonesPerHour,
        avgSecsPerZone,
        pagesPerHour,
      },
      operatorBreakdown,
      // Frontend aliases (byOperator, byPage, efficiency)
      byOperator: operatorBreakdown.map(op => ({
        ...op,
        operator: op.operatorId,
      })),
      pageBreakdown,
      byPage: pageBreakdown.map(p => ({
        ...p,
        zones: p.zoneCount,
      })),
      zoneTypeBreakdown,
      efficiencyMetrics: {
        autoAnnotationSavingsMs,
        reviewQueueReductionPct,
        estimatedCost,
        complexityScore,
      },
      efficiency: {
        autoAnnotationSavings: autoAnnotationSavingsMs,
        reviewQueueReduction: reviewQueueReductionPct,
        estimatedCost,
        complexityScore,
      },
    };
  }

  async exportTimesheetCsv(runId: string): Promise<string | null> {
    const report = await this.getTimesheetReport(runId);
    if (!report) return null;

    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    // Section 1: Operator breakdown
    const opHeaders = ['Operator', 'ZonesReviewed', 'ActiveMs', 'ZonesPerHour', 'Confirm%', 'Correct%', 'Reject%', 'LastActivity'];
    const opRows = report.operatorBreakdown.map(r => [
      r.operatorId, r.zonesReviewed, r.activeMs,
      r.zonesPerHour !== null ? r.zonesPerHour.toFixed(1) : '',
      r.confirmPct !== null ? (r.confirmPct * 100).toFixed(1) : '',
      r.correctPct !== null ? (r.correctPct * 100).toFixed(1) : '',
      r.rejectPct !== null ? (r.rejectPct * 100).toFixed(1) : '',
      r.lastActivity ?? '',
    ].map(escape).join(','));

    // Section 2: Page breakdown
    const pgHeaders = [
      'Page', 'Zones', 'TimeSpentMs', 'ZonesPerMin',
      'Confirmed', 'Corrected', 'Rejected', 'ReviewMode', 'TimingSource',
    ];
    const pgRows = report.pageBreakdown.map(r => [
      r.pageNumber, r.zoneCount, r.timeSpentMs,
      r.zonesPerMin !== null ? r.zonesPerMin.toFixed(1) : '',
      r.confirmed, r.corrected, r.rejected, r.reviewMode, r.timingSource,
    ].map(escape).join(','));

    // Section 3: Zone type breakdown
    const ztHeaders = ['ZoneType', 'Total', 'Confirmed', 'Corrected', 'Rejected', 'Confirm%', 'Correct%', 'Reject%'];
    const ztRows = report.zoneTypeBreakdown.map(r => [
      r.zoneType, r.total, r.confirmed, r.corrected, r.rejected,
      r.confirmPct !== null ? (r.confirmPct * 100).toFixed(1) : '',
      r.correctPct !== null ? (r.correctPct * 100).toFixed(1) : '',
      r.rejectPct !== null ? (r.rejectPct * 100).toFixed(1) : '',
    ].map(escape).join(','));

    return [
      '# Operator Breakdown',
      opHeaders.join(','),
      ...opRows,
      '',
      '# Page Breakdown',
      pgHeaders.join(','),
      ...pgRows,
      '',
      '# Zone Type Breakdown',
      ztHeaders.join(','),
      ...ztRows,
    ].join('\n');
  }

  async exportTimesheetPdf(runId: string): Promise<Buffer | null> {
    const report = await this.getTimesheetReport(runId);
    if (!report) return null;

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    let currentPage = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const drawText = (text: string, x: number, yPos: number, size: number, useBold = false) => {
      currentPage.drawText(text, {
        x,
        y: yPos,
        size,
        font: useBold ? boldFont : font,
        color: rgb(0, 0, 0),
      });
    };

    const ensureSpace = (needed: number) => {
      if (y < margin + needed) {
        currentPage = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
    };

    const fmtMs = (ms: number): string => {
      if (ms < 1000) return `${ms}ms`;
      const secs = Math.round(ms / 1000);
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return `${mins}m ${remSecs}s`;
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hours}h ${remMins}m`;
    };

    // Title
    drawText('Annotation Timesheet', margin, y, 18, true);
    y -= 25;
    drawText(`Document: ${report.header.documentName}`, margin, y, 10);
    y -= 15;
    drawText(`Run: ${report.header.calibrationRunId}`, margin, y, 10);
    y -= 15;
    drawText(`Pages: ${report.header.totalPages}  |  Zones: ${report.header.totalZones}`, margin, y, 10);
    y -= 25;

    // Time summary
    drawText('Time Summary', margin, y, 14, true);
    y -= 18;
    const ts = report.timeSummary;
    const timeLines = [
      `Wall Clock: ${fmtMs(ts.totalWallClockMs)}`,
      `Active Time: ${fmtMs(ts.totalActiveMs)}`,
      `Idle Time: ${fmtMs(ts.totalIdleMs)}`,
      `Zones/Hour: ${ts.zonesPerHour !== null ? ts.zonesPerHour.toFixed(1) : 'N/A'}`,
      `Avg Secs/Zone: ${ts.avgSecsPerZone !== null ? ts.avgSecsPerZone.toFixed(1) : 'N/A'}`,
      `Pages/Hour: ${ts.pagesPerHour !== null ? ts.pagesPerHour.toFixed(1) : 'N/A'}`,
    ];
    for (const line of timeLines) {
      drawText(line, margin + 10, y, 10);
      y -= 14;
    }
    y -= 10;

    // Operator breakdown
    ensureSpace(60);
    drawText('Operator Breakdown', margin, y, 14, true);
    y -= 18;
    for (const op of report.operatorBreakdown) {
      ensureSpace(30);
      drawText(
        `${op.operatorId}: ${op.zonesReviewed} zones, ${fmtMs(op.activeMs)} active, ${op.zonesPerHour !== null ? op.zonesPerHour.toFixed(0) + ' zones/hr' : ''}`,
        margin + 10, y, 9,
      );
      y -= 14;
    }
    y -= 10;

    // Efficiency
    ensureSpace(60);
    drawText('Efficiency', margin, y, 14, true);
    y -= 18;
    const e = report.efficiencyMetrics;
    const effLines = [
      `Auto-annotation Savings: ${fmtMs(e.autoAnnotationSavingsMs)}`,
      `Review Queue Reduction: ${e.reviewQueueReductionPct !== null ? (e.reviewQueueReductionPct * 100).toFixed(1) + '%' : 'N/A'}`,
      `Estimated Cost (@ $25/hr): ${e.estimatedCost !== null ? '$' + e.estimatedCost.toFixed(2) : 'N/A'}`,
      `Complexity Score: ${e.complexityScore !== null ? e.complexityScore.toFixed(2) : 'N/A'}`,
    ];
    for (const line of effLines) {
      drawText(line, margin + 10, y, 10);
      y -= 14;
    }

    const pdfBytes = await pdf.save();
    return Buffer.from(pdfBytes);
  }
}

export const annotationTimesheetService = new AnnotationTimesheetService();
