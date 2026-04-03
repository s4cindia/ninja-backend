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
  pageBreakdown: PageTimeRow[];
  efficiencyMetrics: {
    autoAnnotationSavingsMs: number;
    reviewQueueReductionPct: number | null;
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

    // Page breakdown — derive from zone decisions (no per-page timing from sessions yet)
    const pageMap = new Map<number, { count: number; confirmed: number; corrected: number; rejected: number }>();
    for (const z of zones) {
      const existing = pageMap.get(z.pageNumber) ?? { count: 0, confirmed: 0, corrected: 0, rejected: 0 };
      existing.count++;
      if (z.decision === 'CONFIRMED') existing.confirmed++;
      if (z.decision === 'CORRECTED') existing.corrected++;
      if (z.decision === 'REJECTED') existing.rejected++;
      pageMap.set(z.pageNumber, existing);
    }

    // Distribute total active time proportionally by zone count
    const totalZoneCount = zones.length;
    const pageBreakdown: PageTimeRow[] = [...pageMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, data]) => {
        const timeSpentMs = totalZoneCount > 0
          ? Math.round(totalActiveMs * (data.count / totalZoneCount))
          : 0;
        const mins = timeSpentMs / 60_000;
        return {
          pageNumber: page,
          zoneCount: data.count,
          timeSpentMs,
          zonesPerMin: mins > 0 ? data.count / mins : null,
          confirmed: data.confirmed,
          corrected: data.corrected,
          rejected: data.rejected,
        };
      });

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
      pageBreakdown,
      efficiencyMetrics: {
        autoAnnotationSavingsMs,
        reviewQueueReductionPct,
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
    const pgHeaders = ['Page', 'Zones', 'TimeSpentMs', 'ZonesPerMin', 'Confirmed', 'Corrected', 'Rejected'];
    const pgRows = report.pageBreakdown.map(r => [
      r.pageNumber, r.zoneCount, r.timeSpentMs,
      r.zonesPerMin !== null ? r.zonesPerMin.toFixed(1) : '',
      r.confirmed, r.corrected, r.rejected,
    ].map(escape).join(','));

    return [
      '# Operator Breakdown',
      opHeaders.join(','),
      ...opRows,
      '',
      '# Page Breakdown',
      pgHeaders.join(','),
      ...pgRows,
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
