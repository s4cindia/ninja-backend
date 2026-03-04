import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// States classified as machine time (automated, no human involvement)
const MACHINE_STATES = new Set([
  'UPLOAD_RECEIVED',
  'PREPROCESSING',
  'RUNNING_EPUBCHECK',
  'RUNNING_ACE',
  'RUNNING_AI_ANALYSIS',
  'AUTO_REMEDIATION',
  'VERIFICATION_AUDIT',
  'CONFORMANCE_MAPPING',
  'ACR_GENERATION',
]);

// AWAITING states that represent HITL gates
const HITL_STATES = new Set([
  'AWAITING_AI_REVIEW',
  'AWAITING_REMEDIATION_REVIEW',
  'AWAITING_CONFORMANCE_REVIEW',
  'AWAITING_ACR_SIGNOFF',
]);

// Map AWAITING state → gate name
const STATE_TO_GATE: Record<string, string> = {
  AWAITING_AI_REVIEW: 'AI_REVIEW',
  AWAITING_REMEDIATION_REVIEW: 'REMEDIATION_REVIEW',
  AWAITING_CONFORMANCE_REVIEW: 'CONFORMANCE_REVIEW',
  AWAITING_ACR_SIGNOFF: 'ACR_SIGNOFF',
};

// Terminal states
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED']);

interface SessionSegment {
  openedAt: string;
  closedAt: string;
  activeMs: number;
  idleMs: number;
}

interface TimeMetricsConfig {
  idleThresholdMinutes: number;
  gateBaselines: {
    AI_REVIEW: number;
    REMEDIATION_REVIEW: number;
    CONFORMANCE_REVIEW: number;
    ACR_SIGNOFF: number;
  };
}

const DEFAULT_GATE_BASELINES: TimeMetricsConfig['gateBaselines'] = {
  AI_REVIEW: 15,
  REMEDIATION_REVIEW: 20,
  CONFORMANCE_REVIEW: 25,
  ACR_SIGNOFF: 10,
};

class WorkflowMetricsService {
  /**
   * Called fire-and-forget from workflow.service.ts on every state transition.
   * Upserts WorkflowTimeMetric and creates HITLGateMetric rows for AWAITING states.
   */
  async recordStateTransition(
    workflowId: string,
    fromState: string | null,
    toState: string,
    timestamp: Date
  ): Promise<void> {
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowId },
      select: { batchId: true, createdBy: true, startedAt: true, file: { select: { tenantId: true } } },
    });
    if (!workflow) return;

    const tenantId = workflow.file?.tenantId ?? '';
    const workflowType = workflow.batchId ? 'AGENTIC' : 'MANUAL';

    // Read existing metric BEFORE upsert so we have the old lastStateEnteredAt for duration calc
    const existingMetric = await prisma.workflowTimeMetric.findUnique({ where: { workflowId } });

    // Compute duration of the state we are leaving using the OLD lastStateEnteredAt
    let machineIncrement = 0;
    let updatedBreakdown: Record<string, number> | null = null;

    if (fromState && existingMetric?.lastStateEnteredAt) {
      const durationMs = timestamp.getTime() - new Date(existingMetric.lastStateEnteredAt).getTime();
      if (durationMs > 0) {
        const breakdown = (existingMetric.stateBreakdown as Record<string, number>) ?? {};
        breakdown[fromState] = (breakdown[fromState] ?? 0) + durationMs;
        updatedBreakdown = breakdown;

        // Add to machineTimeMs if it was a machine state
        if (MACHINE_STATES.has(fromState)) {
          machineIncrement = durationMs;
        }
        // HITL state durations are handled via gate metrics (recordReviewStarted/Submitted), not here
      }
    }

    // Upsert WorkflowTimeMetric — include duration increments in the same operation
    const metric = await prisma.workflowTimeMetric.upsert({
      where: { workflowId },
      create: {
        workflowId,
        tenantId,
        batchId: workflow.batchId ?? null,
        workflowType,
        startedAt: workflow.startedAt,
        machineTimeMs: machineIncrement,
        humanWaitMs: 0,
        humanActiveMs: 0,
        gateCount: 0,
        autoApprovedCount: 0,
        manualReviewCount: 0,
        stateBreakdown: updatedBreakdown ?? {},
        lastState: toState,
        lastStateEnteredAt: timestamp,
      },
      update: {
        lastState: toState,
        lastStateEnteredAt: timestamp,
        ...(machineIncrement > 0 ? { machineTimeMs: { increment: machineIncrement } } : {}),
        ...(updatedBreakdown ? { stateBreakdown: updatedBreakdown } : {}),
      },
    });

    // If entering an AWAITING state, create a HITLGateMetric
    if (HITL_STATES.has(toState)) {
      const gate = STATE_TO_GATE[toState];
      if (gate) {
        await prisma.hITLGateMetric.create({
          data: {
            workflowId,
            timeMetricId: metric.id,
            tenantId,
            gate,
            gateEnteredAt: timestamp,
            autoApproved: false,
          },
        });

        await prisma.workflowTimeMetric.update({
          where: { workflowId },
          data: { gateCount: { increment: 1 } },
        });
      }
    }

    // If terminal, finalize
    if (TERMINAL_STATES.has(toState)) {
      await this.finalizeWorkflowMetrics(workflowId);
    }
  }

  /**
   * Called fire-and-forget when a HITL gate is auto-approved.
   * Marks the most recent gate metric for this workflow+gate as autoApproved.
   */
  async recordAutoApproval(
    workflowId: string,
    gate: string,
    timestamp: Date
  ): Promise<void> {
    // Find the most recent open gate metric for this workflow + gate
    const gateMetric = await prisma.hITLGateMetric.findFirst({
      where: { workflowId, gate, reviewSubmittedAt: null },
      orderBy: { gateEnteredAt: 'desc' },
    });
    if (!gateMetric) return;

    const durationMs = timestamp.getTime() - new Date(gateMetric.gateEnteredAt).getTime();

    await prisma.hITLGateMetric.update({
      where: { id: gateMetric.id },
      data: {
        autoApproved: true,
        reviewSubmittedAt: timestamp,
        activeMs: 0,
        waitMs: 0,
      },
    });

    // Auto-approved gates count as machine time (FR-1.5)
    await prisma.workflowTimeMetric.update({
      where: { workflowId },
      data: {
        machineTimeMs: { increment: durationMs > 0 ? durationMs : 0 },
        autoApprovedCount: { increment: 1 },
      },
    });
  }

  /**
   * Called when a reviewer opens a HITL review page.
   * Sets reviewStartedAt on the most recent open gate metric.
   */
  async recordReviewStarted(
    workflowId: string,
    gate: string,
    reviewerId: string,
    timestamp: Date
  ): Promise<void> {
    const gateMetric = await prisma.hITLGateMetric.findFirst({
      where: { workflowId, gate, reviewSubmittedAt: null },
      orderBy: { gateEnteredAt: 'desc' },
    });
    if (!gateMetric) return;

    // Only set reviewStartedAt once (first open — FR-2.7)
    if (gateMetric.reviewStartedAt) {
      // Already started; increment session count
      await prisma.hITLGateMetric.update({
        where: { id: gateMetric.id },
        data: {
          sessionCount: { increment: 1 },
          reviewerId,
        },
      });
      return;
    }

    const waitMs = timestamp.getTime() - new Date(gateMetric.gateEnteredAt).getTime();
    const waitMsClamped = waitMs > 0 ? waitMs : 0;

    await prisma.hITLGateMetric.update({
      where: { id: gateMetric.id },
      data: {
        reviewStartedAt: timestamp,
        waitMs: waitMsClamped,
        reviewerId,
        sessionCount: 1,
      },
    });

    // Push wait time into WorkflowTimeMetric immediately so in-progress reports show live data.
    // finalizeWorkflowMetrics will overwrite with the authoritative sum at completion.
    await prisma.workflowTimeMetric.update({
      where: { workflowId },
      data: { humanWaitMs: { increment: waitMsClamped } },
    }).catch(() => { /* WorkflowTimeMetric may not exist yet for very early opens */ });
  }

  /**
   * Called when a reviewer submits HITL decisions.
   * Records active time and session log; computes waitMs if not already set.
   */
  async recordReviewSubmitted(
    workflowId: string,
    gate: string,
    activeTimeMs: number,
    sessionLog: SessionSegment[],
    timestamp: Date
  ): Promise<void> {
    const gateMetric = await prisma.hITLGateMetric.findFirst({
      where: { workflowId, gate, reviewSubmittedAt: null },
      orderBy: { gateEnteredAt: 'desc' },
    });
    if (!gateMetric) return;

    const waitMs = gateMetric.waitMs ??
      (gateMetric.reviewStartedAt
        ? new Date(gateMetric.reviewStartedAt).getTime() - new Date(gateMetric.gateEnteredAt).getTime()
        : null);

    await prisma.hITLGateMetric.update({
      where: { id: gateMetric.id },
      data: {
        reviewSubmittedAt: timestamp,
        activeMs: activeTimeMs,
        waitMs: waitMs !== null && waitMs >= 0 ? waitMs : 0,
        sessionLog: sessionLog as object[],
      },
    });

    await prisma.workflowTimeMetric.update({
      where: { workflowId },
      data: {
        humanWaitMs: { increment: waitMs !== null && waitMs >= 0 ? waitMs : 0 },
        humanActiveMs: { increment: activeTimeMs },
        manualReviewCount: { increment: 1 },
      },
    });
  }

  /**
   * Called when workflow reaches COMPLETED or FAILED.
   * Computes totalElapsedMs, idleTimeMs, and triggers batch finalization.
   */
  async finalizeWorkflowMetrics(workflowId: string): Promise<void> {
    const workflow = await prisma.workflowInstance.findUnique({
      where: { id: workflowId },
      select: { completedAt: true, batchId: true, startedAt: true },
    });
    if (!workflow) return;

    const metric = await prisma.workflowTimeMetric.findUnique({ where: { workflowId } });
    if (!metric) return;

    // Recompute human wait/active from gate metrics — more reliable than incremental updates
    const gateMetrics = await prisma.hITLGateMetric.findMany({ where: { workflowId } });
    const humanWaitMs = gateMetrics.reduce((sum, g) => sum + (g.waitMs ?? 0), 0);
    const humanActiveMs = gateMetrics.reduce((sum, g) => sum + (g.activeMs ?? 0), 0);

    const completedAt = workflow.completedAt ?? new Date();
    const totalElapsedMs = completedAt.getTime() - new Date(metric.startedAt).getTime();

    const idleTimeMs = Math.max(
      0,
      totalElapsedMs - metric.machineTimeMs - humanWaitMs - humanActiveMs
    );

    await prisma.workflowTimeMetric.update({
      where: { workflowId },
      data: {
        completedAt,
        totalElapsedMs,
        humanWaitMs,
        humanActiveMs,
        idleTimeMs,
      },
    });

    // Trigger batch finalization if part of a batch
    if (workflow.batchId) {
      await this.finalizeBatchMetrics(workflow.batchId).catch(
        err => logger.warn(`[Metrics] finalizeBatchMetrics failed: ${err.message}`)
      );
    }
  }

  /**
   * Aggregates WorkflowTimeMetric rows for all workflows in a batch.
   * Skips if any workflow is still in-progress.
   */
  async finalizeBatchMetrics(batchId: string): Promise<void> {
    const batch = await prisma.batchWorkflow.findUnique({
      where: { id: batchId },
      select: { startedAt: true, completedAt: true, createdBy: true },
    });
    if (!batch) return;

    // Check all workflows in batch are terminal
    const inProgressCount = await prisma.workflowInstance.count({
      where: {
        batchId,
        completedAt: null,
        currentState: { notIn: ['FAILED'] },
      },
    });
    if (inProgressCount > 0) return; // Not all done yet

    const metrics = await prisma.workflowTimeMetric.findMany({
      where: { batchId },
      include: { gateMetrics: true },
    });
    if (metrics.length === 0) return;

    // Load tenant for gate baselines
    const workflow = await prisma.workflowInstance.findFirst({
      where: { batchId },
      select: { file: { select: { tenantId: true } } },
    });
    const tenantId = workflow?.file?.tenantId ?? '';

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings = (tenant?.settings && typeof tenant.settings === 'object')
      ? (tenant.settings as Record<string, unknown>)
      : {};
    const timeMetrics = (settings.timeMetrics && typeof settings.timeMetrics === 'object')
      ? (settings.timeMetrics as Record<string, unknown>)
      : {};
    const gateBaselines = (timeMetrics.gateBaselines && typeof timeMetrics.gateBaselines === 'object')
      ? (timeMetrics.gateBaselines as Record<string, number>)
      : DEFAULT_GATE_BASELINES;

    // Aggregate
    let totalMachineMs = 0;
    let totalHumanWaitMs = 0;
    let totalHumanActiveMs = 0;
    let totalGates = 0;
    let totalAutoApproved = 0;
    let humanTimeSavedMs = 0;
    let completedFiles = 0;
    let failedFiles = 0;
    const completionTimes: number[] = [];

    for (const m of metrics) {
      totalMachineMs += m.machineTimeMs;
      totalHumanWaitMs += m.humanWaitMs;
      totalHumanActiveMs += m.humanActiveMs;
      totalGates += m.gateCount;
      totalAutoApproved += m.autoApprovedCount;
      if (m.totalElapsedMs) completionTimes.push(m.totalElapsedMs);

      // Check workflow outcome
      const wf = await prisma.workflowInstance.findUnique({
        where: { id: m.workflowId },
        select: { currentState: true },
      });
      if (wf?.currentState === 'COMPLETED') completedFiles++;
      else failedFiles++;

      // Human time saved = baselines for auto-approved gates
      for (const gate of m.gateMetrics) {
        if (gate.autoApproved) {
          const baselineMinutes = gateBaselines[gate.gate as keyof typeof DEFAULT_GATE_BASELINES]
            ?? DEFAULT_GATE_BASELINES[gate.gate as keyof typeof DEFAULT_GATE_BASELINES]
            ?? 10;
          humanTimeSavedMs += baselineMinutes * 60 * 1000;
        }
      }
    }

    const autoApprovalRate = totalGates > 0 ? totalAutoApproved / totalGates : 0;
    const avgWorkflowTimeMs = completionTimes.length > 0
      ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length)
      : null;

    const batchCompletedAt = batch.completedAt ?? new Date();
    const totalElapsedMs = batchCompletedAt.getTime() - new Date(batch.startedAt).getTime();

    await prisma.batchTimeMetric.upsert({
      where: { batchId },
      create: {
        batchId,
        tenantId,
        batchStartedAt: batch.startedAt,
        batchCompletedAt,
        totalElapsedMs,
        totalFiles: metrics.length,
        completedFiles,
        failedFiles,
        totalMachineMs,
        totalHumanWaitMs,
        totalHumanActiveMs,
        avgWorkflowTimeMs,
        autoApprovalRate,
        humanTimeSavedMs,
      },
      update: {
        batchCompletedAt,
        totalElapsedMs,
        completedFiles,
        failedFiles,
        totalMachineMs,
        totalHumanWaitMs,
        totalHumanActiveMs,
        avgWorkflowTimeMs,
        autoApprovalRate,
        humanTimeSavedMs,
      },
    });
  }
}

export const workflowMetricsService = new WorkflowMetricsService();
