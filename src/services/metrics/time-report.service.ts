import prisma from '../../lib/prisma';
import type { Prisma } from '@prisma/client';

// State type classification for display
const MACHINE_STATES = new Set([
  'UPLOAD_RECEIVED', 'PREPROCESSING', 'RUNNING_EPUBCHECK', 'RUNNING_ACE',
  'RUNNING_AI_ANALYSIS', 'AUTO_REMEDIATION', 'VERIFICATION_AUDIT',
  'CONFORMANCE_MAPPING', 'ACR_GENERATION',
]);
const HITL_STATES = new Set([
  'AWAITING_AI_REVIEW', 'AWAITING_REMEDIATION_REVIEW',
  'AWAITING_CONFORMANCE_REVIEW', 'AWAITING_ACR_SIGNOFF',
]);

function classifyState(state: string): 'machine' | 'hitl' | 'terminal' | 'other' {
  if (MACHINE_STATES.has(state)) return 'machine';
  if (HITL_STATES.has(state)) return 'hitl';
  if (['COMPLETED', 'FAILED'].includes(state)) return 'terminal';
  return 'other';
}

export interface StateTimelineRow {
  state: string;
  type: 'machine' | 'hitl' | 'terminal' | 'other';
  enteredAt: string;
  exitedAt: string | null;
  durationMs: number | null;
}

export interface GateBreakdownRow {
  gate: string;
  enteredAt: string;
  reviewStartedAt: string | null;
  reviewSubmittedAt: string | null;
  waitMs: number | null;
  activeMs: number | null;
  autoApproved: boolean;
  reviewerId: string | null;
  sessionCount: number;
}

export interface WorkflowDetailReport {
  workflowId: string;
  currentState: string;
  startedAt: string;
  completedAt: string | null;
  metrics: {
    totalElapsedMs: number | null;
    machineTimeMs: number;
    humanWaitMs: number;
    humanActiveMs: number;
    idleTimeMs: number | null;
    gateCount: number;
    autoApprovedCount: number;
    manualReviewCount: number;
    stateBreakdown: Record<string, number>;
  } | null;
  stateTimeline: StateTimelineRow[];
  gateBreakdown: GateBreakdownRow[];
}

export interface BatchFileRow {
  workflowId: string;
  filename: string;
  fileType: string;
  currentState: string;
  totalElapsedMs: number | null;
  machineTimeMs: number;
  humanWaitMs: number;
  humanActiveMs: number;
  gateCount: number;
  autoApprovedCount: number;
  /** ISO timestamp of when the currently-open HITL gate was entered, null if no gate is open */
  openGateEnteredAt: string | null;
}

export interface BatchDetailReport {
  batchId: string;
  name: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summary: {
    totalElapsedMs: number | null;
    totalFiles: number;
    completedFiles: number;
    failedFiles: number;
    totalMachineMs: number;
    totalHumanWaitMs: number;
    totalHumanActiveMs: number;
    avgWorkflowTimeMs: number | null;
    autoApprovalRate: number | null;
    humanTimeSavedMs: number | null;
  } | null;
  files: BatchFileRow[];
}

export interface WorkflowSummaryRow {
  workflowId: string;
  filename: string;
  fileType: string;
  workflowType: string;
  currentState: string;
  startedAt: string;
  completedAt: string | null;
  totalElapsedMs: number | null;
  machineTimeMs: number;
  humanWaitMs: number;
  humanActiveMs: number;
  autoApprovalRate: number | null;
}

export interface AggregateReport {
  kpis: {
    avgWorkflowTimeMs: number | null;
    avgMachineTimeMs: number | null;
    avgHumanWaitMs: number | null;
    totalHumanTimeSavedMs: number;
    autoApprovalRate: number | null;
    p50ElapsedMs: number | null;
    p90ElapsedMs: number | null;
    totalWorkflows: number;
    completedWorkflows: number;
    failedWorkflows: number;
  };
  rows: WorkflowSummaryRow[];
}

export interface AggregateFilters {
  from?: Date;
  to?: Date;
  workflowType?: 'MANUAL' | 'AGENTIC';
  fileType?: string;
  tenantId?: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

class TimeReportService {
  /**
   * Returns per-state timeline and HITL gate breakdown for a single workflow.
   */
  async getWorkflowDetailReport(workflowId: string, tenantId: string): Promise<WorkflowDetailReport | null> {
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowId },
      select: {
        id: true,
        currentState: true,
        startedAt: true,
        completedAt: true,
        file: { select: { tenantId: true, originalName: true, filename: true } },
        timeMetric: true,
        gateMetrics: {
          orderBy: { gateEnteredAt: 'asc' },
        },
        events: {
          orderBy: { timestamp: 'asc' },
          select: { fromState: true, toState: true, timestamp: true },
        },
      },
    });

    if (!workflow || workflow.file?.tenantId !== tenantId) return null;

    // Build state timeline from events
    const stateTimeline: StateTimelineRow[] = [];
    const events = workflow.events;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const nextEv = events[i + 1];

      // On first event, also emit the fromState entry
      if (i === 0 && ev.fromState) {
        stateTimeline.push({
          state: ev.fromState,
          type: classifyState(ev.fromState),
          enteredAt: new Date(workflow.startedAt).toISOString(),
          exitedAt: new Date(ev.timestamp).toISOString(),
          durationMs: new Date(ev.timestamp).getTime() - new Date(workflow.startedAt).getTime(),
        });
      }

      const enteredAt = new Date(ev.timestamp);
      const exitedAt = nextEv ? new Date(nextEv.timestamp) : null;
      stateTimeline.push({
        state: ev.toState ?? '',
        type: classifyState(ev.toState ?? ''),
        enteredAt: enteredAt.toISOString(),
        exitedAt: exitedAt ? exitedAt.toISOString() : null,
        durationMs: exitedAt ? exitedAt.getTime() - enteredAt.getTime() : null,
      });
    }

    // Gate breakdown
    const gateBreakdown: GateBreakdownRow[] = workflow.gateMetrics.map(g => ({
      gate: g.gate,
      enteredAt: new Date(g.gateEnteredAt).toISOString(),
      reviewStartedAt: g.reviewStartedAt ? new Date(g.reviewStartedAt).toISOString() : null,
      reviewSubmittedAt: g.reviewSubmittedAt ? new Date(g.reviewSubmittedAt).toISOString() : null,
      waitMs: g.waitMs ?? null,
      activeMs: g.activeMs ?? null,
      autoApproved: g.autoApproved,
      reviewerId: g.reviewerId,
      sessionCount: g.sessionCount,
    }));

    const tm = workflow.timeMetric;

    return {
      workflowId: workflow.id,
      currentState: workflow.currentState,
      startedAt: new Date(workflow.startedAt).toISOString(),
      completedAt: workflow.completedAt ? new Date(workflow.completedAt).toISOString() : null,
      metrics: tm ? {
        totalElapsedMs: tm.totalElapsedMs ?? null,
        machineTimeMs: tm.machineTimeMs,
        humanWaitMs: tm.humanWaitMs,
        humanActiveMs: tm.humanActiveMs,
        idleTimeMs: tm.idleTimeMs ?? null,
        gateCount: tm.gateCount,
        autoApprovedCount: tm.autoApprovedCount,
        manualReviewCount: tm.manualReviewCount,
        stateBreakdown: (tm.stateBreakdown as Record<string, number>) ?? {},
      } : null,
      stateTimeline,
      gateBreakdown,
    };
  }

  /**
   * Returns batch-level summary and per-file rows.
   */
  async getBatchDetailReport(batchId: string, tenantId: string, fileType?: string): Promise<BatchDetailReport | null> {
    const batch = await prisma.batchWorkflow.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        name: true,
        status: true,
        startedAt: true,
        completedAt: true,
        batchTimeMetric: true,
        workflows: {
          select: {
            id: true,
            currentState: true,
            file: { select: { tenantId: true, originalName: true, filename: true, mimeType: true } },
            timeMetric: true,
            gateMetrics: {
              where: { reviewSubmittedAt: null },
              orderBy: { gateEnteredAt: 'desc' },
              take: 1,
              select: { gateEnteredAt: true },
            },
          },
        },
      },
    });

    if (!batch) return null;

    // Verify at least one workflow belongs to tenant
    const hasAccess = batch.workflows.some(w => w.file?.tenantId === tenantId);
    if (!hasAccess) return null;

    const allFiles: BatchFileRow[] = batch.workflows
      .filter(w => {
        if (!fileType || fileType === 'All') return true;
        const mime = w.file?.mimeType?.toLowerCase() ?? '';
        if (fileType === 'EPUB') return mime.includes('epub');
        if (fileType === 'PDF') return mime.includes('pdf');
        return true;
      })
      .map(w => {
        const tm = w.timeMetric;
        const mime = w.file?.mimeType?.toLowerCase() ?? '';
        const openGate = w.gateMetrics?.[0] ?? null;
        return {
          workflowId: w.id,
          filename: w.file?.originalName ?? w.file?.filename ?? 'Unknown',
          fileType: mime.includes('epub') ? 'EPUB' : mime.includes('pdf') ? 'PDF' : 'Unknown',
          currentState: w.currentState,
          totalElapsedMs: tm?.totalElapsedMs ?? null,
          machineTimeMs: tm?.machineTimeMs ?? 0,
          humanWaitMs: tm?.humanWaitMs ?? 0,
          humanActiveMs: tm?.humanActiveMs ?? 0,
          gateCount: tm?.gateCount ?? 0,
          autoApprovedCount: tm?.autoApprovedCount ?? 0,
          openGateEnteredAt: openGate ? new Date(openGate.gateEnteredAt).toISOString() : null,
        };
      });

    const btm = batch.batchTimeMetric;

    return {
      batchId: batch.id,
      name: batch.name,
      status: batch.status,
      startedAt: new Date(batch.startedAt).toISOString(),
      completedAt: batch.completedAt ? new Date(batch.completedAt).toISOString() : null,
      summary: btm ? {
        totalElapsedMs: btm.totalElapsedMs ?? null,
        totalFiles: btm.totalFiles,
        completedFiles: btm.completedFiles,
        failedFiles: btm.failedFiles,
        totalMachineMs: btm.totalMachineMs,
        totalHumanWaitMs: btm.totalHumanWaitMs,
        totalHumanActiveMs: btm.totalHumanActiveMs,
        avgWorkflowTimeMs: btm.avgWorkflowTimeMs ?? null,
        autoApprovalRate: btm.autoApprovalRate ?? null,
        humanTimeSavedMs: btm.humanTimeSavedMs ?? null,
      } : null,
      files: allFiles,
    };
  }

  /**
   * Returns aggregate KPIs and per-workflow summary rows.
   */
  async getAggregateReport(filters: AggregateFilters): Promise<AggregateReport> {
    const where: Prisma.WorkflowTimeMetricWhereInput = {};

    if (filters.tenantId) where.tenantId = filters.tenantId;
    if (filters.workflowType) where.workflowType = filters.workflowType;

    if (filters.from || filters.to) {
      where.startedAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    const metrics = await prisma.workflowTimeMetric.findMany({
      where,
      include: {
        workflow: {
          select: {
            id: true,
            currentState: true,
            startedAt: true,
            completedAt: true,
            file: { select: { originalName: true, filename: true, mimeType: true } },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });

    // Apply fileType filter (post-query since it's on related file)
    const filtered = filters.fileType && filters.fileType !== 'All'
      ? metrics.filter(m => {
          const mime = m.workflow.file?.mimeType?.toLowerCase() ?? '';
          if (filters.fileType === 'EPUB') return mime.includes('epub');
          if (filters.fileType === 'PDF') return mime.includes('pdf');
          return true;
        })
      : metrics;

    // Compute KPIs
    const elapsedTimes = filtered
      .filter(m => m.totalElapsedMs !== null)
      .map(m => m.totalElapsedMs as number)
      .sort((a, b) => a - b);

    const totalGates = filtered.reduce((s, m) => s + m.gateCount, 0);
    const totalAutoApproved = filtered.reduce((s, m) => s + m.autoApprovedCount, 0);
    const totalHumanSaved = filtered.reduce((s, _m) => s + 0, 0); // populated via batch metrics; placeholder here

    const completedCount = filtered.filter(m => m.lastState === 'COMPLETED').length;
    const failedCount = filtered.filter(m => m.lastState === 'FAILED').length;

    const avg = (arr: number[]): number | null =>
      arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    const rows: WorkflowSummaryRow[] = filtered.map(m => {
      const mime = m.workflow.file?.mimeType?.toLowerCase() ?? '';
      const totalGatesForWf = m.gateCount;
      const autoRate = totalGatesForWf > 0 ? m.autoApprovedCount / totalGatesForWf : null;
      return {
        workflowId: m.workflowId,
        filename: m.workflow.file?.originalName ?? m.workflow.file?.filename ?? 'Unknown',
        fileType: mime.includes('epub') ? 'EPUB' : mime.includes('pdf') ? 'PDF' : 'Unknown',
        workflowType: m.workflowType,
        currentState: m.workflow.currentState,
        startedAt: new Date(m.startedAt).toISOString(),
        completedAt: m.completedAt ? new Date(m.completedAt).toISOString() : null,
        totalElapsedMs: m.totalElapsedMs ?? null,
        machineTimeMs: m.machineTimeMs,
        humanWaitMs: m.humanWaitMs,
        humanActiveMs: m.humanActiveMs,
        autoApprovalRate: autoRate,
      };
    });

    return {
      kpis: {
        avgWorkflowTimeMs: avg(elapsedTimes),
        avgMachineTimeMs: avg(filtered.map(m => m.machineTimeMs)),
        avgHumanWaitMs: avg(filtered.map(m => m.humanWaitMs)),
        totalHumanTimeSavedMs: totalHumanSaved,
        autoApprovalRate: totalGates > 0 ? totalAutoApproved / totalGates : null,
        p50ElapsedMs: percentile(elapsedTimes, 50),
        p90ElapsedMs: percentile(elapsedTimes, 90),
        totalWorkflows: filtered.length,
        completedWorkflows: completedCount,
        failedWorkflows: failedCount,
      },
      rows,
    };
  }

  /**
   * Exports aggregate report rows as a CSV string.
   */
  async exportAggregateCsv(filters: AggregateFilters): Promise<string> {
    const report = await this.getAggregateReport(filters);

    const headers = [
      'workflowId', 'filename', 'fileType', 'workflowType', 'currentState',
      'startedAt', 'completedAt', 'totalElapsedMs', 'machineTimeMs',
      'humanWaitMs', 'humanActiveMs', 'autoApprovalRate',
    ];

    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const lines = [
      headers.join(','),
      ...report.rows.map(r =>
        headers.map(h => escape(r[h as keyof typeof r])).join(',')
      ),
    ];

    return lines.join('\n');
  }
}

export const timeReportService = new TimeReportService();
